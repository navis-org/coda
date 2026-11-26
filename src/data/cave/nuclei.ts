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
 *
 * ## At each root's own moment (`somataLive`)
 *
 * A root made after the last materialization has no row in any of them, and reads as "no
 * nucleus" — which is how a neuron being proofread looks, since every merge makes a new root
 * (`docs/seam-live-plan.md`). So a reader of a neuron somebody is editing asks the **live** table
 * instead, at the last moment each root was current (`rootLives`). Remembered for the session
 * too, and for the same reason: while a root is current its supervoxels do not change, so its
 * nucleus row is the same at any moment of its life.
 */

import { groupBy } from '../../core/collections'
import type { NeuronId } from '../../core/ids'
import { idText } from '../../core/ids'
import { queryTableChecked, queryTableLive } from './api'
import type { CaveRequestOptions, CaveRow } from './client'
import { deploymentKey } from './deployments'
import type { GrapheneSource } from './graphene'
import { rootLives } from './rootIds'

type Position = readonly [number, number, number]

/** Per materialization: each root asked about, and its soma or `null` for none. */
const known = new Map<string, Map<NeuronId, Position | null>>()
const inFlight = new Map<string, Promise<unknown>>()

/** Drop what this module remembers. Reached through `resetCaveState`. */
export function resetNuclei(): void {
  known.clear()
  inFlight.clear()
}

/** The columns and units every nucleus read asks for, and the cost of one coming back short. */
const COLUMNS = ['id', 'pt_root_id', 'pt_position']
const NANOMETRES = [1, 1, 1] as const
const CONSEQUENCE = { consequence: 'some neurons would be missing their soma' }

/** Each id's soma in nanometres, where it has exactly one nucleus. */
export function somataFor(
  server: string,
  datastack: string,
  version: number,
  table: string,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions,
): Promise<Map<NeuronId, Position>> {
  return remembered(`${datastack}|${version}|${table}`, neuronIds, options, async (ids) =>
    positionsOf(
      await queryTableChecked(
        server,
        datastack,
        version,
        {
          table,
          filters: { in: { pt_root_id: [...ids] } },
          columns: COLUMNS,
          resolution: NANOMETRES,
        },
        CONSEQUENCE,
        options,
      ),
    ),
  )
}

/** `somataLive`'s answer: the somata, and what a reader should be told about the roots. */
export interface LiveSomata {
  readonly somata: Map<NeuronId, Position>
  /**
   * Roots no longer current, each with the last moment it was, epoch ms. Its soma, where it has
   * one, was read as it was then — the neuron as somebody saw it, not as it is now.
   */
  readonly replaced: Map<NeuronId, number>
  /** Ids the chunkedgraph never made. Nothing was read for them. */
  readonly unknown: NeuronId[]
}

/**
 * Each id's soma in nanometres, read from the **live** table at the last moment its root was
 * current — for a node that follows its query neuron rather than a materialization.
 *
 * **Every root still current is read in one query**, at the earliest of their `last` moments —
 * a moment each of them was current at, where it was made before it, which `rootLives` asking
 * when roots were made before anything else makes so; a root made later is read at its own
 * moment rather than trusted to it. Grouped by their exact moments instead, a server that stamps
 * each root on its own would cost a query per neuron. A replaced root is read at its own moment,
 * and roots one merge replaced share it. (A moment a little ahead of the materialization
 * service's clock is fine: it answered for two minutes ahead, 2026-11-17.)
 *
 * `rootLives` is asked on every call, even where every soma is remembered: whether a root has
 * been replaced since is the one thing here that changes. A caller whose result is cached does
 * not call, and its reader keeps what the run that made it said.
 *
 * **An absence is not remembered here**, where the materialized read remembers it: a frozen
 * table cannot gain a row, and the live one can — a nucleus annotated after the first run.
 */
export async function somataLive(
  server: string,
  graphene: GrapheneSource,
  datastack: string,
  table: string,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions,
): Promise<LiveSomata> {
  const { lives, unknown } = await rootLives(graphene, neuronIds, options)
  const replaced = new Map<NeuronId, number>()
  let now = Infinity
  for (const [root, life] of lives) {
    if (life.current) now = Math.min(now, life.last)
    else replaced.set(root, life.last)
  }
  const momentOf = (id: NeuronId) => {
    const life = lives.get(id)!
    return !life.current ? life.last : life.made <= now ? now : life.last
  }

  const somata = await remembered(
    `${datastack}|live|${table}`,
    [...lives.keys()],
    options,
    async (ids) => {
      const rows: CaveRow[] = []
      // In turn, as everything that asks a shared server in this directory does.
      for (const [at, group] of groupBy(ids, momentOf)) {
        rows.push(
          ...(await queryTableLive(
            server,
            datastack,
            at,
            { table, idsIn: { pt_root_id: group }, columns: COLUMNS, resolution: NANOMETRES },
            CONSEQUENCE,
            options,
          )),
        )
      }
      return positionsOf(rows)
    },
    { keepAbsent: false },
  )
  return { somata, replaced, unknown }
}

/**
 * The session's memory of somata under `scope`, asking `fetch` only for ids it does not hold.
 *
 * **A call arriving while another is in flight waits for it** — the module header's rule, shared
 * by both reads so neither can lose it.
 *
 * `keepAbsent: false` holds only roots the table answered for — a soma, or `null` for two — and
 * asks again about the rest each time.
 */
async function remembered(
  scope: string,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions,
  fetch: (ids: readonly NeuronId[]) => Promise<Map<NeuronId, Position | null>>,
  { keepAbsent = true } = {},
): Promise<Map<NeuronId, Position>> {
  const key = deploymentKey(options.deployment, scope)
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
      const found = await fetch(unknown)
      for (const id of unknown) {
        const position = found.get(id)
        if (position !== undefined || keepAbsent) held.set(id, position ?? null)
      }
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

/** Each root's soma out of nucleus rows, `null` for a root holding more than one. */
function positionsOf(rows: readonly CaveRow[]): Map<NeuronId, Position | null> {
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
