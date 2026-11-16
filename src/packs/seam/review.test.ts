/**
 * What `seam:review` publishes when the tables hold more than one neuron.
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
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
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
  const def = requireNodeDef('seam:review')
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
    const off = (await run({ neuron: 'n1', current: '2', showAccepted: false }))[
      'current'
    ] as TableValue
    expect(off.length).toBe(0)
    const on = (await run({ neuron: 'n2', current: '2' }))['current'] as TableValue
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
    const table = await current({ current: '1', verdicts: 'n1/c=accept;n2/b=accept' })
    // `b` is accepted on n2, which is not the neuron on screen.
    expect(rows(table)).toEqual(['n1:neuron', 'a:candidate', 'c:accepted'])
  })

  /** Every row says where to look, so sorting the table cannot move the camera. */
  it('carries the cursor’s contact on every row', async () => {
    const table = await current({ current: '1', verdicts: 'n1/c=accept' })
    expect(table.data['x']).toEqual([10, 10, 10])
  })

  /** Pressing Accept on the piece under the cursor turns it green at once. */
  it('colours the piece under the cursor as accepted once it is', async () => {
    const table = await current({ current: '1', verdicts: 'n1/a=accept' })
    expect(rows(table)).toEqual(['n1:neuron', 'a:accepted'])
  })

  /** Accepted pieces mean nothing on their own, so the neuron leads; the camera stays put. */
  it('shows the neuron and its accepted pieces with no row selected', async () => {
    const table = await current({ verdicts: 'n1/c=accept' })
    expect(rows(table)).toEqual(['n1:neuron', 'c:accepted'])
    expect(table.data['x']).toEqual([null, null])
  })

  it('shows only the pair when switched off', async () => {
    const table = await current({ current: '1', verdicts: 'n1/c=accept', showAccepted: false })
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
    const out = await run({ merges: record, verdicts, current: '1' }, inputs)
    expect(rows(out['current'] as TableValue)).toEqual([
      '720575940700000001:neuron',
      '999:accepted',
    ])
    const before = await run({ verdicts, current: '1' }, inputs)
    expect(rows(before['current'] as TableValue)).toEqual([
      `${N}:neuron`,
      '997:accepted',
      '999:accepted',
    ])
    // With no Dataset wired, the record is read for no chunkedgraph: no merge here.
    const unwired = await run(
      { merges: record, verdicts, current: '1' },
      { ...inputs, dataset: undefined },
    )
    expect(rows(unwired['current'] as TableValue)).toEqual(
      rows(before['current'] as TableValue),
    )
  })
})
