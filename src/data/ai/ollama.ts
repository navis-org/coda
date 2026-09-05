/**
 * Ollama — the server on the user's own machine, and the cloud models it fronts.
 *
 * The only provider here that needs no key. It is also the only one that can fail for reasons
 * outside this app entirely, so several of them are handled explicitly rather than left to
 * arrive as a bare "could not reach".
 *
 * **A `-cloud` model is the same transport and a different promise.** Ollama runs big models on
 * ollama.com and serves them through the *local* server: `ollama signin`, then
 * `gemma4:31b-cloud` answers on `localhost:11434` exactly like a local pull. So there is no
 * second endpoint here and there must not be one — the direct API at `https://ollama.com/api/chat`
 * sends **no CORS headers at all** and answers a preflight with 405, which makes it unreachable
 * from a browser and therefore unreachable from Coda, whose whole `data/ai` layer is arranged
 * around needing no proxy. What does change is what the user is promised: a cloud model needs an
 * ollama.com account, and the question and the graph leave the machine. `label`, `note` and the
 * Connections privacy line all say both halves now, because a provider called "local" that can
 * be pointed at somebody else's servers is the kind of wrong nobody checks.
 *
 * **The suffix is load-bearing, not decoration.** `gpt-oss:120b-cloud` resolves and
 * `gpt-oss:120b` answers `model 'gpt-oss:120b' not found` — the local router requires it. That
 * makes the *name* a free and reliable answer to "is this running here?", which is what
 * `isCloudModel` leans on and why nothing has to fetch anything to find out.
 *
 * **A cloud model accepts the JSON schema and ignores it**, which is the failure this file
 * already knew in another costume — see `STRUCTURED_FORMAT`, written for MLX builds. Measured
 * the same way, on the same machine: asked for `{summary, count}`, `gemma4:31b-cloud` and
 * `gpt-oss:120b-cloud` both answered prose, while a GGUF build answered the schema exactly. It
 * is the cloud engine rather than any one model. Left alone that took Coda's own live suite to
 * **4 of 5 failing**. The remedy is Gemini's — describe the schema in the prompt — and it is
 * decisive: on the real Coda prompt, five reps each, `format` alone parsed **1/5** and the
 * description parsed and applied **5/5**. `format` is still sent alongside, which costs nothing
 * on an engine that ignores it and means a build that starts honouring it is simply better.
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
 * **The cloud half of that list is declared, and it has to be.** `/api/tags` returns a cloud
 * model once it has been pulled — a 312-byte pointer, no weights — so a user who has one is
 * already offered it by the paragraph above, with no help from `models`. What cannot be asked
 * for is the *catalogue*: `https://ollama.com/api/tags` publishes it without a key, and sends
 * no CORS headers, so a browser cannot read it. A shortlist under "Available to pull" is
 * therefore the only way a cloud model is ever discovered by somebody who does not already know
 * its name, and going stale is the price. Being stale is survivable here in a way it is not for
 * the local list: every entry is one `ollama pull` from being true, and the *installed* half is
 * still asked for.
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

import { getJson, messageIn, noText, postJson, truncated, withSchema } from './http'
import type { AiProvider, CompletionRequest, CompletionResult, ModelOption } from './types'
import { AiError } from './types'

const BASE_URL = 'http://localhost:11434'

/**
 * Does this name run on ollama.com rather than here?
 *
 * The suffix is the router's own requirement rather than a convention somebody could drop —
 * `gpt-oss:120b-cloud` resolves and `gpt-oss:120b` answers `model not found` — so this is a
 * fact about the request, not a guess about the weights. Which is what lets every caller below
 * answer without fetching anything, including `complete`, on a decision it has to make before
 * every single request.
 */
function isCloudModel(model: string): boolean {
  return /-cloud$/.test(model)
}

