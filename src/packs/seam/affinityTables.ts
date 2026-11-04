/**
 * The two tables the node publishes, each as the schema/value pair invariant 3 asks for.
 *
 * `affinityTables.test.ts` holds each pair to its partner. The agreement matters more here than
 * usual because both schemas are folded over an upstream one: a column written under a name the
 * schema half spelled differently does not throw, it simply never reaches a picker.
 *
 * **One summary, published twice.** The per-neuron numbers are folded into the `Skeletons`
 * output's attributes *and* handed out as the `Table` output, and both come from this one pair.
 * That is what makes `Split Neurons` work on "more than one cluster" with nothing new: a split
 * reads the attribute table, so the finding has to be a column on it rather than only a
 * standalone table beside it.
 *
 * **Cluster is a word on the points and a number on the nodes**, and the asymmetry is forced:
 * `SkeletonGeometry.nodeValues` holds `Float32Array`s, while a point's cluster is categorical and
 * a numeric one would be drawn on a continuous ramp. Each channel gets the form its consumer can
 * read; `clusterName` is the one spelling of the word half.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'
import type { NeuronSummary } from './affinityOps'

/*
 * The column names, by the spellings the help document uses. Module-local: the schema halves
 * below are the module's interface, and a caller naming a column reaches for one of those.
 */
const CLUSTERS_COLUMN = 'clusters'
const BACKGROUND_SHARE_COLUMN = 'backgroundShare'
const CONFIDENCE_COLUMN = 'confidence'
const LOWEST_CONFIDENCE_COLUMN = 'lowestConfidence'
const POINT_CLUSTER_COLUMN = 'cluster'
const POINT_NODE_COLUMN = 'node'

const SUMMARY_COLUMNS = [
  column(CLUSTERS_COLUMN, 'i64'),
  column(BACKGROUND_SHARE_COLUMN, 'f64'),
  column(CONFIDENCE_COLUMN, 'f64'),
  column(LOWEST_CONFIDENCE_COLUMN, 'f64'),
]

/**
 * A cluster number as the word a legend shows. Background is named rather than left null: "the
 * model was not confident about anything here" is a finding, and a null reads as a gap.
 */
export function clusterName(label: number): string {
  return label === 0 ? 'background' : `cluster ${label}`
}

/**
 * The summary's schema half: the neurons' own columns with the four folded in.
 *
 * `cluster`, not `merge`: these are counts of what the clustering found, and a `seam:findMerges`
 * node with a summary of its own is being built — `mergeSummaryTable` in this file would then
 * mean "the cluster node's table", which is the most confusing residue available.
 */
export function clusterSummarySchema(schema: TableSchema | undefined): TableSchema {
  return foldColumns(schema ?? tableSchema(), SUMMARY_COLUMNS)
}

/**
 * The summary's value half: `attributes` with one row's worth of numbers per neuron.
 *
 * `summaries` is index-aligned with the attribute rows, `undefined` where a neuron was skipped —
 * which reads as null in every column rather than as zero clusters, because a skeleton nobody
 * asked the model about has not been found to hold one neuron.
 */
export function clusterSummaryTable(
  attributes: TableValue,
  summaries: readonly (NeuronSummary | undefined)[],
): TableValue {
  const schema = clusterSummarySchema(attributes.schema)
  const data: Record<string, ColumnData> = { ...attributes.data }
  // `Array.from`, never `summaries.map`: a caller that built its array with `new Array(n)` and
  // filled only some slots hands us a **sparse** one, and `map` preserves holes — so the skipped
  // neurons' cells would read `undefined` rather than the null promised just above, with the
  // column still the right length and nothing thrown. `Array.from` reads every index.
  const column = (read: (summary: NeuronSummary) => CellValue): ColumnData =>
    Array.from({ length: summaries.length }, (_, i) => {
      const summary = summaries[i]
      return summary ? read(summary) : null
    })
  data[CLUSTERS_COLUMN] = column((s) => s.clusters)
  data[BACKGROUND_SHARE_COLUMN] = column((s) => s.backgroundShare)
  data[CONFIDENCE_COLUMN] = column((s) => s.confidence)
  data[LOWEST_CONFIDENCE_COLUMN] = column((s) => s.lowestConfidence)
  return makeTable(schema, data, attributes.kind)
}

/**
 * The sampled cloud's schema half.
 *
 * Four columns and no carry param: these points are the model's own input, not a general-purpose
 * cloud, and a reader wanting cell types on them has `core.join` and the `neuronId` to join on.
 */
export function affinityPointsSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column(POINT_NODE_COLUMN, 'i64'),
    column(POINT_CLUSTER_COLUMN, 'str'),
    column(CONFIDENCE_COLUMN, 'f64'),
  )
}

/** One neuron's drawn points, ready to be concatenated into the cloud. */
export interface PointRows {
  readonly neuronId: string
  readonly sourceIndex: Int32Array
  readonly labels: Int32Array
  readonly confidence: readonly (number | null)[]
}

/** The sampled cloud's value half, over every neuron that ran. */
export function affinityPointsTable(neurons: readonly PointRows[]): TableValue {
  const schema = affinityPointsSchema()
  const ids: CellValue[] = []
  const nodes: CellValue[] = []
  const clusters: CellValue[] = []
  const confidence: CellValue[] = []
  // One string per *distinct* label rather than one per point: a neuron has a handful of
  // clusters and 1,024 points, and `ColumnData` holds a reference per cell, so minting a fresh
  // string per row retains tens of thousands of copies of a dozen words.
  const named = new Map<number, string>()
  for (const neuron of neurons) {
    for (let i = 0; i < neuron.labels.length; i++) {
      const label = neuron.labels[i]!
      let word = named.get(label)
      if (word === undefined) named.set(label, (word = clusterName(label)))
      ids.push(neuron.neuronId)
      nodes.push(neuron.sourceIndex[i]!)
      clusters.push(word)
      confidence.push(neuron.confidence[i] ?? null)
    }
  }
  return makeTable(schema, {
    [ID_COLUMN_NAME]: ids,
    [POINT_NODE_COLUMN]: nodes,
    [POINT_CLUSTER_COLUMN]: clusters,
    [CONFIDENCE_COLUMN]: confidence,
  })
}
