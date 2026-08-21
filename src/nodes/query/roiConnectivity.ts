import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { MatrixValue, TableValue } from '../../core/values'
import { getColumn, makeMatrix } from '../../core/values'
import { ROI_CONNECTIVITY_SCHEMA, capabilityOf } from '../../data/source'
import { requireDataset, sourceLabel, sourceSupports } from '../lib/datasetParam'

/**
 * Which regions of a dataset talk to which.
 *
 * The coarsest possible view of a connectome — a few dozen regions rather than a hundred
 * thousand neurons — and neuPrint precomputes it, so it costs one small request and answers
 * before any per-neuron query would have started. The picture a Network or a Heatmap draws
 * from this is the one worth looking at before deciding which neurons to ask about.
 *
 * **Two outputs describing one fetch**, exactly `core.pivot`'s arrangement and for the same
 * reasons. `Matrix` is what the Heatmap takes and is a dead end for every table op, since a
 * matrix carries no schema; `Links` is the same data long, which sorts, filters, joins and
 * exports. The matrix is *reshaped from* the table rather than built alongside it, so the two
 * cannot disagree about labels, ordering or which measure they are showing.
 *
 * `Matrix` stays first, so a link dragged off the node starts there and the footer's summary
 * reads `N × M`.
 */

/**
 * Which published number the matrix cells carry.
 *
 * Both travel in the table; this decides only what gets reshaped. The default is `count`
 * because it is the one whose meaning is settled: neuPrint publishes `weight` alongside it and
 * the two are *not* the same measure in different units — on hemibrain `AB(L)→BU(L)` reports
 * `count: 13, weight: 3.11`, so weight is scaled or normalised rather than additive. Offering
 * it is right, because it is what the server said; defaulting to it would put a number on a
 * legend without being able to say what the number is.
 */
const MEASURES = [
  { value: 'count', label: 'Connections' },
  { value: 'weight', label: 'Weight (as published)' },
] as const

export const roiConnectivityNode = registerNode({
  type: 'neuron.roiConnectivity',
  label: 'ROI Connectivity',
  category: 'query',
  description: 'Region-to-region connectivity for the whole dataset, as a matrix and a table.',
  guide:
    'Region-to-region connectivity for the whole dataset, precomputed on neuPrint’s side, so a whole connectome answers in a few hundred kilobytes. Emits both a matrix for the Heatmap and a long table for everything else. The matrix carries count, which is a synapse count and unambiguous; the table also carries neuPrint’s weight, which is scaled or normalised in a way that is not documented — treat it as the server’s number rather than as synapses.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [
    { id: 'matrix', label: 'Matrix', type: T.matrix() },
    { id: 'links', label: 'Links', type: T.table(ROI_CONNECTIVITY_SCHEMA) },
  ],
  params: [
    {
      id: 'measure',
      kind: 'enum',
      label: 'Cells',
      help: 'Which published number fills the matrix. Both are always in the Links table.',
      default: 'count',
      options: MEASURES.map((m) => ({ value: m.value, label: m.label })),
    },
  ],

  inferOutputs: () => ({
    matrix: T.matrix(),
    links: T.table(ROI_CONNECTIVITY_SCHEMA),
  }),

  validate: (ctx) => {
    if (!sourceSupports(ctx, 'roiSummary')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      return [`${label} does not publish a region connectivity summary`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const fetch = source.fetchRoiConnectivity?.bind(source)
    if (!fetch || !capabilityOf(source, dataset.datasetId, 'roiSummary')) {
      throw new Error(`${source.label} does not publish a region connectivity summary`)
    }

    ctx.progress(0.2, 'regions')
    const links = await fetch({ datasetId: dataset.datasetId, signal: ctx.signal })
    const measure = String(ctx.params.measure ?? 'count')
    const label = MEASURES.find((m) => m.value === measure)?.label ?? measure

    return { matrix: linksToMatrix(links, measure, label), links }
  },
})

/**
 * Reshape the long form into a square matrix over every region either end names.
 *
 * Three decisions, each of which would otherwise produce a picture that is quietly wrong.
 *
 * **The axes are the union of both ends, sorted.** A region that only ever receives would
 * otherwise be missing from the row axis and a matrix would not be square, so a heatmap's
 * diagonal would stop meaning self-connection. Sorted rather than left in the response's order,
 * which is arbitrary: this value reaches a provenance key, and axes that shuffled between runs
 * would invalidate everything downstream for nothing.
 *
 * **An absent pair is 0, though the table has no row for it.** hemibrain publishes 3,416 pairs
 * over 63 regions against 3,969 possible, so a fifth of the cells were never returned. In a
 * *table* those rows are rightly absent — nothing was measured — but a matrix cell has to hold
 * something, and 0 is what "no connection found" means once a grid exists.
 *
 * **A null measure is 0 too, for the same reason,** rather than `NaN`, which would propagate
 * through the heatmap's own scaling and blank the whole picture.
 */
export function linksToMatrix(
  links: TableValue,
  measure: string,
  valueLabel: string,
): MatrixValue {
  const source = getColumn(links, 'source')
  const target = getColumn(links, 'target')
  const values = getColumn(links, measure === 'weight' ? 'weight' : 'count')

  const labels = [
    ...new Set([...source, ...target].filter((v): v is string => typeof v === 'string')),
  ].sort()
  const index = new Map(labels.map((label, i) => [label, i]))

  const cells = new Float64Array(labels.length * labels.length)
  for (let row = 0; row < links.length; row++) {
    const from = index.get(String(source[row]))
    const to = index.get(String(target[row]))
    if (from === undefined || to === undefined) continue
    const value = Number(values[row])
    cells[from * labels.length + to] = Number.isFinite(value) ? value : 0
  }

  return makeMatrix(labels, [...labels], cells, valueLabel)
}
