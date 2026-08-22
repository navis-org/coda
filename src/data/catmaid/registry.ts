/**
 * One `CatmaidSource` per server, created on demand.
 *
 * neuPrint's arrangement and for its reason: a Custom CATMAID node stores a server URL, every
 * node resolves its source through `ctx.resolveSource(sourceId)`, and the only moment a source
 * for a second instance can be registered is when something asks. Hence a lazy factory rather
 * than a fixed list.
 *
 * The distinction matters more here than anywhere else in the tree, because **CATMAID is
 * software rather than a service.** neuPrint has a canonical deployment and CAVE has a global
 * service that lists datastacks; CATMAID has neither, so every instance is somebody's server and
 * two of them share nothing — not project ids, not annotation ids, not the meta-annotation
 * conventions that give a neuron its type. Keying the source on the server is what keeps two
 * instances' projects, annotation graphs and volume lists from being read as one.
 */

import { getSource, registerSource } from '../source'
import { CatmaidSource } from './CatmaidSource'
import { DEFAULT_CATMAID_SERVER } from './credentials'

/** Trailing slashes off, scheme filled in — so three spellings land on one instance. */
export function normaliseCatmaidServer(server: string | undefined): string {
  const raw = (server ?? '').trim().replace(/\/+$/, '')
  if (!raw) return DEFAULT_CATMAID_SERVER
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

/**
 * The source id for a server.
 *
 * The default instance keeps the bare `catmaid` id, which is what every saved graph carries, and
 * the rule that makes that safe is the same one `sourceIdForServer` follows for neuPrint: the id
 * is derived from the *normalised* server, so a node storing `catmaid-fafb.virtualflybrain.org/`
 * resolves to the same source as one storing the full URL.
 */
export function catmaidSourceId(server: string | undefined): string {
  const normalised = normaliseCatmaidServer(server)
  return normalised === DEFAULT_CATMAID_SERVER ? 'catmaid' : `catmaid:${normalised}`
}

/** A readable label, since the source id is a URL for anything but the default. */
function labelFor(server: string): string {
  if (server === DEFAULT_CATMAID_SERVER) return 'CATMAID'
  try {
    return `CATMAID (${new URL(server).hostname})`
  } catch {
    return 'CATMAID'
  }
}

/**
 * The source for a server, registering it the first time it is asked for.
 *
 * Safe to call from `inferOutputs`: synchronous, and a fresh instance knows nothing until
 * something calls `listDatasets` — the "answer with what you have, learn in the background"
 * contract `peekDatasets` exists for.
 */
export function catmaidSourceFor(server: string | undefined): CatmaidSource {
  const normalised = normaliseCatmaidServer(server)
  const id = catmaidSourceId(normalised)
  const existing = getSource(id)
  if (existing instanceof CatmaidSource) return existing
  return registerSource(
    new CatmaidSource(normalised, id, labelFor(normalised)),
  ) as CatmaidSource
}
