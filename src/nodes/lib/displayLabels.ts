/**
 * Names for things a value knows only by label.
 *
 * A `MatrixValue` axis is two `string[]`s and a `LinkageValue`'s leaves are one, so by the time
 * a tree reaches a viewer every neuron is whatever named the matrix — a root id, on every route
 * into Linkage but NBLAST's. The annotation that would make it readable is one wire away and
 * one join away: a neuron table carries `neuronId` and `type` beside each other, and matching
 * the leaf's own label against the id column is the whole operation.
 *
 * **What a caller does with the answer is the caller's decision, and the two callers differ.**
 * This resolves what a thing is *called*; it does not decide whether the name is a drawing or
 * the value. `out.dendrogram` draws it and leaves the tree's own labels alone, which is what
 * keeps `Selected → Selected to Neurons` working on a tree labelled by cell type. `out.heatmap`
 * writes it into the matrix, because its Filter tab matches on axis labels and its Order tab
 * sorts by them — a name on screen that those two cannot see would be the worse kind of wrong,
 * since the picture looks right. See the header of each node for its own argument, and
 * `docs/viewers.md` for why one operation ends in two places.
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

import { ID_COLUMN_NAME } from '../../core/ids'
import type { InferContext, ParamDef } from '../../core/node'
import { findColumn } from '../../core/types'
import type { TableSchema } from '../../core/types'
import { schemaOf } from '../../core/types'
import type { TableValue } from '../../core/values'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
import { labelsByNeuron } from './typeMapping'

/**
 * The name to draw for each label a value carries, or `undefined` where nothing can name them.
 *
 * **Four ways to answer nothing, and they are all the same answer on purpose**: no table wired,
 * either picker unset, or either column absent from the table that did arrive. A caller draws
 * the labels the value arrived with in every one of them, which is the honest degradation —
 * invariant 5's corollary, applied to a pair of pickers that name things.
 *
 * The `findColumn` pair is what turns the last of those from a throw into an answer:
 * `labelsByNeuron` reads through `getColumn`, which is right for a node that has validated its
 * pickers and wrong for a viewer asked to draw whatever is on the wire this frame.
 *
 * A `Map` rather than an accessor object, so the caller decides in one place what an absent
 * name means. Both callers answer "keep the label it had", which inverts `core.relabel`'s
 * `Unmatched` default because a blank leaf is strictly worse than the id it replaced — and on a
 * matrix axis, worse again: blanks collide, and the Filter box can no longer address the lines
 * that took one.
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
  const key = `${matchColumn}\u0000${labelColumn}`
  const held = JOINS.get(table)
  const cached = held?.get(key)
  if (cached) return cached
  const names = labelsByNeuron(table, matchColumn, labelColumn)
  if (held) held.set(key, names)
  else JOINS.set(table, new Map([[key, names]]))
  return names
}

/**
 * The join, held against the table it read.
 *
 * `labelsByNeuron` is an `idText` call and a `Map` insert per row, and both callers ask for it
 * far more often than the answer changes: `out.heatmap` re-joins on every keystroke in its
 * Filter box, since a `cheap` node re-runs on every edit, and `out.dendrogram` builds it during
 * *render*, so a hover over a tree re-walks the neuron table that named it. On a real annotation
 * table that is 10⁵–10⁶ conversions thrown away per pointer sample.
 *
 * A `WeakMap` on the table's identity, keyed inside by the column pair, so it is collected with
 * the value and a new upstream result recomputes — `rowFields.ts`' `slotCache` idiom, which the
 * heatmap's own `cornersByBucket` and `gridImage` already follow one directory over. Two
 * unrelated columns of one table cost two entries, which is the arrangement that makes trying
 * `type`, then `instance`, then `hemilineage` free the second time round.
 */
const JOINS = new WeakMap<TableValue, Map<string, Map<string, string>>>()

// ---------------------------------------------------------------------------
// The port around the join
// ---------------------------------------------------------------------------

