/**
 * What a CAVE datastack's neuron table looks like, and how that is learned.
 *
 * Same problem and same shape as `neuprint/schema.ts`: column schemas must be known at *edit*
 * time so pickers populate before anything runs, and inference may not await (invariant 2). So
 * discovery is a background fetch, cached per datastack, announced with `reportSourceLearned`;
 * until it lands the source answers with the canonical shape.
 *
 * What differs is where the answer comes from. neuPrint can be asked for a neuron and told what
 * properties it has. A CAVE annotation table is **long** — one row per (neuron, kind, value) —
 * so the column names are the *distinct values* of its `classification_system` column, and
 * `unique_string_values` is exactly that question: 52 kB and about a second on
 * `hierarchical_neuron_annotations`, against tens of megabytes for the annotations themselves.
 * That cheapness is the whole reason discovery and the neuron index can be separate steps.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { SourceSchemas } from '../source'
import { CANONICAL_SCHEMAS } from '../source'

/**
 * CAVE's name for a column → Coda's, wherever the two differ.
 *
 * Two entries, and they are the whole seam — the same one `PROPERTY_NAMES` is on the neuPrint
 * side, for the same reason. A neuron table's id column has to be Coda's word because it is the
 * one column every node addresses *by name*; `type` is the second, being what `profileStats`
 * and the Connectivity node's `preType`/`postType` are built from.
 *
 * **Everything else keeps CAVE's spelling**, and that is deliberate rather than lazy: a
 * passthrough column is only ever named by a column picker, so `super_class` and `cell_class`
 * arrive as themselves exactly as neuPrint's `cellBodyFiber` does. A source that renamed
 * everything into some house style would be inventing vocabulary nobody can look up.
 */
const COLUMN_NAMES: Record<string, string> = {
  pt_root_id: ID_COLUMN_NAME,
  cell_type: 'type',
}

/** What Coda calls a CAVE column. Identity for everything but the id and the cell type. */
export function codaColumn(caveName: string): string {
  return COLUMN_NAMES[caveName] ?? caveName
}

/**
 * The neuron schema for a datastack, given the annotation kinds it publishes.
 *
 * `neuronId` is **`str`**, not `i64`, and that is the point of invariant 8 reaching this far: a
 * root id is eighteen digits, so an `i64` column — a float64 in truth — holds a different
 * neuron. What it costs is numeric sorting of ids and their appearance in numeric pickers,
 * neither of which is a loss: nobody sums a root id, and `isIdentifierColumn` already prints
 * one verbatim rather than grouping it.
 *
 * `type` leads the annotation columns when it exists, because it is the canonical one and the
 * one a picker should offer first. The rest are alphabetical, so the same datastack produces
 * the same schema on every connect — a schema that reshuffled would reshuffle every column
 * picker with it.
 */
export function neuronSchemaFor(systems: readonly string[]): TableSchema {
  const named = [...new Set(systems.map(codaColumn))]
  const rest = named.filter((n) => n !== 'type').sort()
  const ordered = named.includes('type') ? ['type', ...rest] : rest
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...ordered.map((name) => column(name, 'str')),
  )
}

/**
 * The full `SourceSchemas` for a datastack.
 *
 * Every table that names a neuron has its id columns widened to `str`, which is the one edit
 * invariant 8 forces on this source. Beyond that each is the canonical shape minus what CAVE
 * does not publish, because a schema is a promise about what a query returns: `morphology`
 * drops `instance`, `status`, `size` and `cableLength` — a graphene mesh carries none of them,
 * and advertising a column that arrives null on every row breaks every picker that believed it.
 *
 * `roiCounts` stays canonical and unreachable: `capabilities.roiCounts` is false, so nothing
 * ever asks.
 */
export function schemasFor(neurons: TableSchema): SourceSchemas {
  return {
    ...CANONICAL_SCHEMAS,
    neurons,
    connectivity: tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('neuronType', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('weight', 'i64', 'synapses'),
    ),
    morphology: tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('type', 'str'),
      column('points', 'i64'),
    ),
    /*
     * Narrowed to the four columns a CAVE synapse row can actually fill — no `type` or
     * `partnerType`, which the synapse table does not carry and which would arrive null on every
     * row of a cloud with tens of thousands of them. Two dead entries in every colour picker on
     * a Synapses node, for the sake of matching a canonical shape. `neuprint/schema.ts` narrows
     * its own for the same reason.
     */
    synapses: tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('partnerId', 'str'),
      column('polarity', 'str'),
      // The cleft score, where the table has one: a per-synapse confidence rather than a count,
      // which is what `weight` means on a *connection*. Named `weight` because that is the
      // column every encoding and every viewer already reaches for on a point cloud.
      column('weight', 'f64'),
    ),
  }
}

/**
 * The shape a datastack has before discovery lands.
 *
 * `neuronId` alone rather than the canonical seven: a schema is a promise about what a query
 * will return, and advertising `status` and `size` on a source that has neither would empty
 * every picker pointing at them the moment a real one arrived. One column is honest and still
 * types the wire, so a link still connects and the id picker still works.
 */
export function defaultSchemas(): SourceSchemas {
  return schemasFor(tableSchema(column(ID_COLUMN_NAME, 'str')))
}
