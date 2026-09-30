/**
 * Custom Dataset — a dataset assembled from parts wired into one node.
 *
 * Every other dataset node stands for one backend's idea of a connectome. This one stands for
 * whatever the user puts together: a neuron table from a sheet, an upload or a CAVE query, with
 * meshes and skeletons borrowed from any other dataset on the canvas. `CompositeSource` answers
 * each question from the part that can; which parts a dataset is made of is `data/custom/layout.ts`,
 * which also holds why the type and the value carry different ids.
 *
 * ## The neuron table is the Annotations channel
 *
 * A request already carries `annotations` to the source, and a type already carries their schema
 * to every column picker downstream (`withAnnotations`). So the neuron table *is* this dataset's
 * annotations, once its id column has been named and renamed `neuronId` — nothing downstream has
 * to learn that this dataset is any different from a CAVE datastack with a chain wired to it,
 * including Explore's rule that a wired table which has not run means wait rather than load.
 *
 * ## Edges: a wire, and only a wire
 *
 * An edge list arrives on the Edges socket — any table, or a Link Table file for one too large to
 * hold as a table — and reaches the value as `edges`, where the connectivity funnel answers
 * Connectivity, Adjacency, Paths and the synapse totals from it; see `data/edges/wired.ts` for how
 * a wired one becomes a set. Not an edge set imported under Edge data, which needs a body this
 * card does not have — `docs/datasets.md` records why.
 *
 * The three column pickers are **optional**, for `idColumn`'s reason: a required picker with no
 * column called `pre` falls through to the first compatible one (rule 3), which for the two ends
 * is the *same* column — an edge list of self-loops. Optional leaves them unresolved and
 * `validate` asks, naming the column `suggestEdgeColumns` — the importer's own guess — would pick.
 *
 * ## Synapses: looked up, never read whole
 *
 * A synapse table on the Synapses socket answers the synapse nodes a lookup at a time — see
 * `data/custom/synapses.ts` — and, with no edge list, the connectivity questions too: its `pre`
 * and `post` columns become a wired edge set whose weights are row counts. Its coordinates are
 * scaled by the voxel size to nanometres, and no template space is claimed, since a table cannot
 * say which space it is in.
 *
 * ## The geometry sockets are ordinary wires, not references
 *
 * A reference would hand this node the delegate's *type*, which for a family node on "Latest"
 * names no dataset until its listing lands. An ordinary wire runs that node first — it is `cheap`
 * — and delivers the resolved handle, which is what a build has to hold. What it costs is that
 * the canvas then has two dataset producers, so a query node added afterwards is not auto-wired;
 * with a connectome and a custom dataset both on the canvas, which one it meant is a real
 * question. Auto-wiring also leaves *this* node's sockets alone (`autoWireDataset`): they are its
 * parts, and the one dataset on the canvas is a guess about those.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { hashValue } from '../../core/hash'
import type { NodeDefinition, ParamDef, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import type { ColumnSchema } from '../../core/types'
import {
  T,
  TABLE_OR_FILE_KINDS,
  attributeSchema,
  datasetRef,
  findColumn,
  isNumericDType,
} from '../../core/types'
import type { DatasetAnnotations, DatasetEdges, DatasetValue } from '../../core/values'
import { isTableFileValue, isTableValue } from '../../core/values'
import type { EdgeColumns } from '../../data/edges/encode'
import type { SynapseColumns } from '../../data/custom/synapses'
import type { VoxelScale } from '../../data/units'
import { IDENTITY_SCALE } from '../../data/units'
import {
  carriedSchemas,
  pinSynapseTable,
  shadowedColumns,
  wiredSynapses,
} from '../../data/custom/synapses'
import { pinEdgeSet } from '../../data/edges/store'
import { wiredEdges } from '../../data/edges/wired'
import type { GeometryRole } from '../../data/custom/layout'
import {
  CUSTOM_SOURCE_ID,
  GEOMETRY_ROLES,
  GEOMETRY_SOCKETS,
  buildIdFor,
  compositeLayout,
  pinBuild,
  registerBuild,
  registerLayout,
} from '../../data/custom/layout'
import { idColumnProblem, neuronTable, neuronTableSchema } from '../../data/custom/neurons'
import { suggestEdgeColumns } from '../../data/edges/read'
import { DATASET_CARD_WIDTH } from '../../nodes/dataset/description'
import { requireDataset, sourceSupports } from '../../nodes/lib/datasetParam'

/** What an unnamed one is called, on the value and in every message about it. */
const DEFAULT_LABEL = 'Custom dataset'

