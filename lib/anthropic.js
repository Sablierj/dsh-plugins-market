/**
 * anthropic — the Anthropic Messages (`POST /v1/messages`) wire protocol.
 *
 * Pure data shaping: this module never touches HTTP, `res`, or provider state.
 * The transport (`index.js`) parses the request body, calls
 * {@link handleMessages}, and turns a thrown {@link BridgeError} into the
 * Anthropic error envelope `{type:'error', error:{type, message}}`.
 *
 * Rules taken from the frozen contract in `./bridge-core.js`:
 *  - every input is validated and `BridgeError(400, 'invalid_request_error')`
 *    is thrown BEFORE the first byte is written (`api.sendJson` / `api.sse.start`);
 *  - after bytes are on the wire only a clean `return` is allowed, so a
 *    mid-stream upstream failure is reported inside the `message_delta`
 *    payload and the stream is closed with `stop_reason:'end_turn'`.
 *
 * DSH `RequestMessage`s always carry `id` and `source`: the DSH provider adapter
 * reads `message.source.replayState`, so a message without `source` crashes the
 * second turn of a tool round trip. The shapes below mirror `lib/openai.js`.
 */
import {
  BridgeError,
  fail,
  collectStream,
  toToolSchema,
  toStopList,
  toCount,
  argsToJson,
  safeJsonParse,
  genId,
  finishReasonFor,
  hasToolCall,
  describeError,
  textBlock,
} from './bridge-core.js'

const SOURCE = 'anthropic'
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
/** Message roles whose text is folded into the DSH `system` option. */
const SYSTEM_ROLES = new Set(['system', 'developer'])

/**
 * Anthropic Messages entry point.
 * @param {object} body already-parsed JSON request body (`{}` when empty)
 * @param {import('./bridge-core.js').BridgeApi} api
 */
export async function handleMessages(body, api) {
  const parsed = parseMessagesRequest(body, api?.backend)
  const options = buildStreamOptions(parsed)
  if (typeof api?.log === 'function') {
    api.log('anthropic: /v1/messages', {
      requestedModel: parsed.model,
      stream: parsed.stream,
      messages: options.messages.length,
      tools: options.tools?.length ?? 0,
    })
  }
  return parsed.stream ? streamMessages(options, api) : jsonMessages(options, api)
}

/* ------------------------------------------------------------------ *
 * Request parsing / validation
 * ------------------------------------------------------------------ */

