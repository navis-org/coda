/**
 * What an output port's hover preview says about the value sitting on it.
 *
 * Headless and pure — the panel that draws this is `PortPreviewPanel`, and everything decided
 * here is decided from the value alone. That split is what lets the whole table of answers be
 * asserted without jsdom, which matters because there are twelve value kinds and eleven of them
 * are reachable from one hover.
 *
 * **The headline is `describeValue`, not a second spelling of it.** That string is already the
 * card's own footer, so a preview whose first line disagreed with the line under the card it is
 * hanging off would be two answers to one question. What this adds is the two things a footer
 * cannot carry: the *facts* a count implies nothing about, and the *first rows* — which is the
 * whole point of the feature, since "what is actually in this column" is the question a schema
 * readout has never been able to answer.
 *
 * **A network is two tables, and that is why `rows` is a list.** Its nodes and its edges are
 * separate tables with separate schemas, and a preview that showed one of them would show the
 * wrong one about half the time. Geometry is the same shape one level down: a skeleton set's
 * attribute table is the collection's *own* table, which after a `Carry fields` join is not the
 * table that named the neurons — see `docs/nodes.md`.
 *
 * **Nothing here reads the graph, the store or the scheduler.** The value is handed in, already
 * cached; a preview never causes a fetch and never causes a run.
 */

import type { MatrixValue, NetworkValue, TableValue, Value } from '../../core/values'
import { describeValue } from '../../core/values'
import { formatCell, truncateLabel } from '../format'

/**
 * How many rows of a table are drawn.
 *
 * Five, because the panel is a transient thing beside a socket rather than a table viewer: it
 * answers "what does a row look like" and hands the rest to the Table node and the overlay,
 * which is the same division `TableSummary` draws.
 */
export const MAX_ROWS = 5

/**
 * The most columns drawn, before width is considered at all.
 *
 * A ceiling rather than the rule: which columns fit is decided by `fitColumns` below, because an
 * annotation table's sixty columns and a Paths table's four are different problems. This bounds
 * the intrinsic-width pass the panel's `<table>` does.
 */
export const MAX_COLUMNS = 6

/** How much of one cell is drawn before it is cut. Ids survive whole; free text does not. */
const MAX_CELL = 22

/**
 * How much of a long scalar reaches the DOM.
 *
 * `.port-preview__text` shows about 6.5em of it and hides the rest, but hiding is not the same
 * as not building: a Neuroglancer link is 70 kB, and handing that whole string to a box with
 * `overflow-wrap: anywhere` line-breaks a few thousand line boxes to paint six — synchronously,
 * because the panel measures itself before its first paint. The `Length` fact states the real
 * size, so cutting here costs nothing on screen.
 */
const TEXT_PREVIEW_CHARS = 600

/**
 * How wide the drawn columns may come to, in CSS pixels.
 *
 * **The panel counts what it drops and must therefore not drop anything else.** Fitting six
 * columns by CSS instead — `max-width` and `overflow: hidden` — cuts the last one mid-cell while
 * the footer underneath says "+1 more columns", which is a second truncation that nothing on
 * screen admits to. Measured in a browser at 1600×1000 on a neuron table: six columns wanted
 * ~420px in a 360px panel, and the sixth was half a column of digits with no header.
 *
 * So the panel is sized to its content up to `.port-preview`'s `max-width`, and the *content* is
 * what is bounded here. `pnpm probe:port-preview` is what keeps the two agreeing: it asserts the
 * drawn table never overflows the panel, which is the half this estimate cannot promise on its
 * own.
 */
const TABLE_BUDGET_PX = 396

/**
 * Width of one character at the panel's 11px, and the padding beside each column.
 *
 * An estimate, and deliberately a slight over-estimate: the panel's type is proportional, so a
 * column of `l`s is narrower than this says and a column of `W`s is wider. Erring high spends a
 * column that would have fitted; erring low is the clipped cell this whole budget exists to
 * prevent.
 */
const CHAR_PX = 6.4
const COLUMN_PAD_PX = 8

export interface PreviewFact {
  label: string
  value: string
}