export const NOTHING_WIRED =
  'Wire at least one part: a table of neurons into Neurons, an edge list into Edges, a synapse ' +
  'table into Synapses, or a dataset into Meshes or Skeletons to take geometry from.'

export const PICK_ID_COLUMN = 'Pick which column of the Neurons table holds the neuron id.'

/** The Weight column's declared default — also the one held value that is not a decision. */
const DEFAULT_WEIGHT = 'weight'

/** What a column's name suggests each picker should hold, where the schema is known to say. */
type Guess = Partial<Record<'pre' | 'post' | 'weight' | 'x' | 'y' | 'z', string>> & {
  /** The default `weight` column is there and holds something other than numbers. */
  textWeight?: boolean
}

/**
 * A picker a socket needs: its param, what it holds (for the sentence asking for it), which key of
 * the guess it reads, and its declared default. One shape for both sockets' pickers, so one
 * function asks for all of them (`unpicked`).
 */
interface Picker {
  readonly id: string
  readonly label: string
  readonly what: string
  readonly guess: keyof Guess
  readonly fallback: string
}

/** Each end of an edge list — the ids are also the keys of an `EdgeColumns`. */
const EDGE_PICKERS: readonly Picker[] = [
  { id: 'pre', label: 'Pre column', what: 'presynaptic id', guess: 'pre', fallback: 'pre' },
  {
    id: 'post',
    label: 'Post column',
    what: 'postsynaptic id',
    guess: 'post',
    fallback: 'post',
  },
]

/**
 * The synapse table's two ends, defaulting to CAVE's column names, which is what an exported
 * synapse table most often carries. The coordinates are one three-column picker, `synPosition`.
 */
const SYNAPSE_PICKERS: readonly Picker[] = [
  {
    id: 'synPre',
    label: 'Synapse pre column',
    what: 'presynaptic neuron id',
    guess: 'pre',
    fallback: 'pre_pt_root_id',
  },
  {
    id: 'synPost',
    label: 'Synapse post column',
    what: 'postsynaptic neuron id',
    guess: 'post',
    fallback: 'post_pt_root_id',
  },
]

/**
 * What a table's column names suggest: the ends and the weight are the edge importer's own guess
 * (`suggestEdgeColumns`), an axis a column called `x` or ending `_x`.
 */
function columnGuess(columns: readonly ColumnSchema[]): Guess {
  const names = columns.map((c) => c.name)
  const at = suggestEdgeColumns(names, true)
  const axis = (a: string) =>
    names.find((n) => n.toLowerCase() === a) ??
    names.find((n) => new RegExp(`[_.]${a}$`, 'i').test(n))
  return {
    pre: at && names[at.pre],
    post: at && names[at.post],
    weight: at?.weight === undefined ? undefined : names[at.weight],
    x: axis('x'),
    y: axis('y'),
    z: axis('z'),
    textWeight: columns.some((c) => c.name === DEFAULT_WEIGHT && !isNumericDType(c.dtype)),
  }
}

/**
 * What is wrong with a socket's pickers: each unresolved one asked for by name, with the column
 * that looks like it, and the two ends naming one column — both lists being exactly the two
 * ends. `socket` and the labels are the words the card uses.
 */
function unpicked(
  ctx: { column(id: string): string | undefined },
  pickers: readonly Picker[],
  socket: string,
  guess: Guess,
): string[] {
  const problems: string[] = []
  for (const { id, what, guess: key } of pickers) {
    if (ctx.column(id)) continue
    const looks = guess[key] ? ` — "${guess[key]}" looks like it` : ''
    problems.push(`Pick the ${socket} column holding the ${what}${looks}.`)
  }
  const [pre, post] = pickers
  const end = ctx.column(pre!.id)
  if (end && end === ctx.column(post!.id)) {
    problems.push(`${pre!.label} and ${post!.label} name the same column.`)
  }
  return problems
}

/**
 * Above this, counting connectivity from a synapse table says what it costs. The one whole read a
 * synapse table ever gets, and it is two id columns: at ten million rows that is the edge import's
 * measured couple of seconds (`edges/worker.ts`), past which it is worth knowing an edge list would
 * spare it. A Feather file states no row count, so it always says.
 */
const WHOLE_READ_WARN_ROWS = 10_000_000

/** The voxel size a fresh card holds: coordinates already in nanometres. */
const DEFAULT_VOXEL = IDENTITY_SCALE.join(', ')

