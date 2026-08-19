/**
 * One `NeuPrintSource` per deployment, created on demand.
 *
 * The Custom neuPrint node stores a server URL, and every node resolves its source through
 * `ctx.resolveSource(sourceId)` — a lookup in the global registry. So a node pointing at a
 * second deployment needs a registered source for it, and the only moment that can happen is
 * when something asks. Hence a lazy factory rather than a fixed registration list.
 *
 * Keyed by canonical deployment URL, so `neuprint.janelia.org`, `https://neuprint.janelia.org`
 * and a trailing slash all land on the same instance and share its dataset listing, discovered
 * schemas and resolved mesh sources. The default deployment keeps the bare `neuprint` id that
 * existing graphs already carry.
 */

import { getSource, registerSource } from '../source'
import { NeuPrintSource } from './NeuPrintSource'
import { normaliseServer, sourceIdForServer } from './servers'

/**
 * The source for a deployment, registering it the first time it is asked for.
 *
 * Safe to call from `inferOutputs`: it is synchronous and does no network work — a fresh
 * instance knows nothing until something calls `listDatasets`, which is exactly the "answer
 * with what you have, learn in the background" contract `peekDatasets` exists for.
 */
export function neuPrintSourceFor(server: string | undefined): NeuPrintSource {
  const id = sourceIdForServer(server)
  const existing = getSource(id)
  if (existing instanceof NeuPrintSource) return existing
  return registerSource(new NeuPrintSource(normaliseServer(server))) as NeuPrintSource
}
