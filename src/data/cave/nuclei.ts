/**
 * Each neuron's soma, from the datastack's nucleus table — what `CaveSource.somaPositions` answers.
 *
 * One query for the ids not already asked about this session, whatever their number, at the
 * requested materialization. **Remembered for the session**: a materialization is immutable, so a
 * root's nucleus at it cannot change. Asked in nanometres, and the server answers a position named
 * `pt_position` as three columns, `pt_position_x`/`_y`/`_z` — checked live on minnie65 (asking for
 * the three names by hand is a 500).
 *
 * Two roots have no soma, and neither is an error: one holding **more than one** nucleus (a merge
 * — which would be the neuron's?) and one holding **none**. Both are left out of the answer.
 *
 * **A call arriving while another is in flight waits for it**, then asks only what is still
 * unknown. The card and a Run ask for the same index at the same moment, and the filter on that
 * query lists every id — two of them would be the same large request twice.
 */

import type { NeuronId } from '../../core/ids'
import { idText } from '../../core/ids'
import { queryTableChecked } from './api'
import type { CaveRequestOptions } from './client'
import { deploymentKey } from './deployments'

type Position = readonly [number, number, number]

/** Per materialization: each root asked about, and its soma or `null` for none. */
const known = new Map<string, Map<NeuronId, Position | null>>()
const inFlight = new Map<string, Promise<unknown>>()

/** Drop what this module remembers. Reached through `resetCaveState`. */
export function resetNuclei(): void {
  known.clear()
  inFlight.clear()
}

/** Each id's soma in nanometres, where it has exactly one nucleus. */
export async function somataFor(
  server: string,
  datastack: string,
  version: number,
  table: string,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions,
): Promise<Map<NeuronId, Position>> {
  const key = deploymentKey(options.deployment, `${datastack}|${version}|${table}`)
  const held = known.get(key) ?? new Map<NeuronId, Position | null>()
  known.set(key, held)

  // Known already: answered now, waiting on nobody else's query.
  if (!neuronIds.every((id) => held.has(id))) {
    // Chained onto whatever is already being asked, before any await, so two calls in one moment
    // cannot both find an id unknown. A failure there is its own caller's to report.
    const prior = inFlight.get(key)
    const turn = (async () => {
      await prior?.catch(() => undefined)
      const unknown = [...new Set(neuronIds)].filter((id) => !held.has(id))
      if (unknown.length === 0) return
      const found = await ask(server, datastack, version, table, unknown, options)
      for (const id of unknown) held.set(id, found.get(id) ?? null)
    })()
    inFlight.set(key, turn)
    try {
      await turn
    } finally {
      if (inFlight.get(key) === turn) inFlight.delete(key)
    }
  }

  const out = new Map<NeuronId, Position>()
  for (const id of neuronIds) {
    const position = held.get(id)
    if (position) out.set(id, position)
  }
  return out
}

async function ask(
  server: string,
  datastack: string,
  version: number,
  table: string,
  ids: readonly NeuronId[],
  options: CaveRequestOptions,
): Promise<Map<NeuronId, Position | null>> {
  const rows = await queryTableChecked(
    server,
    datastack,
    version,
    {
      table,
      filters: { in: { pt_root_id: [...ids] } },
      columns: ['id', 'pt_root_id', 'pt_position'],
      resolution: [1, 1, 1],
    },
    { consequence: 'Some neurons would be missing their soma.' },
    options,
  )
  const found = new Map<NeuronId, Position | null>()
  for (const row of rows) {
    // `idText`, never `String`: an id that ever arrived as a double would be a different neuron
    // with nothing to say so (invariant 8).
    const root = idText(row['pt_root_id'] ?? null)
    if (!root) continue
    // A second nucleus under one root is a merge, which has no one soma.
    found.set(
      root,
      found.has(root)
        ? null
        : [
            Number(row['pt_position_x']),
            Number(row['pt_position_y']),
            Number(row['pt_position_z']),
          ],
    )
  }
  return found
}
