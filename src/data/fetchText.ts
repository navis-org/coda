/**
 * A plain cross-origin GET, with the two failures worth telling apart.
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

/** Extra sentences for the two failures a caller may know something about. */
export interface FetchTextMessages {
  /** Appended to the unreachable/cross-origin message: what the caller knows about this host. */
  hint?: string
  /** Replaces the generic status message for a 404, which usually has a specific meaning. */
  notFound?: string
}

export async function fetchText(
  url: string,
  messages: FetchTextMessages = {},
): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'omit', redirect: 'follow' })
  } catch {
    throw new Error(
      `Could not fetch ${url}. The host may be unreachable, or it may not allow cross-origin reads — a browser refuses those without saying so.${messages.hint ? ` ${messages.hint}` : ''}`,
    )
  }
  if (response.status === 404 && messages.notFound) {
    throw new Error(`${url} returned 404. ${messages.notFound}`)
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`.trim())
  }
  return response.text()
}
