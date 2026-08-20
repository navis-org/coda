/**
 * The `#!` fragment: what a shareable Coda link says, and how to read it back.
 *
 * Modelled on neuroglancer's, which puts its whole viewer state after `#!` and is the reason
 * anybody can mail a neuroglancer view without a server existing anywhere. A Coda graph is the
 * same kind of thing — a document small enough to be its own link — and the fragment is the one
 * part of a URL a browser never sends anywhere, so nothing about a shared workflow reaches a
 * machine we run.
 *
 * **Five payload forms, one grammar**, dispatched on what the payload starts with:
 *
 *   {…}                      the graph as literal JSON, percent-decoded first
 *   c1.<base64url>           deflate-raw of the minified JSON, format 1
 *   gh://<user>/<gistId>     a GitHub Gist
 *   gs://<bucket>/<path>     an object on Google Cloud Storage
 *   https://…                any JSON over https
 *
 * Coda *writes* the second and third; it *reads* all five. The literal form is what keeps a
 * link hand-editable and lets the docs print one, which is worth the 2.8x it costs — measured
 * on the bundled examples at 4,282–4,786 characters against 1,540–2,004 packed.
 *
 * **`c1.` names the format, not the algorithm.** An unrecognised blob then fails with a
 * sentence rather than an inflate error nobody can act on, and changing compressor later is a
 * `c2` rather than a guess about what the bytes were.
 *
 * **`deflate-raw`, not `gzip`.** Measured 24 characters shorter across the examples, which is
 * exactly the gzip container — a header, a CRC and a length, none of which a URL wants.
 *
 * This module is deliberately **pure**: no fetch, no storage, nothing to mock. The grammar is
 * asked once at boot, synchronously, before anything is resolved — see `hasShareFragment` — and
 * putting a network call in here would make that cheap question drag the expensive one.
 */

import type { CodaGraph } from '../../core/graph'
import { serializeGraph } from '../../core/graph'

/** The prefix marking a Coda share link, matching neuroglancer's. */
export const SHARE_PREFIX = '#!'

/** The packed form's tag. Bump with the format, never with the compressor. */
const PACKED_TAG = 'c1.'

/**
 * A link resolved as far as it can be without touching the network.
 *
 * `json` and `packed` are separate members because only one of them is async: the literal form
 * is a graph already, where the packed one has to be inflated. Collapsing them would make the
 * cheap case await for nothing.
 */
export type ShareRef =
  | { kind: 'json'; json: string }
  | { kind: 'packed'; blob: string }
  | { kind: 'gist'; owner?: string; id: string; revision?: string }
  | { kind: 'gcs'; bucket: string; path: string }
  | { kind: 'https'; url: string }

/** A fragment that is not a link this build can read. Carries a sentence, never a code. */
export class ShareLinkError extends Error {}

/**
 * Is there a share link in this fragment?
 *
 * Synchronous and cheap on purpose: the store's initialiser asks it before anything else, and
 * the answer is what withholds the start page. That has to be settled in the same tick the store
 * is created — a link discovered an effect later means the welcome modal is already up, over a
 * workflow the recipient has not seen yet.
 *
 * Note what it deliberately does *not* change: the autosaved graph is still restored and painted.
 * That is what gives the recipient something to compare against, and it is why `useShareLink`
 * asks before replacing a canvas that has work on it.
 *
 * It deliberately does not validate the payload. "There is a link here" and "the link is
 * readable" are different questions with different answers, and only the first one is needed
 * this early.
 */
export function hasShareFragment(hash: string): boolean {
  return hash.startsWith(SHARE_PREFIX) && hash.length > SHARE_PREFIX.length
}

/**
 * Read a fragment into a reference, or throw a sentence saying why not.
 *
 * The ordering of the branches is the grammar: a leading `{` wins over everything, then a
 * scheme, then the packed tag, and an unrecognised scheme is **named** rather than folded into
 * a generic refusal — "coda cannot read `ftp://` links" sends somebody somewhere, where "bad
 * link" does not.
 */
export function parseShareFragment(hash: string): ShareRef {
  if (!hasShareFragment(hash)) throw new ShareLinkError('No workflow link in this address.')
  const raw = hash.slice(SHARE_PREFIX.length)

  // Percent-decoding first, and tolerantly: a `{` typed by hand survives as itself in every
  // browser's address bar, while one that has been through a chat client comes back as `%7B`.
  // A malformed escape is not a reason to refuse — the payload may not be encoded at all.
  let payload = raw
  try {
    payload = decodeURIComponent(raw)
  } catch {
    // Leave it as it was written.
  }

  if (payload.startsWith('{')) return { kind: 'json', json: payload }

  if (payload.startsWith(PACKED_TAG)) {
    const blob = payload.slice(PACKED_TAG.length)
    if (!blob) throw new ShareLinkError('This workflow link carries no data.')
    return { kind: 'packed', blob }
  }

  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(payload)
  const scheme = match?.[1]?.toLowerCase()
  const rest = payload.slice(match?.[0].length ?? 0)

  switch (scheme) {
    case 'gh':
      return parseGistRef(rest)
    case 'gs':
      return parseGcsRef(rest)
    case 'https':
      return { kind: 'https', url: payload }
    case undefined:
      throw new ShareLinkError(
        'This workflow link is in a format this build does not recognise — it may have been made by a newer version of Coda, or truncated on the way here.',
      )
    default:
      // http, file, javascript, data — anything that is a scheme but not one of ours. Named,
      // because the fix differs completely between them and a shared refusal helps with none.
      throw new ShareLinkError(
        `Coda cannot open "${scheme}://" workflow links. Links can carry the workflow itself, or point at a gist (gh://), a storage object (gs://) or an https URL.`,
      )
  }
}