/**
 * Will `format` be applied, or accepted and ignored?
 *
 * Two ways to be ignored and they are known with different confidence, which is the whole
 * reason this reads names rather than the listing. A **`-cloud`** model is certain: it does not
 * execute here at all, and the suffix is mandatory. An **`-mlx`** build is a convention — the
 * tag Ollama's own library uses for the MLX build beside the GGUF one — so this is a good guess
 * where the other is a fact. Getting the guess wrong costs a redundant paragraph in the prompt
 * and nothing else, because `format` is sent either way.
 *
 * Deliberately **not** read off `/api/tags`, though `pulled` below extracts exactly this from
 * `details.format` and is more accurate for the MLX case. Two reasons. `complete` would have to
 * fetch the listing before every request — a second round trip, a second way to fail, and a
 * second answer for a model that is *not listed at all*, which a cloud model is until somebody
 * pulls it and which it still answers perfectly well as. And it would make one request into two,
 * which is the sort of change that quietly turns a stubbed `calls[0]` into the wrong call in
 * every test that asserts on a request body.
 *
 * Measured, five reps each on Coda's real prompt against `gemma4:31b-cloud`: `format` alone
 * parsed 1/5; described in the prompt, 5/5, applying a six-node graph each time. The same
 * remedy on a local MLX build parsed 8/8 against a documented "pull the plain tag instead".
 */
/**
 * What a cloud model's row says instead of a size, and the only copy of it.
 *
 * Shared by the models `/api/tags` reports and the shortlist declared below, which is the point:
 * the same model reads the same way whether or not it has been pulled. It is also the disclosure
 * itself — the row is the one surface that is unconditional, per-model, and in front of somebody
 * at the moment they choose — so `verify` deliberately does not repeat it. See the note there.
 */
const CLOUD_NOTE = 'cloud · runs on ollama.com'

function ignoresSchemaField(model: string): boolean {
  return isCloudModel(model) || /-mlx$/.test(model)
}

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
        /*
         * Where it runs, or how big it is — never both, because for a cloud model the second is
         * a lie told in a plausible unit. `/api/tags` reports a pulled cloud model at **312
         * bytes**: it is a pointer, not weights, and `sizeLabel` renders that as `0 MB`, which
         * reads as a broken download rather than as a model that lives somewhere else.
         */
        isCloudModel(m.name!) ? CLOUD_NOTE : sizeLabel(m.size),
        contextNote(context),
        /*
         * Only where the engine will not apply the schema *and* Coda is not already making up
         * for it. A cloud or MLX build gets the schema described in the prompt
         * (`ignoresSchemaField`), which measured 5/5 and 8/8 — so marking it here would be
         * warning about a problem this file fixes two functions up. What is left is the case
         * neither knows how to reach: a build the listing calls unstructured under a name that
         * says nothing about it.
         */
        structured || ignoresSchemaField(m.name!) ? '' : 'ignores JSON schema',
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

/** What `/api/me` says, of which only these two are ever shown. */
interface Account {
  name?: string
  plan?: string
}

/**
 * Who the local server is signed in to ollama.com as, or nothing.
 *
 * `POST /api/me` — the local server's own endpoint, and one of the few that answers a browser
 * with `Access-Control-Allow-Origin`, so this is askable from the page rather than only from a
 * terminal. It also returns the account's email, which nothing here reads: the question is
 * whether a cloud request will be accepted, and an address is not part of that answer.
 *
 * Never raises. A machine that is not signed in and a machine whose Ollama is too old to have
 * the endpoint are the same fact for the one caller — a cloud model is not going to work — and
 * the caller's own message covers both. An unreachable server still raises from `postJson`,
 * which is the one failure that is genuinely about something else.
 */
async function account(
  base: string,
  signal?: AbortSignal | undefined,
): Promise<Account | undefined> {
  const { ok, payload } = await postJson(`${base}/api/me`, {}, {}, signal)
  if (!ok) return undefined
  const body = payload as Account
  return body.name ? body : undefined
}

