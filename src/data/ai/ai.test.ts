// @vitest-environment jsdom

/**
 * The providers, against a stubbed `fetch`.
 *
 * The network itself is not covered and cannot be — same standing as `neuprint.test.ts`. What
 * *is* covered is every decision each provider makes about a request or a response, because
 * each one is a place where the obvious reading produces a confident wrong answer: Anthropic
 * puts a refusal in a 200, Gemini puts a rejected key in a 400, OpenAI hides a truncation in
 * `finish_reason`, and Ollama will quietly cut the prompt in half if nobody sets `num_ctx`.
 *
 * The CORS reachability of all four was verified by hand against the live endpoints. Whether
 * their *plans* are any good is `assistant/live.test.ts`, and only Anthropic has been measured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStorageStub } from '../../test/jsdomStubs'
import { anthropic } from './anthropic'
import {
  getBaseUrl,
  getKey,
  getModel,
  getProviderId,
  isConfigured,
  resetCredentials,
  setBaseUrl,
  setKey,
  setModel,
  setProviderId,
  setThinking,
  subscribeAuthFailure,
} from './credentials'
import type { StubbedCall } from './fixture'
import { messagesReply, stubFetch } from './fixture'
import { gemini } from './gemini'
import { ollama } from './ollama'
import { openai } from './openai'
import { PROVIDERS, complete, providerFor } from './registry'
import { AiError } from './types'

let calls: StubbedCall[] = []

function respond(body: unknown, status = 200): void {
  calls = stubFetch((name, value) => vi.stubGlobal(name, vi.fn(value as never)), body, status)
}

const ASK = { system: 'the catalogue', messages: [{ role: 'user' as const, content: 'hi' }] }

beforeEach(() => {
  installStorageStub()
  resetCredentials()
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('choosing a provider', () => {
  it('offers Anthropic, OpenAI, Gemini and Ollama, and defaults to Anthropic', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'gemini', 'ollama'])
    expect(getProviderId()).toBe('anthropic')
  })

  it('keeps a key per provider, so trying another and coming back costs nothing', () => {
    // A settings panel that forgets what you pasted is one nobody experiments in.
    setKey('anthropic', 'sk-ant-1')
    setKey('openai', 'sk-oai-2')
    setProviderId('openai')

    expect(getKey()).toBe('sk-oai-2')
    setProviderId('anthropic')
    expect(getKey()).toBe('sk-ant-1')
  })

  it('keeps a model per provider, since an id from one is meaningless to another', () => {
    setModel('openai', 'gpt-4o-mini')
    expect(getModel('openai')).toBe('gpt-4o-mini')
    // Untouched providers keep their own default rather than inheriting a foreign id.
    expect(getModel('anthropic')).toBe(anthropic.defaultModel)
  })

  it('falls back to Anthropic for a provider id this build does not have', () => {
    // A value written by a later build, or by hand. Silently answering "no provider" would
    // disable the assistant with nothing on screen explaining why.
    setProviderId('some-future-service')
    expect(getProviderId()).toBe('anthropic')
  })

  it('carries a key forward from before providers existed', () => {
    resetCredentials()
    localStorage.setItem('coda.anthropic.key', 'sk-ant-legacy')
    // A fresh module read, as a reload would do.
    setProviderId('anthropic')
    expect(getKey('anthropic')).toBe('sk-ant-legacy')
  })

  it('counts a local provider as configured with no key at all', () => {
    setProviderId('ollama')
    expect(isConfigured()).toBe(true)

    setProviderId('openai')
    expect(isConfigured()).toBe(false)
    setKey('openai', 'sk-oai')
    expect(isConfigured()).toBe(true)
  })

  it('remembers a server only where the endpoint is the user’s to choose', () => {
    setBaseUrl('ollama', 'http://192.168.1.10:11434/')
    // Trailing slash stripped, so joining a path stays a plain concatenation.
    expect(getBaseUrl('ollama')).toBe('http://192.168.1.10:11434')
    expect(getBaseUrl('anthropic')).toBe(anthropic.defaultBaseUrl)
  })
})

describe('routing a request', () => {
  it('sends it to whichever provider is selected', async () => {
    setProviderId('openai')
    setKey('openai', 'sk-oai')
    respond({ choices: [{ message: { content: '{}' } }] })

    await complete(ASK)
    expect(calls[0]!.url).toContain('api.openai.com')
  })

  it('refuses without a key, names the provider, and opens the panel', async () => {
    setProviderId('gemini')
    const seen: string[] = []
    const stop = subscribeAuthFailure((m) => seen.push(m))

    await expect(complete(ASK)).rejects.toThrow(/Google Gemini API key/)
    // The panel opens off the channel, not off the error text — matching neuPrint's 401 path.
    expect(seen).toHaveLength(1)
    stop()
  })

  it('raises the auth channel once, wherever the rejection came from', async () => {
    // Each provider only has to get its *status* right; the channel is fired in one place.
    setProviderId('openai')
    setKey('openai', 'sk-bad')
    const seen: string[] = []
    const stop = subscribeAuthFailure((m) => seen.push(m))
    respond({ error: { message: 'Incorrect API key provided' } }, 401)

    await expect(complete(ASK)).rejects.toBeInstanceOf(AiError)
    expect(seen).toHaveLength(1)
    stop()
  })
})

describe('Anthropic', () => {
  const ask = { ...ASK, apiKey: 'sk-ant', model: 'claude-sonnet-5' }

  it('carries the key, the version and the direct-browser-access opt-in', async () => {
    respond(messagesReply('{}'))
    await anthropic.complete(ask)

    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant')
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
    // Without this the call is not a supported one, however well the preflight goes.
    expect(calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })

  it('marks the prompt and the last turn as cacheable, for an hour', async () => {
    /*
     * The only provider here with cache *control*, and it is most of what it costs to run: at
     * the default five-minute TTL a panel a person thinks in front of pays the write again on
     * most turns, which is worse than not caching at all.
     */
    respond(messagesReply('{}'))
    await anthropic.complete({
      ...ask,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    })

    const body = calls[0]!.body as {
      system: Array<{ cache_control?: unknown }>
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>
    }
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[2]!.content[0]!.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  it('reads the text past the empty thinking block', async () => {
    // Thinking is on by default and its text is empty under the default display, so taking the
    // first block yields "" and blames the JSON parser for the wrong thing.
    respond(messagesReply('{"summary":"ok"}'))
    expect((await anthropic.complete(ask)).text).toBe('{"summary":"ok"}')
  })

  it('treats a refusal as a verdict, not as a transport failure', async () => {
    respond({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })
    await expect(anthropic.complete(ask)).rejects.toThrow(/declined/i)
  })

  it('says a truncated reply is truncated', async () => {
    respond({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"sum' }] })
    await expect(anthropic.complete(ask)).rejects.toThrow(/length limit/i)
  })

  it('checks a key without spending a token', async () => {
    respond({
      id: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      max_input_tokens: 1000000,
    })
    const check = await anthropic.verify({ apiKey: 'sk-ant', model: 'claude-sonnet-5' })

    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toContain('/v1/models/claude-sonnet-5')
    expect(check.context).toBe(1000000)
  })
})

