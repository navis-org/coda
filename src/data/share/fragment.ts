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
 *   demo://<type>[/plan]     a workflow built on the spot around that node
 *
 * Coda *writes* the second, third and sixth; it *reads* all six. The literal form is what keeps a
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
import { toBase64 } from '../base64'

/** The prefix marking a Coda share link, matching neuroglancer's. */
export const SHARE_PREFIX = '#!'

/** The packed form's tag. Bump with the format, never with the compressor. */
const PACKED_TAG = 'c1.'

/**
 * The four forms that name somewhere to *get* a document, which is what `resolve.ts` handles.
 *
 * `json` and `packed` are separate members because only one of them is async: the literal form
 * is a graph already, where the packed one has to be inflated. Collapsing them would make the
 * cheap case await for nothing.
 *
 * Split from `ShareRef` so that the one form which is built rather than fetched cannot reach a
 * function that fetches. Both of those functions used to carry a `case 'demo'` — one inventing a
 * label nobody could see, one throwing a sentence no path reached — because the switch was
 * exhaustive over a union that claimed every reference was resolvable. A type is the right place
 * to say it is not.
 */
export type FetchableRef =
  | { kind: 'json'; json: string }
  | { kind: 'packed'; blob: string }
  | { kind: 'gist'; owner?: string; id: string; revision?: string }
  | { kind: 'gcs'; bucket: string; path: string }
  | { kind: 'https'; url: string }

/**
 * The one form whose payload is not a document.
 *
 * See `wizard/demo.ts`. `useShareLink` answers it above `src/data`, because the builder reaches
 * `src/wizard` and invariant 1 forbids that here — so this is deliberately not a `FetchableRef`,
 * and a caller that hands one to `resolveShareRef` is a compile error rather than a thrown
 * sentence nobody ever sees.
 */
export type BuiltRef = {
  kind: 'demo'
  type: string
  plan?: DemoPlanRef
}

/** Everything a fragment can name — one to fetch, or the one to build. */
export type ShareRef = FetchableRef | BuiltRef

/**
 * A demo workflow's plan, as it travels in a link: three wizard answers and the wiring rank.
 *
 * The node guide's "Open in a workflow" carries a node type and, optionally, this — about forty
 * characters in all, where 102 packed graphs would have been 75 kB of base64 in a static page
 * whose readable half is what a crawler and a language model get.
 * `demo://out.heatmap/mock.opticlobe/matrix/heatmap` is something somebody can quote, retype,
 * and read before clicking.
 *
 * The plan is a *fact about the guide's build*, not part of the address: without it the app
 * searches for itself, which is what a hand-written `demo://core.filterTable` gets. With it,
 * exactly one workflow is built — and that is what keeps a click from peeking at every backend
 * (see `wizard/demo.ts`), so the guide always writes the long form.
 *
 * **Strings, not the wizard's own id types**, which live in `src/wizard` and `src/data` may not
 * import (invariant 1). Declared once here and imported by the builder rather than restated
 * there, so a fifth field is one edit. The builder narrows the names, and one it does not
 * recognise is a link that opens nothing rather than one that opens something wrong.
 */
export interface DemoPlanRef {
  dataset: string
  analysis: string
  view: string
  rank?: number
}

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
    case 'demo':
      return parseDemoRef(rest)
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

/**
 * `demo://<type>` or `demo://<type>/<dataset>/<analysis>/<view>[/<rank>]`.
 *
 * The grammar, not the list: `fragment.ts` is pure and knows nothing about which nodes or
 * analyses exist, and a link naming something this build has retired should fail where every
 * other unreadable link does — with a sentence from whoever *does* know, which is the app. What
 * is refused here is anything that is not a node type at all, since that is the half a regex can
 * settle.
 *
 * **A malformed plan is dropped, not refused.** The type is the address and the plan is an
 * optimisation over it, so a link truncated after the node name, or one whose trailing segments
 * were mangled, still opens the right node's workflow — the app searches instead. Refusing would
 * turn a recoverable link into a dead one.
 */
function parseDemoRef(rest: string): ShareRef {
  const [type = '', ...plan] = rest.replace(/\/+$/, '').split('/')
  if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(type)) {
    throw new ShareLinkError(
      `"${rest}" does not name a node. A demo link looks like demo://core.filterTable.`,
    )
  }
  const [dataset, analysis, view, rank] = plan
  if (!dataset || !analysis || !view) return { kind: 'demo', type }
  const nth = rank === undefined ? undefined : Number(rank)
  if (nth !== undefined && !Number.isInteger(nth)) return { kind: 'demo', type }
  return {
    kind: 'demo',
    type,
    plan: { dataset, analysis, view, ...(nth === undefined ? {} : { rank: nth }) },
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

/**
 * The link that opens a workflow around this node type.
 *
 * One composer, because the fragment is written in a page that cannot import this module: the
 * node guide is a separate vite entry and pulling `serializeGraph` in for a string concatenation
 * would land `src/core` in a 5 kB document. `src/nodeguide/data.ts` runs at build time, where the
 * import is free, and puts the finished href in the JSON the page reads. So the grammar has one
 * writer and one reader, and they are in the same file.
 */
export function demoFragment(type: string, plan?: DemoPlanRef): string {
  const tail = plan
    ? `/${plan.dataset}/${plan.analysis}/${plan.view}${plan.rank === undefined ? '' : `/${plan.rank}`}`
    : ''
  return `${SHARE_PREFIX}demo://${type}${tail}`
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

/** base64url: `toBase64` with the two characters a URL would escape swapped, and no padding. */
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