export const ollama: AiProvider = {
  id: 'ollama',
  /*
   * No longer "(local)". The parenthesis was the whole claim — it is what a reader checks
   * against the privacy note — and it stopped being true for every name in this list the
   * moment a `-cloud` model could be picked from it. The distinction did not disappear, it
   * moved to where it now varies: the model row, which says `cloud · runs on ollama.com`.
   */
  label: 'Ollama',
  needsKey: false,
  /*
   * Corrected once measured: this used to say OLLAMA_ORIGINS is needed, flatly. Ollama allows
   * `http://localhost:*` whatever is configured, so a locally served Coda needs nothing — and
   * telling somebody on a dev server to go and set an environment variable sends them to fix
   * the one thing that was never broken. It is the hosted origin that has to be named.
   */
  note: "Your own Ollama server, at localhost. A model on this machine needs no key and no account, and nothing leaves the computer — pick one with a context window of at least 32k, since the prompt is ~10k tokens before your canvas is described. Names ending -cloud are different: they run on Ollama's servers, so they need a free ollama.com account (`ollama signin`) and your question and graph are sent there, but they need no GPU of your own. Served from localhost this works as it stands; the hosted app additionally needs OLLAMA_ORIGINS set so the browser is allowed to call it, and some browsers block an https page from reaching a plain-http local server at all.",
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
    /*
     * The cloud shortlist. Bigger than anything above by two orders of magnitude and it costs a
     * laptop nothing, which is the point of offering them at all: the local list asks somebody
     * to have 16 GB of RAM free and these do not.
     *
     * Declared rather than asked for, because the catalogue at `ollama.com/api/tags` sends no
     * CORS headers — see the header. So this list is a snapshot and will go stale; each entry is
     * one `ollama pull` from being true, and anything already pulled arrives from `/api/tags`
     * under "On this machine" whether or not it is named here.
     *
     * **Every one of these was run on a free account, and that is the entry condition.** The
     * published catalogue is not the offer: of nine names tried through the local router, two
     * answered **402** (`qwen3.5:397b-cloud`, `deepseek-v4-flash:0731-cloud` — "requires a
     * subscription") and four answered **404** despite being listed at `ollama.com/api/tags`
     * (`kimi-k2.6-cloud`, `minimax-m2.7-cloud`, `glm-5.3-flash-cloud`, `nemotron-3-super-cloud`),
     * which is the router serving a narrower set than the site publishes. A dropdown entry that
     * cannot answer is worse than an absent one — it reads as Coda being broken — so a name goes
     * in here only after it has replied. All three then went through `assistant/live.test.ts`
     * whole: **5/5 each**, at 16 s, 41 s and 90 s for the five cases — against 14-83 s for a
     * *single* question on a local 27B model, which is why these are not merely a fallback for a
     * small laptop. Ordered by that, fastest first; the provider's `defaultModel` stays local,
     * because what this provider is mostly for has not changed.
     */
    { id: 'gemma4:31b-cloud', label: `Gemma 4 31B — ${CLOUD_NOTE}` },
    { id: 'gpt-oss:120b-cloud', label: `GPT-OSS 120B — ${CLOUD_NOTE}` },
    { id: 'gpt-oss:20b-cloud', label: `GPT-OSS 20B — ${CLOUD_NOTE}` },
  ],
  defaultModel: 'qwen2.5-coder:14b',
  defaultBaseUrl: BASE_URL,
  editableBaseUrl: true,
  thinkingSwitch: true,

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

    /*
     * A cloud model is asked a different question, because the local one has no answer for it.
     *
     * "Is it pulled?" is not the constraint: a cloud model answers perfectly well unpulled —
     * measured, `gemma4:31b-cloud` chatted before any `ollama pull` — so the check below would
     * fail a setting that works. What can actually be wrong is the account, and there is no way
     * to find that out from the model list. `/api/me` is the endpoint that knows, it is on the
     * local server, and it is CORS-enabled for a browser origin, so Test can simply ask.
     */
    if (isCloudModel(id)) {
      const who = await account(base, signal)
      if (!who) {
        throw new AiError(
          `${id} runs on ollama.com, and this machine is not signed in. Run \`ollama signin\` ` +
            `in a terminal — it is free and takes one browser round trip — then press Test again.`,
          401,
        )
      }
      /*
       * No `warning`, deliberately. That field is contracted as a *quality* caveat — "will not
       * stop the model answering but will change what comes back" — and where the question and
       * the graph go is not that. Three things were wrong with putting it there: it renders in
       * the amber `warn` tone, so a disclosure was styled as a defect; it only appears if
       * somebody presses Test, which is optional, and this panel's own privacy note already
       * says "a consent line behind a tooltip is not a consent line"; and it was a fourth copy
       * of a sentence that has to stay in step. It lives on the model row instead
       * (`CLOUD_NOTE`), which is unconditional and is read at the moment the choice is made.
       */
      return {
        model: id,
        // The account *name*, never the email `/api/me` also returns: naming somebody's address
        // back at them in a settings panel is a disclosure nobody asked this button for.
        label: `${id} — signed in as ${who.name}${who.plan ? `, ${who.plan} plan` : ''}`,
        context: NUM_CTX,
      }
    }

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
    // Not where Coda already compensates: an `-mlx` tag gets the schema described in the prompt
    // instead, which measured 8/8 against the "plans come back in the wrong shape" this warns
    // about. What is left is a build the listing calls unstructured under a name that does not
    // say so, where nothing has made up for it and the caveat is still true.
    if (chosen && !chosen.structured && !ignoresSchemaField(id)) {
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
        {
          role: 'system',
          /*
           * Described in words only where the field will not be honoured — see
           * `ignoresSchemaField`. A GGUF build gets the prompt it has always had, because
           * grammar-constrained decoding is exact and the description would be 632 tokens
           * saying so again; a cloud or MLX model gets it because otherwise four plans in five
           * come back in a shape `parsePlan` cannot read.
           *
           * Constant per model, so the prefix stays byte-identical between turns and llama.cpp
           * still reuses the KV cache — the thing that takes a session's second question from
           * 120 s to 4.4 s. Switching model re-prefills anyway.
           */
          content: ignoresSchemaField(model)
            ? withSchema(request.system, request.schema)
            : request.system,
        },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: false,
      /*
       * A JSON Schema here is grammar-constrained decoding rather than a request, which is the
       * single biggest thing a small local model needs help with. Needs a reasonably recent
       * Ollama; an older one rejects the object and says so.
       *
       * Sent even to a model known to ignore it, and that is not belt-and-braces: an engine
       * that ignores it costs nothing to send it to (measured — `prompt_eval_count` is
       * identical with and without), and a build that starts honouring it then simply gets the
       * better path with no release of ours in between.
       */
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
      /*
       * A rejected cloud request is about an account, not a key, and the panel has no key field
       * to point at — `needsKey` is false. Left untranslated it arrives as a bare `Unauthorized`
       * from a server running on the user's own machine, which reads as a local permissions
       * problem. Kept as a 401 so `registry.complete` still raises the auth channel and opens
       * the section where the sentence below is repeated.
       */
      if (isCloudModel(model) && (status === 401 || status === 403)) {
        throw new AiError(
          `${model} runs on ollama.com and this machine is not signed in to an account that ` +
            `may use it. Run \`ollama signin\`, or pick a model that runs locally. (${message})`,
          status,
        )
      }
      /*
       * 402, which no other provider here uses and which is not a failure of anybody's setup:
       * the account is fine and this particular model is not included in it. Ollama's own text
       * already names the upgrade page, so this adds only the part it cannot know — that
       * picking a different model is a real option, because three of them are free.
       */
      if (status === 402) {
        throw new AiError(
          `${model} is not included in this ollama.com account. ${message} Or pick one of the ` +
            `free cloud models, or a model that runs locally.`,
          402,
        )
      }
      if (status === 404) {
        throw new AiError(
          isCloudModel(model)
            ? `${message} — cloud models are served by name and this one is not among them, ` +
                `whatever ollama.com may list. Pick another from the dropdown.`
            : `${message} — is the model pulled? Try \`ollama pull ${model}\`.`,
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