export interface PreviewColumn {
  name: string
  /** Absent for a matrix, whose columns are labels rather than typed fields. */
  dtype?: string
  unit?: string
}

export interface PreviewRows {
  /** Names the table where a value has more than one. Absent where it has one. */
  caption?: string
  columns: PreviewColumn[]
  /** Row-major, already formatted for display. */
  cells: string[][]
  /** Columns and rows this value has that the panel is not drawing. Both are said out loud. */
  moreColumns: number
  moreRows: number
}

export interface PortPreview {
  /** `describeValue`'s line — the same one the card's footer draws. */
  headline: string
  facts: PreviewFact[]
  rows: PreviewRows[]
  /**
   * A long scalar, drawn as wrapped text rather than as a row.
   *
   * The Neuroglancer node emits a URL carrying a whole viewer state — 70 kB on male-CNS — which
   * `describeValue` elides to sixty characters because it is a one-line footer. Here there is
   * room to show the beginning of it, which is where the origin and the dataset are.
   */
  text?: string
}

/**
 * Build the preview for one realised value.
 *
 * Total over the `Value` union: every kind answers something, because a kind that fell through
 * to an empty panel would look exactly like the "nothing has run yet" case the hover is
 * deliberately silent about.
 */
export function portPreview(value: Value): PortPreview {
  const headline = describeValue(value)
  switch (value.kind) {
    case 'table':
    case 'neurons':
      return { headline, facts: [], rows: [previewRows(value)] }

    case 'network':
      return {
        headline,
        facts: [{ label: 'Direction', value: value.directed ? 'directed' : 'undirected' }],
        rows: networkRows(value),
      }

    case 'skeletons':
    case 'meshes':
    case 'points':
      // The attributes table *is* the summary of the items — one row per skeleton, per mesh, per
      // point — so there is nothing to add beside it that `describeValue` has not already said.
      return { headline, facts: [], rows: [previewRows(value.attributes)] }

    case 'matrix':
      return { headline, facts: matrixFacts(value), rows: [matrixRows(value)] }

    case 'linkage':
      /*
       * Leaves, method and cluster count are all in the headline already — `describeValue`
       * composes exactly that line — so the only fact here is the one it cannot say, because it
       * says it by *omission*: an absent `clusters` means the tree has not been cut, which is a
       * different statement from one cluster (see `LinkageValue.clusters`).
       */
      return {
        headline,
        facts: value.clusters ? [] : [{ label: 'Cut', value: 'not cut' }],
        rows: [],
      }

    case 'dataset':
      return {
        headline,
        facts: [
          { label: 'Backend', value: value.sourceId },
          { label: 'Dataset', value: value.datasetId },
          // Both are absent on an ordinary dataset and both change what every query node
          // downstream will do, so they are named where they are present and nowhere else.
          ...(value.annotations ? [{ label: 'Annotations', value: 'wired' }] : []),
          ...(value.edges ? [{ label: 'Connectivity', value: 'attached edge set' }] : []),
        ],
        rows: [],
      }

    /*
     * Three kinds whose whole answer is their headline.
     *
     * The first version drew facts here too — `Placed 312`, `Landmarks 48`, `Layers 3` — which
     * is `describeValue`'s own line taken apart and set again underneath itself, and a second
     * derivation of the same fields free to drift from it. A transform's `label` is the one
     * addition, and it is what the *card* is already called.
     */
    case 'layout':
    case 'transform':
    case 'layers':
      return { headline, facts: [], rows: [] }

    default: {
      // A scalar, whose headline *is* the value — so there is nothing to add unless it is a
      // string `describeValue` had to elide, in which case the head of it goes in `text`.
      const text = String(value.value)
      const long = typeof value.value === 'string' && text.length > 60
      if (!long) return { headline, facts: [], rows: [] }
      return {
        headline,
        facts: [{ label: 'Length', value: `${text.length.toLocaleString()} characters` }],
        rows: [],
        text: text.slice(0, TEXT_PREVIEW_CHARS),
      }
    }
  }
}

