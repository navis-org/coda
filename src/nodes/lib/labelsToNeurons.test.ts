/**
 * Labels in, neurons out.
 *
 * The two nodes are one operation under two names, so this is where the operation is checked;
 * `transform/labelsToNeurons.test.ts` covers what the two registrations differ about, which is
 * nothing that runs.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import { labelsToNeurons, labelsToNeuronsSchema } from './labelsToNeurons'

/** Six neurons of three types, the shape an NBLAST labelled by type is clustered from. */
function neurons(): TableValue {
  return tableFromRows(
    tableSchema(column('neuronId', 'i64'), column('type', 'str'), column('status', 'str')),
    [
      { neuronId: 11, type: 'LC4', status: 'Traced' },
      { neuronId: 12, type: 'LC4', status: 'Traced' },
      { neuronId: 21, type: 'LC6', status: 'Traced' },
      { neuronId: 31, type: 'DNp01', status: 'Traced' },
      { neuronId: 32, type: 'DNp01', status: 'Assign' },
      { neuronId: 41, type: 'APL', status: 'Traced' },
    ],
    'neurons',
  )
}

/** A Cut Tree's Clusters, labelled by type. */
function clusters(): TableValue {
  return tableFromRows(
    tableSchema(column('label', 'str'), column('cluster', 'i64'), column('order', 'i64')),
    [
      { label: 'LC4', cluster: 1, order: 0 },
      { label: 'LC6', cluster: 1, order: 1 },
      { label: 'DNp01', cluster: 2, order: 2 },
      { label: 'GONE', cluster: 3, order: 3 },
    ],
  )
}

describe('matching against a neuron table', () => {
  const run = () =>
    labelsToNeurons({
      labels: clusters(),
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'type',
    })

  it('expands a label to every neuron carrying it', () => {
    // The point of the whole node when the tree is labelled by type: a clade of three types is
    // five neurons, and it is the neurons somebody wants in a 3D view.
    const out = run().neurons
    expect(getColumn(out, 'neuronId')).toEqual([11, 12, 21, 31, 32])
  })

  it('carries every neuron column and every extra label column', () => {
    const out = run().neurons
    expect(out.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      'status',
      'cluster',
      'order',
    ])
    // Each neuron gets the cluster of its own label, which is what Neuroglancer colours by.
    expect(getColumn(out, 'cluster')).toEqual([1, 1, 1, 2, 2])
    expect(getColumn(out, 'status')).toEqual(['Traced', 'Traced', 'Traced', 'Traced', 'Assign'])
  })

  it('drops the label column, which is the match column under a second name', () => {
    expect(run().neurons.schema.columns.map((c) => c.name)).not.toContain('label')
  })

  it('is a neurons table, not a plain one', () => {
    // A value whose kind disagrees with its port's declared type is a disagreement nothing
    // type-checks — and `T.neurons()` is what Neuroglancer's socket demands.
    expect(run().neurons.kind).toBe('neurons')
  })

  it('keeps the neuron table order rather than the label order', () => {
    const reversed = tableFromRows(clusters().schema, [
      { label: 'DNp01', cluster: 2, order: 2 },
      { label: 'LC4', cluster: 1, order: 0 },
    ])
    const out = labelsToNeurons({
      labels: reversed,
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'type',
    }).neurons
    expect(getColumn(out, 'neuronId')).toEqual([11, 12, 31, 32])
  })

  it('reports how many labels found anything, so a wrong Match on is visible', () => {
    const result = run()
    expect(result.asked).toBe(4)
    // GONE names no neuron.
    expect(result.matched).toBe(3)
  })

  it('matches as text, which is what makes a body-id label work at all', () => {
    /*
     * An NBLAST labelled by neuron id produces the *string* "11" against an `i64` column. This is
     * the default wiring, so comparing by value would fail on the common case rather than an
     * exotic one — the same `String(cell)` rule `joinTables` follows.
     */
    const byId = tableFromRows(tableSchema(column('label', 'str'), column('cluster', 'i64')), [
      { label: '11', cluster: 1 },
      { label: '41', cluster: 2 },
    ])
    const out = labelsToNeurons({
      labels: byId,
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'neuronId',
    }).neurons
    expect(getColumn(out, 'neuronId')).toEqual([11, 41])
  })

  it('takes the first row for a repeated label rather than multiplying neurons', () => {
    const dupes = tableFromRows(tableSchema(column('label', 'str'), column('cluster', 'i64')), [
      { label: 'LC4', cluster: 1 },
      { label: 'LC4', cluster: 9 },
    ])
    const out = labelsToNeurons({
      labels: dupes,
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'type',
    }).neurons
    expect(out.length).toBe(2)
    expect(getColumn(out, 'cluster')).toEqual([1, 1])
  })

  it('suffixes a carried column the neuron table already has', () => {
    const collides = tableFromRows(
      tableSchema(column('label', 'str'), column('status', 'str')),
      [{ label: 'LC4', status: 'from the cut' }],
    )
    const out = labelsToNeurons({
      labels: collides,
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'type',
      suffix: '_c',
    }).neurons
    expect(out.schema.columns.map((c) => c.name)).toContain('status_c')
    expect(getColumn(out, 'status')).toEqual(['Traced', 'Traced'])
    expect(getColumn(out, 'status_c')).toEqual(['from the cut', 'from the cut'])
  })

  it('ignores a null or empty label, which names nothing', () => {
    const blanks = tableFromRows(
      tableSchema(column('label', 'str'), column('cluster', 'i64')),
      [
        { label: null, cluster: 1 },
        { label: '', cluster: 2 },
      ],
    )
    expect(
      labelsToNeurons({
        labels: blanks,
        labelColumn: 'label',
        neurons: neurons(),
        matchColumn: 'type',
      }).neurons.length,
    ).toBe(0)
  })
})

