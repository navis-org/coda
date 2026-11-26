/**
 * What `seam:proofreadMerges` publishes when the tables hold more than one neuron.
 *
 * The node reviews one neuron at a time, and two of its outputs follow that choice: `Layers`,
 * whose annotation points would otherwise put a second neuron's suggestions in the viewer, and
 * `Current`, whose cursor must not resolve onto a neuron the card is not showing. `Tips` and
 * `Verdicts` stay whole, so switching neuron loses no verdict downstream.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import type { EvalContext, ParamValues } from '../../core/node'
import { defaultParams, findParam, makeInferContext } from '../../core/node'
import { allInputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { column, columnNames, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { emptyGraph, referrerOf } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { EXTENDED_PORT, extendPlanOf } from './pieces'
import type { LayersValue, TableValue, Value } from '../../core/values'
import '../../nodes'

const TIPS: TableValue = makeTable(
  tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('x', 'f64'),
    column('y', 'f64'),
    column('z', 'f64'),
    column('r', 'f64'),
  ),
  {
    // Interleaved, so taking the table's first rows is not the same as taking one neuron.
    [ID_COLUMN_NAME]: ['n1', 'n2', 'n1'],
    end_uid: [1, 2, 3],
    x: [1, 2, 3],
    y: [1, 2, 3],
    z: [1, 2, 3],
    r: [0.5, 0.9, 0.4],
  },
)

const CANDIDATES: TableValue = makeTable(
  tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('candidateId', 'str'),
    column('rank', 'i64'),
    column('contact_x', 'f64'),
    column('contact_y', 'f64'),
    column('contact_z', 'f64'),
  ),
  {
    [ID_COLUMN_NAME]: ['n1', 'n2', 'n1'],
    end_uid: [1, 2, 3],
    candidateId: ['a', 'b', 'c'],
    rank: [1, 1, 1],
    contact_x: [10, 20, 30],
    contact_y: [10, 20, 30],
    contact_z: [10, 20, 30],
  },
)

async function run(
  params: ParamValues,
  inputs: Record<string, Value | undefined> = { tips: TIPS, candidates: CANDIDATES },
): Promise<Record<string, Value>> {
  const def = requireNodeDef('seam:proofreadMerges')
  const ctx = {
    params: { ...defaultParams(def), ...params },
    input: (portId: string) => inputs[portId],
  } as unknown as EvalContext
  return (await def.evaluate(ctx)) as Record<string, Value>
}

const points = (out: Record<string, Value>): string[] => {
  const layers = out['layers'] as LayersValue
  const layer = layers.items.at(-1) as { annotations: { id: string }[] }
  return layer.annotations.map((a) => a.id)
}

describe('one neuron at a time', () => {
  it('draws only the first neuron’s suggestions until another is picked', async () => {
    expect(points(await run({}))).toEqual([
      'n1-1-tip',
      'n1-1-contact',
      'n1-3-tip',
      'n1-3-contact',
    ])
  })

  it('draws only the picked neuron’s suggestions', async () => {
    expect(points(await run({ neuron: 'n2' }))).toEqual(['n2-2-tip', 'n2-2-contact'])
  })

  it('resolves the cursor only within the picked neuron', async () => {
    const off = (await run({ neuron: 'n1', current: 'n2|2', showAccepted: false }))[
      'current'
    ] as TableValue
    expect(off.length).toBe(0)
    const on = (await run({ neuron: 'n2', current: 'n2|2' }))['current'] as TableValue
    expect(on.data[ID_COLUMN_NAME]).toEqual(['n2', 'b'])
  })

  /** Switching neuron loses nothing downstream: the tables still carry every neuron. */
  it('passes every neuron’s tips and verdicts through', async () => {
    const out = await run({ neuron: 'n1', verdicts: 'n2/b=accept;n1/c=reject' })
    expect((out['tips'] as TableValue).length).toBe(3)
    expect((out['verdicts'] as TableValue).data['candidateId']).toEqual(['b', 'c'])
  })

  /** A verdict is about a piece and a neuron: listed at two tips, it is still one judgement. */
  it('lists a verdict once, at the tip where the piece is first listed', async () => {
    const twice = makeTable(CANDIDATES.schema, {
      ...CANDIDATES.data,
      candidateId: ['a', 'b', 'a'],
    })
    const out = await run({ verdicts: 'n1/a=accept' }, { tips: TIPS, candidates: twice })
    const table = out['verdicts'] as TableValue
    expect(table.data['candidateId']).toEqual(['a'])
    expect(table.data['end_uid']).toEqual([1])
  })
})

