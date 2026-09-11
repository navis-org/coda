/**
 * The viewers' export decisions — the two note families and what each chart resolves — asked of
 * the plans directly.
 *
 * The fixture draws every chart with its pickers set and most with nothing selected, so the
 * goldens hold one sentence per family at most. What is pinned here is each node's own gesture
 * in the empty-selection sentence, the pickers each drawing names when it draws nothing, and the
 * conditions: a selection that exists but has no column to be matched against is still empty.
 */

import { describe, expect, it } from 'vitest'

import type { ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { encodeRange } from '../../nodes/lib/chartSelection'
import { encodeClauses, resolveFilters } from '../../nodes/lib/tableFilter'
import {
  barChartPlan,
  dendrogramSelection,
  distributionPlan,
  histogramPlan,
  pickedIds,
  piePlan,
  scatterPlan,
  tableViewerPlan,
  viewer3dPlan,
} from './viewers'
import { fakeNeutralContext } from './testContext'

const ctx = (type: string, params: ParamValues, wires: Record<string, string> = {}) =>
  fakeNeutralContext({ type, params, wires })

const RANGE = encodeRange({ lo: 1, hi: 5, closed: false })

describe('an empty selection', () => {
  it('names the gesture that fills each port, and the port', () => {
    expect(pickedIds(ctx('out.viewer3d', {}), 'out.viewer3d')).toEqual({
      note: 'Nothing is picked in the viewer, so Selected is empty.',
    })
    expect(pickedIds(ctx('out.profile', {}), 'out.profile')).toEqual({
      note: 'No neuron is pinned on the canvas, so Current is empty.',
    })
    expect(pickedIds(ctx('neuron.explore', {}), 'neuron.explore')).toEqual({
      note: 'Nothing is ticked on the canvas, so Selected is empty.',
    })
    expect(histogramPlan(ctx('out.histogram', { value: 'pre' })).selected).toEqual({
      note: 'No bars are selected on the canvas, so Selected is empty.',
    })
    expect(scatterPlan(ctx('out.scatter', {})).selected).toEqual({
      note: 'Nothing is lassoed on the canvas, so Selected is empty.',
    })
    expect(dendrogramSelection({})).toEqual({
      note: 'No branch is selected on the canvas, so Selected is empty.',
    })
    expect(piePlan(ctx('out.pie', {})).selected).toEqual({
      note: 'No slices are selected on the canvas, so Selected is empty.',
    })
    expect(distributionPlan(ctx('out.distribution', {})).selected).toEqual({
      note: 'No boxes are selected on the canvas, so Selected is empty.',
    })
  })

  it('is still empty when the column a selection is matched on is unset', () => {
    expect(
      histogramPlan(ctx('out.histogram', { selection: [RANGE] })).selected.note,
    ).toBeDefined()
    expect(scatterPlan(ctx('out.scatter', { selection: ['101'] })).selected.note).toBeDefined()
    expect(piePlan(ctx('out.pie', { selection: ['LC4'] })).selected.note).toBeDefined()
    expect(
      distributionPlan(ctx('out.distribution', { selection: ['LC4'] })).selected.note,
    ).toBeDefined()
  })

  /*
   * `rowsMatching` compares labels as stored, so nothing is trimmed or dropped — unlike an id
   * selection — and `markLabel` names a null "—", which is what the null arm is for.
   */
  it('reads pie and box labels verbatim, and flags the name a null is drawn under', () => {
    expect(
      piePlan(ctx('out.pie', { category: 'type', selection: [' LC4 ', '', '5'] })).selected,
    ).toEqual({ column: 'type', labels: [' LC4 ', '', '5'], missing: false })
    expect(
      distributionPlan(ctx('out.distribution', { group: 'type', selection: ['LC4', '—'] }))
        .selected,
    ).toEqual({ column: 'type', labels: ['LC4', '—'], missing: true })
  })

  it('is filled otherwise, with ids as exact text and leaves as positions', () => {
    expect(
      pickedIds(ctx('out.viewer3d', { selection: [' 720575940628857210 '] }), 'out.viewer3d'),
    ).toEqual({ ids: ['720575940628857210'] })
    expect(
      histogramPlan(ctx('out.histogram', { value: 'pre', selection: [RANGE] })).selected,
    ).toEqual({ column: 'pre', ranges: [{ lo: 1, hi: 5 }] })
    expect(
      scatterPlan(ctx('out.scatter', { idColumn: 'neuronId', selection: ['101'] })).selected,
    ).toEqual({ column: 'neuronId', ids: ['101'] })
    expect(dendrogramSelection({ selection: ['2', 'x', '0'] })).toEqual({ positions: [2, 0] })
  })
})

describe('a chart with nothing to draw', () => {
  it('names the pickers its drawing needs', () => {
    expect(barChartPlan(ctx('out.barChart', { category: 'type' }))).toEqual({
      note: 'No category or value column is picked, so nothing is drawn.',
    })
    expect(piePlan(ctx('out.pie', {})).drawn).toEqual({
      note: 'No category column is picked, so nothing is drawn.',
    })
    expect(histogramPlan(ctx('out.histogram', {})).drawn).toEqual({
      note: 'No value column is picked, so nothing is drawn.',
    })
    expect(distributionPlan(ctx('out.distribution', { group: 'type' })).drawn).toEqual({
      note: 'No value column is picked, so nothing is drawn.',
    })
    expect(scatterPlan(ctx('out.scatter', { x: 'pre' })).drawn).toEqual({
      note: 'No x or y column is picked, so nothing is drawn.',
    })
  })

  it('keeps the column a pie or box is drawn by, whether or not it draws', () => {
    expect(piePlan(ctx('out.pie', { category: 'type' }))).toMatchObject({
      category: 'type',
      drawn: {},
    })
    expect(distributionPlan(ctx('out.distribution', { group: 'type' }))).toMatchObject({
      group: 'type',
    })
  })

  it('stacks a bar chart by series only when the card asks to', () => {
    const params = { category: 'type', value: 'pre', series: 'side' }
    const plain = barChartPlan(ctx('out.barChart', params))
    expect(plain.note === undefined && plain.series).toBeUndefined()
    expect(barChartPlan(ctx('out.barChart', { ...params, useSeries: true }))).toHaveProperty(
      'series',
      'side',
    )
  })
})

describe('the other viewers', () => {
  it('refuse a 3D Viewer with no geometry, and draw volumes on their own', () => {
    expect(viewer3dPlan(ctx('out.viewer3d', {})).refusal).toBe(
      'No geometry is wired to this 3D Viewer.',
    )
    expect(viewer3dPlan(ctx('out.viewer3d', {}, { volumes: 'shells' }))).toMatchObject({
      geometry: [],
      volumes: 'shells',
    })
  })

  it('notes a table filter the canvas is ignoring, and applies none of it', () => {
    const schema: TableSchema = { columns: [{ name: 'type', dtype: 'str' }] }
    const clauses = [{ column: 'gone', expression: 'LC4' }]
    const plan = tableViewerPlan(
      fakeNeutralContext({
        type: 'out.table',
        params: { filters: encodeClauses(clauses) },
        schemas: { in: schema },
      }),
    )
    expect(plan.terms).toEqual([])
    // The card's own sentence, from `resolveFilters`, with the document's suffix.
    const [problem] = resolveFilters(schema, clauses).problems
    expect(plan.ignored).toEqual([`${problem!.message} — not applied.`])
  })
})
