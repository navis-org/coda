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
 * The most fields drawn down the panel, across every table in it.
 *
 * **The panel is turned ninety degrees: a table's columns run down it and its first rows run
 * across.** Which columns a value carries is the thing a reader cannot get anywhere else — a
 * count is on the card already, and the values themselves are the Table node's job — and read
 * across the page a wide table spends the whole width on four of them. Down the page a schema is
 * a list, which is `TableSummary`'s finding on a surface with the same shape.
 *
 * So this is a *height* budget where `TABLE_BUDGET_PX` is a width one. Divided between the
 * tables in a panel, because a network draws two and 48 rows is taller than the window; the
 * remainder is counted and said out loud like everything else the panel does not draw.
 */
export const MAX_FIELDS = 24

/**
 * How many of a table's rows are drawn across: **one, always**.
 *
 * A fixed number rather than as many as fit, and the fixed number is one, for a reason that is
 * not taste. The first pivot spent whatever width the field names left over, which drew four
 * sample rows on a two-column table, two on a neuron table and none on a table with no rows at
 * all — so the same feature looked like three different features depending on the value under
 * the pointer, and the arithmetic behind that was invisible.
 *
 * One is the count that always fits: a field name, its type and one value come to 408px at their
 * widest against a budget of 416, where a *second* value column would have to be paid for by
 * cutting the first — and the cell most often under a pointer here is an eighteen-digit id,
 * which invariant 8 says is not an id once it is truncated. So the choice was between one honest
 * example and two mutilated ones.
 *
 * It is also `TableSummary`'s answer on the surface with the same shape and the same job: a
 * schema readout with an example, where reading the table itself belongs to the Table node and
 * the overlay.
 */
const TABLE_ROWS = 1

/**
 * How many of a matrix's columns are drawn across.
 *
 * More than a table's one because a matrix is not a schema — a single column of a grid says
 * nothing about it — and it can afford them: its labels are short and its cells are numbers,
 * where a table pays for a name and a type before it reaches a value.
 */
const MATRIX_COLUMNS = 4

/** How much of one cell is drawn before it is cut. Ids survive whole; free text does not. */
const MAX_CELL = 22

/** How much of a column's `dtype · unit` is drawn. `i64 · synapses` is 14. */
const MAX_TYPE = 16

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
 * How wide the drawn table may come to, in CSS pixels.
 *
 * **The panel counts what it drops and must therefore not drop anything else.** Fitting by CSS
 * instead — `max-width` and `overflow: hidden` — cuts the last column mid-cell while the footer
 * underneath says "+1 more", which is a second truncation that nothing on screen admits to.
 * Measured in a browser at 1600×1000 before the pivot: six columns wanted ~420px in a 360px
 * panel, and the sixth was half a column of digits with no header.
 *
 * Since the pivot this bounds how many *rows* run across, on top of the field name and its type,
 * which are the fixed cost. `pnpm probe:port-preview` is what keeps the estimate and the
 * stylesheet agreeing: it asserts in a real browser that the drawn table never overflows the
 * panel, which is the half this cannot promise on its own.
 */
const TABLE_BUDGET_PX = 416

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

/**
 * One row of the pivoted table: a column of the value, drawn down the panel.
 *
 * A matrix has no schema, so its fields are its row labels and they carry no `dtype` — which is
 * the whole of the difference between the two things this shape describes. Both are a label
 * column and a few value columns, so both are one rendering.
 */
export interface PreviewField {
  name: string
  /**
   * The column's type and unit as one string — `i64 · synapses`.
   *
   * Joined and cut here rather than in the panel, so that the width this costs is a number this
   * file knows: the fit below is an estimate of *drawn* text, and a panel free to assemble its
   * own strings is a panel free to draw something wider than the estimate allowed for. Absent
   * for a matrix, whose rows are labels rather than typed columns.
   */
  type?: string
  /** One per drawn value column, already formatted. */
  values: string[]
}

export interface PreviewTable {
  /** Names the table where a value has more than one. Absent where it has one. */
  caption?: string
  /**
   * What one field is — the head over the names, and the noun the footer counts in.
   *
   * `column` for a table, `row` for a matrix, and one field rather than two because they are the
   * same word said in two places: a footer reading "+36 more columns" under a heading reading
   * "column" cannot be misread, where the two written separately could drift into contradicting
   * each other.
   */
  fieldNoun: string
  /** Head of each value column: `first row` for a table, its own label for a matrix's column. */
  headers: string[]
  fields: PreviewField[]
  /**
   * Fields the panel is not drawing. Said out loud; nothing else is dropped silently.
   *
   * There is deliberately no companion count for the *rows* not drawn. The headline above
   * already says how many the value has and the head says which one is shown, so a second
   * statement in the footer added nothing — and sitting under a list of fields it read as
   * labelling them, which is exactly the confusion the pivot introduced.
   */
  moreFields: number
}

export interface PortPreview {
  /** `describeValue`'s line — the same one the card's footer draws. */
  headline: string
  facts: PreviewFact[]
  tables: PreviewTable[]
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
      return { headline, facts: [], tables: [previewTable(value, MAX_FIELDS)] }

    case 'network':
      return {
        headline,
        facts: [{ label: 'Direction', value: value.directed ? 'directed' : 'undirected' }],
        tables: networkTables(value),
      }

