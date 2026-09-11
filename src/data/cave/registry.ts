/**
 * One `CaveSource` per deployment, created on demand.
 *
 * `catmaid/registry.ts`' arrangement and for its reason: a `Custom CAVE` node stores a global
 * server, every node resolves its source through `ctx.resolveSource(sourceId)`, and the only
 * moment a source for a second deployment can be registered is when something asks. Hence a lazy
 * factory rather than a fixed list — `registerBuiltinSources` asks for the ones the spec table
 * names, and a Custom node asks for its own from `inferOutputs`.
 *
 * Separate from `deployments.ts` because this one imports `CaveSource`, which imports that.
 */

import { getSource, registerSource } from '../source'
import { CaveSource } from './CaveSource'
import { DEFAULT_CAVE_SERVER, caveSourceId, normaliseCaveServer } from './deployments'

/**
 * The source for a deployment, registering it the first time it is asked for.
 *
 * Safe to call from `inferOutputs`: synchronous, and a fresh instance knows nothing until
 * something calls `listDatasets` — the "answer with what you have, learn in the background"
 * contract `peekDatasets` exists for. An existing registration is kept, including a test's
 * subclass registered under the same id.
 */
export function caveSourceFor(server: string | undefined): CaveSource {
  const deployment = normaliseCaveServer(server)
  const existing = getSource(caveSourceId(deployment))
  if (existing instanceof CaveSource) return existing
  return registerSource(new CaveSource(deployment)) as CaveSource
}

/**
 * The source id a node publishes for a deployment, registering the source only if it is **not**
 * the default one.
 *
 * The default is `registerBuiltinSources`' to register, never a node's. Registering it from
 * `inferOutputs` hands every schema lookup a source some context deliberately left out: the
 * exporter runs with no sources registered, and a Custom CAVE card doing this put an unlisted
 * `cave` source under the whole graph — Find Neurons on FlyWire then checked its filter rows
 * against a schema with no `type` in it and dropped the filter from the notebook. A second
 * deployment has nobody else to register it, so that one is a node's to do.
 */
export function publishedCaveSourceId(server: string | undefined): string {
  const deployment = normaliseCaveServer(server)
  if (deployment !== DEFAULT_CAVE_SERVER) caveSourceFor(deployment)
  return caveSourceId(deployment)
}