describe('OpenAI', () => {
  const ask = { ...ASK, apiKey: 'sk-oai', model: 'gpt-4o' }

  it('authenticates with a bearer token and folds the prompt into a system message', async () => {
    respond({ choices: [{ message: { content: '{}' } }] })
    await openai.complete(ask)

    expect(calls[0]!.headers.authorization).toBe('Bearer sk-oai')
    const body = calls[0]!.body as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'the catalogue' })
  })

  it('sends the schema in strict mode, which our schema already satisfies', async () => {
    // `planJsonSchema` marks every property required and every object closed because
    // *Anthropic* demanded it; those happen to be exactly OpenAI's two strict-mode rules.
    respond({ choices: [{ message: { content: '{}' } }] })
    await openai.complete({ ...ask, schema: { type: 'object', additionalProperties: false } })

    const body = calls[0]!.body as { response_format?: { json_schema?: { strict?: boolean } } }
    expect(body.response_format?.json_schema?.strict).toBe(true)
  })

  it('catches a truncation hidden in finish_reason', async () => {
    // A 200 whose JSON is half-written. Left to the parser it reads as a bug in the plan
    // format rather than as a reply that was cut off.
    respond({ choices: [{ message: { content: '{"sum' }, finish_reason: 'length' }] })
    await expect(openai.complete(ask)).rejects.toThrow(/length limit/i)
  })
})

