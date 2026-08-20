/**
 * Ollama — a model running on the user's own machine.
 *
 * The only provider here that needs no key and sends nothing anywhere. It is also the only one
 * that can fail for reasons outside this app entirely, so three of them are handled explicitly
 * rather than left to arrive as a bare "could not reach".
 *
 * **The context window is the one that fails silently, so it is set here.** Ollama's default
 * `num_ctx` is a few thousand tokens and the catalogue alone is ~13k: left alone, the prompt is
 * *quietly truncated* from the front and the model answers confidently about a node list it was
 * never shown. That is the worst failure available — no error, a plausible wrong plan — so
 * `num_ctx` is sent on every request. A model whose trained context is smaller will clamp, and
 * the effect is the same, which is why `verify` says what the request is going to ask for.
 *
 * **The model list is asked for, not declared.** `models` below is a shortlist of reasonable
 * things to pull; what is *on the machine* is whatever the user ran `ollama pull` for, and no
 * list written here can know it. Left as the only source, every name in the dropdown reads as a
 * model you can pick and none of them may be — reported from a real install whose two models
 * appeared nowhere in the five offered. `listModels` reads `/api/tags`, which `verify` was
 * already reading to name what is installed when a chat 404s.
 *
 * **Cross-origin.** Ollama refuses browsers it has not been told about; the user sets
 * `OLLAMA_ORIGINS`. There is nothing this app can do about it, so the network error names it.
 *
 * **Mixed content.** A page served over https may be blocked from reaching a plain-http local
 * server before the request is made. That means Ollama is reliable on the dev server and may
 * simply not work on the deployed build, depending on the browser — untestable from here, so
 * the panel says so rather than claiming either way.
 */

import { getJson, messageIn, noText, postJson, truncated } from './http'
import type { AiProvider, CompletionRequest, CompletionResult, ModelOption } from './types'
import { AiError } from './types'

const BASE_URL = 'http://localhost:11434'

/**
 * Room for the ~13k-token prompt and a plan on top of it, without asking a laptop for a 32k
 * KV cache it will feel. Below this the catalogue is silently cut; far above it, the memory is
 * spent on context nothing uses.
 */
const NUM_CTX = 16384

interface TagsResponse {
  models?: Array<{ name?: string; size?: number; details?: { format?: string } }>
}

/** What `pulled` knows about a model beyond its name. */
interface PulledModel extends ModelOption {
  /** Whether `format` is likely to be honoured — see `STRUCTURED_FORMAT`. */
  structured: boolean
}

/**
 * The on-disk format whose engine applies the JSON schema.
 *
 * Ollama accepts `format` for every model and reports no capability for it — `/api/show` lists
 * `completion, vision, tools, thinking` identically for a build that honours it and one that
 * does not. What separates them is the engine behind the weights: a `gguf` model runs through
 * llama.cpp, where the schema becomes a compiled grammar, while a `safetensors` model (an MLX or
 * native conversion) runs elsewhere and the field is accepted and **ignored**.
 *
 * Measured, on one machine holding both builds of the same model. Asked for `{summary: string}`
 * with `additionalProperties: false`, the gguf build answered `{"summary": "test"}` and the
 * safetensors build answered `{"plan": {"goal": …, "steps": […]}}`. Given Coda's real schema it
 * invented `{summary, steps}` — which is valid JSON, so nothing raised, and a plan with no
 * actions in it carried a confident sentence about what it had done.
 *
 * Hence a warning rather than a refusal: the model answers, and often in *nearly* the right
 * shape. It is `parsePlan` that catches the rest.
 */
const STRUCTURED_FORMAT = 'gguf'