/**
 * The two pickers, for a node that names things from a wired table.
 *
 * `colorParams`/`sizeParams` in `encodingParams.ts` are the idiom, and this is here rather than
 * there because the defaults and the `optional: true` argument are facts about *this join*: the
 * pair is meaningless without `displayLabels` above, and it was the second node re-stating them
 * that made a factory worth having.
 *
 * **Both `optional`, and that is the load-bearing half rather than a shrug.** `resolveColumn`'s
 * rule 3 substitutes the *first compatible column* for a required picker whose declared default
 * the schema lacks, which here would name every line after whatever column happens to come first
 * in somebody's annotation table — silently, and plausibly. `optional` answers "off" instead, and
 * off keeps the labels the value arrived with. The declared defaults still land at creation
 * through `defaultParams`, so wiring a neuron table and getting cell types needs nothing set; and
 * a graph stored before the port existed has neither key, reads as off, and produces exactly what
 * it produced before — absence and the default agreeing, which is why this is not `absentMeans`'
 * case.
 */
export function labelPickerParams(options: {
  /** Which tab they sit in, where the node has tabs. */
  group?: string
  /** True where the names are a drawing rather than the value — `out.dendrogram`. */
  presentational?: boolean
  matchHelp: string
  labelHelp: string
}): ParamDef[] {
  const shared = {
    kind: 'column' as const,
    from: 'annotations',
    optional: true,
    ...(options.group ? { group: options.group } : {}),
    ...(options.presentational ? { presentational: true } : {}),
  }
  return [
    {
      ...shared,
      id: 'matchColumn',
      label: 'Match on',
      default: ID_COLUMN_NAME,
      help: options.matchHelp,
    },
    {
      ...shared,
      id: 'labelColumn',
      label: 'Label by',
      default: TYPE_COLUMN_NAME,
      help: options.labelHelp,
    },
  ]
}

/**
 * What a wired-but-useless Annotations port can be told at edit time.
 *
 * Three checks, and the middle one is why this is worth sharing rather than the two nodes each
 * writing it: a numeric id column presents *identically to having wired nothing*, so the
 * sentence explaining invariant 8 is the load-bearing part and a fix to it has to land once.
 *
 * Nothing here can tell an unannotated value from a mistyped one — the labels are data the run
 * decides — so what is checkable is the *table*. `noun` is what the caller calls a line, since
 * that is the whole of what differs between a tree's leaves and a matrix's rows and columns.
 */
export function labelPickerIssues(
  ctx: Pick<InferContext, 'inputs' | 'column'>,
  noun: { plural: string; singular: string },
): string[] {
  const annotations: TableSchema | undefined = schemaOf(ctx.inputs.annotations)
  // A port that is not wired is not a port whose columns are missing, and unwired is the
  // ordinary state. Nothing to say until a table has actually arrived.
  if (!annotations) return []

  const match = ctx.column('matchColumn')
  const label = ctx.column('labelColumn')
  if (!match || !label) {
    return [
      `Annotations is wired but Match on and Label by are not both set, so the ${noun.plural} ` +
        `keep the labels the matrix arrived with`,
    ]
  }

  const issues: string[] = []
  const key = findColumn(annotations, match)
  if (key && key.dtype !== 'str') {
    /*
     * `relabelTable`'s warning, one node over and for the same reason: this is never fatal,
     * because a narrow id read as a number still resolves. What it is about is the wide one — an
     * 18-digit root id in an `i64` column is a float64 that has already lost the digits
     * identifying it, so `idText` **drops** it rather than naming whichever neuron owns the
     * rounded value (invariant 8). The line keeps its own label, which is indistinguishable from
     * having wired no annotations at all: hence a line here rather than silence.
     */
    issues.push(
      `"${match}" is ${key.dtype} — a wide neuron id read as a number has already lost the ` +
        `digits that identified it, so those ${noun.plural} keep their own labels ` +
        `(see invariant 8)`,
    )
  }
  if (match === label) {
    issues.push(
      `Match on and Label by are both "${match}" — every ${noun.singular} keeps its own name`,
    )
  }
  return issues
}