function invalid(message) {
  return fail(400, 'invalid_request_error', `${SOURCE}: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function imageUnsupported(where) {
  return invalid(
    `暂不支持图片输入（${where} 中出现了 image block）。` +
      '请移除图片或改用纯文本请求；如需图片理解，请先在客户端把图片转换成文字描述再发送。',
  )
}

function parseMessagesRequest(body, backend) {
  if (!isPlainObject(body)) throw invalid('请求体必须是一个 JSON 对象')

  const model = body.model
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw invalid('model 是必填字段，必须是非空字符串')
  }

  const maxTokens = parseMaxTokens(body.max_tokens)
  const stream = parseStream(body.stream)
  const temperature = parseTemperature(body.temperature)
  const stop = parseStop(body.stop_sequences)
  const tools = parseTools(body.tools)

  const systemText = []
  collectSystemText(body.system, systemText, 'system')

  const messages = []
  parseConversation(body.messages, { systemText, messages, backend })

  if (messages.length === 0) {
    throw invalid('messages 中没有可用的对话内容（user/assistant 消息均为空）')
  }

  return {
    model,
    maxTokens,
    stream,
    temperature,
    stop,
    tools,
    system: systemText.length > 0 ? systemText.join('\n\n') : undefined,
    messages,
  }
}

/** `max_tokens` is required by the Anthropic Messages API. */
function parseMaxTokens(raw) {
  if (raw === undefined || raw === null) {
    throw invalid('max_tokens 是必填字段（Anthropic Messages API 要求正整数）')
  }
  const value = toCount(raw)
  if (value === undefined || value < 1) {
    throw invalid('max_tokens 必须是大于 0 的整数')
  }
  return value
}

function parseStream(raw) {
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'boolean') throw invalid('stream 必须是布尔值')
  return raw
}

function parseTemperature(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw invalid('temperature 必须是 0 到 1 之间的数字')
  }
  return raw
}

function parseStop(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return [raw]
  if (!Array.isArray(raw)) throw invalid('stop_sequences 必须是字符串数组')
  for (const entry of raw) {
    if (typeof entry !== 'string') throw invalid('stop_sequences 必须是字符串数组')
  }
  return toStopList(raw)
}

function parseTools(raw) {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw invalid('tools 必须是数组')
  if (raw.length === 0) return undefined
  return raw.map((tool, index) => {
    if (!isPlainObject(tool)) throw invalid(`tools[${index}] 必须是对象`)
    // `toToolSchema` validates the name and the `input_schema` shape itself.
    return toToolSchema(tool, SOURCE)
  })
}

/** `system` may be a string or a text-block array; `system`/`developer` messages fold in too. */
function collectSystemText(raw, out, where) {
  if (raw === undefined || raw === null) return
  if (typeof raw === 'string') {
    if (raw.length > 0) out.push(raw)
    return
  }
  if (!Array.isArray(raw)) throw invalid(`${where} 必须是字符串或 text block 数组`)
  for (let i = 0; i < raw.length; i += 1) {
    const block = raw[i]
    if (!isPlainObject(block)) throw invalid(`${where}[${i}] 必须是对象`)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalid(`${where}[${i}].text 必须是字符串`)
      if (block.text.length > 0) out.push(block.text)
    } else if (block.type === 'image') {
      throw imageUnsupported(`${where}[${i}]`)
    } else {
      throw invalid(`${where}[${i}] 的 content block type ${JSON.stringify(block.type)} 不受支持`)
    }
  }
}

function parseConversation(raw, { systemText, messages, backend }) {
  if (!Array.isArray(raw)) throw invalid('messages 必须是数组')
  if (raw.length === 0) throw invalid('messages 不能为空数组')

  for (let i = 0; i < raw.length; i += 1) {
    const message = raw[i]
    if (!isPlainObject(message)) throw invalid(`messages[${i}] 必须是对象`)
    const role = message.role
    if (typeof role !== 'string' || role.length === 0) {
      throw invalid(`messages[${i}].role 必须是非空字符串`)
    }
    if (SYSTEM_ROLES.has(role)) {
      collectSystemText(message.content, systemText, `messages[${i}].content`)
      continue
    }
    if (role !== 'user' && role !== 'assistant') {
      throw invalid(`messages[${i}].role ${JSON.stringify(role)} 不受支持（仅支持 user、assistant）`)
    }
    const blocks = parseContent(message.content, role, `messages[${i}].content`)
    if (role === 'assistant') appendAssistantMessage(blocks, messages, backend)
    else appendUserMessage(blocks, messages, backend)
  }
}

/** @returns {object[]} validated, protocol-neutral blocks (`undefined` entries dropped). */
function parseContent(raw, role, where) {
  if (typeof raw === 'string') return raw.length === 0 ? [] : [{ type: 'text', text: raw }]
  if (raw === undefined || raw === null) throw invalid(`${where} 不能为空`)
  if (!Array.isArray(raw)) throw invalid(`${where} 必须是字符串或 content block 数组`)
  const blocks = []
  for (let i = 0; i < raw.length; i += 1) {
    const block = parseContentBlock(raw[i], role, `${where}[${i}]`)
    if (block !== undefined) blocks.push(block)
  }
  return blocks
}

function parseContentBlock(raw, role, where) {
  if (!isPlainObject(raw)) throw invalid(`${where} 必须是对象`)
  switch (raw.type) {
    case 'text': {
      if (typeof raw.text !== 'string') throw invalid(`${where}.text 必须是字符串`)
      return { type: 'text', text: raw.text }
    }
    case 'image':
      throw imageUnsupported(where)
    case 'document':
      throw invalid(`${where}: 暂不支持 document block（PDF/文本附件）`)
    case 'tool_use': {
      if (role !== 'assistant') throw invalid(`${where}: tool_use 只能出现在 assistant 消息中`)
      const id = raw.id
      if (typeof id !== 'string' || id.length === 0) throw invalid(`${where}.id 必须是非空字符串`)
      const name = raw.name
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
        throw invalid(`${where}.name ${JSON.stringify(name)} 必须匹配 ^[a-zA-Z0-9_-]{1,64}$`)
      }
      const input = raw.input === undefined || raw.input === null ? {} : raw.input
      if (!isPlainObject(input)) throw invalid(`${where}.input 必须是 JSON 对象`)
      return { type: 'tool_use', id, name, input }
    }
    case 'tool_result': {
      if (role !== 'user') throw invalid(`${where}: tool_result 只能出现在 user 消息中`)
      const toolUseId = raw.tool_use_id
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
        throw invalid(`${where}.tool_use_id 必须是非空字符串`)
      }
      const isError = raw.is_error === undefined ? false : raw.is_error
      if (typeof isError !== 'boolean') throw invalid(`${where}.is_error 必须是布尔值`)
      return { type: 'tool_result', toolUseId, isError, text: toolResultText(raw.content, where) }
    }
    // Anthropic replays signed thinking blocks in multi-turn tool use; DSH does
    // not need them back, so they are dropped instead of rejected.
    case 'thinking':
    case 'redacted_thinking': {
      if (role !== 'assistant') throw invalid(`${where}: ${raw.type} 只能出现在 assistant 消息中`)
      return undefined
    }
    case undefined:
      throw invalid(`${where}.type 是必填字段`)
    default:
      throw invalid(`${where} 的 content block type ${JSON.stringify(raw.type)} 不受支持`)
  }
}

/** `tool_result.content` may be a string or a text-block array. */
function toolResultText(raw, where) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) throw invalid(`${where}.content 必须是字符串或 content block 数组`)
  const parts = []
  for (let i = 0; i < raw.length; i += 1) {
    const block = raw[i]
    if (!isPlainObject(block)) throw invalid(`${where}.content[${i}] 必须是对象`)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalid(`${where}.content[${i}].text 必须是字符串`)
      parts.push(block.text)
    } else if (block.type === 'image') {
      throw imageUnsupported(`${where}.content[${i}]`)
    } else {
      throw invalid(
        `${where}.content[${i}] 的 content block type ${JSON.stringify(block.type)} 不受支持`,
      )
    }
  }
  return parts.join('\n')
}

function appendAssistantMessage(blocks, messages, backend) {
  const content = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push(textBlock(block.text))
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: argsToJson(block.input),
      })
    }
  }
  if (content.length === 0) return // an empty assistant turn carries no information
  messages.push({
    id: genId('msg_'),
    role: 'assistant',
    content,
    source: { kind: 'model', provider: backend?.provider ?? 'bridge', model: backend?.model ?? 'bridge' },
  })
}

/**
 * One `user` message may interleave plain text and `tool_result` blocks. Every
 * result becomes its own DSH `tool` message and the surrounding text keeps its
 * original position relative to it; no `tool_result` stays inside `user`.
 */
function appendUserMessage(blocks, messages, backend) {
  let pending = []
  const flush = () => {
    if (pending.length === 0) return
    messages.push({ id: genId('msg_'), role: 'user', content: pending, source: { kind: 'user' } })
    pending = []
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) pending.push(textBlock(block.text))
      continue
    }
    // tool_result
    flush()
    if (!hasToolCall(messages, block.toolUseId)) {
      throw invalid(
        `tool_result 的 tool_use_id ${JSON.stringify(block.toolUseId)} ` +
          '没有匹配的 assistant tool_use（严格上游会拒绝该请求）',
      )
    }
    messages.push({
      id: genId('msg_'),
      role: 'tool',
      toolCallId: block.toolUseId,
      content: [textBlock(block.text)],
      isError: block.isError,
      source: { kind: 'tool', callId: block.toolUseId },
    })
  }
  flush()
}

function buildStreamOptions(parsed) {
  const options = { messages: parsed.messages, maxTokens: parsed.maxTokens }
  if (parsed.system !== undefined) options.system = parsed.system
  if (parsed.tools !== undefined) options.tools = parsed.tools
  if (parsed.temperature !== undefined) options.temperature = parsed.temperature
  if (parsed.stop !== undefined) options.stop = parsed.stop
  return options
}

/* ------------------------------------------------------------------ *
 * Failure shaping
 * ------------------------------------------------------------------ */

/** Map a thrown upstream value onto a `BridgeError` that is still safe to send. */
function toUpstreamError(error) {
  if (error instanceof BridgeError) return error
  const described = describeError(error)
  const status =
    Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
      ? error.status
      : described.status
  return fail(status, described.code, described.message)
}

/** Describe a terminal `error`/`aborted` finish reason from the DSH stream. */
function failureInfo(kind, failure) {
  const aborted = kind === 'aborted'
  const code =
    typeof failure?.code === 'string' && failure.code.length > 0
      ? failure.code
      : aborted
        ? 'request_aborted'
        : 'upstream_error'
  const message =
    typeof failure?.message === 'string' && failure.message.length > 0
      ? failure.message
      : aborted
        ? '上游请求已中止（客户端断开或超时）'
        : '上游模型返回错误'
  const status = Number.isInteger(failure?.status) ? failure.status : 502
  return { code, message, status }
}

/* ------------------------------------------------------------------ *
 * Non-streaming path
 * ------------------------------------------------------------------ */

async function jsonMessages(options, api) {
  let collected
  try {
    collected = await collectStream(api.streamModel(options))
  } catch (error) {
    // No bytes written yet: the transport can still map this onto a real status.
    throw toUpstreamError(error)
  }

  if (collected.finishReason === 'error' || collected.finishReason === 'aborted') {
    const info = failureInfo(collected.finishReason, collected.failure)
    throw fail(info.status, info.code, info.message)
  }

  const usage = collected.usage
  api.sendJson(200, {
    id: genId('msg_'),
    type: 'message',
    role: 'assistant',
    model: api.modelName,
    content: contentFromCollected(collected),
    stop_reason: finishReasonFor(collected.finishReason, 'anthropic'),
    stop_sequence: null,
    usage: {
      input_tokens: toCount(usage?.inputTokens) ?? 0,
      output_tokens: toCount(usage?.outputTokens) ?? 0,
    },
  })
}

function contentFromCollected(collected) {
  const content = []
  for (const block of collected.blocks) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) {
        content.push({ type: 'text', text: block.text })
      }
    } else if (block.type === 'tool-call') {
      content.push({
        type: 'tool_use',
        id: block.id || genId('toolu_'),
        name: block.name,
        input: toInputObject(block.arguments),
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return content
}

/** Tool arguments arrive as a JSON string; Anthropic wants a JSON object. */
function toInputObject(raw) {
  const parsed = safeJsonParse(raw, undefined)
  return isPlainObject(parsed) ? parsed : {}
}

/* ------------------------------------------------------------------ *
 * Streaming path (Anthropic SSE event sequence)
 * ------------------------------------------------------------------ */

async function streamMessages(options, api) {
  let stream
  try {
    stream = api.streamModel(options)
  } catch (error) {
    throw toUpstreamError(error)
  }

  // True streaming: the first byte goes out as soon as the first content event
  // exists, so a client (Claude Code / Codex waiting on a long turn) sees
  // progress instead of a silent socket that may even hit a headers timeout.
  // `message_start` therefore cannot carry the prompt size — DSH only reveals
  // `usage` in a terminal chunk — and the real counts travel in the closing
  // `message_delta.usage`, which Anthropic allows (SDK `MessageDeltaUsage`
  // contains `input_tokens`).
  let started = false
  const ensureStarted = () => {
    if (started) return
    api.sse.start()
    started = true
    api.sse.event('message_start', {
      type: 'message_start',
      message: {
        id: genId('msg_'),
        type: 'message',
        role: 'assistant',
        model: api.modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  let usage
  let finishKind = 'stop'
  let failure

  /** @type {Map<number, {index: number, type: string}>} DSH block index → emitted block */
  const opened = new Map()
  /** @type {Map<number, string>} DSH block index → declared blockType */
  const declared = new Map()
  let nextIndex = 0
  let open = null

  const closeOpen = () => {
    if (open === null) return
    api.sse.event('content_block_stop', { type: 'content_block_stop', index: open.index })
    open = null
  }

  const openBlock = (dshIndex, type, info) => {
    const existing = opened.get(dshIndex)
    if (existing !== undefined) return existing
    ensureStarted()
    if (open !== null) closeOpen()
    const index = nextIndex++
    const contentBlock =
      type === 'tool-call'
        ? {
            type: 'tool_use',
            id: typeof info?.id === 'string' ? info.id : '',
            name: typeof info?.name === 'string' ? info.name : '',
            input: {},
          }
        : type === 'reasoning'
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' }
    api.sse.event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    })
    const entry = { dshIndex, index, type }
    opened.set(dshIndex, entry)
    open = entry
    return entry
  }

  const emitDelta = (index, delta) => {
    ensureStarted()
    api.sse.event('content_block_delta', { type: 'content_block_delta', index, delta })
  }

  let streamError = null
  try {
    for await (const chunk of stream) {
      switch (chunk?.type) {
        case 'block-start':
          declared.set(chunk.index, chunk.blockType)
          break
        case 'text-delta': {
          const block = openBlock(chunk.index, 'text')
          if (typeof chunk.text === 'string' && chunk.text.length > 0) {
            emitDelta(block.index, { type: 'text_delta', text: chunk.text })
          }
          break
        }
        case 'reasoning-delta': {
          const block = openBlock(chunk.index, 'reasoning')
          if (typeof chunk.text === 'string' && chunk.text.length > 0) {
            emitDelta(block.index, { type: 'thinking_delta', thinking: chunk.text })
          }
          break
        }
        case 'tool-call-delta': {
          const block = openBlock(chunk.index, 'tool-call', { id: chunk.id, name: chunk.name })
          if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) {
            emitDelta(block.index, { type: 'input_json_delta', partial_json: chunk.argumentsDelta })
          }
          break
        }
        case 'block-end': {
          const dshIndex = chunk.index
          if (opened.has(dshIndex)) {
            if (open !== null && open.dshIndex === dshIndex) closeOpen()
            break
          }
          // No delta ever arrived (for example a tool call with empty input, or
          // an empty text block): emit the authoritative assembled block now.
          const type = normalizeBlockType(chunk.block?.type ?? declared.get(dshIndex))
          const block = openBlock(
            dshIndex,
            type,
            type === 'tool-call' ? { id: chunk.block?.id, name: chunk.block?.name } : undefined,
          )
          if (typeof chunk.block?.text === 'string' && chunk.block.text.length > 0) {
            emitDelta(block.index, {
              type: type === 'reasoning' ? 'thinking_delta' : 'text_delta',
              ...(type === 'reasoning'
                ? { thinking: chunk.block.text }
                : { text: chunk.block.text }),
            })
          } else if (
            type === 'tool-call' &&
            typeof chunk.block?.arguments === 'string' &&
            chunk.block.arguments.length > 0
          ) {
            emitDelta(block.index, {
              type: 'input_json_delta',
              partial_json: chunk.block.arguments,
            })
          }
          closeOpen()
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
    // Before the first byte the transport can still map this onto a real status.
    if (!started) throw toUpstreamError(error)
    // Bytes are on the wire: Anthropic clients cannot recover, so the stream is
    // closed cleanly and the failure travels inline instead of as a throw.
    streamError = describeError(error)
  }

  if (streamError === null && (finishKind === 'error' || finishKind === 'aborted')) {
    const info = failureInfo(finishKind, failure)
    if (!started) throw fail(info.status, info.code, info.message)
    streamError = info
  }

  try {
    closeOpen()
  } catch {
    // The transport is already gone; there is nothing left to terminate.
  }

  // A stream that produced no content block at all still has to open with
  // `message_start` and close with message_delta/message_stop (never a bare
  // `message_stop` tail).
  ensureStarted()

  const payload = {
    type: 'message_delta',
    delta: {
      stop_reason: streamError !== null ? 'end_turn' : finishReasonFor(finishKind, 'anthropic'),
      stop_sequence: null,
    },
    usage: {
      input_tokens: toCount(usage?.inputTokens) ?? 0,
      output_tokens: toCount(usage?.outputTokens) ?? 0,
    },
  }
  if (streamError !== null) {
    // `type` matches the Anthropic error envelope; `code` is the bridge's stable
    // machine code, kept alongside it so either convention is readable.
    payload.error = { type: streamError.code, code: streamError.code, message: streamError.message }
  }
  try {
    api.sse.event('message_delta', payload)
    api.sse.event('message_stop', { type: 'message_stop' })
  } catch {
    // Nothing more can be written; index.js closes the response itself.
  }
  if (typeof api.sse.end === 'function') {
    try {
      api.sse.end()
    } catch {
      // The transport already ended the response.
    }
  }
}

function normalizeBlockType(type) {
  if (type === 'reasoning' || type === 'tool-call') return type
  return 'text'
}