/**
 * `Show accepted`: every piece accepted on the picked neuron rides on `Current` as `accepted`,
 * which the Neuroglancer node draws green, wherever the cursor is.
 */
describe('showing accepted pieces', () => {
  const current = async (params: ParamValues) => (await run(params))['current'] as TableValue
  const rows = (table: TableValue) =>
    (table.data[ID_COLUMN_NAME] ?? []).map((id, i) => `${id}:${table.data['part']![i]}`)

  it('adds the picked neuron’s accepted pieces after the pair under the cursor', async () => {
    const table = await current({ current: 'n1|1', verdicts: 'n1/c=accept;n2/b=accept' })
    // `b` is accepted on n2, which is not the neuron on screen.
    expect(rows(table)).toEqual(['n1:neuron', 'a:candidate', 'c:accepted'])
  })

  /** Every row says where to look, so sorting the table cannot move the camera. */
  it('carries the cursor’s contact on every row', async () => {
    const table = await current({ current: 'n1|1', verdicts: 'n1/c=accept' })
    expect(table.data['x']).toEqual([10, 10, 10])
  })

  /** Pressing Accept on the piece under the cursor turns it green at once. */
  /** Accepted, and in focus: a lighter green, so it stands out among the other green pieces. */
  it('colours the piece under the cursor as accepted, in focus, once it is', async () => {
    const table = await current({ current: 'n1|1', verdicts: 'n1/a=accept' })
    expect(rows(table)).toEqual(['n1:neuron', 'a:focus'])
  })

  /** Accepted pieces mean nothing on their own, so the neuron leads; the camera stays put. */
  it('shows the neuron and its accepted pieces with no row selected', async () => {
    const table = await current({ verdicts: 'n1/c=accept' })
    expect(rows(table)).toEqual(['n1:neuron', 'c:accepted'])
    expect(table.data['x']).toEqual([null, null])
  })

  it('shows only the pair when switched off', async () => {
    const table = await current({
      current: 'n1|1',
      verdicts: 'n1/c=accept',
      showAccepted: false,
    })
    expect(rows(table)).toEqual(['n1:neuron', 'a:candidate'])
  })

  /** A rejected or unsure piece is not going to be merged, so it is not drawn as if it were. */
  it('ignores verdicts other than accept', async () => {
    const table = await current({ verdicts: 'n1/c=reject;n1/a=unsure' })
    expect(rows(table)).toEqual(['n1:neuron'])
  })
})

/**
 * After Submit: the record (`merges`) is published as `Merges`, and `Current` shows the neuron at
 * the root its merges made, with the merged pieces part of it rather than drawn as themselves.
 */
describe('after merges', () => {
  // Real ids this time: the record keeps only entries whose ids are ids.
  const N = '720575940621039145'
  const renamed = (table: TableValue): TableValue =>
    makeTable(table.schema, {
      ...table.data,
      [ID_COLUMN_NAME]: table.data[ID_COLUMN_NAME]!.map((id) => (id === 'n1' ? N : id)),
      ...(table.data['candidateId']
        ? { candidateId: table.data['candidateId'].map((id) => `9${String(id).charCodeAt(0)}`) }
        : {}),
    })
  // The record is read for the wired Dataset's chunkedgraph, and for none with nothing wired.
  const dataset: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test:1',
    label: 'test',
  }
  const inputs = { tips: renamed(TIPS), candidates: renamed(CANDIDATES), dataset }
  // Candidates `a` and `c` are now 997 and 999.
  const record = JSON.stringify([
    {
      deployment: DEFAULT_CAVE_SERVER,
      datastack: 'test',
      reviewedRoot: N,
      candidateRoot: '997',
      endUid: 1,
      neuronRoot: N,
      neuron: { supervoxel: '11', positionNm: [1, 2, 3] },
      candidate: { supervoxel: '12', positionNm: [1, 2, 3] },
      at: '2026-11-16T10:00:00.000Z',
      outcome: 'merged',
      newRoot: '720575940700000001',
      operationId: '4217',
    },
  ])
  const rows = (table: TableValue) =>
    (table.data[ID_COLUMN_NAME] ?? []).map((id, i) => `${id}:${table.data['part']![i]}`)

  it('publishes the record, one row per entry', async () => {
    const merges = (await run({ merges: record }, inputs))['merges'] as TableValue
    expect(merges.data[ID_COLUMN_NAME]).toEqual([N])
    expect(merges.data['new_root']).toEqual(['720575940700000001'])
    expect(((await run({}, inputs))['merges'] as TableValue).length).toBe(0)
  })

  it('shows the neuron at its root now, and a merged piece as part of it', async () => {
    const verdicts = `${N}/997=accept;${N}/999=accept`
    const out = await run({ merges: record, verdicts, current: `${N}|1` }, inputs)
    expect(rows(out['current'] as TableValue)).toEqual([
      '720575940700000001:neuron',
      '999:accepted',
    ])
    const before = await run({ verdicts, current: `${N}|1` }, inputs)
    expect(rows(before['current'] as TableValue)).toEqual([
      `${N}:neuron`,
      '997:focus',
      '999:accepted',
    ])
    // With no Dataset wired, the record is read for no chunkedgraph: no merge here.
    const unwired = await run(
      { merges: record, verdicts, current: `${N}|1` },
      { ...inputs, dataset: undefined },
    )
    expect(rows(unwired['current'] as TableValue)).toEqual(
      rows(before['current'] as TableValue),
    )
  })
})

