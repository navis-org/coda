/**
 * A credential-less cross-origin read — a GET, or a POST to a public read-only query endpoint —
 * telling apart the failures worth telling apart: unreachable or refused, 404, and cancelled.
 *
 * A browser reports a cross-origin refusal as an opaque `TypeError` indistinguishable from a
 * dead host — the constraint `data/precomputed/transport.ts` works around by trying and
 * remembering, and the reason `core.tableFromUrl` names both in its message. Same rule here:
 * the fix for one is nothing like the fix for the other, and saying only "network error" sends
 * somebody to check their wifi over a header that host never sent.
 *
 * `credentials: 'omit'` is the default for a cross-origin fetch and is stated anyway: nothing
 * about following a workflow link, or listing a public repository of them, should carry the
 * reader's cookies to the host it points at.
 *
 * Named `fetchText` rather than `fetchJson`, which is what `precomputed/transport.ts` already
 * exports — two functions of one name two directories apart is a grep hazard, and this one hands
 * the body back unparsed anyway. **That is also why this module exists.** The function lived in
 * `share/resolve.ts` and was copied into `zoo/source.ts`, which made the grep hazard that
 * comment warns about real, two directories apart, in the codebase that wrote the warning.
 */

/**
 * A 404, as a type rather than a sentence.
 *
 * For a caller to whom *absent* is an answer rather than a failure: NeuronBridge's bucket is keyed
 * by body id, so a neuron it has no matches for is a missing object, and the only other way to
 * tell that from a dead host would be matching on the message. The message is unchanged, so every
 * caller that only reads it sees exactly what it did before.
 */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
}

/** What a caller knows about the request: the sentences for its failures, and how to make it. */
export interface FetchTextOptions {
  /** Appended to the unreachable/cross-origin message: what the caller knows about this host. */
  hint?: string
  /** Replaces the generic status message for a 404, which usually has a specific meaning. */
  notFound?: string
  /**
   * Cancellation, for a caller that can be given up on.
   *
   * An `AbortError` is deliberately re-thrown as itself rather than folded into the message
   * above: the standing rule everywhere else here is that a cancellation must stay a
   * cancellation, or giving up on something reads downstream as the host being unreachable.
   */
  signal?: AbortSignal
  /**
   * A request that is not a plain GET — a POST with a body, for a query endpoint (the Neo4j
   * transaction API Virtual Fly Brain exposes). The failures above are told apart the same way
   * whatever the method, which is the reason this is an option here and not a second function.
   * Deliberately narrow: no `credentials`, so no caller can undo `credentials: 'omit'`.
   */
  init?: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }
}

/**
 * A request that never got an answer, in the one sentence for it — `fetchText`'s own, and that of
 * any other cross-origin read that has to say the same (a table file's HEAD).
 */
export function unreachable(url: string, hint?: string): Error {
  return new Error(
    `Could not fetch ${url}. The host may be unreachable, or may refuse cross-origin ` +
      `reads. The browser does not say which.${hint ? ` ${hint}` : ''}`,
  )
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      ...options.init,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw unreachable(url, options.hint)
  }
  if (response.status === 404) {
    throw new NotFoundError(
      options.notFound
        ? `${url} returned 404. ${options.notFound}`
        : `${url} returned 404 ${response.statusText}`.trim(),
    )
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`.trim())
  }
  return response.text()
}