describe('Gemini', () => {
  const ask = { ...ASK, apiKey: 'g-key', model: 'gemini-2.5-flash' }

  it('treats a 400 about the key as a rejected key, not a bad request', async () => {
    /*
     * Every other provider here uses 401. Keying on the status code would file a rejected key
     * as a malformed request: the panel would not open, and the user would be told their plan
     * was wrong.
     */
    respond(
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      },
      400,
    )
    const error = await gemini.complete(ask).catch((e: AiError) => e)
    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).status).toBe(401)
    expect((error as AiError).message).toMatch(/rejected the key/i)
  })

  it('leaves an ordinary 400 alone', async () => {
    respond({ error: { code: 400, message: 'Invalid JSON payload received.' } }, 400)
    const error = await gemini.complete(ask).catch((e: AiError) => e)
    expect((error as AiError).status).toBe(400)
  })

  it('renames the assistant role, which Gemini calls model', async () => {
    respond({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
    await gemini.complete({
      ...ask,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    })

    const body = calls[0]!.body as { contents: Array<{ role: string }> }
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model'])
  })

  it('describes the schema in the prompt rather than sending one', async () => {
    // `responseSchema` is an OpenAPI subset and the plan schema needs an `anyOf`. Shipping a
    // converter whose failure is a 400 on a paid request is worse than asking in words.
    respond({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
    await gemini.complete({ ...ask, schema: { type: 'object' } })

    const body = calls[0]!.body as {
      systemInstruction: { parts: Array<{ text: string }> }
      generationConfig?: { responseMimeType?: string; responseSchema?: unknown }
    }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    expect(body.generationConfig?.responseSchema).toBeUndefined()
    expect(body.systemInstruction.parts[0]!.text).toContain('JSON Schema')
  })

  it('joins a reply split across parts', async () => {
    respond({ candidates: [{ content: { parts: [{ text: '{"a"' }, { text: ':1}' }] } }] })
    expect((await gemini.complete(ask)).text).toBe('{"a":1}')
  })
})

describe('Ollama', () => {
  const ask = { ...ASK, model: 'qwen2.5-coder:14b' }

  it('asks for a window the prompt actually fits in', async () => {
    /*
     * Two failures behind one number. Ollama's default context is a few thousand tokens, which
     * loses the catalogue with no error and produces a confident plan about a node list the
     * model never saw. And the floor here used to be 16384, from when the catalogue was ~13k
     * tokens — measured since at `prompt_eval_count: 16587` on an *empty* canvas, 17,687 with
     * the plan schema attached, so every request overran its own window. Asserted as a floor
     * over the real measurement rather than as equality: raising `NUM_CTX` is fine, and only
     * dropping it back under the prompt is the regression.
     */
    respond({ message: { content: '{}' } })
    await ollama.complete(ask)

    const body = calls[0]!.body as { options?: { num_ctx?: number } }
    expect(body.options?.num_ctx).toBeGreaterThan(17_687)
  })

  it('says the prompt did not fit, rather than passing on Ollama’s account of it', async () => {
    /*
     * The four-minute stall. A prompt over the window is truncated from the front, the user
     * turn is what falls off, and the structured-output path then refuses a conversation with
     * no question in it — as a 500 reading `no user query found in messages`, which names the
     * last step and none of the ones a person can act on. Arrives minutes late, because the
     * prompt is evaluated before any of it, so untranslated it reads as a hang that ended in
     * a riddle.
     */
    respond({ error: 'no user query found in messages' }, 500)
    await expect(ollama.complete(ask)).rejects.toThrow(
      /did not fit qwen2\.5-coder:14b's context window/,
    )
    await expect(ollama.complete(ask)).rejects.toThrow(/ollama show qwen2\.5-coder:14b/)
  })

  it('leaves every other 500 alone, since a crashed runner is not a small window', async () => {
    // Keyed on the message, not the status: an out-of-memory load returns 500 too, and telling
    // somebody to pull a bigger model is the opposite of the fix.
    respond({ error: 'model runner has unexpectedly stopped' }, 500)
    await expect(ollama.complete(ask)).rejects.toThrow(/model runner has unexpectedly stopped/)
  })

  it('turns reasoning off by sending false, because it is most of the wait', async () => {
    /*
     * Measured on one machine, warm model, same question: `qwen3.8:latest` answered in 254 s
     * with reasoning and 49 s without — 6k characters of thinking against a 1.6k-character
     * plan, and both plans applied.
     */
    respond({ message: { content: '{}' } })
    await ollama.complete({ ...ask, think: false })
    expect((calls[0]!.body as { think?: unknown }).think).toBe(false)
  })

  it('turns reasoning *on* by saying nothing, which is not symmetry', async () => {
    /*
     * Measured: Ollama accepts `think: false` from any model and answers normally, but rejects
     * `think: true` from one without the capability — `"qwen2.5:0.5b" does not support
     * thinking`. Coda's own default model is such a model, so honouring the checkbox with a
     * `true` would break the default setup for everyone who ticked it. Absent leaves the
     * model's own behaviour, which is what "on" means.
     */
    respond({ message: { content: '{}' } })
    await ollama.complete({ ...ask, think: true })
    expect((calls[0]!.body as { think?: unknown }).think).toBeUndefined()

    respond({ message: { content: '{}' } })
    await ollama.complete(ask)
    expect((calls[0]!.body as { think?: unknown }).think).toBeUndefined()
  })

  it('sends the schema for grammar-constrained decoding, which is what a small model needs', async () => {
    respond({ message: { content: '{}' } })
    await ollama.complete({ ...ask, schema: { type: 'object' } })

    expect((calls[0]!.body as { format?: unknown }).format).toEqual({ type: 'object' })
  })

  it('catches a truncated reply, which here is the ordinary case not the edge', async () => {
    /*
     * The context is fixed and the prompt is already most of it, so a long plan runs out of
     * room. Untreated this reaches `parsePlan` and is reported as "the reply was not JSON",
     * which sends somebody looking for a bug in the plan format.
     */
    respond({ message: { content: '{"summ' }, done_reason: 'length' })
    await expect(ollama.complete(ask)).rejects.toThrow(/length limit/i)
  })

  it('needs no key, and sends none', async () => {
    expect(ollama.needsKey).toBe(false)
    respond({ message: { content: '{}' } })
    await ollama.complete(ask)
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('names what is installed when the model is not pulled', async () => {
    // The commonest local failure by a wide margin, and left to the chat request it arrives as
    // a 404 about a manifest. The listing was already fetched, so saying so is free.
    respond({ models: [{ name: 'llama3.1:8b' }, { name: 'mistral-nemo' }] })
    const error = await ollama.verify({ model: 'qwen2.5-coder:14b' }).catch((e: AiError) => e)

    expect((error as AiError).message).toContain('ollama pull qwen2.5-coder:14b')
    expect((error as AiError).message).toContain('llama3.1:8b')
  })

  it('accepts a model that is installed', async () => {
    respond({ models: [{ name: 'qwen2.5-coder:14b' }] })
    const check = await ollama.verify({ model: 'qwen2.5-coder:14b' })
    expect(check.model).toBe('qwen2.5-coder:14b')
  })

  it('blames the local setup, not the network, when it cannot be reached', async () => {
    // A browser reports a CORS refusal, a dead port and a blocked request identically. The two
    // cases have completely different fixes, and OLLAMA_ORIGINS is one nobody guesses.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const error = await ollama.complete(ask).catch((e: AiError) => e)
    expect((error as AiError).message).toMatch(/OLLAMA_ORIGINS/)
    expect((error as AiError).message).toMatch(/https/)
  })
})

describe('every provider', () => {
  it('says the same thing about a truncated reply, whatever it calls one', async () => {
    // One sentence, four vocabularies: `max_tokens`, `length`, `MAX_TOKENS`, `done_reason`.
    const cut: Array<[string, unknown]> = [
      ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }],
      ['openai', { choices: [{ message: { content: '{' }, finish_reason: 'length' }] }],
      ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }],
      ['ollama', { message: { content: '{' }, done_reason: 'length' }],
    ]
    for (const [id, reply] of cut) {
      respond(reply)
      await expect(providerFor(id)!.complete({ ...ASK, apiKey: 'k' }), id).rejects.toThrow(
        /length limit/i,
      )
    }
  })

  it('lets an abort stay an abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      }),
    )
    for (const provider of PROVIDERS) {
      await expect(provider.complete({ ...ASK, apiKey: 'k' }), provider.id).rejects.toThrow(
        DOMException,
      )
    }
  })

  it('declares a model list, a default that is in it, and a base URL', async () => {
    // The panel renders all three before anything is configured, so a provider missing one
    // would show an empty picker rather than fail.
    for (const provider of PROVIDERS) {
      expect(provider.models.length, provider.id).toBeGreaterThan(0)
      expect(
        provider.models.map((m) => m.id),
        provider.id,
      ).toContain(provider.defaultModel)
      expect(provider.defaultBaseUrl, provider.id).toMatch(/^https?:\/\//)
      expect(providerFor(provider.id)).toBe(provider)
    }
  })

  it('carries the reasoning setting only to a provider that has the switch', async () => {
    /*
     * Off is the stored default, so the request has to *say* so — a provider filling nothing in
     * would leave a local model reasoning for minutes on every question. And a cloud provider
     * must not be handed the field at all: its reasoning is not a per-request boolean and the
     * ones here would reject or ignore it, either of which is worse than not asking.
     */
    setProviderId('ollama')
    respond({ message: { content: '{}' } })
    await complete(ASK)
    expect((calls[0]!.body as { think?: unknown }).think).toBe(false)

    setThinking('ollama', true)
    respond({ message: { content: '{}' } })
    await complete(ASK)
    expect((calls[0]!.body as { think?: unknown }).think).toBeUndefined()

    setProviderId('anthropic')
    setKey('anthropic', 'k')
    respond(messagesReply('{}'))
    await complete(ASK)
    expect((calls[0]!.body as { think?: unknown }).think).toBeUndefined()
  })

  it('reports usage in the same shape, zeroed where it has no cache to speak of', async () => {
    setKey('anthropic', 'k')
    respond(messagesReply('{}'))
    const result = await complete(ASK)
    expect(Object.keys(result.usage).sort()).toEqual([
      'cacheReadTokens',
      'cacheWriteTokens',
      'inputTokens',
      'outputTokens',
    ])
  })
})