/**
 * Extending (`docs/seam-extend-plan.md`): the pairs leave by `Extended`, and a reference to the
 * node is answered with the same table from its params alone — which is what Find Merge Candidates
 * reads, before this node has run.
 */
describe('what is extended', () => {
  const SEED = '648518347558097460'
  const PIECE = '648518347558680055'
  const NEXT = '648518347558349370'
  const def = requireNodeDef('seam:proofreadMerges')
  const grown = (id: string[], seed: string[], steps: number[], junction: boolean[]) =>
    makeTable(
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('x', 'f64'),
        column('y', 'f64'),
        column('z', 'f64'),
        column('seed', 'str'),
        column('steps', 'i64'),
        column('junction', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: id,
        end_uid: id.map((_, i) => (junction[i] ? 0 : i === 0 ? 0 : 1)),
        x: id.map(() => 1),
        y: id.map(() => 1),
        z: id.map(() => 1),
        seed,
        steps,
        junction,
      },
    )
  // The neuron's one tip, then the piece's joining end and its one open end.
  const tips = grown([SEED, PIECE, PIECE], [SEED, SEED, SEED], [0, 1, 1], [false, true, false])
  const candidates = makeTable(CANDIDATES.schema, {
    [ID_COLUMN_NAME]: [SEED, PIECE],
    end_uid: [0, 1],
    candidateId: [PIECE, NEXT],
    rank: [1, 1],
    contact_x: [10, 20],
    contact_y: [10, 20],
    contact_z: [10, 20],
  })
  const inputs = { tips, candidates }
  const accepted = `${SEED}/${PIECE}=accept;${PIECE}/${NEXT}=accept`
  const pairsOf = (value: Value | undefined) => {
    const table = value as TableValue
    return table.data['parent']!.map((parent, i) => `${parent}/${table.data['piece']![i]}`)
  }

  it('promises the pairs’ shape before anything has run', () => {
    const out = def.inferOutputs!(makeInferContext(def, defaultParams(def), {})) as Record<
      string,
      { schema?: TableSchema }
    >
    expect(columnNames(out['extended']!.schema!)).toEqual([
      'parent',
      'piece',
      'mode',
      'auto_min_q',
    ])
  })

  it('publishes the pairs that are asked for and still accepted', async () => {
    const out = await run({ verdicts: accepted, extend: `${SEED}/${PIECE}` }, inputs)
    expect(pairsOf(out['extended'])).toEqual([`${SEED}/${PIECE}`])
    expect(pairsOf((await run({ verdicts: accepted }, inputs))['extended'])).toEqual([])
  })

  /** One function for both, so the search and an ordinary wire cannot read two tables. */
  it('answers a reference with the same table, from the params alone', async () => {
    const params = {
      ...defaultParams(def),
      verdicts: accepted,
      extend: `${PIECE}/${NEXT};${SEED}/${PIECE}`,
    }
    const referred = def.asReference!(params, 'extended')
    expect(referred).toEqual((await run(params, inputs))['extended'])
    // And it is what Find Merge Candidates reads: two chunkedgraph ids a pair, in a stable order.
    expect(extendPlanOf(referred).pairs).toEqual([
      { parent: SEED, piece: PIECE },
      { parent: PIECE, piece: NEXT },
    ])
    // Only that output answers: a wire from any other is not a reference to read.
    expect(def.asReference!(params, 'tips')).toBeUndefined()
  })

  /** The toggle changes what a press writes, never what this node publishes: it re-keys nothing. */
  it('publishes the same with Extend on accept on, and keeps it out of the key', async () => {
    const params = { verdicts: accepted, extend: `${SEED}/${PIECE}` }
    expect(await run({ ...params, extendOnAccept: true }, inputs)).toEqual(
      await run(params, inputs),
    )
    const toggle = def.params!.find((param) => param.id === 'extendOnAccept')!
    expect(toggle.presentational).toBe(true)
    expect(toggle.default).toBe(false)
    // Saved as `autoExtend` before the name went to the menu's Auto-extend (user, 2026-11-18).
    expect(toggle.formerId).toBe('autoExtend')
  })

  /**
   * The card finds the node that searches a piece by who reads `Extended` **by reference** —
   * the reader's own declaration, not a type id the card would have to know.
   */
  it('is read by reference by Find Merge Candidates, which is how the card finds the search', () => {
    const node = (id: string, type: string) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      params: {},
    })
    const edge = (sourceHandle: string, target: string, targetHandle: string) => ({
      id: `${sourceHandle}-${target}-${targetHandle}`,
      source: 'r1',
      sourceHandle,
      target,
      targetHandle,
    })
    const graph = (edges: ReturnType<typeof edge>[]): CodaGraph => ({
      ...emptyGraph(),
      nodes: [
        node('r1', 'seam:proofreadMerges'),
        node('s1', 'seam:findMergeCandidates'),
        node('f1', 'core.filter'),
      ],
      edges,
    })
    expect(referrerOf(graph([edge(EXTENDED_PORT, 's1', 'review')]), 'r1', EXTENDED_PORT)).toBe(
      's1',
    )
    // An ordinary wire carries the table; it does not name the card.
    expect(
      referrerOf(graph([edge(EXTENDED_PORT, 'f1', 'in')]), 'r1', EXTENDED_PORT),
    ).toBeUndefined()
    // Another output wired into the same port is not this one.
    expect(
      referrerOf(graph([edge('tips', 's1', 'review')]), 'r1', EXTENDED_PORT),
    ).toBeUndefined()
    expect(referrerOf(graph([]), 'r1', EXTENDED_PORT)).toBeUndefined()
    // And the port Find Merge Candidates declares names this output as its producer.
    const port = allInputPorts(requireNodeDef('seam:findMergeCandidates')).find(
      (one) => one.id === 'review',
    )!
    expect(port.producedBy).toEqual({ type: 'seam:proofreadMerges', port: EXTENDED_PORT })
  })

  it('reviews the piece’s tips under the neuron, and leaves its joining end out', async () => {
    const out = await run(
      { verdicts: accepted, extend: `${SEED}/${PIECE}`, current: `${PIECE}|1` },
      inputs,
    )
    // One neuron in the viewer: the seed, with both accepted pieces green — the one in hand in
    // focus.
    const current = out['current'] as TableValue
    expect(current.data[ID_COLUMN_NAME]).toEqual([SEED, PIECE, NEXT])
    expect(current.data['part']).toEqual(['neuron', 'accepted', 'focus'])
    expect(current.data['x']).toEqual([20, 20, 20])
    expect(points(out)).toEqual([
      `${SEED}-0-tip`,
      `${SEED}-0-contact`,
      `${PIECE}-1-tip`,
      `${PIECE}-1-contact`,
    ])
  })

  /**
   * The rows of a piece that is no longer extended are still in the table until the search runs
   * again. They pass through `Tips`, which is a tap; nothing else reads them.
   */
  it('reads nothing of a piece that is no longer extended, and still passes its rows on', async () => {
    const out = await run({ verdicts: accepted, current: `${PIECE}|1` }, inputs)
    expect((out['tips'] as TableValue).length).toBe(3)
    // Its rows pass through, with no verdict folded on: the one made there is unread.
    expect((out['tips'] as TableValue).data['verdict']).toEqual(['accept', null, null])
    expect((out['current'] as TableValue).data[ID_COLUMN_NAME]).toEqual([SEED, PIECE])
    expect(points(out)).toEqual([`${SEED}-0-tip`, `${SEED}-0-contact`])
    const verdicts = out['verdicts'] as TableValue
    expect(verdicts.data['candidateId']).toEqual([PIECE])
  })
})

describe('Exclude organelles', () => {
  /** On by default, and on for a graph saved before it existed: a reading aid, publishing nothing. */
  it('is on by default and when absent, and changes nothing the node publishes', () => {
    const def = requireNodeDef('seam:proofreadMerges')
    expect(findParam(def, 'excludeOrganelles')).toMatchObject({
      kind: 'boolean',
      default: true,
      absentMeans: true,
      presentational: true,
    })
  })
})