interface ChatResponse {
  model?: string
  message?: { content?: string }
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

/** A pulled model's size on disk, which is the constraint that actually decides on a laptop. */
function sizeLabel(bytes: number | undefined): string {
  if (!bytes) return ''
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/**
 * The models pulled on this machine.
 *
 * Answers `[]` for an HTTP error and *raises* for an unreachable server, which is the same split
 * every call here makes: a server that answered and has nothing is a fact, and one that did not
 * answer is a failure. `verify` leans on that — it only names what is installed when the listing
 * actually arrived, or a stopped Ollama would be reported as a machine with no models on it.
 */
async function pulled(base: string, signal?: AbortSignal | undefined): Promise<PulledModel[]> {
  const { ok, payload } = await getJson(`${base}/api/tags`, {}, signal)
  if (!ok) return []
  const body = payload as TagsResponse
  return (body.models ?? [])
    .filter((m) => m.name)
    .map((m) => {
      const structured = (m.details?.format ?? STRUCTURED_FORMAT) === STRUCTURED_FORMAT
      const notes = [sizeLabel(m.size), structured ? '' : 'ignores JSON schema'].filter(Boolean)
      return {
        id: m.name!,
        label: notes.length ? `${m.name} — ${notes.join(' · ')}` : m.name!,
        structured,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export const ollama: AiProvider = {
  id: 'ollama',
  label: 'Ollama (local)',
  needsKey: false,
  note: 'A model on your own machine — no key, no account, nothing leaves the computer. Needs OLLAMA_ORIGINS set so the browser is allowed to call it, and a model with a large enough context for a ~13k-token prompt. A page served over https may be blocked from reaching a plain-http local server, so this is most reliable on a local dev server.',
  models: [
    { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
    { id: 'qwen2.5:14b', label: 'Qwen2.5 14B' },
    { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
    { id: 'mistral-nemo', label: 'Mistral Nemo' },
    { id: 'gemma2:9b', label: 'Gemma 2 9B' },
  ],
  defaultModel: 'qwen2.5-coder:14b',
  defaultBaseUrl: BASE_URL,
  editableBaseUrl: true,
  schemaSupport: 'native',

  async listModels({ baseUrl, signal }) {
    // Narrowed to the declared shape rather than handed back whole: `structured` is this
    // module's own bookkeeping, and a caller that started reading it would be depending on a
    // field the interface never promised.
    const found = await pulled(baseUrl || BASE_URL, signal)
    return found.map(({ id, label }) => ({ id, label }))
  },

  async verify({ model, baseUrl, signal }) {
    const base = baseUrl || BASE_URL
    const id = model || ollama.defaultModel
    const installed = await pulled(base, signal)
    const names = installed.map((m) => m.id)

    /*
     * "Not pulled" is the commonest local failure by a wide margin, and left to the chat
     * request it arrives as a 404 mentioning a manifest. Naming what *is* there turns it into
     * an instruction, and it is free — the listing has already been fetched.
     */
    if (names.length && !names.includes(id) && !names.some((n) => n.split(':')[0] === id)) {
      throw new AiError(
        `${id} is not pulled on this machine. Run \`ollama pull ${id}\`, or choose one you ` +
          `have: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}.`,
        404,
      )
    }
    /*
     * An unknown model is *not* reported as unstructured: it is one this listing never described,
     * so saying anything about its format would be a claim about a build nobody has seen. Same
     * unknown-is-not-empty rule the column pickers follow.
     */
    const chosen = installed.find((m) => m.id === id)
    return {
      model: id,
      label: names.length ? `${id} — ${names.length} models installed` : id,
      context: NUM_CTX,
      ...(chosen && !chosen.structured
        ? {
            warning:
              `${id} is not a GGUF build, so it runs on an engine that accepts the JSON schema ` +
              `and ignores it — plans may come back in the wrong shape. A GGUF build of the same ` +
              `model honours it.`,
          }
        : {}),
    }
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const base = request.baseUrl || BASE_URL
    const model = request.model || ollama.defaultModel

    const body = {
      model,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: false,
      // A JSON Schema here is grammar-constrained decoding rather than a request, which is the
      // single biggest thing a small local model needs help with. Needs a reasonably recent
      // Ollama; an older one rejects the object and says so.
      ...(request.schema ? { format: request.schema } : {}),
      options: { num_ctx: NUM_CTX },
    }

    const { status, ok, payload } = await postJson(`${base}/api/chat`, {}, body, request.signal)
    if (!ok) {
      const message = messageIn(payload, `Ollama returned ${status}.`)
      if (status === 404) {
        throw new AiError(
          `${message} — is the model pulled? Try \`ollama pull ${model}\`.`,
          404,
        )
      }
      throw new AiError(message, status)
    }

    const reply = payload as ChatResponse

    /*
     * The one provider where truncation is the *ordinary* case rather than the edge: the
     * context is fixed at `NUM_CTX` and the prompt is already ~13k tokens of it, so a long plan
     * runs out of room. Untreated it reaches `parsePlan` and is reported as "the reply was not
     * JSON", which sends somebody looking for a bug in the plan format.
     */
    if (reply.done_reason === 'length') truncated()

    const text = reply.message?.content ?? ''
    if (!text) noText('Ollama')

    return {
      text,
      model: reply.model ?? model,
      usage: {
        inputTokens: reply.prompt_eval_count ?? 0,
        outputTokens: reply.eval_count ?? 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    }
  },
}