describe('listing what a local server actually has', () => {
  const tags = (...models: Array<{ name: string; size?: number }>) => ({ models })

  it('answers with what is pulled, naming the size that decides on a laptop', async () => {
    respond(tags({ name: 'qwen3.8:27b-mlx', size: 16_100_000_000 }, { name: 'llama3.1:8b' }))

    const found = await ollama.listModels!({})
    expect(found).toEqual([
      { id: 'llama3.1:8b', label: 'llama3.1:8b' },
      { id: 'qwen3.8:27b-mlx', label: 'qwen3.8:27b-mlx — 16.1 GB' },
    ])
    expect(calls[0]!.url).toBe('http://localhost:11434/api/tags')
    expect(calls[0]!.method).toBe('GET')
  })

  it('sorts by name, so the list does not reshuffle between openings', async () => {
    respond(tags({ name: 'zephyr' }, { name: 'alpha' }, { name: 'mistral' }))
    expect((await ollama.listModels!({})).map((m) => m.id)).toEqual([
      'alpha',
      'mistral',
      'zephyr',
    ])
  })

  it('reads an empty answer as an empty machine, not as a failure', async () => {
    // A server that answered and has nothing pulled is a fact worth printing. Throwing here
    // would make it indistinguishable from one that is not running.
    respond(tags())
    await expect(ollama.listModels!({})).resolves.toEqual([])
  })

  it('raises when the server cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(ollama.listModels!({})).rejects.toThrow(/Could not reach/)
  })

  it('honours a base url, so a server on another port is asked rather than the default', async () => {
    respond(tags({ name: 'a' }))
    await ollama.listModels!({ baseUrl: 'http://192.168.1.9:9999' })
    expect(calls[0]!.url).toBe('http://192.168.1.9:9999/api/tags')
  })

  it('names what is installed when Test is pressed on a model that is not', async () => {
    // The listing has already been fetched, so turning the 404 into an instruction is free.
    respond(tags({ name: 'qwen3.8:latest' }, { name: 'gemma2:9b' }))
    await expect(ollama.verify({ model: 'qwen2.5-coder:14b' })).rejects.toThrow(
      /is not pulled on this machine.*gemma2:9b, qwen3\.8:latest/s,
    )
  })
})

