// @vitest-environment jsdom

/**
 * The readout under the two clustering bridges.
 *
 * What it exists for is the one silent failure the nodes have: a label matches on a column
 * somebody chose, and the wrong choice gives an empty table with every count in the footer
 * correct and nothing pointing at the cause. Most of this is that case.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValue } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { LabelsToNeuronsBody } from './LabelsToNeuronsBody'
import '../../nodes'

beforeAll(() => {
  installJsdomStubs({ width: 300, height: 240 })
})
afterEach(cleanup)

const TYPE = 'cluster.clustersToNeurons'

function neurons(): TableValue {
  return tableFromRows(
    tableSchema(column('neuronId', 'i64'), column('type', 'str')),
    [
      { neuronId: 11, type: 'LC4' },
      { neuronId: 12, type: 'LC4' },
      { neuronId: 21, type: 'LC6' },
    ],
    'neurons',
  )
}

function clusters(): TableValue {
  return tableFromRows(tableSchema(column('label', 'str'), column('cluster', 'i64')), [
    { label: 'LC4', cluster: 1 },
    { label: 'LC6', cluster: 1 },
    { label: 'GONE', cluster: 2 },
  ])
}

/**
 * The body reads the run through the store, so the store is what has to be primed. Both
 * getters are stubbed rather than a graph being run — what is under test is the arithmetic of
 * the line, not the scheduler.
 */
function draw(options: {
  params?: Record<string, ParamValue>
  labels?: TableValue
  neuronTable?: TableValue
  result?: TableValue
  wired?: boolean
}) {
  const def = requireNodeDef(TYPE)
  const merged = { ...defaultParams(def), ...(options.params ?? {}) }
  const node = { id: 'l2n', type: TYPE, position: { x: 0, y: 0 }, params: merged }

  useGraphStore.setState({
    nodeOutput: (() => options.result) as never,
    nodeInputs: (() => ({
      labels: options.labels,
      neurons: options.neuronTable,
    })) as never,
  } as never)

  const inputs = {
    ...(options.wired === false ? {} : { labels: T.table(options.labels?.schema) }),
    ...(options.neuronTable ? { neurons: T.neurons(options.neuronTable.schema) } : {}),
  }
  const ctx = makeInferContext(def, merged, inputs)
  return render(
    <LabelsToNeuronsBody
      node={node as never}
      ctx={ctx}
      compact
      setParam={() => {}}
      onError={() => {}}
    />,
  )
}

describe('the labels-to-neurons readout', () => {
  it('says how many labels named nothing, which is what a wrong Match on looks like', () => {
    // `neuronId` against a tree labelled by type: nothing matches, and the empty table alone
    // says nothing about why.
    draw({
      params: { matchColumn: 'neuronId' },
      labels: clusters(),
      neuronTable: neurons(),
      result: tableFromRows(neurons().schema, [], 'neurons'),
    })
    expect(screen.getByText(/3 matched nothing/)).toBeTruthy()
  })

  it('counts only the labels that really missed', () => {
    draw({
      params: { matchColumn: 'type' },
      labels: clusters(),
      neuronTable: neurons(),
      result: tableFromRows(neurons().schema, [{ neuronId: 11, type: 'LC4' }], 'neurons'),
    })
    // LC4 and LC6 match; GONE does not.
    expect(screen.getByText(/1 matched nothing/)).toBeTruthy()
    expect(screen.getByText(/3 labels/)).toBeTruthy()
  })

  it('says nothing about misses when every label matched', () => {
    // A line that appears when all is well is a line nobody reads when it is not.
    const all = tableFromRows(tableSchema(column('label', 'str')), [{ label: 'LC4' }])
    draw({
      params: { matchColumn: 'type' },
      labels: all,
      neuronTable: neurons(),
      result: tableFromRows(neurons().schema, [{ neuronId: 11, type: 'LC4' }], 'neurons'),
    })
    expect(screen.queryByText(/matched nothing/)).toBeNull()
  })

  it('counts labels that are not neuron ids when no neuron table is wired', () => {
    // The other way to get an empty result, and it wants a different fix — wire the table.
    draw({
      labels: clusters(),
      result: tableFromRows(tableSchema(column('neuronId', 'i64')), [], 'neurons'),
    })
    expect(screen.getByText(/3 not an ID/)).toBeTruthy()
  })

  it('distinguishes not-wired from not-run, which are different states', () => {
    // Reading "0 labels" off an unwired node would be a claim about nothing.
    draw({ wired: false })
    expect(screen.getByText(/Connect a Selected or Clusters table/)).toBeTruthy()

    cleanup()
    draw({ labels: clusters(), neuronTable: neurons() })
    expect(screen.getByText(/3 labels/)).toBeTruthy()
    expect(screen.queryByText(/neurons/)).toBeNull()
  })

  it('renders every non-advanced param, so a body forgets no control', () => {
    draw({ labels: clusters(), neuronTable: neurons() })
    const shown = (requireNodeDef(TYPE).params ?? []).filter((p) => !p.advanced)
    for (const param of shown) expect(screen.getByText(param.label)).toBeTruthy()
    // And the advanced one stays in the inspector.
    expect(screen.queryByText('Suffix')).toBeNull()
  })
})
