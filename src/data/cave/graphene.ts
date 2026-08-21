/**
 * Reading a `graphene://` segmentation source.
 *
 * The scheme prefix carries the **server and the chunkedgraph table**, and that table is not the
 * datastack: FlyWire's datastack is `flywire_fafb_public` and its table `flywire_public`, BANC's
 * are `brain_and_nerve_cord_public` and `wclee_fly_cns_001_public`. Three APIs are keyed by the
 * table rather than by the datastack — meshing, the level-2 chunk graph and the L2 cache — so
 * taking the datastack name for any of them 404s.
 *
 * Shared because there are now two consumers (`meshes.ts` and `l2.ts`) and a second copy is how
 * one of them starts 404ing on a datastack whose URL is shaped slightly differently. Both forms
 * seen live are covered: `/segmentation/1.0/<table>` and `/segmentation/table/<table>`.
 */

export interface GrapheneSource {
  /** Origin of the segmentation service, e.g. `https://cave.fanc-fly.com`. */
  readonly server: string
  /** Chunkedgraph table name. */
  readonly table: string
  /** The source with its `graphene://` prefix removed — what `/info` hangs off. */
  readonly base: string
}

export function parseGrapheneSource(source: string | undefined): GrapheneSource | undefined {
  if (!source) return undefined
  const base = source.replace(/^graphene:\/\//, '').replace(/\/+$/, '')
  const match = /^(https?:\/\/[^/]+)\/segmentation\/[^/]+\/([^/?#]+)/.exec(base)
  if (!match) return undefined
  const [, server, table] = match
  return server && table ? { server, table, base } : undefined
}