/** Three positive numbers, separated by commas or spaces — or undefined for anything else. */
function parseVoxel(text: string): VoxelScale | undefined {
  const parts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  return parts.length === 3 && parts.every((v) => Number.isFinite(v) && v > 0)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : undefined
}

/**
 * The synapse pickers' columns and voxel size, or what is wrong — `edgeColumnsOf`'s arrangement:
 * `validate` lists the problems, a run refuses on the first.
 */
export function synapseColumnsOf(
  ctx: {
    column(id: string): string | undefined
    columns(id: string): string[]
    params: ParamValues
  },
  guess: Guess = {},
): { columns?: SynapseColumns; problems: string[] } {
  const problems = unpicked(ctx, SYNAPSE_PICKERS, 'Synapses', guess)
  const [pre, post] = SYNAPSE_PICKERS.map(({ id }) => ctx.column(id))
  const position = ctx.columns('synPosition')
  if (position.length !== 3) {
    const axes = [guess.x, guess.y, guess.z]
    const looks = axes.every(Boolean) ? ` — "${axes.join('", "')}" look like them` : ''
    problems.push(`Pick three Synapses position columns, x, y and z in that order${looks}.`)
  }
  const voxel = parseVoxel(String(ctx.params.voxelSize))
  if (!voxel)
    problems.push('Voxel size must be three positive numbers of nanometres, e.g. 4, 4, 40.')
  const carry = ctx.columns('synCarry')
  const shadowed = shadowedColumns(carry)
  if (shadowed.length) {
    problems.push(
      `Carry columns cannot include ${shadowed.map((n) => `"${n}"`).join(', ')} — every synapse ` +
        `point already has a column of that name.`,
    )
  }
  const [x, y, z] = position
  if (problems.length || !pre || !post || !x || !y || !z || !voxel) return { problems }
  return { problems, columns: { pre, post, x, y, z, carry, voxel } }
}

/**
 * Which parts are wired, asked one way by all three halves: of the input *types* in inference and
 * `validate`, of the input *values* in a run.
 */
function partsOf(wired: (port: string) => boolean) {
  const neurons = wired('neurons')
  const edgeList = wired('edges')
  const synapses = wired('synapses')
  return {
    neurons,
    // A synapse table answers connectivity too, counting its rows per pair, where no edge list does.
    edges: edgeList || synapses,
    synapses,
    /** Connectivity comes from the synapse table: nothing else supplies it. */
    edgesFromSynapses: synapses && !edgeList,
    nothing: !neurons && !edgeList && !synapses && !wired('meshes') && !wired('skeletons'),
  }
}

/**
 * The edge pickers' columns, or what is wrong with them — one reading for both halves: `validate`
 * lists every problem and note, a run refuses on the first problem (or on `refusal`, a chosen
 * column since gone, which the framework's own column check words on the card), since a warning
 * does not block and an edge list built from a guess is a connectome nobody chose. A note never
 * blocks. `guess` names the column the importer would pick, where the schema is known to say.
 */
export function edgeColumnsOf(
  ctx: { column(id: string): string | undefined; params: ParamValues },
  guess: Guess = {},
): { columns?: EdgeColumns; problems: string[]; notes: string[]; refusal?: string } {
  const problems = unpicked(ctx, EDGE_PICKERS, 'Edges', guess)
  const notes: string[] = []
  const [pre, post, weight] = [ctx.column('pre'), ctx.column('post'), ctx.column('weight')]
  // An absent weight on the untouched default counts rows — the framework's rule that a stored
  // default was never a decision (`validateColumnParams` stays silent on it), so an edge list with
  // no `weight` column needs nothing cleared. Where a column there looks like one, say so: summing
  // `syn_count` and counting rows are both plausible numbers.
  const chosen = String(ctx.params.weight).trim()
  const untouched = !weight && chosen === DEFAULT_WEIGHT
  if (untouched && guess.textWeight) {
    notes.push(
      `The "${DEFAULT_WEIGHT}" column does not hold numbers, so each row counts as one. Pick a ` +
        `numeric column under Weight column to sum it instead, or clear it to say rows are meant.`,
    )
  } else if (untouched && guess.weight) {
    notes.push(
      `There is no "${DEFAULT_WEIGHT}" column, so each row counts as one — "${guess.weight}" ` +
        `looks like a weight; pick it under Weight column to sum it instead.`,
    )
  }
  // A column somebody chose that has since gone, or that holds text: `validateColumnParams`
  // reports it on the card, and a run refuses rather than counting rows in its place. Worded for
  // both, since the emitter asks with no schema in hand to tell them apart.
  if (!weight && chosen && chosen !== DEFAULT_WEIGHT) {
    return {
      problems,
      notes,
      refusal: `The Edges list has no numeric column "${chosen}" to take weights from.`,
    }
  }
  if (problems.length || !pre || !post) return { problems, notes }
  return { problems, notes, columns: weight ? { pre, post, weight } : { pre, post } }
}