    case 'skeletons':
    case 'meshes':
    case 'points':
      // The attributes table *is* the summary of the items — one row per skeleton, per mesh, per
      // point — so there is nothing to add beside it that `describeValue` has not already said.
      return { headline, facts: [], tables: [previewTable(value.attributes, MAX_FIELDS)] }

    case 'matrix':
      return { headline, facts: matrixFacts(value), tables: [matrixTable(value)] }

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
        tables: [],
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
        tables: [],
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
      return { headline, facts: [], tables: [] }

    default: {
      // A scalar, whose headline *is* the value — so there is nothing to add unless it is a
      // string `describeValue` had to elide, in which case the head of it goes in `text`.
      const text = String(value.value)
      const long = typeof value.value === 'string' && text.length > 60
      if (!long) return { headline, facts: [], tables: [] }
      return {
        headline,
        facts: [{ label: 'Length', value: `${text.length.toLocaleString()} characters` }],
        tables: [],
        text: text.slice(0, TEXT_PREVIEW_CHARS),
      }
    }
  }
}

/** A network's two tables, each captioned, because neither one alone answers the question. */
function networkTables(value: NetworkValue): PreviewTable[] {
  // Halved, or a network is two full-height schemas stacked and the panel outgrows the window.
  const each = Math.floor(MAX_FIELDS / 2)
  return [
    { ...previewTable(value.nodes, each), caption: 'Nodes' },
    { ...previewTable(value.edges, each), caption: 'Edges' },
  ]
}

/**
 * A table pivoted: its columns down the panel, its first row across.
 *
 * Three columns, always the same three — the name, the type, one value — so that every table
 * preview in the app is the same shape whatever is in it. What varies is only how many fields
 * there are to list.
 */
function previewTable(table: TableValue, maxFields: number): PreviewTable {
  const columns = table.schema.columns.slice(0, maxFields)
  const shown = Math.min(table.length, TABLE_ROWS)
  return {
    fieldNoun: 'column',
    // Named rather than blank, because a bare value beside a type is ambiguous about *which*
    // row it came from — and the head is where the reader is told there is only one.
    headers: ['first row'],
    fields: columns.map((col) => ({
      name: cut(col.name),
      type: truncateLabel(col.dtype + (col.unit ? ` · ${col.unit}` : ''), MAX_TYPE, 1),
      values: Array.from({ length: TABLE_ROWS }, (_, row) =>
        /*
         * Empty rather than a dash for a table with no rows: there is no first row to be absent
         * from, and a dash would read as a null in one. `TableSummary` draws the same
         * distinction. The column itself stays, so an empty table is recognisably the same
         * drawing as a full one with the values missing.
         */
        row < shown ? cut(formatCell(table.data[col.name]?.[row] ?? null, col.name)) : '',
      ),
    })),
    moreFields: Math.max(0, table.schema.columns.length - columns.length),
  }
}

/** Characters across the longest of a set of strings. */
function widest(texts: string[]): number {
  let chars = 0
  for (const text of texts) chars = Math.max(chars, text.length)
  return chars
}

/** What a label column costs, in pixels. */
function labelWidth(labels: string[]): number {
  return widest(labels) * CHAR_PX + COLUMN_PAD_PX
}

/**
 * How many value columns fit beside a label column costing `fixed` pixels.
 *
 * A matrix's guard alone since a table was fixed at one value column — `TABLE_ROWS` records why —
 * and left to right rather than by width, these being the matrix's *first* columns in order.
 * **Zero is a real answer**: a matrix whose row labels fill the panel is a list of its rows,
 * where one column forced in is the clipped cell this budget exists to prevent.
 */
function fitCount(widths: number[], fixed: number): number {
  let used = fixed
  for (let i = 0; i < widths.length; i++) {
    used += widths[i]! * CHAR_PX + COLUMN_PAD_PX
    if (used > TABLE_BUDGET_PX) return i
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
 * A matrix's top-left corner: row labels down the panel, column labels across.
 *
 * The same rendering as a pivoted table and, unlike one, the same *orientation* it always had — a
 * matrix is already a grid with a label on each axis, so nothing is turned. What it does not have
 * is a schema, which is why its fields carry no type and why its field noun is `row` where a
 * table's is `column`.
 */
function matrixTable(value: MatrixValue): PreviewTable {
  const rowLabels = value.rowLabels.slice(0, MAX_FIELDS).map((label) => cut(label))
  const colCount = Math.min(value.colLabels.length, MATRIX_COLUMNS)
  const cells = rowLabels.map((_, row) =>
    Array.from({ length: colCount }, (_, col) =>
      cut(formatCell(value.values[row * value.colLabels.length + col] ?? null)),
    ),
  )
  const headers = value.colLabels.slice(0, colCount).map((label) => cut(label))
  // Unlike a table's three fixed columns, a matrix's are as many as fit: its labels are its own
  // and can be any length, so this is where the width guard still earns its keep.
  const shown = fitCount(
    Array.from({ length: colCount }, (_, col) =>
      Math.max(headers[col]?.length ?? 0, widest(cells.map((values) => values[col] ?? ''))),
    ),
    labelWidth(rowLabels),
  )
  return {
    fieldNoun: 'row',
    headers: headers.slice(0, shown),
    fields: rowLabels.map((name, index) => ({ name, values: cells[index]!.slice(0, shown) })),
    moreFields: Math.max(0, value.rowLabels.length - rowLabels.length),
  }
}

/** One cell's text, cut. `truncateLabel` in characters — the ellipsis rule has one home. */
function cut(text: string): string {
  return truncateLabel(text, MAX_CELL, 1)
}
