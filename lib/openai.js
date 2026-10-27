/**
 * OpenAI-compatible wire protocol for the session model bridge.
 *
 * Serves `POST /v1/chat/completions` (streamed and non-streamed) and
 * `GET /v1/models`. The client-visible model name is always the bridge's
 * unified name; the real backend is chosen by the transport (index.js).
 *
 * Contract: see the JSDoc block at the top of ./bridge-core.js.
 */
import {
  BridgeError,
  argsToJson,
  collectStream,
  describeError,
  fail,
  finishReasonFor,
  genId,
  nowSec,
  safeJsonParse,
  toCount,
  toStopList,
  toToolSchema,
} from './bridge-core.js'

const IMAGE_HINT =
  '本反代暂不支持图片输入（image_url / input_image）；请先在 DSH 会话里让支持视觉的模型看图，或去掉图片后重试。'

/** Map a thrown upstream value onto a BridgeError whose status still reflects the upstream. */
function toUpstreamError(error) {
  if (error instanceof BridgeError) return error
  const described = describeError(error)
  const status =
    Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 502
  return fail(status, described.code, described.message)
}

/** Flatten an OpenAI `content` value (string or part array) into text. */
function contentToText(content, where) {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    throw fail(400, 'invalid_request_error', `${where}: content 必须是字符串或内容块数组`)
  }
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    const type = part?.type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (typeof part.text === 'string') parts.push(part.text)
      continue
    }
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      throw fail(400, 'unsupported_content', IMAGE_HINT)
    }
    if (type === 'refusal') continue
    // Unknown vendor part: keep any text it carries rather than dropping it silently.
    if (typeof part?.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/** Convert the OpenAI `messages` array into DSH request messages + a system prompt. */
function toRequestMessages(messages, backend) {
  const systemParts = []
  const out = []
  let lastRole = ''

  for (const [index, message] of messages.entries()) {
    const role = message?.role
    const where = `messages[${index}]`
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content, where)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'user') {
      const text = contentToText(message.content, where)
      if (text.length === 0) continue
      out.push({ id: genId('msg_'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      lastRole = 'user'
      continue
    }
    if (role === 'assistant') {
      const blocks = []
      const text = contentToText(message.content, where)
      if (text.length > 0) blocks.push({ type: 'text', text })
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const [callIndex, call] of calls.entries()) {
        const fn = call?.function ?? {}
        const name = typeof fn.name === 'string' ? fn.name : typeof call?.name === 'string' ? call.name : ''
        if (name.length === 0) {
          throw fail(400, 'invalid_request_error', `${where}.tool_calls[${callIndex}]: 缺少 function.name`)
        }
        blocks.push({
          type: 'tool-call',
          id: typeof call?.id === 'string' && call.id.length > 0 ? call.id : genId('call_'),
          name,
          arguments: argsToJson(fn.arguments),
        })
      }
      // Legacy single function_call form.
      if (message.function_call?.name) {
        blocks.push({
          type: 'tool-call',
          id: genId('call_'),
          name: message.function_call.name,
          arguments: argsToJson(message.function_call.arguments),
        })
      }
      if (blocks.length === 0) continue
      out.push({
        id: genId('msg_'),
        role: 'assistant',
        content: blocks,
        source: { kind: 'model', provider: backend?.provider ?? 'bridge', model: backend?.model ?? 'bridge' },
      })
      lastRole = 'assistant'
      continue
    }
    if (role === 'tool' || role === 'function') {
      const callId = typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0 ? message.tool_call_id : genId('call_')
      const text = contentToText(message.content, where)
      out.push({
        id: genId('msg_'),
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
        source: { kind: 'tool', callId },
      })
      lastRole = 'tool'
      continue
    }
    throw fail(400, 'invalid_request_error', `${where}: 未知 role ${JSON.stringify(role)}`)
  }

  // A conversation must not start with a tool result block.
  while (out.length > 0 && out[0].role === 'tool') out.shift()
  if (out.length > 0 && lastRole === 'assistant') {
    // Providers reject a request whose history ends on a bare assistant turn;
    // nudge the conversation forward instead of failing the client.
    out.push({ id: genId('msg_'), role: 'user', content: [{ type: 'text', text: '继续。' }], source: { kind: 'user' } })
  }
  return { messages: out, system: systemParts.join('\n\n') }
}

/** Normalize `tools` / `tool_choice` into DSH ToolSchema[]. */
function toTools(body) {
  if (body.tools === undefined || body.tools === null) return undefined
  if (!Array.isArray(body.tools)) throw fail(400, 'invalid_request_error', 'tools 必须是数组')
  if (body.tools.length === 0) return undefined
  const schemas = []
  for (const [index, tool] of body.tools.entries()) {
    if (tool?.type !== 'function' || tool.function === undefined) {
      throw fail(400, 'invalid_request_error', `tools[${index}]: 只支持 {"type":"function","function":{...}}`)
    }
    schemas.push(toToolSchema(tool.function, 'openai'))
  }
  return schemas
}

/**
 * OpenAI `usage` object from a DSH token usage.
 *
 * OpenAI requires `total_tokens === prompt_tokens + completion_tokens`, but DSH
 * providers report cache/context tokens outside the input count (the OpenCode
 * Zen free wire, for example, returns prompt 136 + completion 2 with a total of
 * 394). Fold cache tokens into the prompt count and keep them visible as
 * `prompt_tokens_details.cached_tokens`, so the sum holds for every provider.
 */
function toUsage(usage) {
  const cacheRead = Number.isFinite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0
  const cacheWrite = Number.isFinite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  const reasoning = Number.isFinite(usage?.reasoningTokens) ? usage.reasoningTokens : 0
  const prompt = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite
  const completion = usage?.outputTokens ?? 0
  const result = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (cacheRead > 0) result.prompt_tokens_details = { cached_tokens: cacheRead }
  if (reasoning > 0) result.completion_tokens_details = { reasoning_tokens: reasoning }
  return result
}

/** `GET /v1/models`. */
export async function listModels(api) {
  const created = nowSec()
  const data = [
    { id: api.modelName, object: 'model', created, owned_by: 'dsh-session-model-bridge' },
  ]
  // With a valid session token, also advertise the live backend id plus a
  // non-standard `x_dsh_backend` field, so a client (or a test) can see which
  // session model this token is currently bridged to.
  if (api.backend?.provider && api.backend?.model) {
    data[0].x_dsh_backend = {
      provider: api.backend.provider,
      model: api.backend.model,
      sessionId: api.backend.sessionId,
      source: api.backend.source,
      stale: api.backend.stale,
    }
    const alias = `${api.backend.provider}/${api.backend.model}`
    if (alias !== api.modelName) {
      data.push({ id: alias, object: 'model', created, owned_by: api.backend.provider })
    }
  }
  api.sendJson(200, { object: 'list', data })
}

/** `POST /v1/chat/completions`. */
export async function handleChatCompletions(body, api) {
  const rawMessages = body.messages
  if (!Array.isArray(rawMessages)) {
    throw fail(400, 'invalid_request_error', 'messages 必须是数组')
  }
  const tools = toTools(body)
  const { messages, system } = toRequestMessages(rawMessages, api.backend)
  if (messages.length === 0) {
    throw fail(400, 'invalid_request_error', 'messages 为空：至少需要一条 user 消息')
  }
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined
  const maxTokens =
    toCount(body.max_tokens) ?? toCount(body.max_completion_tokens) ?? toCount(body.max_output_tokens)
  const stop = toStopList(body.stop)
  const stream = body.stream === true
  const includeUsage = body.stream_options?.include_usage === true

  const options = {
    messages,
    system,
    tools,
    temperature,
    maxTokens,
    stop,
    signal: api.signal,
  }

  if (!stream) {
    let collected
    try {
      collected = await collectStream(api.streamModel(options))
    } catch (error) {
      // No bytes written yet: the transport can still map this onto a real status.
      throw toUpstreamError(error)
    }
    if (collected.finishReason === 'error' || collected.finishReason === 'aborted') {
      const failure = collected.failure
      throw fail(502, failure?.code ?? 'provider_error', failure?.message ?? '模型请求失败')
    }
    const message = { role: 'assistant', content: collected.text.length > 0 ? collected.text : null }
    if (collected.reasoning.length > 0) message.reasoning_content = collected.reasoning
    if (collected.toolCalls.length > 0) {
      message.tool_calls = collected.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
      }))
    }
    api.sendJson(200, {
      id: genId('chatcmpl-'),
      object: 'chat.completion',
      created: nowSec(),
      model: api.modelName,
      choices: [{ index: 0, message, finish_reason: finishReasonFor(collected.finishReason, 'openai') }],
      usage: toUsage(collected.usage),
    })
    return
  }

  // ---- streaming -----------------------------------------------------------
  const id = genId('chatcmpl-')
  const created = nowSec()
  let started = false
  let roleSent = false
  /** block index → position inside the OpenAI `tool_calls` array */
  const toolPositions = new Map()
  const toolNamesSent = new Set()
  let usage
  let finishKind = 'stop'
  let failure

  const ensureStarted = () => {
    if (!started) {
      started = true
      api.sse.start()
    }
  }
  const sendChunk = (delta, finishReason = null, extra) => {
    ensureStarted()
    api.sse.send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: api.modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(extra ?? {}),
    })
  }
  const withRole = (delta) => {
    if (roleSent) return delta
    roleSent = true
    return { role: 'assistant', ...delta }
  }

  try {
    for await (const chunk of api.streamModel(options)) {
      switch (chunk.type) {
        case 'text-delta':
          if (chunk.text.length > 0) sendChunk(withRole({ content: chunk.text }))
          break
        case 'reasoning-delta':
          if (chunk.text.length > 0) sendChunk(withRole({ reasoning_content: chunk.text }))
          break
        case 'tool-call-delta': {
          let position = toolPositions.get(chunk.index)
          if (position === undefined) {
            position = toolPositions.size
            toolPositions.set(chunk.index, position)
          }
          const fn = {}
          if (!toolNamesSent.has(position)) {
            toolNamesSent.add(position)
            fn.name = chunk.name ?? ''
            fn.arguments = ''
            sendChunk(withRole({
              tool_calls: [{
                index: position,
                id: chunk.id,
                type: 'function',
                function: fn,
              }],
            }))
            if ((chunk.argumentsDelta ?? '').length > 0) {
              sendChunk({ tool_calls: [{ index: position, function: { arguments: chunk.argumentsDelta } }] })
            }
          } else if ((chunk.argumentsDelta ?? '').length > 0) {
            sendChunk({ tool_calls: [{ index: position, function: { arguments: chunk.argumentsDelta } }] })
          }
          break
        }
        case 'block-end': {
          // A provider may deliver a whole tool call with no deltas at all.
          if (chunk.block?.type === 'tool-call' && !toolNamesSent.has(toolPositions.get(chunk.index) ?? -1)) {
            const position = toolPositions.get(chunk.index) ?? toolPositions.size
            toolPositions.set(chunk.index, position)
            toolNamesSent.add(position)
            sendChunk(withRole({
              tool_calls: [{
                index: position,
                id: chunk.block.id,
                type: 'function',
                function: { name: chunk.block.name, arguments: chunk.block.arguments ?? '' },
              }],
            }))
          }
          break
        }
        case 'usage':
          usage = chunk.usage
          break
        case 'finish':
          finishKind = chunk.reason?.kind ?? 'stop'
          failure = chunk.reason?.failure
          break
        default:
          break
      }
    }
  } catch (error) {
    if (!started) throw error
    api.log?.(`openai stream failed mid-flight: ${error?.message ?? error}`)
    sendChunk(withRole({ content: `\n\n[bridge error] ${error?.message ?? error}` }), finishReasonFor('error', 'openai'))
    toolPositions.clear()
    api.sse.end()
    return
  }

  if (!started) ensureStarted()
  if (finishKind === 'error' || finishKind === 'aborted') {
    // A terminal failure after bytes were written cannot change the status code,
    // so it travels inline (same shape as a mid-flight throw) instead of being
    // reported to the client as a normal, complete answer.
    const detail =
      failure?.message ??
      (finishKind === 'aborted' ? '上游请求已中止（客户端断开或超时）' : '上游模型返回错误')
    sendChunk(withRole({ content: `\n\n[bridge error] ${detail}` }))
  }
  sendChunk(withRole({}), finishReasonFor(finishKind, 'openai'))
  if (includeUsage) {
    api.sse.send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: api.modelName,
      choices: [],
      usage: toUsage(usage),
    })
  }
  api.sse.end()
}
