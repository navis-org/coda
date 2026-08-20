/**
 * A share reference, fetched.
 *
 * `fragment.ts` reads a link as far as it can without a network; this is the other half. Three
 * of the five payload forms name somewhere to fetch from, and each has a different failure the
 * user can act on, so each gets its own message rather than a shared "could not load".
 *
 * **Who is asked before a fetch happens is decided here, and the split is deliberate.**
 * `gh://` and `gs://` name a known host *in the link itself* — anybody hovering the link
 * already sees where it goes — so they resolve without a prompt. A bare `https://` is opaque:
 * shortening a link is exactly the act of hiding its destination, so before Coda fetches from a
 * host neither it nor the recipient has ever heard of, the dialog shows the origin and asks.
 * That keeps the common path frictionless and puts the question where it is actually a
 * question.
 *
 * Worth stating plainly, because it is what stops this being a bigger security question than it
 * is: what comes back is **data**. `deserializeGraph` validates and drops what it does not
 * recognise, note and blurb markdown goes through an AST parser that cannot emit raw HTML, no
 * credential is ever inside a graph, and opening a graph runs only the *cheap* pass — where
 * `core.tableFromUrl`, the one node that fetches a URL named in the document, is `expensive`
 * precisely because its URL is a text field. So a shared workflow fetches nothing of its own
 * until the recipient presses Run.
 */

import type { ShareRef } from './fragment'
import { decodePacked } from './fragment'
import { readGist } from './gist'

/** Where a reference points, in words, for a dialog that has to say so before fetching. */
export interface ShareTarget {
  /** One phrase naming the kind of source: "a GitHub gist", "storage.googleapis.com". */
  label: string
  /** The host, where there is one to show. */
  host: string | undefined
  /** Whether to ask the user before fetching. See the module note. */
  needsConfirm: boolean
}

export function shareTarget(ref: ShareRef): ShareTarget {
  switch (ref.kind) {
    case 'json':
    case 'packed':
      return { label: 'the link itself', host: undefined, needsConfirm: false }
    case 'gist':
      return {
        label: ref.owner ? `a GitHub gist by ${ref.owner}` : 'a GitHub gist',
        host: 'gist.github.com',
        needsConfirm: false,
      }
    case 'gcs':
      return {
        label: `the storage bucket "${ref.bucket}"`,
        host: 'storage.googleapis.com',
        needsConfirm: false,
      }
    case 'https':
      return {
        label: hostOf(ref.url) ?? 'another site',
        host: hostOf(ref.url),
        needsConfirm: true,
      }
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** Fetch whatever the reference points at, and hand back graph JSON. */
export async function resolveShareRef(ref: ShareRef): Promise<string> {
  switch (ref.kind) {
    case 'json':
      return ref.json
    case 'packed':
      return decodePacked(ref.blob)
    case 'gist':
      return readGist(ref.id, ref.revision)
    case 'gcs':
      return fetchText(
        `https://storage.googleapis.com/${ref.bucket}/${ref.path}`,
        `The bucket "${ref.bucket}" may not allow cross-origin reads. That is set on the bucket by whoever owns it, not by Coda.`,
      )
    case 'https':
      return fetchText(ref.url)
  }
}

/**
 * A plain GET with the two failures worth telling apart.
 *
 * A browser reports a cross-origin refusal as an opaque `TypeError` indistinguishable from a
 * dead host — the constraint `data/precomputed/transport.ts` works around by trying and
 * remembering, and the reason `core.tableFromUrl` names both in its message. Same rule here:
 * the fix for one is nothing like the fix for the other, and saying only "network error" sends
 * somebody to check their wifi over a header that host never sent.
 *
 * `credentials: 'omit'` is the default for a cross-origin fetch and is stated anyway: nothing
 * about following a workflow link should carry the reader's cookies to the host it points at.
 *
 * Named `fetchText` rather than `fetchJson`, which is what `precomputed/transport.ts` already
 * exports — two functions of one name two directories apart is a grep hazard, and this one hands
 * the body back unparsed anyway.
 */
async function fetchText(url: string, hint?: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'omit', redirect: 'follow' })
  } catch {
    throw new Error(
      `Could not fetch ${url}. The host may be unreachable, or it may not allow cross-origin reads — a browser refuses those without saying so.${hint ? ` ${hint}` : ''}`,
    )
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`.trim())
  }
  return response.text()
}
