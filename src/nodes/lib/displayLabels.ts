/**
 * Names for things a value knows only by label.
 *
 * A `MatrixValue` axis is two `string[]`s and a `LinkageValue`'s leaves are one, so by the time
 * a tree reaches a viewer every neuron is whatever named the matrix — a root id, on every route
 * into Linkage but NBLAST's. The annotation that would make it readable is one wire away and
 * one join away: a neuron table carries `neuronId` and `type` beside each other, and matching
 * the leaf's own label against the id column is the whole operation.
 *
 * **This is a drawing, not data.** It resolves what a leaf is *called on screen*; nothing here
 * touches the value, the tree's own labels, or the identity a downstream node matches on. That
 * split is what keeps `Selected → Selected to Neurons` working with a dendrogram labelled by
 * cell type — see the header of `nodes/output/dendrogram.ts` for the argument, and
 * `docs/viewers.md` for why the Heatmap deliberately does *not* get the same port.
 *
 * **The join itself is `labelsByNeuron`**, which is the same operation under the same two rules
 * and already has three callers — an id column and a label column of *some* table, resolved
 * through `idText`, first wins, a blank is no label. What is left here is the guard: four ways
 * of having nothing to look anything up in, which that function would answer by throwing.
 *
 * Headless, so the arithmetic is testable without a DOM — the standing `dendrogramLayout.ts`
 * has, one directory over, and the one `profileStats.ts` and `datasetStats.ts` already have in
 * this one. The exporters reach the *same* semantics by a different road: they emit
 * `coda_relabel`, which is `firstByKey`'s rule and `idText`'s written once each in Python and R,
 * rather than importing anything from here.
 */

import { findColumn } from '../../core/types'
import type { TableValue } from '../../core/values'
import { labelsByNeuron } from './typeMapping'

/**
 * The name to draw for each label a value carries, or `undefined` where nothing can name them.
 *
 * **Four ways to answer nothing, and they are all the same answer on purpose**: no table wired,
 * either picker unset, or either column absent from the table that did arrive. A caller draws
 * the value's own labels in every one of them, which is the honest degradation — invariant 5's
 * corollary, applied to a control that only decorates.
 *
 * The `findColumn` pair is what turns the last of those from a throw into an answer:
 * `labelsByNeuron` reads through `getColumn`, which is right for a node that has validated its
 * pickers and wrong for a viewer asked to draw whatever is on the wire this frame.
 *
 * A `Map` rather than an accessor object, so the caller decides in one place what an absent
 * name means — here it is "keep the leaf's own label", which inverts `core.relabel`'s
 * `Unmatched` default because a blank leaf is strictly worse than the id it replaced.
 */
export function displayLabels(
  table: TableValue | undefined,
  matchColumn: string | undefined,
  labelColumn: string | undefined,
): Map<string, string> | undefined {
  if (!table || !matchColumn || !labelColumn) return undefined
  if (!findColumn(table.schema, matchColumn) || !findColumn(table.schema, labelColumn)) {
    return undefined
  }
  return labelsByNeuron(table, matchColumn, labelColumn)
}
