/**
 * Turn an edge table into a Network.
 *
 * Node attributes are derived from the edges (degree, total weight) and optionally joined
 * from a second table, so "colour nodes by cell type" works straight off a Connectivity
 * result without any extra wiring. Aggregating parallel edges is on by default: a
 * neuron-level connectivity table has one row per synapse group, and drawing 40 separate
 * links between the same pair is noise, not information.
 */

import type { ColumnSchema, TableSchema } from '../../core/types'
import {
  NUMERIC_DTYPES,
  T,
  attributeSchema,
  column,
  findColumn,
  tableSchema,
} from '../../core/types'
import { registerNode } from '../../core/registry'
import type { CellValue, ColumnData, NetworkValue, TableValue } from '../../core/values'
import { getColumn, isTableValue, makeTable } from '../../core/values'

const NODE_ID = 'id'

/** Node attribute schema: the id, whatever we joined, then the derived degree columns. */
function nodeSchemaFor(joined: TableSchema | undefined, keyColumn: string | undefined): TableSchema {
  const extra: ColumnSchema[] = (joined?.columns ?? []).filter((c) => c.name !== keyColumn)
  return tableSchema(
    column(NODE_ID, 'str'),
    ...extra,
    column('degreeIn', 'i64'),
    column('degreeOut', 'i64'),
    column('weightIn', 'f64'),
    column('weightOut', 'f64'),
  )
}

/** Column names this node produces itself; a carried attribute may not collide with one. */
const RESERVED = new Set(['source', 'target', 'weight', 'edges'])

/** Ports whose columns this node already represents under its own names. */
interface EdgeKeys {
  source: string | undefined
  target: string | undefined
  weight: string | undefined
}

/**
 * Which edge attributes ride along, resolved once so the schema and the values cannot diverge.
 *
 * **An empty list means all of them**, matching the node half of this very node — which has
 * always carried every joined column — and the `chips` idiom elsewhere, where empty means
 * "decide for me" rather than "nothing". A non-empty list is taken literally and in order.
 *
 * Four kinds of column never ride along: the names this node owns (`source`, `target`,
 * `weight`, `edges`), and the source, target and weight columns themselves, which are already
 * carried under those names. Anything the incoming schema does not have is dropped rather than
 * emitted empty — a column of nulls says less than an absent column.
 */
function keptEdgeColumns(
  schema: TableSchema | undefined,
  names: string[],
  keys: EdgeKeys,
): ColumnSchema[] {
  if (!schema) return []
  const owned = (name: string) =>
    RESERVED.has(name) || name === keys.source || name === keys.target || name === keys.weight

  if (names.length === 0) return schema.columns.filter((c) => !owned(c.name))

  const seen = new Set<string>()
  const kept: ColumnSchema[] = []
  for (const name of names) {
    if (owned(name) || seen.has(name)) continue
    const found = findColumn(schema, name)
    if (!found) continue
    seen.add(name)
    kept.push(found)
  }
  return kept
}

function edgeSchemaFor(
  weightColumn: string | undefined,
  kept: ColumnSchema[] = [],
): TableSchema {
  return tableSchema(
    column('source', 'str'),
    column('target', 'str'),
    column('weight', 'f64', weightColumn ? undefined : 'count'),
    column('edges', 'i64'),
    ...kept,
  )
}

