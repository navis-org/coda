/**
 * Ollama — a model running on the user's own machine.
 *
 * The only provider here that needs no key and sends nothing anywhere. It is also the only one
 * that can fail for reasons outside this app entirely, so three of them are handled explicitly
 * rather than left to arrive as a bare "could not reach".
 *
 * **The context window is the one that fails silently, so it is set here.** Ollama's default
 * `num_ctx` is a few thousand tokens and the catalogue alone is ~9k, ~10k with the plan schema
 * and more once the canvas is described: left alone, the prompt is *quietly truncated* from the
 * front and the model answers confidently about a node list it was never shown. That is the worst failure available — no error, a plausible wrong plan — so
 * `num_ctx` is sent on every request. A model whose trained context is smaller will clamp, and
 * the effect is the same, which is why `verify` says what the request is going to ask for and
 * why `pulled` reads each model's own window back out of `/api/tags`.
 *
 * **The model list is asked for, not declared.** `models` below is a shortlist of reasonable
 * things to pull; what is *on the machine* is whatever the user ran `ollama pull` for, and no
 * list written here can know it. Left as the only source, every name in the dropdown reads as a
 * model you can pick and none of them may be — reported from a real install whose two models
 * appeared nowhere in the five offered. `listModels` reads `/api/tags`, which `verify` was
 * already reading to name what is installed when a chat 404s.
 *
 * **Reasoning is off by default, and that is a speed decision.** A thinking model spends most
 * of the wait on it: `qwen3.8:latest` answered the same question in 254 s with reasoning and
 * 49 s without, on a warm model — 6k characters of thinking against a 1.6k-character plan.
 * Both applied. `thinkingSwitch` is what puts the choice in Connections; `complete` below has
 * the asymmetry it has to be sent with.
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
 * Room for the prompt and a plan on top of it.
 *
 * **Measured, not estimated, and it moved.** This was 16384 while the catalogue was ~13k
 * tokens. It is not any more: `buildSystemPrompt()` is 65,076 characters, and Ollama counted
 * `prompt_eval_count: 16587` for it against an *empty canvas* — 17,687 once the plan schema
 * goes on as `format`. Every assistant request therefore overran the window it asked for
 * before the user had put a single node down.
 *
 * That does not degrade the way the header above describes. Ollama truncates the overflow from
 * the front, the *user turn* is what falls off the end, and its structured-output path then
 * rejects a conversation with no user query left in it — a 500 reading `no user query found in
 * messages`, arriving four minutes later because the prompt is evaluated first. `overflowed`
 * below is that failure named; this number is it fixed. The same request at 32768 answered
 * with a plan that applied.
 *
 * Costs a laptop a 32k KV cache, which is the trade being made knowingly: below ~20k there is
 * no room to answer in, and a window that cannot hold the question is not a cheaper setting.
 *
 * **It stays 32768 even though the catalogue since halved, and that is the second measurement.**
 * The `lean` catalogue took the prompt to 9,167 tokens, which looked like it bought 16384 back
 * and a laptop half its KV cache. It does not: the prompt is only the fixed part. On a 37-node
 * canvas `describeGraph` adds 6,558 characters and the plan schema 2,681, for 42,015 in total —
 * ~12k tokens before the model has written a word, and a plan for a graph that size is a
 * thousand or two more. 16384 would leave about 2k of headroom on a canvas people will
 * reasonably build, and the failure when it runs out is `overflowed` below: minutes of prompt
 * evaluation, then a 500 that reads as a hang.
 *
 * Nor can the window follow the canvas. Ollama reloads the model when `num_ctx` changes, which
 * discards the KV prefix — the thing that takes a session's first question from 120 s to 4.4 s.
 * A window that tracked the graph would re-pay that on every resize. Fixed and generous is the
 * setting that costs memory once instead of time repeatedly.
 */
const NUM_CTX = 32768

interface TagsResponse {
  models?: Array<{
    name?: string
    size?: number
    details?: { format?: string; context_length?: number }
  }>
}