describe('a model that accepts the schema and ignores it', () => {
  /*
   * Ollama takes `format` for every model and reports no capability for it — `/api/show` lists
   * `completion, vision, tools, thinking` identically for a build that honours the schema and
   * one that does not. The on-disk format is what separates them, so it is what gets reported.
   */
  const tags = (...models: Array<{ name: string; format: string }>) => ({
    models: models.map((m) => ({ name: m.name, details: { format: m.format } })),
  })

  /*
   * The example is a safetensors build under a name that does *not* say so, and that is now the
   * whole point of it. `qwen3:27b-mlx` used to stand here and no longer can: an `-mlx` tag is
   * one of the two spellings `ignoresSchemaField` recognises, so Coda describes the schema in
   * the prompt for it and the caveat below stops being true. What is left is the case nothing
   * can reach — an unstructured engine behind a name that gives no hint — which is exactly the
   * one still worth marking.
   */
  it('marks a build whose engine will not apply the schema', async () => {
    respond(tags({ name: 'my-conversion:latest', format: 'safetensors' }))
    expect((await ollama.listModels!({}))[0]!.label).toContain('ignores JSON schema')
  })

  it('leaves a gguf build unmarked', async () => {
    respond(tags({ name: 'qwen3:latest', format: 'gguf' }))
    expect((await ollama.listModels!({}))[0]!.label).not.toContain('ignores')
  })

  it('warns on Test rather than refusing, because the model does answer', async () => {
    respond(tags({ name: 'my-conversion:latest', format: 'safetensors' }))
    const check = await ollama.verify({ model: 'my-conversion:latest' })
    expect(check.model).toBe('my-conversion:latest')
    expect(check.warning).toMatch(/GGUF/)
  })

  it('says nothing about a build whose schema Coda already describes in the prompt', async () => {
    // An `-mlx` tag is compensated for, so marking it would be warning about a problem this
    // provider fixes on the way out. Both surfaces have to agree, or Test contradicts the list.
    respond(tags({ name: 'qwen3:27b-mlx', format: 'safetensors' }))
    expect((await ollama.listModels!({}))[0]!.label).not.toContain('ignores')
    expect((await ollama.verify({ model: 'qwen3:27b-mlx' })).warning).toBeUndefined()
  })

  it('says nothing about a gguf build', async () => {
    respond(tags({ name: 'qwen3:latest', format: 'gguf' }))
    expect((await ollama.verify({ model: 'qwen3:latest' })).warning).toBeUndefined()
  })

  it('claims nothing about a model the listing never described', async () => {
    // Unknown is not unstructured — the same rule the column pickers follow. A server that
    // could not be listed has said nothing about anybody's build.
    respond({ models: [] })
    expect((await ollama.verify({ model: 'something-else' })).warning).toBeUndefined()
  })

  it('treats a missing format as ordinary, not as a warning', async () => {
    // Older Ollama builds omit `details.format`. Warning there would mark every model on them.
    respond({ models: [{ name: 'llama3.1:8b' }] })
    const found = await ollama.listModels!({})
    expect(found[0]!.label).not.toContain('ignores')
    expect((await ollama.verify({ model: 'llama3.1:8b' })).warning).toBeUndefined()
  })
})

