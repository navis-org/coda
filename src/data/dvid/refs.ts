/**
 * The DVID address grammar: what a `dvid://` source string names, and where its bytes live.
 *
 * Pure string work, no network — which is what lets `inferOutputs` and a card being typed into
 * both ask the same questions without a fetch (invariant 2).
 *
 * ## What a source names, and what it does not
 *
 * A neuroglancer layer's `source` is `dvid://<server>/<node>/<instance>`, and the instance it
 * names is the **segmentation**, not the geometry:
 *
 *     dvid://https://flyem.dvid.io/babdf6dbc23e44a69953a66e2260ff0a/groundtruth
 *              └──────── server ────────┘└─────────── node ───────────┘└ instance ┘
 *
 * Geometry lives in sibling keyvalue instances named by *convention*, `<instance>_meshes` and
 * `<instance>_skeletons`. That convention is neuroglancer's — `datasource/dvid/frontend.ts`
 * builds exactly these two names and shows nothing when they are absent — and following it
 * rather than searching is deliberate. `AL-VA1v` on the public server is why: its skeletons sit
 * in `bodies121714_skeletons`, left over from an earlier name for a segmentation now called
 * `segmentation`, so a search would find them and neuroglancer does not. Coda showing skeletons
 * that neuroglancer says are not there is a worse answer than showing none.
 *
 * The other reason is the one the user of a private server cares about: a search means
 * `/api/repos/info`, which answers with **every repo on the host** — 42 kB naming aliases,
 * uuids and instances of other people's data on the public server alone. Asking
 * `<instance>_meshes/info` instead is one narrow question about the one node somebody already
 * has the address of. See `docs/backends.md`.
 *
 * ## Why the node is not validated as a uuid
 *
 * DVID accepts an **abbreviated** node — `neuprint.janelia.org` publishes
 * `dvid://https://emdata6-fib19.janelia.org/93f08/segmentation`, five hex characters against the
 * usual thirty-two. So the check is that it is hex and non-empty, and the server settles the
 * rest. A stricter rule would reject a real published source; a looser one costs nothing here,
 * since a wrong node fails at the first request with the server's own words.
 */

/** A `dvid://` location split into the three things every request needs. */
export interface DvidRef {
  /**
   * Everything before `/api`, with no trailing slash — origin, plus any path the deployment
   * sits under. Kept whole rather than reduced to an origin, so a DVID behind `/dvid/` works.
   */
  server: string
  /** The node (version) uuid, possibly abbreviated. */
  node: string
  /** The data instance the source named: a segmentation, not a geometry store. */
  instance: string
}

/** Hex, non-empty, no length rule — see the header on abbreviated nodes. */
const NODE = /^[0-9a-f]+$/i

/**
 * Split a `dvid://` location — the part after the scheme — into its three pieces.
 *
 * Undefined rather than a throw, and undefined for every shape that is not this one: an empty
 * string, a location with no node and instance, a node that is not hex. The callers are a
 * card describing what somebody typed and a filter over a published state's layers, and neither
 * has anything useful to do with an exception.
 *
 * The node and instance are the **last two** path segments, so everything before them is the
 * server. Taking them from the end rather than the start is what makes a path prefix work.
 */
export function parseDvidRef(location: string): DvidRef | undefined {
  let parsed: URL
  try {
    parsed = new URL(location.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return undefined
  const instance = segments[segments.length - 1]!
  const node = segments[segments.length - 2]!
  if (!NODE.test(node)) return undefined
  const prefix = segments.slice(0, -2)
  const server = `${parsed.origin}${prefix.length ? `/${prefix.join('/')}` : ''}`
  return { server, node, instance }
}

/** The mesh keyvalue instance a segmentation's meshes live in, by neuroglancer's convention. */
export function meshInstance(ref: DvidRef): string {
  return `${ref.instance}_meshes`
}

/** The skeleton keyvalue instance, by the same convention. */
export function skeletonInstance(ref: DvidRef): string {
  return `${ref.instance}_skeletons`
}

/**
 * Everything before the verb: one data instance on one node.
 *
 * The unit the rest of the code passes around, because it is what a `MeshSource.base` can be —
 * so a mesh reader holding only that string can still build a key URL, and nothing has to carry
 * a `DvidRef` through the precomputed machinery to do it.
 */
export function instanceUrl(ref: DvidRef, instance: string): string {
  return `${ref.server}/api/node/${ref.node}/${instance}`
}

/**
 * One key in a keyvalue instance, from that instance's URL.
 *
 * The key is encoded, because it reaches here as a neuron id that came off a table and this
 * module promises a URL rather than a well-formed one by luck. Ids are digits in practice, so
 * this never changes anything — which is the point of doing it anyway.
 */
export function keyUrl(base: string, key: string): string {
  return `${base}/key/${encodeURIComponent(key)}`
}

/**
 * The server an instance URL is on, for a message that must not repeat the whole address.
 *
 * On these deployments the node *is* the access control, so an error string — which gets pasted
 * into bug reports — names the host and stops there.
 */
export function serverOf(base: string): string {
  try {
    return new URL(base).origin
  } catch {
    return base
  }
}
