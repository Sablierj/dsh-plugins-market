/**
 * bridge-core — the FROZEN contract between the transport (`index.js`) and the
 * wire-protocol modules (`lib/openai.js`, `lib/anthropic.js`).
 *
 * Nothing in here touches HTTP, the DSH services, or provider state: it is pure
 * data shaping so that every protocol module can be unit-tested with a fake
 * `api` object.
 *
 * ---------------------------------------------------------------------------
 * A protocol module exports exactly one or two async handler functions:
 *
 *   export async function handleChatCompletions(body, api)   // lib/openai.js
 *   export async function listModels(api)                    // lib/openai.js
 *   export async function handleMessages(body, api)          // lib/anthropic.js
 *
 * `body` is the already-parsed JSON request body (an object; `{}` when empty).
 * The handler returns when the response is complete. It MUST validate every
 * input and throw `BridgeError` BEFORE it calls `api.sendJson(...)` or
 * `api.sse.start()`; once bytes have been written only a clean `return`
 * is allowed (a throw there can no longer change the status code).
 *
 * ---------------------------------------------------------------------------
 * @typedef {object} Backend
 * @property {string} provider          DSH llm provider route, e.g. "opencode-zen-free"
 * @property {string} model             exact model id, e.g. "deepseek-v4.1-flash-free"
 * @property {string|null} sessionId    source session, null for a pinned backend
 * @property {string} label             human label of the source session
 * @property {boolean} stale            true when resolved from the last-known cache
 * @property {string} source            'session' | 'cached' | 'default' | 'pinned'
 *
 * @typedef {object} StreamOptions
 * @property {object[]} messages        DSH RequestMessage[]
 * @property {string} [system]
 * @property {object[]} [tools]         DSH ToolSchema[]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {string[]} [stop]
 *
 * @typedef {object} BridgeApi
 * @property {string} modelName   unified outward model name (config.modelName)
 * @property {Backend} backend    backend resolved for THIS request
 * @property {AbortSignal} signal aborts on client disconnect or timeout
 * @property {(options: StreamOptions) => AsyncIterable<object>} streamModel
 *   Streams DSH `StreamChunk`s for the backend. Terminal `finish` chunks carry
 *   `{kind:'stop'|'tool-calls'|'max-tokens'|'error'|'aborted', failure?}`.
 * @property {(status: number, payload: object) => void} sendJson
 * @property {{ start: () => void,
 *              send: (payload: object) => void,
 *              event: (name: string, payload: object) => void,
 *              end: () => void }} sse
 *   Anthropic-style modules use `event(name, payload)`; OpenAI-style modules use
 *   `send(payload)` and then `end()` (which writes `data: [DONE]`).
 * @property {(message: string, data?: object) => void} log
 */

/** Error that maps onto a wire-protocol error response. */
export class BridgeError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code stable machine code, e.g. `invalid_request_error`
   * @param {string} message human-readable, already safe to return to a client
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
    this.code = code
  }
}

/** Build a {@link BridgeError} (kept as a function so modules read declaratively). */
export function fail(status, code, message) {
  return new BridgeError(status, code, message)
}

/** Milliseconds since the epoch, truncated to whole seconds (wire `created`). */
export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