/** `<bucket>/<path>`, where the path may itself have slashes in it. */
function parseGcsRef(rest: string): ShareRef {
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) {
    throw new ShareLinkError(
      `Not a complete storage address: "gs://${rest}". It needs a bucket and a path, as in gs://my-bucket/workflow.coda.json.`,
    )
  }
  return { kind: 'gcs', bucket: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

/**
 * `<user>/<id>`, `<id>`, or either with `@<revision>` pinned on the end.
 *
 * The user segment is decorative — the gist API needs only the id — and is generated anyway,
 * because a link somebody is about to click should say whose gist it is. Reading both forms
 * costs one branch and means a link trimmed by hand still works.
 */
function parseGistRef(rest: string): ShareRef {
  const [locator = '', revision] = rest.split('@')
  const parts = locator.split('/').filter(Boolean)
  const id = parts[parts.length - 1]
  if (!id) throw new ShareLinkError('This gist link names no gist.')
  return {
    kind: 'gist',
    id,
    ...(parts.length > 1 ? { owner: parts[0] } : {}),
    ...(revision ? { revision } : {}),
  }
}

// ---------------------------------------------------------------------------
// The packed form
// ---------------------------------------------------------------------------

/**
 * Serialise compactly, deflate, and base64url the result.
 *
 * `compact` matters more than it looks: `serializeGraph` writes two-space JSON by default,
 * because a `.coda.json` is a file people read and diff, and a link is neither. Deflate recovers
 * most of the difference but not all of it, and the bytes are free to drop — and the obvious
 * spelling for dropping them, `JSON.stringify(JSON.parse(serializeGraph(g)))`, walks the whole
 * document three times and holds a throwaway copy of it to undo work that had just been done.
 */
export async function encodeShareFragment(graph: CodaGraph): Promise<string> {
  const json = serializeGraph(graph, { compact: true })
  const packed = await through(
    new TextEncoder().encode(json),
    new CompressionStream('deflate-raw'),
  )
  return `${SHARE_PREFIX}${PACKED_TAG}${toBase64Url(packed)}`
}

/** Inflate a `c1.` payload back to graph JSON. */
export async function decodePacked(blob: string): Promise<string> {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(blob)
  } catch {
    throw new ShareLinkError(
      'This workflow link is damaged — some characters are missing or were changed on the way here. Ask for it again, unwrapped.',
    )
  }
  try {
    const out = await through(bytes, new DecompressionStream('deflate-raw'))
    return new TextDecoder().decode(out)
  } catch {
    throw new ShareLinkError(
      'This workflow link could not be unpacked. It was most likely truncated — links are often cut short by chat and mail clients.',
    )
  }
}

/**
 * Push bytes through a compression stream and collect the result.
 *
 * **Both writer promises are caught, and that is not defensive noise.** A corrupt payload fails
 * on *both* ends of the transform: the readable side rejects, which is the one awaited and
 * turned into a sentence, and the writable side rejects with the same thing a tick later with
 * nobody listening. Left alone that surfaces as an unhandled rejection — a `Z_BUF_ERROR` stack
 * beside a test that passed, and in a browser a console error next to a message that had
 * already explained itself properly.
 */
async function through(data: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  const ignore = () => {}
  void writer.write(data).catch(ignore)
  void writer.close().catch(ignore)
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/**
 * base64url, in chunks.
 *
 * `String.fromCharCode(...bytes)` is the one-liner and it blows the call stack: an Explore
 * select-all packs to roughly 42,000 bytes, which is already past what some engines will spread
 * into arguments, and nothing about the failure names the array that did it.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The inverse.
 *
 * Padding is restored rather than relied on: `atob` tolerates its absence in some engines and
 * throws in others, and the difference would be a link that works in one browser and not the
 * one it was mailed to.
 */
function fromBase64Url(blob: string): Uint8Array {
  const b64 = blob.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Building a link
// ---------------------------------------------------------------------------

/**
 * The absolute URL for a fragment, against wherever this build is served from.
 *
 * `BASE_URL` rather than `location.href`: `base` is `'./'` so the app can live at a subpath,
 * and a link built from the current path would carry whatever route the user happened to be on.
 * The origin comes along with it, which is why a link generated on a dev server points at the
 * dev server — correct, and the reason the dialog says so when the origin is a local one.
 */
export function shareUrl(fragment: string, baseUrl: string, href: string): string {
  const base = new URL(baseUrl, href)
  return `${base.origin}${base.pathname}${fragment}`
}

/** Whether a URL is one only its author can open. The dialog says so rather than pretending. */
export function isLocalOrigin(href: string): boolean {
  try {
    const { hostname, protocol } = new URL(href)
    if (protocol === 'file:') return true
    return /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$|.*\.local$)/i.test(hostname)
  } catch {
    return false
  }
}
