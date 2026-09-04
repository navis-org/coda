/**
 * What every AI provider agrees about, and nothing more.
 *
 * The seam is deliberately one function's worth: a system prompt, a conversation, an optional
 * schema, out a string. `assistant/converse.ts` has only ever called that much, which is why
 * adding providers is a matter of writing them rather than of rearranging anything above.
 *
 * Everything a provider disagrees about stays inside the provider: how it is authenticated,
 * what its JSON body looks like, how it reports usage, and — the one that costs real money —
 * whether it can be told to cache a prompt prefix at all.
 */

/**
 * Tokens, normalised. The cache fields are zero on providers that have no cache *control*.
 *
 * That is not the same as having no cache: OpenAI caches long prefixes automatically and simply
 * does not let a caller ask, and Gemini's caching is a separate API with its own lifetime. So a
 * zero here means "this provider does not report a decision we made", not "nothing was cached".
 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Tokens written to the cache this call. Anthropic only. */
  cacheWriteTokens: number
  /** Tokens served from the cache this call. Anthropic only. */
  cacheReadTokens: number
}

export interface CompletionRequest {
  /**
   * Stable prefix — the node catalogue and the rules.
   *
   * Byte-identical between calls, which is what lets a provider that supports prompt caching
   * mark it. A provider that cannot express a schema natively may append to it; that costs the
   * cache nothing, because such a provider has no cache to lose.
   */
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** JSON Schema the reply must satisfy. Omit for prose. */
  schema?: object | undefined
  /**
   * Whether the model should reason before answering, where the provider takes a switch for it.
   *
   * `undefined` leaves the model's own default alone, which is what a provider without
   * `thinkingSwitch` gets and what "on" means — see `AiProvider.thinkingSwitch` for why "on"
   * is an omission rather than a `true`.
   */
  think?: boolean | undefined
  signal?: AbortSignal | undefined
  /** Overrides the stored values. The Connections panel uses these to test a candidate key. */
  apiKey?: string | undefined
  model?: string | undefined
  baseUrl?: string | undefined
}

export interface CompletionResult {
  text: string
  model: string
  usage: Usage
}

/** What a successful key test found. `context` is 0 where a provider does not say. */
export interface KeyCheck {
  model: string
  label: string
  context: number
  /**
   * Something that will not stop the model answering but will change what comes back.
   *
   * Reported beside a *successful* check rather than as a failure, because the setting is
   * usable and the caveat is about quality. A refusal here would block a configuration that
   * works.
   */
  warning?: string
}

/**
 * Every failure from any provider, carrying the HTTP status where there was one.
 *
 * One class rather than one per provider: nothing downstream branches on which service failed
 * — the panel shows the message and the auth channel opens the right tab — so a hierarchy would
 * be types nobody reads. `status` is 0 for a request that never reached a server.
 */
export class AiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

export interface ModelOption {
  id: string
  label: string
}

/**
 * One service the assistant can talk to.
 *
 * A plain object rather than a class: there is no per-instance state — the key and the model
 * are looked up per call, because the Connections panel has to be able to test a candidate key
 * without storing it first.
 */
export interface AiProvider {
  id: string
  label: string
  /** Where a key comes from. Absent for a provider that needs none. */
  keyUrl?: string
  /**
   * Where the setup is written down, for a provider whose setup is more than pasting a key.
   *
   * Only Ollama, and the note alone is why: installing a runtime, picking a model by its context
   * window, and letting the browser through takes a page, not the two sentences a panel has room
   * for. A link is the honest form of that — the alternative is a note that gets longer every
   * time somebody hits a new way for it not to work.
   */
  guideUrl?: string
  /** False for a local provider. Governs whether the panel demands a key before enabling Ask. */
  needsKey: boolean
  /** Shown under the key field: what this provider is, and anything it needs set up. */
  note: string
  /**
   * The models this provider is *offered* with — a curated shortlist, not an inventory.
   *
   * For a cloud provider that is the whole truth, because the catalogue is the same for
   * everybody. For a local one it is a guess about somebody else's machine, which is what
   * `listModels` exists to correct.
   */
  models: readonly ModelOption[]
  defaultModel: string
  defaultBaseUrl: string
  /** True where the endpoint is the user's to choose — a local server on another port. */
  editableBaseUrl?: boolean
  /**
   * True where reasoning is a per-request switch the user should be offered.
   *
   * Only Ollama, and it is a *speed* control rather than a quality one, which is why it is
   * offered at all. Measured on one machine, same question, warm model: `qwen3.8:latest`
   * answered in **254 s** with reasoning and **49 s** without — 75% of the wait was 6k
   * characters of thinking nobody reads. Both plans applied, and the shorter run was the better
   * graph of the two, which is a tie at n=1 rather than a win.
   *
   * The cloud providers have reasoning too and are deliberately not wired to this: Anthropic's
   * is adaptive and inside a `max_tokens` this file already sets, and none of them is where the
   * minutes go.
   */
  thinkingSwitch?: boolean
  /**
   * What is *actually* available, asked of the provider.
   *
   * Optional, and deliberately so: it is for a provider whose real list is a fact about the
   * user's own setup rather than about the service. Ollama is the case — `models` above can only
   * ever be a guess at what somebody has pulled, and being wrong about it is not cosmetic, since
   * every name in the dropdown reads as one you can pick. The cloud providers implement nothing
   * here because their shortlist is already right, and their own `/models` endpoints answer with
   * hundreds of entries — embeddings, transcription, retired snapshots — that would have to be
   * filtered back down to roughly the list already declared above.
   *
   * Throws like everything else here: an unreachable server raises, an HTTP error raises. An
   * empty array means the provider answered and has nothing, which is a different fact.
   */
  listModels?(options: {
    apiKey?: string | undefined
    baseUrl?: string | undefined
    signal?: AbortSignal | undefined
  }): Promise<readonly ModelOption[]>
  complete(request: CompletionRequest): Promise<CompletionResult>
  /** Confirm a key and a model without spending anything, where the provider allows it. */
  verify(options: {
    apiKey?: string | undefined
    model?: string | undefined
    baseUrl?: string | undefined
    signal?: AbortSignal | undefined
  }): Promise<KeyCheck>
}