/** What `pulled` knows about a model beyond its name. */
interface PulledModel extends ModelOption {
  /** Whether `format` is likely to be honoured — see `STRUCTURED_FORMAT`. */
  structured: boolean
  /**
   * The window the model was *trained* with, as `/api/tags` reports it, or 0 where it does not.
   *
   * Zero is "not said", never "small": older Ollama builds omit the field entirely, and marking
   * every model on one as too small would be a claim about a build nobody has seen — the same
   * unknown-is-not-empty rule `structured` follows two lines up.
   */
  context: number
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

/**
 * The prompt did not fit, said as the thing the user can act on.
 *
 * Ollama's own words for this are `no user query found in messages`, HTTP 500 — which describes
 * the *last* step of the failure and none of the ones that matter. What happened: the prompt
 * exceeded the window, Ollama truncated it from the front, the user's turn was what fell off,
 * and the structured-output path then found a conversation with nothing to answer. Worse, the
 * prompt is evaluated before any of that, so the 500 lands minutes later and reads as a hang.
 *
 * Keyed on the message rather than on the status, because 500 is also what a crashed runner
 * and an out-of-memory load return, and neither is fixed by pulling a bigger model.
 */
function overflowed(model: string): never {
  throw new AiError(
    `The prompt did not fit ${model}'s context window. Ollama truncated it from the front until ` +
      `the question itself was gone, then refused what was left. Coda asks for ` +
      `${NUM_CTX / 1024}k tokens and sends ~10k of prompt before your canvas is described, but ` +
      `a model clamps to the window it ` +
      `was trained with — check that with \`ollama show ${model}\`, and pick one offering at ` +
      `least ${NUM_CTX / 1024}k.`,
    500,
  )
}

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
 * A window smaller than the one every request asks for, said in the dropdown.
 *
 * Only when it is *too small*. A model with room to spare gets no note, because the number
 * that matters to somebody choosing from this list is the one that rules a model out — printing
 * `262k window` beside the six that are fine is six lines of reassurance hiding the one refusal.
 */
function contextNote(context: number): string {
  if (!context || context >= NUM_CTX) return ''
  return `${Math.round(context / 1024)}k window — too small for Coda's prompt`
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
      const context = m.details?.context_length ?? 0
      const notes = [
        sizeLabel(m.size),
        contextNote(context),
        structured ? '' : 'ignores JSON schema',
      ].filter(Boolean)
      return {
        id: m.name!,
        label: notes.length ? `${m.name} — ${notes.join(' · ')}` : m.name!,
        structured,
        context,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export const ollama: AiProvider = {
  id: 'ollama',
  label: 'Ollama (local)',
  needsKey: false,
  /*
   * Corrected once measured: this used to say OLLAMA_ORIGINS is needed, flatly. Ollama allows
   * `http://localhost:*` whatever is configured, so a locally served Coda needs nothing — and
   * telling somebody on a dev server to go and set an environment variable sends them to fix
   * the one thing that was never broken. It is the hosted origin that has to be named.
   */
  note: 'A model on your own machine — no key, no account, nothing leaves the computer. Needs a model with a context window of at least 32k: the prompt is ~10k tokens before your canvas is described, and grows with it. Served from localhost this works as it stands; the hosted app additionally needs OLLAMA_ORIGINS set so the browser is allowed to call it, and some browsers block an https page from reaching a plain-http local server at all.',
  guideUrl: 'https://github.com/navis-org/coda/blob/main/docs/ollama.md',
  models: [
    { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
    { id: 'qwen2.5:14b', label: 'Qwen2.5 14B' },
    { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
    { id: 'mistral-nemo', label: 'Mistral Nemo' },
    // No `gemma2:9b`. It was offered here while the prompt was ~13k tokens and its 8k window
    // merely truncated it; against ~10k and a canvas on top the request cannot be served at
    // all, so listing it under "Available to pull" would be offering a model that answers
    // nothing.
  ],
  defaultModel: 'qwen2.5-coder:14b',
  defaultBaseUrl: BASE_URL,
  editableBaseUrl: true,
  thinkingSwitch: true,
  schemaSupport: 'native',

  async listModels({ baseUrl, signal }) {
    // Narrowed to the declared shape rather than handed back whole: `structured` and `context`
    // are this module's own bookkeeping, and a caller that started reading them would be
    // depending on fields the interface never promised.
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

    /*
     * Two caveats, and a model can carry both — an MLX build with a small window is one pull,
     * not two. Joined rather than ranked: `KeyCheck.warning` is one string because the panel
     * prints one line, and dropping the second would make Test say the setting is fine in the
     * respect it happens to check first.
     */
    const warnings: string[] = []
    if (chosen && !chosen.structured) {
      warnings.push(
        `${id} is not a GGUF build, so it runs on an engine that accepts the JSON schema ` +
          `and ignores it — plans may come back in the wrong shape. A GGUF build of the same ` +
          `model honours it.`,
      )
    }
    /*
     * The failure this catches used to arrive as a four-minute stall — see `NUM_CTX`. Ollama
     * clamps `num_ctx` to the window the model was trained with, and a prompt that does not fit
     * has its user turn truncated away, so the request 500s after the whole prompt has been
     * evaluated. `/api/tags` has said so all along; nothing was reading it.
     */
    if (chosen && contextNote(chosen.context)) {
      warnings.push(
        `${id} was trained with a ${Math.round(chosen.context / 1024)}k context window and ` +
          `Coda's prompt is ~10k tokens before the canvas is described, so Ollama will clamp ` +
          `the request and the prompt will ` +
          `not fit. Asking will fail rather than answer badly. Pull a model with at least ` +
          `${NUM_CTX / 1024}k.`,
      )
    }

    return {
      model: id,
      label: names.length ? `${id} — ${names.length} models installed` : id,
      context: NUM_CTX,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
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
      /*
       * Off is a `false`; on is *silence*. Not symmetry for its own sake — measured: Ollama
       * accepts `think: false` from any model and answers normally, and rejects `think: true`
       * from one without the capability with `"qwen2.5:0.5b" does not support thinking`, HTTP
       * 400. Coda's own default model is such a model, so sending `true` to honour a checkbox
       * would break the default setup for everyone who ticked it. Omitting leaves the model's
       * own behaviour, which is what "on" means anyway.
       */
      ...(request.think === false ? { think: false } : {}),
      options: { num_ctx: NUM_CTX },
    }

    const { status, ok, payload } = await postJson(`${base}/api/chat`, {}, body, request.signal)
    if (!ok) {
      const message = messageIn(payload, `Ollama returned ${status}.`)
      if (/no user query found in messages/i.test(message)) overflowed(model)
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
     * context is fixed at `NUM_CTX` and a large canvas already spends ~12k of it, so a long plan
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