export const customDatasetNode: NodeDefinition = packNode({
  type: 'connectome:customDataset',
  label: 'Custom Dataset',
  category: 'dataset',
  cardWidth: DATASET_CARD_WIDTH,
  description:
    'Assemble a dataset from parts: a neuron table, an edge list, a synapse table, and geometry from other datasets.',
  guide:
    'For data no single backend holds: a neuron table into **Neurons**, an edge list into ' +
    '**Edges**, a synapse table into **Synapses** — each a table or a Link Table file, with its ' +
    'columns picked — and any dataset into **Meshes** or **Skeletons**. Without an edge list, ' +
    'connectivity counts synapses. The ids must mean the same neurons in every part, which ' +
    'nothing here can check.',
  cost: 'cheap',
  inputs: [
    { id: 'neurons', label: 'Neurons', type: T.table(), required: false },
    { id: 'edges', label: 'Edges', type: T.any(), kinds: TABLE_OR_FILE_KINDS, required: false },
    {
      id: 'synapses',
      label: 'Synapses',
      type: T.any(),
      kinds: TABLE_OR_FILE_KINDS,
      required: false,
    },
    { id: 'meshes', label: 'Meshes', type: T.dataset(), required: false },
    { id: 'skeletons', label: 'Skeletons', type: T.dataset(), required: false },
  ],
  outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  params: [
    {
      id: 'name',
      kind: 'string',
      label: 'Name',
      placeholder: DEFAULT_LABEL,
      help: 'What to call this dataset wherever it is named downstream.',
      default: '',
    },
    /*
     * Optional, with `neuronId` as the default, and both halves are deliberate. A required picker
     * with no such column in the table falls through to the first compatible one (rule 3), which
     * for an id is a column of cell types quietly standing in for neuron ids. Optional means a
     * table without `neuronId` leaves this unresolved and `validate` asks — the honest answer.
     */
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      from: 'neurons',
      optional: true,
      default: ID_COLUMN_NAME,
      whenWired: true,
      help: 'The column of the Neurons table holding each neuron’s id. It is renamed neuronId and read as text, so eighteen-digit ids stay exact.',
    },
    ...EDGE_PICKERS.map(({ id, label, what, fallback }): ParamDef => ({
      id,
      kind: 'column',
      label,
      from: 'edges',
      optional: true,
      default: fallback,
      dtypes: ['str', 'i64'],
      whenWired: true,
      help: `The column of the Edges list holding each connection’s ${what}.`,
    })),
    {
      id: 'weight',
      kind: 'column',
      label: 'Weight column',
      from: 'edges',
      optional: true,
      default: DEFAULT_WEIGHT,
      dtypes: ['i64', 'f64'],
      whenWired: true,
      help: 'Each connection’s weight, summed where a pair repeats. Empty counts every row as one — a list with a row per synapse then counts synapses.',
    },
    /*
     * The synapse table's — `SYNAPSE_PICKERS`, optional for `idColumn`'s reason.
     */
    ...SYNAPSE_PICKERS.map(({ id, label, what, fallback }): ParamDef => ({
      id,
      kind: 'column',
      label,
      from: 'synapses',
      optional: true,
      default: fallback,
      dtypes: ['str', 'i64'],
      whenWired: true,
      help: `The column of the Synapses table holding each synapse’s ${what}.`,
    })),
    {
      id: 'synPosition',
      kind: 'columns',
      label: 'Synapse position',
      from: 'synapses',
      default: ['x', 'y', 'z'],
      dtypes: ['i64', 'f64'],
      whenWired: true,
      help: 'The three columns holding each synapse’s position: x, y and z, in that order.',
      // The order is the meaning, which a list of column names does not say (`catalogueNote`).
      catalogueNote: 'Exactly three column names, in the order x, y, z.',
    },
    {
      id: 'synCarry',
      kind: 'columns',
      label: 'Carry columns',
      from: 'synapses',
      default: [],
      advanced: true,
      whenWired: true,
      help: 'Further columns of the Synapses table to put on every synapse point — a neurotransmitter prediction, a region — for colouring and filtering downstream.',
    },
    {
      id: 'voxelSize',
      kind: 'string',
      label: 'Voxel size',
      default: DEFAULT_VOXEL,
      placeholder: DEFAULT_VOXEL,
      advanced: true,
      whenWired: 'synapses',
      help: 'Nanometres per unit of the position columns, x, y and z — 1, 1, 1 when they are already in nanometres; FlyWire’s voxels are 4, 4, 40.',
      // A string holding three numbers — a shape the kind cannot convey (`catalogueNote`).
      catalogueNote: `Three positive numbers, nanometres per unit of x, y and z, comma-separated: "4, 4, 40". Default "${DEFAULT_VOXEL}".`,
    },
  ],

  inferOutputs: (ctx) => {
    const wired = partsOf((port) => Boolean(ctx.inputs[port]))
    const carried = wired.synapses
      ? carriedSchemas(attributeSchema(ctx.inputs.synapses), ctx.columns('synCarry'))
      : undefined
    const layoutId = registerLayout(
      compositeLayout(
        { ...wired, synapses: carried },
        { meshes: datasetRef(ctx.inputs.meshes), skeletons: datasetRef(ctx.inputs.skeletons) },
      ),
    )
    const schema = ctx.schema('neurons')
    const idColumn = ctx.column('idColumn')
    // Published only when the table will actually become one: a schema claiming a `neuronId` the
    // run is about to refuse would configure every picker downstream against a table that never
    // arrives.
    const neurons =
      schema && idColumn && !idColumnProblem(schema, idColumn)
        ? neuronTableSchema(schema, idColumn)
        : undefined
    return { dataset: T.dataset(CUSTOM_SOURCE_ID, layoutId, neurons, wired.edges) }
  },

  validate: (ctx) => {
    const wired = partsOf((port) => Boolean(ctx.inputs[port]))
    if (wired.nothing) return [NOTHING_WIRED]
    const guessFor = (port: string) =>
      columnGuess(attributeSchema(ctx.inputs[port])?.columns ?? [])
    const issues: string[] = []
    const schema = ctx.schema('neurons')
    // Silent while the table's columns are unknown — a Pivot upstream publishes none until it has
    // run, and asking somebody to pick from an empty list is worse advice than waiting.
    if (ctx.inputs.neurons && schema?.columns.length) {
      const idColumn = ctx.column('idColumn')
      const problem = idColumn ? idColumnProblem(schema, idColumn) : PICK_ID_COLUMN
      if (problem) issues.push(problem)
    }
    // The same silence, for the same reason: a socket whose columns are unknown is not asked about.
    const known = (port: string) => Boolean(attributeSchema(ctx.inputs[port])?.columns.length)
    if (known('edges')) {
      const { problems, notes } = edgeColumnsOf(ctx, guessFor('edges'))
      issues.push(...problems, ...notes)
    }
    if (known('synapses')) issues.push(...synapseColumnsOf(ctx, guessFor('synapses')).problems)
    for (const role of GEOMETRY_ROLES) {
      const type = ctx.inputs[role]
      if (type && !sourceSupports(type, role)) {
        issues.push(`The dataset wired into ${GEOMETRY_SOCKETS[role]} has no ${role}.`)
      }
    }
    return issues
  },

  evaluate: async (ctx) => {
    const parts: Partial<Record<GeometryRole, DatasetValue>> = {}
    for (const role of GEOMETRY_ROLES) {
      const value = ctx.input(role)
      if (value !== undefined) parts[role] = requireDataset(value, GEOMETRY_SOCKETS[role])
    }
    const neurons = ctx.input('neurons')
    const edgeInput = ctx.input('edges')
    const synapseInput = ctx.input('synapses')
    const wired = partsOf((port) => ctx.input(port) !== undefined)
    if (wired.nothing) throw new Error(NOTHING_WIRED)

    let annotations: DatasetAnnotations | undefined
    if (neurons !== undefined) {
      if (!isTableValue(neurons)) throw new Error('Neurons takes a table')
      const idColumn = ctx.column('idColumn')
      if (!idColumn) throw new Error(PICK_ID_COLUMN)
      if (!findColumn(neurons.schema, idColumn)) {
        throw new Error(`The Neurons table has no column "${idColumn}".`)
      }
      const problem = idColumnProblem(neurons.schema, idColumn)
      if (problem) throw new Error(problem)
      const { table, dropped, duplicates } = neuronTable(neurons, idColumn)
      if (dropped) {
        ctx.warn(
          `${dropped.toLocaleString()} rows of the Neurons table have no usable id in ` +
            `"${idColumn}" and were left out.`,
        )
      }
      if (duplicates) {
        ctx.warn(
          `${duplicates.toLocaleString()} rows repeat an id already in the Neurons table; ` +
            `the first row for each id is kept.`,
        )
      }
      // The pipeline's provenance *and* the column read from it: the same table keyed by two
      // different columns is two different neuron tables.
      annotations = { key: hashValue([ctx.inputKey('neurons') ?? '', idColumn]), table }
    }

    // Nothing is read here: a wired list is registered and built by the first question that
    // needs it (`data/edges/wired.ts`), so this node stays cheap.
    let edges: DatasetEdges | undefined
    if (edgeInput !== undefined) {
      if (!isTableValue(edgeInput) && !isTableFileValue(edgeInput)) {
        throw new Error('Edges takes a table or a Link Table file')
      }
      const { columns, problems, refusal } = edgeColumnsOf(ctx)
      if (!columns) throw new Error(refusal ?? problems[0])
      // Never a default: two wires hashing alike would share one set, the last to register
      // answering for both.
      const key = ctx.inputKey('edges')
      if (!key) throw new Error('The Edges input has no provenance key.')
      edges = wiredEdges(edgeInput, columns, key)
    }

    // The same arrangement for synapses: registered here, looked up by the questions that need them.
    let synapseTable: string | undefined
    let carried: ColumnSchema[] | undefined
    if (synapseInput !== undefined) {
      if (!isTableValue(synapseInput) && !isTableFileValue(synapseInput)) {
        throw new Error('Synapses takes a table or a Link Table file')
      }
      const { columns, problems } = synapseColumnsOf(ctx)
      if (!columns) throw new Error(problems[0])
      const key = ctx.inputKey('synapses')
      if (!key) throw new Error('The Synapses input has no provenance key.')
      ;({ id: synapseTable, carried } = wiredSynapses(synapseInput, columns, key))
      // No edge list: the synapse table's rows, counted per pair, are the connectivity.
      if (wired.edgesFromSynapses) {
        const rows = isTableFileValue(synapseInput) ? synapseInput.rows : synapseInput.length
        if (rows === undefined || rows > WHOLE_READ_WARN_ROWS) {
          ctx.warn(
            `Connectivity here is counted from the Synapses ${isTableFileValue(synapseInput) ? 'file' : 'table'}` +
              `${rows === undefined ? '' : `'s ${rows.toLocaleString()} rows`}, whose pre and post ` +
              `columns the first connectivity question reads in full. Wire an edge list into ` +
              `Edges to answer it from that instead.`,
          )
        }
        edges = wiredEdges(
          synapseInput,
          { pre: columns.pre, post: columns.post },
          key,
          'Synapses',
        )
      }
    }

    // From the values, so each part is resolved — and copied down to its two ids, which is what
    // keeps the build from pinning a delegate's annotation table (see `layout.ts`).
    const layout = compositeLayout({ ...wired, synapses: carried }, parts)
    const layoutId = registerLayout(layout)
    const label = String(ctx.params.name).trim() || DEFAULT_LABEL
    const id = buildIdFor(layoutId, {
      neurons: annotations?.key ?? null,
      edges: edges?.id ?? null,
      synapses: synapseTable ?? null,
      meshes: ctx.inputKey('meshes') ?? null,
      skeletons: ctx.inputKey('skeletons') ?? null,
      // Two cards with the same parts and different names are two datasets, each under its own
      // name — or both would show whichever registered last.
      label,
    })
    registerBuild({
      ...layout,
      id,
      label,
      ...(edges ? { edgeSet: edges } : {}),
      ...(synapseTable ? { synapseTable } : {}),
    })
    const dataset: DatasetValue = {
      kind: 'dataset',
      sourceId: CUSTOM_SOURCE_ID,
      datasetId: id,
      label,
      ...(annotations ? { annotations } : {}),
      ...(edges ? { edges } : {}),
    }
    // What the value names by id lives as long as the value does — see `PinnedLru`.
    pinBuild(dataset, id)
    if (edges) pinEdgeSet(dataset, edges.id)
    if (synapseTable) pinSynapseTable(dataset, synapseTable)
    return { dataset }
  },
})