describe('with no neuron table, the labels are ids', () => {
  const byId = () =>
    tableFromRows(tableSchema(column('label', 'str'), column('cluster', 'i64')), [
      { label: '722817260', cluster: 1 },
      { label: '11', cluster: 2 },
    ])

  it('reads them straight off, which is the default NBLAST wiring', () => {
    const out = labelsToNeurons({ labels: byId(), labelColumn: 'label' }).neurons
    expect(out.kind).toBe('neurons')
    expect(getColumn(out, 'neuronId')).toEqual([722817260, 11])
    expect(getColumn(out, 'cluster')).toEqual([1, 2])
  })

  it('puts neuronId first, since that is the column it exists to produce', () => {
    expect(
      labelsToNeurons({ labels: byId(), labelColumn: 'label' }).neurons.schema.columns[0]!.name,
    ).toBe('neuronId')
  })

  it('drops a label that is not a usable id, and counts it', () => {
    /*
     * Dropped rather than refused: this is data arriving from a viewer, not text somebody
     * typed, so the asymmetry `idsFromColumn` records applies. A tree labelled by cell type
     * comes through here as nothing at all, which is what the count is for.
     */
    const types = tableFromRows(tableSchema(column('label', 'str')), [
      { label: 'LC4' },
      { label: '11' },
    ])
    const result = labelsToNeurons({ labels: types, labelColumn: 'label' })
    expect(getColumn(result.neurons, 'neuronId')).toEqual([11])
    expect(result.dropped).toBe(1)
    expect(result.matched).toBe(1)
  })

  it('drops an id too big to be exact rather than identifying a different neuron', () => {
    // 2^53 and beyond is stored as a different integer — the rule `idList.ts` refuses on.
    const big = tableFromRows(tableSchema(column('label', 'str')), [
      { label: '9007199254740993' },
    ])
    expect(labelsToNeurons({ labels: big, labelColumn: 'label' }).dropped).toBe(1)
  })
})

describe('the schema, which infer and evaluate share', () => {
  it('describes exactly what the run produces, both ways round', () => {
    const withNeurons = labelsToNeuronsSchema(
      clusters().schema,
      'label',
      neurons().schema,
      '_c',
    )
    const ran = labelsToNeurons({
      labels: clusters(),
      labelColumn: 'label',
      neurons: neurons(),
      matchColumn: 'type',
      suffix: '_c',
    }).neurons
    expect(withNeurons?.columns.map((c) => c.name)).toEqual(
      ran.schema.columns.map((c) => c.name),
    )
  })

  it('describes the id path too', () => {
    const inferred = labelsToNeuronsSchema(clusters().schema, 'label', undefined, '_c')
    const ran = labelsToNeurons({ labels: clusters(), labelColumn: 'label' }).neurons
    expect(inferred?.columns.map((c) => c.name)).toEqual(ran.schema.columns.map((c) => c.name))
    expect(inferred?.columns[0]!.name).toBe('neuronId')
  })

  it('answers nothing when the labels table is not known yet', () => {
    expect(labelsToNeuronsSchema(undefined, 'label', neurons().schema, '_c')).toBeUndefined()
  })
})
