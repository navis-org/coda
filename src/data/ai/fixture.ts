/**
 * An Anthropic Messages API reply, in the shape the API actually returns one.
 *
 * Shared rather than written per suite, because the non-obvious part of the shape is the part
 * both suites depend on: the content array leads with a `thinking` block whose text is empty
 * under the default display, which is the whole reason `complete` reads the *last* text block.
 * Two copies of that would drift, and the copy that went stale would be describing a response
 * the client no longer parses — while still passing.
 *
 * Not a `.test.ts` file so both suites can import it, the same arrangement `export/fixture.ts`
 * uses. Nothing outside a test imports it, so it never reaches a bundle.
 */

export interface StubbedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A successful Anthropic reply carrying `text`. */
export function messagesReply(text: string): unknown {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 13000,
    },
  }
}

/**
 * Replace `fetch` with one that answers, and records what it was asked.
 *
 * Takes the stub installer rather than importing vitest, so this stays a plain fixture and the
 * suite keeps control of when the global is restored.
 *
 * Two details are what stopped the three suites sharing this and forking instead, and both are
 * one line: the body is only parsed when there is one, because `verify` issues a GET and
 * `JSON.parse(String(undefined))` throws; and `replies` may be a *list*, answered in turn, so a
 * repair round can be given a different answer from the round before it.
 */
export function stubFetch(
  install: (name: string, value: unknown) => void,
  replies: unknown | unknown[],
  status = 200,
): StubbedCall[] {
  const list = Array.isArray(replies) ? replies : [replies]
  const calls: StubbedCall[] = []
  install('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    })
    const body = list[Math.min(calls.length - 1, list.length - 1)]
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}