export const buildNetworkNode = registerNode({
  type: 'net.build',
  label: 'Build Network',
  category: 'analysis',
  description: 'Turn an edge table into a network of nodes and links.',
  cost: 'cheap',
  inputs: [
    { id: 'edges', label: 'Edges', type: T.table() },
    { id: 'nodes', label: 'Node attrs', type: T.table(), required: false },
  ],
  outputs: [{ id: 'network', label: 'Network', type: T.network() }],
  params: [
    { id: 'source', kind: 'column', label: 'Source', from: 'edges', default: '' },
    { id: 'target', kind: 'column', label: 'Target', from: 'edges', default: '' },
    {
      id: 'weight',
      kind: 'column',
      label: 'Weight',
      from: 'edges',
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      help: 'Leave empty to weight every link by how many rows connect the pair.',
    },
    {
      id: 'directed',
      kind: 'boolean',
      label: 'Directed',
      default: true,
    },
    {
      id: 'aggregate',
      kind: 'boolean',
      label: 'Merge parallel links',
      help: 'Sum the weight of every row connecting the same pair into one link.',
      default: true,
    },
    {
      id: 'keep',
      kind: 'columns',
      label: 'Keep columns',
      from: 'edges',
      default: [],
      optional: true,
      help:
        'Edge attributes to carry onto the links — an ROI, a transmitter, a sign. ' +
        'Empty carries every column the links do not already represent. ' +
        'Where parallel links are merged, a value is kept only if the merged rows agree on ' +
        'it, and left empty otherwise; only Weight is added up.',
    },
    {
      id: 'nodeKey',
      kind: 'column',
      label: 'Join on',
      from: 'nodes',
      default: '',
      advanced: true,
      help: 'Column in the node-attributes table matching the source/target ids.',
    },
    {
      id: 'minWeight',
      kind: 'number',
      label: 'Min link weight',
      default: 0,
      min: 0,
      step: 1,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => ({
    network: T.network(
      nodeSchemaFor(attributeSchema(ctx.inputs.nodes), ctx.column('nodeKey')),
      edgeSchemaFor(
        ctx.column('weight'),
        keptEdgeColumns(attributeSchema(ctx.inputs.edges), ctx.columns('keep'), {
          source: ctx.column('source'),
          target: ctx.column('target'),
          weight: ctx.column('weight'),
        }),
      ),
    ),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    if (!ctx.inputs.edges) return issues
    const source = ctx.column('source')
    const target = ctx.column('target')
    if (source && target && source === target) {
      issues.push('Source and Target are the same column — every link would be a self-loop')
    }
    return issues
  },

  evaluate: (ctx) => {
    const edges = ctx.input('edges')
    if (!isTableValue(edges)) throw new Error('Edges input is not a table')

    const sourceColumn = ctx.column('source')
    const targetColumn = ctx.column('target')
    if (!sourceColumn || !targetColumn) throw new Error('Pick both a source and a target column')

    const weightColumn = ctx.column('weight')
    const directed = ctx.params.directed !== false
    const aggregate = ctx.params.aggregate !== false
    const minWeight = Number(ctx.params.minWeight ?? 0)

    const sourceData = getColumn(edges, sourceColumn)
    const targetData = getColumn(edges, targetColumn)
    const weightData = weightColumn ? getColumn(edges, weightColumn) : undefined

    // Attributes riding along. Resolved through the same helper `inferOutputs` uses, so the
    // schema this promises and the values it produces cannot drift apart.
    const kept = keptEdgeColumns(edges.schema, ctx.columns('keep'), {
      source: sourceColumn,
      target: targetColumn,
      weight: weightColumn,
    })
    const keptData = kept.map((col) => getColumn(edges, col.name))

    interface Link {
      source: string
      target: string
      weight: number
      count: number
      /** One slot per kept column: the value every merged row agreed on, or null. */
      kept: CellValue[]
      /** Slots that have seen two different values, and so have no answer. */
      mixed: boolean[]
    }
    const links = new Map<string, Link>()
    const order: string[] = []

    for (let i = 0; i < edges.length; i++) {
      const source = label(sourceData[i])
      const target = label(targetData[i])
      if (source === '—' || target === '—') continue
      const weight = weightData ? Number(weightData[i] ?? 0) : 1
      if (!Number.isFinite(weight)) continue

      // Undirected graphs canonicalise the pair so A→B and B→A land in one bucket.
      const [a, b] = directed || source <= target ? [source, target] : [target, source]
      const key = aggregate ? `${a}\u0000${b}` : `${a}\u0000${b}\u0000${i}`
      const existing = links.get(key)
      if (existing) {
        existing.weight += weight
        existing.count += 1
        mergeKept(existing, keptData, i)
      } else {
        const link: Link = {
          source: a,
          target: b,
          weight,
          count: 1,
          kept: kept.map((_, k) => keptData[k]![i] ?? null),
          mixed: kept.map(() => false),
        }
        links.set(key, link)
        order.push(key)
      }
    }

    /**
     * Fold one more row into a link that already exists.
     *
     * A carried value survives only where every merged row agrees on it, whatever its type. A
     * link standing for forty synapse groups spread over five ROIs has no single ROI, and
     * saying "LO(R)" because that row happened to come first would be a confident lie. Empty
     * is the honest answer, and `edges` says how many rows are behind it.
     *
     * Numbers are *not* summed, and that is the load-bearing decision. Summing is only right
     * for a measure, and nothing in a dtype distinguishes a measure from an identifier or a
     * code: on a real male-CNS connectivity table, summing added `preId` up to 24093454514 —
     * noise, and noise offered to the numeric pickers where it could have driven a size
     * encoding. `weight` is this node's one additive channel; a second additive quantity
     * belongs in a `groupBy` upstream, which names its result honestly.
     */
    function mergeKept(link: Link, data: ReturnType<typeof getColumn>[], row: number): void {
      for (let k = 0; k < data.length; k++) {
        if (link.mixed[k]) continue
        const incoming = data[k]![row] ?? null
        if (link.kept[k] !== incoming) {
          link.mixed[k] = true
          link.kept[k] = null
        }
      }
    }

    const keptLinks = order
      .map((key) => links.get(key)!)
      .filter((link) => link.weight >= minWeight)

    // --- node table, derived from the surviving links ------------------------
    interface NodeAcc {
      degreeIn: number
      degreeOut: number
      weightIn: number
      weightOut: number
    }
    const nodeAcc = new Map<string, NodeAcc>()
    const nodeOrder: string[] = []
    const touch = (id: string): NodeAcc => {
      let acc = nodeAcc.get(id)
      if (!acc) {
        acc = { degreeIn: 0, degreeOut: 0, weightIn: 0, weightOut: 0 }
        nodeAcc.set(id, acc)
        nodeOrder.push(id)
      }
      return acc
    }
    for (const link of keptLinks) {
      const from = touch(link.source)
      const to = touch(link.target)
      from.degreeOut += 1
      from.weightOut += link.weight
      to.degreeIn += 1
      to.weightIn += link.weight
    }

    // Optional join: one row of attributes per node id.
    const attrs = ctx.input('nodes')
    const nodeKey = ctx.column('nodeKey')
    let lookup: Map<string, number> | undefined
    if (isTableValue(attrs) && nodeKey) {
      const keyData = getColumn(attrs, nodeKey)
      lookup = new Map()
      for (let i = 0; i < attrs.length; i++) {
        const key = label(keyData[i])
        if (!lookup.has(key)) lookup.set(key, i)
      }
    }

    const joinedSchema = isTableValue(attrs) ? attrs.schema : undefined
    const nodeSchema = nodeSchemaFor(joinedSchema, nodeKey)
    const nodeData: Record<string, ColumnData> = {}
    for (const col of nodeSchema.columns) nodeData[col.name] = []

    for (const id of nodeOrder) {
      const acc = nodeAcc.get(id)!
      nodeData[NODE_ID]!.push(id)
      if (joinedSchema && lookup) {
        const row = lookup.get(id)
        for (const col of joinedSchema.columns) {
          if (col.name === nodeKey) continue
          nodeData[col.name]!.push(row === undefined ? null : (attrs as TableValue).data[col.name]?.[row] ?? null)
        }
      }
      nodeData['degreeIn']!.push(acc.degreeIn)
      nodeData['degreeOut']!.push(acc.degreeOut)
      nodeData['weightIn']!.push(acc.weightIn)
      nodeData['weightOut']!.push(acc.weightOut)
    }

    const edgeSchema = edgeSchemaFor(weightColumn, kept)
    const edgeData: Record<string, ColumnData> = {
      source: keptLinks.map((l) => l.source),
      target: keptLinks.map((l) => l.target),
      weight: keptLinks.map((l) => l.weight),
      edges: keptLinks.map((l) => l.count),
    }
    kept.forEach((col, k) => {
      edgeData[col.name] = keptLinks.map((l) => l.kept[k] ?? null)
    })

    const network: NetworkValue = {
      kind: 'network',
      directed,
      nodes: makeTable(nodeSchema, nodeData),
      edges: makeTable(edgeSchema, edgeData),
    }
    return { network }
  },
})

function label(cell: CellValue | undefined): string {
  if (cell === null || cell === undefined || cell === '') return '—'
  return String(cell)
}

/** Exposed for tests: does this table have what BuildNetwork needs? */
export function canBuildNetwork(schema: TableSchema | undefined): boolean {
  return !!schema && schema.columns.length >= 2 && !!findColumn(schema, schema.columns[0]!.name)
}
