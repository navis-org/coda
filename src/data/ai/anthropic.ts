/**
 * Anthropic — the Messages API.
 *
 * **Needs no proxy, which is the opposite of neuPrint.** `api.anthropic.com` answers the
 * preflight with `access-control-allow-origin: *` and allow-lists `x-api-key`,
 * `anthropic-version` and `anthropic-dangerous-direct-browser-access`, so the assistant works
 * on the static build in the same deployment where the Cypher API cannot be reached. Do not add
 * a proxy rule for it; there is nothing to fix.
 *
 * **Plain `fetch`, not `@anthropic-ai/sdk`.** The SDK refuses to run in a browser without
 * `dangerouslyAllowBrowser: true`, a flag meant to stop somebody shipping *their own* key to
 * end users — the opposite of what BYOK does, so it would be permanently on and permanently
 * misleading. It is also one endpoint against a dependency that would have to be lazily loaded.
 *
 * **The only provider here with cache *control*,** which is most of what it costs to run: the
 * ~15k-token catalogue is marked as a breakpoint, so every turn after the first reads it at a
 * tenth of the price instead of paying for it again.
 */

import { declined, getJson, noText, postJson, raiseHttpError, truncated } from './http'
import type { AiProvider, CompletionRequest, CompletionResult, KeyCheck, Usage } from './types'

const BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

/**
 * Comfortably above any plan and comfortably under the HTTP timeout a non-streaming request
 * has to live within. Note this is a ceiling on thinking *plus* text: adaptive thinking is on
 * by default on Opus 5, so a tighter number truncates the plan rather than the reasoning.
 */
const MAX_TOKENS = 16000

/** An hour, not the default five minutes. See the note on `system` below. */
const CACHE: { type: 'ephemeral'; ttl: '1h' } = { type: 'ephemeral', ttl: '1h' }

interface ApiResponse {
  content?: Array<{ type: string; text?: string }>
  model?: string
  stop_reason?: string
  stop_details?: { category?: string | null } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': API_VERSION,
    // The documented opt-in for calling the API straight from a page. See the header note.
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

function readUsage(usage: ApiResponse['usage']): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  }
}

export const anthropic: AiProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  needsKey: true,
  note: 'Claude. The only provider here that can be told to cache the prompt, which makes every turn after the first about ten times cheaper.',
  models: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (recommended)' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  defaultModel: 'claude-sonnet-5',
  defaultBaseUrl: BASE_URL,
  schemaSupport: 'native',

  async verify({ apiKey, model, baseUrl, signal }) {
    /*
     * `GET /v1/models/{id}` costs **zero tokens** and answers two questions at once: whether
     * the key is accepted, and whether the model id exists — which matters because the id is a
     * plain string this app never validates, so a typo would otherwise surface much later as a
     * failed plan. Auth is checked before the id, so a bad key reports as a bad key.
     */
    const base = baseUrl || BASE_URL
    const id = model || anthropic.defaultModel
    const { status, ok, payload } = await getJson(
      `${base}/v1/models/${encodeURIComponent(id)}`,
      headers(apiKey ?? ''),
      signal,
    )
    if (!ok) raiseHttpError('Anthropic', status, payload)
    const body = payload as { id?: string; display_name?: string; max_input_tokens?: number }
    return {
      model: body.id ?? id,
      label: body.display_name ?? id,
      context: body.max_input_tokens ?? 0,
    } satisfies KeyCheck
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const base = request.baseUrl || BASE_URL
    const model = request.model || anthropic.defaultModel

    const body = {
      model,
      max_tokens: MAX_TOKENS,
      /*
       * An array rather than a bare string so the breakpoint can go on it. The catalogue is
       * ~15k tokens and identical on every call, far above Opus 5's 512-token minimum, so
       * every call after the first reads it at a tenth of the price. That holds only while the
       * prefix is byte-identical: anything per-request belongs in `messages`, never here.
       *
       * An hour rather than the default five minutes, because this is a panel a person types
       * into — they ask, read the plan, look at the canvas, ask again, and those gaps routinely
       * exceed five minutes. A write costs 1.25x at the default TTL and 2x at an hour, so with
       * the default every turn outside the window pays *more than not caching at all*.
       */
      system: [{ type: 'text', text: request.system, cache_control: CACHE }],
      /*
       * A second breakpoint, on the last turn. Four are allowed and one left the whole
       * conversation uncached: a repair round re-sends the graph listing and the previous plan,
       * a couple of thousand tokens at full price. Earlier breakpoints stay valid read points.
       */
      messages: request.messages.map((m, index) => ({
        role: m.role,
        content: [
          {
            type: 'text',
            text: m.content,
            ...(index === request.messages.length - 1 ? { cache_control: CACHE } : {}),
          },
        ],
      })),
      ...(request.schema
        ? { output_config: { format: { type: 'json_schema', schema: request.schema } } }
        : {}),
    }

    const { status, ok, payload } = await postJson(
      `${base}/v1/messages`,
      headers(request.apiKey ?? ''),
      body,
      request.signal,
    )
    if (!ok) raiseHttpError('Anthropic', status, payload)

    const reply = payload as ApiResponse

    /*
     * Read `stop_reason` before `content`. A refusal is a successful 200 whose content array is
     * empty or partial, so anything that indexes `content[0]` breaks on it — and it is a
     * verdict about the request rather than a transport failure, so it has to say so.
     */
    if (reply.stop_reason === 'refusal') declined(reply.stop_details?.category)
    if (reply.stop_reason === 'max_tokens') truncated()

    /*
     * The last text block, not the first. With thinking on by default the content array leads
     * with a `thinking` block whose text is empty under the default display, so taking
     * `content[0]` yields an empty string and a JSON parse error blaming the wrong thing.
     */
    const text = (reply.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('')
    if (!text) noText('Anthropic')

    return { text, model: reply.model ?? model, usage: readUsage(reply.usage) }
  },
}