/** A network's two tables, each captioned, because neither one alone answers the question. */
function networkRows(value: NetworkValue): PreviewRows[] {
  return [
    { ...previewRows(value.nodes), caption: 'Nodes' },
    { ...previewRows(value.edges), caption: 'Edges' },
  ]
}

function previewRows(table: TableValue): PreviewRows {
  const candidates = table.schema.columns.slice(0, MAX_COLUMNS)
  const rowCount = Math.min(table.length, MAX_ROWS)
  const cells = Array.from({ length: rowCount }, (_, row) =>
    candidates.map((col) => cut(formatCell(table.data[col.name]?.[row] ?? null, col.name))),
  )
  const shown = fitCount(
    candidates.map((col, index) =>
      // The type sits *under* the name in the head, so a column is as wide as the wider of the
      // two, not as wide as both.
      widthOf(
        Math.max(col.name.length, col.dtype.length + (col.unit ? col.unit.length + 3 : 0)),
        cells,
        index,
      ),
    ),
  )
  return {
    columns: candidates
      .slice(0, shown)
      .map((col) => ({ name: col.name, dtype: col.dtype, unit: col.unit })),
    cells: cells.map((line) => line.slice(0, shown)),
    moreColumns: Math.max(0, table.schema.columns.length - shown),
    moreRows: Math.max(0, table.length - rowCount),
  }
}

/** Characters across the widest of a column's head and its drawn cells. */
function widthOf(head: number, cells: string[][], index: number): number {
  let chars = Math.max(head, 1)
  for (const line of cells) chars = Math.max(chars, line[index]?.length ?? 0)
  return chars
}

/**
 * How many columns fit, taken from the left.
 *
 * Left to right rather than by width: a table's leading columns are the ones a reader is looking
 * for — `neuronId`, `type` — and a fit that reordered them would answer a different question
 * from the one the Table node answers about the same value. Always at least one, since a single
 * column wider than the whole budget is still the only thing there is to show.
 *
 * A count rather than the columns themselves, because the answer is always a prefix and both
 * callers hold their columns and their cells in different shapes.
 */
function fitCount(widths: number[]): number {
  let used = 0
  for (let i = 0; i < widths.length; i++) {
    const next = used + widths[i]! * CHAR_PX + COLUMN_PAD_PX
    if (i > 0 && next > TABLE_BUDGET_PX) return i
    used = next
  }
  return widths.length
}

function matrixFacts(value: MatrixValue): PreviewFact[] {
  return [
    ...(value.valueLabel ? [{ label: 'Cells', value: value.valueLabel }] : []),
    // Absent means unknown rather than "not a distance" — see `MatrixMeasure`. Naming it only
    // where it was stated is what keeps that distinction on screen.
    ...(value.measure ? [{ label: 'Measure', value: value.measure }] : []),
  ]
}

/**
 * A matrix's top-left corner, with the row labels in a leading column.
 *
 * Labelled rather than bare because a matrix is the one value whose axes are named data: a grid
 * of numbers with no labels says nothing that `describeValue`'s dimensions have not already said.
 */
function matrixRows(value: MatrixValue): PreviewRows {
  const cols = value.colLabels.slice(0, MAX_COLUMNS - 1)
  const rowCount = Math.min(value.rowLabels.length, MAX_ROWS)
  const cells = Array.from({ length: rowCount }, (_, row) => [
    cut(value.rowLabels[row] ?? ''),
    ...cols.map((_, col) =>
      cut(formatCell(value.values[row * value.colLabels.length + col] ?? null)),
    ),
  ])
  const heads = ['', ...cols]
  const shown = fitCount(heads.map((head, index) => widthOf(head.length, cells, index)))
  return {
    columns: heads.slice(0, shown).map((name) => ({ name })),
    cells: cells.map((line) => line.slice(0, shown)),
    // `shown` counts the label column, which is not one of the matrix's own.
    moreColumns: Math.max(0, value.colLabels.length - (shown - 1)),
    moreRows: Math.max(0, value.rowLabels.length - rowCount),
  }
}

/** One cell's text, cut. `truncateLabel` in characters — the ellipsis rule has one home. */
function cut(text: string): string {
  return truncateLabel(text, MAX_CELL, 1)
}
