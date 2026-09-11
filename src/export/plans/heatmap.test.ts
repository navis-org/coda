/**
 * The heatmap export's decisions, asked of the plan directly.
 *
 * The goldens hold what the two documents *say* for the fixture's heatmaps; what they cannot
 * reach is the branches no fixture node takes — a pattern that will not compile, a `value` sort
 * with no key, limits being ignored — and those are exactly the ones whose note has to land in
 * the right section.
 */

import { describe, expect, it } from 'vitest'

import type { ParamValues } from '../../core/node'
import { missingKeyProblem } from '../../nodes/lib/matrixShape'
import { heatmapExportPlan } from './heatmap'
import { fakeNeutralContext } from './testContext'

function exportPlan(params: ParamValues, annotations?: string) {
  return heatmapExportPlan(
    fakeNeutralContext({
      type: 'out.heatmap',
      params,
      wires: annotations ? { annotations } : {},
    }),
  )
}

/** The sections, for a heatmap that does not refuse — which is every case but one. */
function planFor(params: ParamValues, annotations?: string) {
  const plan = exportPlan(params, annotations)
  if (plan.refusal !== undefined) throw new Error(`refused: ${plan.refusal}`)
  return plan
}

const NAMED = { matchColumn: 'neuronId', labelColumn: 'type' }

describe('heatmapExportPlan', () => {
  it('does nothing but bind both Selected ports on an untouched heatmap', () => {
    const plan = planFor({})
    expect(plan.tracked).toEqual(new Set())
    expect(plan.labels).toBeUndefined()
    expect(plan.filter).toEqual([])
    expect(plan.order).toBeUndefined()
    expect(plan.selection).toEqual([
      { axis: 'rows', positions: [] },
      { axis: 'columns', positions: [] },
    ])
    expect(plan.colour).toMatchObject({ palette: 'coda', substitute: true, manual: false })
    expect(plan.colour.limitsNote).toBeUndefined()
  })

  it('notes an uncompilable pattern on its own axis and still filters the other', () => {
    const plan = planFor({ rowFilter: '/[', colFilter: '!DN' })
    expect(plan.filter).toEqual([
      {
        axis: 'rows',
        note:
          'The rows filter "/[" is not a valid regular expression, so Coda kept every row and ' +
          'so does this.',
      },
      { axis: 'columns', pattern: 'DN', regex: false, negate: true },
    ])
  })

  it('leaves a keyless value sort as it arrived, with nothing for a follower to follow', () => {
    const order = planFor({ sortBy: 'value', sortAxis: 'rows' }).order!
    expect(order.steps).toEqual([
      {
        axis: 'rows',
        note:
          'The rows are to be ordered by one column but none is named, so they are left as ' +
          'they arrived.',
      },
    ])
    expect(order.follower).toBeUndefined()
    expect(order.ordered).toEqual([])
  })

  it('carries the card’s own sentence for a key only the data can say is missing', () => {
    const order = planFor({ sortBy: 'value', sortKey: 'LC4', sortAxis: 'columns' }).order!
    expect(order.steps).toEqual([
      { axis: 'columns', by: 'value', keyMissing: missingKeyProblem('columns', 'LC4') },
    ])
    // Checked at run time, so the follower is still planned; the documents leave it too.
    expect(order.follower).toEqual({ axis: 'rows', leader: 'columns' })
    const rows = planFor({ sortBy: 'value', sortKey: 'DN1', sortAxis: 'both' }).order!
    expect(rows.steps.map((step) => step.note === undefined && step.by)).toEqual([
      'value',
      'value',
    ])
    expect(rows.steps.map((step) => ('keyMissing' in step ? step.keyMissing : ''))).toEqual([
      missingKeyProblem('rows', 'DN1'),
      missingKeyProblem('columns', 'DN1'),
    ])
  })

  it('refuses a cluster order in a method fastcore does not know, as the card fails', () => {
    expect(exportPlan({ sortBy: 'cluster', clusterMethod: 'ward.D2' }).refusal).toMatch(
      /^"ward\.D2" is not a linkage method fastcore knows/,
    )
    expect(exportPlan({ sortBy: 'cluster', clusterMethod: 'centroid' }).refusal).toBeUndefined()
    // Hidden, and so never read, unless the order is a clustering.
    expect(exportPlan({ sortBy: 'total', clusterMethod: 'ward.D2' }).refusal).toBeUndefined()
  })

  it('sorts each lead axis in turn, and orders the follower too', () => {
    const both = planFor({ sortBy: 'cluster', sortAxis: 'both' }).order!
    expect(both.steps).toEqual([
      { axis: 'rows', by: 'cluster' },
      { axis: 'columns', by: 'cluster' },
    ])
    expect(both.follower).toBeUndefined()

    const followed = planFor({ sortBy: 'total', sortAxis: 'columns' }).order!
    expect(followed.follower).toEqual({ axis: 'rows', leader: 'columns' })
    expect(followed.ordered).toEqual(['rows', 'columns'])
  })

  it('tracks arrival names only on a renamed axis somebody selected on', () => {
    const plan = planFor(
      { ...NAMED, rowFilter: 'LC', sortBy: 'label', selection: ['r:3', 'r:1', 'c:0'] },
      'annotations',
    )
    // Both axes are renamed and both carry a selection, so both are tracked everywhere.
    expect(plan.tracked).toEqual(new Set(['rows', 'columns']))
    expect(plan.labels?.axes).toEqual(['rows', 'columns'])
    expect(plan.selection[0]).toEqual({ axis: 'rows', positions: [1, 3] })

    // Renamed but selected on one axis only: the other has nothing to carry.
    const one = planFor({ ...NAMED, selection: ['c:2'] }, 'annotations')
    expect(one.tracked).toEqual(new Set(['columns']))

    // No wire, no renaming — so nothing to track, whatever is selected.
    const unnamed = planFor({ ...NAMED, selection: ['r:1'] })
    expect(unnamed.labels).toBeUndefined()
    expect(unnamed.tracked).toEqual(new Set())
  })

  it('treats an empty picker as unset, as a real context does', () => {
    const plan = planFor({ ...NAMED, labelColumn: '', selection: ['r:1'] }, 'annotations')
    expect(plan.labels).toBeUndefined()
    expect(plan.tracked).toEqual(new Set())
  })

  it('says why typed limits are ignored, and treats one typed end as manual', () => {
    expect(planFor({ colorMin: '10', colorMax: '1' }).colour.limitsNote).toBe(
      'Coda is ignoring the colour limits because the minimum (10) is not below the maximum ' +
        '(1), so neither this nor the card is using them.',
    )
    expect(planFor({ colorMax: '5' }).colour).toMatchObject({
      manual: true,
      limits: { max: 5 },
    })
  })
})
