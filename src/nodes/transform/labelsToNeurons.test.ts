/**
 * The two registrations.
 *
 * `lib/labelsToNeurons.test.ts` covers the operation; what is left for here is everything the
 * two nodes differ about — which is deliberately nothing that runs, so most of this is checking
 * that they *stay* identical where they should be and differ only where they were meant to.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, schemaOf, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import '../index'

const BOTH = ['cluster.selectedToNeurons', 'cluster.clustersToNeurons']

function neurons(): TableValue {
  return tableFromRows(
    tableSchema(column('bodyId', 'i64'), column('type', 'str')),
    [
      { bodyId: 11, type: 'LC4' },
      { bodyId: 12, type: 'LC4' },
      { bodyId: 21, type: 'LC6' },
    ],
    'neurons',
  )
}

function labels(): TableValue {
  return tableFromRows(
    tableSchema(column('label', 'str'), column('cluster', 'i64'), column('color', 'str')),
    [{ label: 'LC4', cluster: 1, color: '#3987e5' }],
  )
}

function run(type: string, params: Record<string, unknown>, wired = true): Record<string, unknown> {
  const def = requireNodeDef(type)
  return def.evaluate!({
    params: { ...defaultParams(def), ...params },
    input: (port: string) =>
      port === 'labels' ? labels() : wired ? neurons() : undefined,
    column: (id: string) =>
      id === 'labelColumn' ? 'label' : ((params.matchColumn as string) ?? 'bodyId'),
    columns: () => [],
    progress: () => {},
    signal: undefined,
  } as never) as Record<string, unknown>
}

describe.each(BOTH)('%s', (type) => {
  it('emits neurons carrying the label table’s other columns', () => {
    const out = run(type, { matchColumn: 'type' }).neurons as TableValue
    expect(out.kind).toBe('neurons')
    expect(getColumn(out, 'bodyId')).toEqual([11, 12])
    expect(getColumn(out, 'cluster')).toEqual([1, 1])
    // The colour the branch was drawn in, carried to whatever draws the neurons.
    expect(getColumn(out, 'color')).toEqual(['#3987e5', '#3987e5'])
  })

  it('costs nothing to run: no network, no query, no Python', () => {
    expect(requireNodeDef(type).cost).toBe('cheap')
  })

  it('declares a neurons output, which is what a 3D socket demands', () => {
    expect(requireNodeDef(type).outputs?.[0]?.type.kind).toBe('neurons')
  })

  it('says at edit time that unwired Neurons means the labels must be ids', () => {
    // Otherwise the failure is an empty table with nothing pointing at the cause.
    const issues = requireNodeDef(type).validate!({
      params: defaultParams(requireNodeDef(type)),
      inputs: {},
      column: () => undefined,
      columns: () => [],
    } as never)
    expect(issues.join(' ')).toMatch(/read as body ids/)
  })

  it('refuses a labels input that is not a table', () => {
    const def = requireNodeDef(type)
    expect(() =>
      def.evaluate!({
        params: defaultParams(def),
        input: () => ({ kind: 'number', value: 1 }),
        column: () => 'label',
        columns: () => [],
        progress: () => {},
        signal: undefined,
      } as never),
    ).toThrow(/not a table/)
  })
})

describe('what the two differ about', () => {
  it('is the socket name and the warning, not the behaviour', () => {
    const [a, b] = BOTH.map((t) => requireNodeDef(t))
    expect(a!.inputs?.[0]?.label).toBe('Selected')
    expect(b!.inputs?.[0]?.label).toBe('Clusters')
    // Same params, in the same order: one implementation under two names.
    expect(a!.params?.map((p) => p.id)).toEqual(b!.params?.map((p) => p.id))
  })

  it('warns only on the Clusters flavour when there is no cluster column', () => {
    /*
     * Carrying the cluster number is the whole reason that node exists, so a labels table
     * without one is a Dendrogram's Selected wired in by mistake. The other node has no such
     * expectation and must not cry wolf about it.
     */
    const bare = tableSchema(column('label', 'str'))
    const ask = (type: string) =>
      requireNodeDef(type)
        .validate!({
          params: defaultParams(requireNodeDef(type)),
          inputs: { labels: { kind: 'table', schema: bare }, neurons: { kind: 'neurons' } },
          column: () => 'label',
          columns: () => [],
        } as never)
        .join(' ')
    expect(ask('cluster.clustersToNeurons')).toMatch(/No "cluster" column/)
    expect(ask('cluster.selectedToNeurons')).not.toMatch(/No "cluster" column/)
  })
})

describe('inference', () => {
  function graphWith(matchColumn: string) {
    let g = emptyGraph('l2n')
    const node = (id: string, type: string, params: Record<string, unknown> = {}): GraphNode => ({
      id,
      type,
      position: { x: 0, y: 0 },
      params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
    })
    g = addNode(g, node('ds', 'dataset.mock.hemibrain'))
    g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*' }))
    g = addNode(g, node('l2n', 'cluster.clustersToNeurons', { matchColumn }))
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'l2n', targetHandle: 'neurons' })
    return g
  }

  it('publishes a neurons type so a 3D socket accepts the wire', () => {
    const inferred = inferGraph(graphWith('type'))
    expect(inferred.nodes['l2n']?.outputs.neurons?.kind).toBe('neurons')
  })

  it('does not guess a one-column result for a neuron table whose schema is unknown', () => {
    /*
     * Wired-but-unknown is not the same as unwired. Guessing `bodyId` for the first would
     * advertise a shape the run will not produce — the unknown-is-not-empty rule
     * `columnSchemaFor` draws.
     */
    const def = requireNodeDef('cluster.clustersToNeurons')
    const inferred = def.inferOutputs!({
      inputs: { labels: { kind: 'table', schema: tableSchema(column('label', 'str')) }, neurons: { kind: 'neurons' } },
      params: defaultParams(def),
      column: () => 'label',
      columns: () => [],
    } as never)
    expect(schemaOf(inferred.neurons)).toBeUndefined()
  })
})