/** Random wire id such as `chatcmpl-1f9c…` / `msg_1f9c…`. */
export function genId(prefix) {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`
}

/** Parse JSON without throwing; returns `fallback` for empty or malformed input. */
export function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Serialize tool arguments the way DSH expects them (a JSON **string**). */
export function argsToJson(input) {
  if (typeof input === 'string') return input
  if (input === undefined || input === null) return '{}'
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}

/** `{type:'text', text}` content block. */
export function textBlock(text) {
  return { type: 'text', text }
}

/**
 * Normalize one client tool declaration into a DSH `ToolSchema`.
 * @param {{name?: unknown, description?: unknown, parameters?: unknown, input_schema?: unknown}} raw
 * @param {string} source protocol name, for the error message
 */
export function toToolSchema(raw, source) {
  const name = typeof raw?.name === 'string' ? raw.name : ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw fail(400, 'invalid_request_error', `${source}: tool name ${JSON.stringify(name)} must match ^[a-zA-Z0-9_-]{1,64}$`)
  }
  const schema = raw.parameters ?? raw.input_schema ?? { type: 'object', properties: {} }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw fail(400, 'invalid_request_error', `${source}: tool "${name}" parameters must be a JSON object`)
  }
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    parameters: schema,
  }
}

/** Normalize a client `stop`/`stop_sequences` field into `string[] | undefined`. */
export function toStopList(raw) {
  if (typeof raw === 'string') return [raw]
  if (!Array.isArray(raw)) return undefined
  const list = raw.filter((entry) => typeof entry === 'string')
  return list.length > 0 ? list : undefined
}

/** Whole number or `undefined`; rejects negative/NaN values. */
export function toCount(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined
  return Math.floor(raw)
}

/**
 * Find a DSH tool block for the given call id anywhere in already-built messages.
 * Tool-result blocks have to carry the matching assistant `tool-call`, otherwise
 * strict providers reject the request.
 * @param {object[]} messages
 * @param {string} callId
 */
export function hasToolCall(messages, callId) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool-call' && block.id === callId) return true
    }
  }
  return false
}

/**
 * Merge every `StreamChunk` of one call into the final assistant turn.
 * Used by both protocols for the non-streaming path.
 *
 * @param {AsyncIterable<object>} chunks
 * @returns {Promise<{blocks: object[], text: string, reasoning: string,
 *   toolCalls: object[], usage: object|undefined, finishReason: string,
 *   failure: object|undefined}>}
 */
export async function collectStream(chunks) {
  /** @type {Map<number, object>} */
  const byIndex = new Map()
  const pending = new Map()
  let usage
  let finishReason = 'stop'
  let failure

  const slot = (index, blockType) => {
    let block = byIndex.get(index)
    if (block === undefined) {
      block = blockType === 'tool-call'
        ? { type: 'tool-call', id: '', name: '', arguments: '' }
        : { type: blockType, text: '' }
      byIndex.set(index, block)
    }
    return block
  }

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start':
        slot(chunk.index, chunk.blockType)
        break
      case 'text-delta':
        slot(chunk.index, 'text').text += chunk.text
        break
      case 'reasoning-delta':
        slot(chunk.index, 'reasoning').text += chunk.text
        break
      case 'tool-call-delta': {
        const block = slot(chunk.index, 'tool-call')
        block.id = chunk.id ?? block.id
        if (chunk.name !== undefined) block.name = chunk.name
        block.arguments += chunk.argumentsDelta ?? ''
        pending.set(block.id, block)
        break
      }
      case 'block-end':
        // The terminal block is authoritative (it carries the assembled value).
        if (chunk.block?.type === 'tool-call') {
          byIndex.set(chunk.index, {
            type: 'tool-call',
            id: chunk.block.id,
            name: chunk.block.name,
            arguments: chunk.block.arguments,
          })
        } else if (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning') {
          byIndex.set(chunk.index, { type: chunk.block.type, text: chunk.block.text })
        }
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finishReason = chunk.reason?.kind ?? 'stop'
        failure = chunk.reason?.failure
        break
      default:
        break
    }
  }

  const blocks = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
  const toolCalls = blocks.filter((b) => b.type === 'tool-call')
  return { blocks, text, reasoning, toolCalls, usage, finishReason, failure }
}

/**
 * Provider-neutral finish kind → the two protocol vocabularies.
 * @param {string} kind
 */
export function finishReasonFor(kind, protocol) {
  if (protocol === 'anthropic') {
    switch (kind) {
      case 'tool-calls': return 'tool_use'
      case 'max-tokens': return 'max_tokens'
      case 'aborted':
      case 'error': return 'end_turn'
      default: return 'end_turn'
    }
  }
  switch (kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted':
    case 'error': return 'stop'
    default: return 'stop'
  }
}

/** Turn any thrown value into a client-safe `{message, code}` pair. */
export function describeError(error) {
  if (error instanceof BridgeError) {
    return { message: error.message, code: error.code, status: error.status }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.code === 'string' ? error.code : 'bridge_error'
  return { message, code, status: 500 }
}