describe('a cloud model, served through the local server', () => {
  /*
   * Ollama runs big models on its own servers and fronts them from `localhost:11434`, so the
   * transport is unchanged and two other things are not: a cloud model accepts the JSON schema
   * and ignores it, and the promise "nothing leaves this machine" stops holding.
   *
   * Measured rather than assumed, on a free account: asked for `{summary, count}`,
   * `gemma4:31b-cloud` and `gpt-oss:120b-cloud` both answered prose where a GGUF build answered
   * the schema. On Coda's real prompt that took the plan from 1/5 parsed to 5/5 once the schema
   * was described in words instead.
   */
  const ask = { ...ASK, model: 'gemma4:31b-cloud', schema: { type: 'object' } }
  const systemOf = (call: StubbedCall): string =>
    ((call.body as { messages: Array<{ role: string; content: string }> }).messages.find(
      (m) => m.role === 'system',
    )?.content ?? '')

  it('describes the schema in the prompt, since the field will be ignored', async () => {
    respond({ message: { content: '{}' } })
    await ollama.complete(ask)
    expect(systemOf(calls[0]!)).toContain('JSON Schema')
  })

  it('sends the schema as a field as well, so a build that starts honouring it simply wins', async () => {
    // Costs nothing on an engine that ignores it — `prompt_eval_count` is identical either way
    // — and removes the need for a release of ours in between.
    respond({ message: { content: '{}' } })
    await ollama.complete(ask)
    expect((calls[0]!.body as { format?: unknown }).format).toEqual({ type: 'object' })
  })

  it('leaves a local model’s prompt alone, which is what keeps the KV cache warm', async () => {
    /*
     * The regression this guards is a quiet one: describing the schema for everybody costs 632
     * tokens on every request and would be invisible except on the bill and the first-token
     * latency. A GGUF build gets grammar-constrained decoding, which is exact, so the words
     * would be saying it twice.
     */
    respond({ message: { content: '{}' } })
    await ollama.complete({ ...ASK, model: 'qwen2.5-coder:14b', schema: { type: 'object' } })
    expect(systemOf(calls[0]!)).toBe('the catalogue')
  })

  it('says where a cloud model runs rather than how big it is', async () => {
    /*
     * `/api/tags` reports a pulled cloud model at 312 bytes — a pointer, not weights — which
     * `sizeLabel` renders as `0 MB` and reads as a broken download.
     */
    respond({ models: [{ name: 'gemma4:31b-cloud', size: 312, details: { format: '' } }] })
    const found = await ollama.listModels!({})
    expect(found[0]!.label).toContain('cloud · runs on ollama.com')
    expect(found[0]!.label).not.toContain('0 MB')
    expect(found[0]!.label).not.toContain('ignores')
  })

  it('says the same of a cloud model whether or not it has been pulled', async () => {
    /*
     * The row is where the disclosure lives, so it has to be there in both halves of the
     * dropdown: a model pulled onto the machine comes from `/api/tags` above, and one merely
     * offered comes from the declared shortlist. Written as two spellings of one sentence, the
     * one nobody has pulled yet — the case where somebody is *choosing* — is the one that would
     * have gone quiet.
     */
    for (const option of ollama.models.filter((m) => m.id.endsWith('-cloud'))) {
      expect(option.label).toContain('cloud · runs on ollama.com')
    }
  })

  it('asks who is signed in rather than whether the model is pulled', async () => {
    /*
     * A cloud model answers unpulled — measured — so the local "not pulled, run `ollama pull`"
     * refusal would fail a setting that works. What can actually be wrong is the account.
     */
    respond({ name: 'someone', plan: 'free' })
    const check = await ollama.verify({ model: 'gemma4:31b-cloud' })
    expect(calls[0]!.url).toBe('http://localhost:11434/api/me')
    expect(check.label).toContain('someone')
    /*
     * And carries no `warning`. That field is contracted as a quality caveat, it renders in the
     * amber `warn` tone, and it is only seen if somebody presses Test — which this panel's own
     * privacy note rules out as a place for a disclosure ("a consent line behind a tooltip is
     * not a consent line"). Where the request goes is said on the model row instead, which is
     * unconditional and read at the moment the choice is made — asserted below.
     */
    expect(check.warning).toBeUndefined()
  })

  it('never repeats the email /api/me also returns', async () => {
    // The question is whether a request will be accepted; an address is not part of that answer.
    respond({ name: 'someone', email: 'someone@example.com', plan: 'free' })
    const check = await ollama.verify({ model: 'gemma4:31b-cloud' })
    expect(JSON.stringify(check)).not.toContain('example.com')
  })

  it('sends somebody to `ollama signin` when nobody is', async () => {
    respond({ error: 'Unauthorized' }, 401)
    await expect(ollama.verify({ model: 'gemma4:31b-cloud' })).rejects.toThrow(/ollama signin/)
  })

  it('reads a rejected cloud request as an account, not as a key', async () => {
    // `needsKey` is false, so there is no key field for a bare `Unauthorized` to point at.
    respond({ error: 'Unauthorized' }, 401)
    await expect(ollama.complete(ask)).rejects.toThrow(/ollama signin/)
  })

  it('tells a paid-only model apart from a broken setup', async () => {
    /*
     * 402, which no other provider here uses: the account is fine and this model is not in it.
     * Measured — `qwen3.5:397b-cloud` answers 402 on a free account while three others answer
     * normally, so "pick another" is real advice rather than a shrug.
     */
    respond({ error: 'this model requires a subscription, upgrade at https://ollama.com/upgrade' }, 402)
    const error = await ollama.complete({ ...ask, model: 'qwen3.5:397b-cloud' }).catch((e) => e)
    expect((error as AiError).status).toBe(402)
    expect((error as AiError).message).toMatch(/not included in this ollama\.com account/)
    expect((error as AiError).message).toMatch(/free cloud models/)
  })

  it('does not tell somebody to pull a cloud model that does not exist', async () => {
    /*
     * The local router serves a narrower set than `ollama.com/api/tags` publishes — four listed
     * names answered 404 — and `ollama pull` fixes none of them.
     */
    respond({ error: "model 'kimi-k2.6-cloud' not found" }, 404)
    const error = await ollama.complete({ ...ask, model: 'kimi-k2.6-cloud' }).catch((e) => e)
    expect((error as AiError).message).not.toContain('ollama pull')
  })

  it('no longer calls itself local, and offers cloud models that were actually run', async () => {
    /*
     * The parenthesis was the claim a reader checks against the privacy note, and it stopped
     * being true for every name in the list once one of them could be a cloud model.
     *
     * Every cloud entry replied on a free account. The published catalogue is not the offer:
     * two of the nine tried answered 402 and four answered 404.
     */
    const cloud = ollama.models.filter((m) => m.id.endsWith('-cloud'))
    expect(cloud.map((m) => m.id)).toEqual([
      'gemma4:31b-cloud',
      'gpt-oss:120b-cloud',
      'gpt-oss:20b-cloud',
    ])
    expect(ollama.note).toMatch(/ollama signin/)
  })
})

