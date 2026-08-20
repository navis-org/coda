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
    expect(body.messages[2]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
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
    respond({ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 1000000 })
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

  it('sets the context window, because the default silently truncates the prompt', async () => {
    /*
     * The worst failure available: no error, and a confident plan about a node catalogue the
     * model was never shown. Ollama's default context is a few thousand tokens; ours is ~13k.
     */
    respond({ message: { content: '{}' } })
    await ollama.complete(ask)

    const body = calls[0]!.body as { options?: { num_ctx?: number } }
    expect(body.options?.num_ctx).toBeGreaterThanOrEqual(16384)
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
    const error = await ollama
      .verify({ model: 'qwen2.5-coder:14b' })
      .catch((e: AiError) => e)

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
      await expect(
        providerFor(id)!.complete({ ...ASK, apiKey: 'k' }),
        id,
      ).rejects.toThrow(/length limit/i)
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
      await expect(
        provider.complete({ ...ASK, apiKey: 'k' }),
        provider.id,
      ).rejects.toThrow(DOMException)
    }
  })

  it('declares a model list, a default that is in it, and a base URL', async () => {
    // The panel renders all three before anything is configured, so a provider missing one
    // would show an empty picker rather than fail.
    for (const provider of PROVIDERS) {
      expect(provider.models.length, provider.id).toBeGreaterThan(0)
      expect(provider.models.map((m) => m.id), provider.id).toContain(provider.defaultModel)
      expect(provider.defaultBaseUrl, provider.id).toMatch(/^https?:\/\//)
      expect(providerFor(provider.id)).toBe(provider)
    }
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

  it('marks a build whose engine will not apply the schema', async () => {
    respond(tags({ name: 'qwen3:27b-mlx', format: 'safetensors' }))
    expect((await ollama.listModels!({}))[0]!.label).toContain('ignores JSON schema')
  })

  it('leaves a gguf build unmarked', async () => {
    respond(tags({ name: 'qwen3:latest', format: 'gguf' }))
    expect((await ollama.listModels!({}))[0]!.label).not.toContain('ignores')
  })

  it('warns on Test rather than refusing, because the model does answer', async () => {
    respond(tags({ name: 'qwen3:27b-mlx', format: 'safetensors' }))
    const check = await ollama.verify({ model: 'qwen3:27b-mlx' })
    expect(check.model).toBe('qwen3:27b-mlx')
    expect(check.warning).toMatch(/GGUF/)
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