describe('a model whose window is smaller than the prompt', () => {
  /*
   * The one that used to be a four-minute stall ending in `no user query found in messages`.
   * `/api/tags` carries `details.context_length` and has all along; reading it is what turns a
   * failure that costs a whole prompt evaluation into a line under the Test button.
   */
  const tags = (...models: Array<{ name: string; context?: number }>) => ({
    models: models.map((m) => ({
      name: m.name,
      details: { format: 'gguf', ...(m.context ? { context_length: m.context } : {}) },
    })),
  })

  it('marks a window the prompt cannot fit in, in the dropdown', async () => {
    respond(tags({ name: 'gemma2:9b', context: 8192 }))
    expect((await ollama.listModels!({}))[0]!.label).toContain('8k window')
  })

  it('says nothing about a window with room in it', async () => {
    // The number that matters to somebody choosing is the one that rules a model out. A note
    // beside every model that is fine hides the one that is not.
    respond(tags({ name: 'qwen3.8:latest', context: 262_144 }))
    expect((await ollama.listModels!({}))[0]!.label).toBe('qwen3.8:latest')
  })

  it('warns on Test, where the alternative is finding out four minutes into a question', async () => {
    respond(tags({ name: 'gemma2:9b', context: 8192 }))
    const check = await ollama.verify({ model: 'gemma2:9b' })
    expect(check.warning).toMatch(/8k context window/)
    expect(check.warning).toMatch(/at least 32k/)
  })

  it('carries both caveats when a model has both', async () => {
    // One string, because the panel prints one line — and dropping the second would have Test
    // call the setting fine in whichever respect it happened to check first.
    respond({
      models: [{ name: 'small:mlx', details: { format: 'safetensors', context_length: 8192 } }],
    })
    const check = await ollama.verify({ model: 'small:mlx' })
    expect(check.warning).toMatch(/GGUF/)
    expect(check.warning).toMatch(/8k context window/)
  })

  it('claims nothing where the listing does not say', async () => {
    // Older Ollama builds omit `context_length`. Unknown is not small — the same rule the
    // format check follows, and the same one the column pickers do.
    respond(tags({ name: 'llama3.1:8b' }))
    expect((await ollama.listModels!({}))[0]!.label).toBe('llama3.1:8b')
    expect((await ollama.verify({ model: 'llama3.1:8b' })).warning).toBeUndefined()
  })
})
