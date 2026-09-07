/**
 * That a hand-placed graph does not draw one card on top of another.
 *
 * `place.ts` advances by a constant `COL_WIDTH`, and the width a card actually renders at is
 * declared somewhere it cannot look: `NODE_BODIES[type].width` lives in `src/ui`, and `place.ts`
 * is in the headless group. So the constant is a figure kept in step with the cards by hand, and
 * that is precisely the arrangement where it goes stale in silence — a wider body pushes the next
 * column underneath itself on a canvas no unit test renders and jsdom cannot measure. This one
 * overlapped for real: Find Neurons' 360px card spanned two columns of every starter graph, and
 * it took a screenshot to see.
 *
 * So this asserts the property rather than the proxy. Not "is the constant big enough" — which is
 * unanswerable without knowing which nodes a graph holds, and which `out.rois` at 620px would
 * fail on a graph it never appears in — but "does any bundled graph overlap", which is the thing
 * anybody would actually notice. A test can import both halves; neither module can.
 */

import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../core/graph'
import { registerBuiltinSources } from '../data/builtins'
import { GROWING_CROSS_SETS } from '../test/crossSets'
import { DEMO_DATASET, buildWorkflow } from '../wizard/build'
import { demoGraph, demoPlans } from '../wizard/demo'
import {
  analysisOptions,
  everyCombination,
  startOptions,
  visualisationOptions,
} from '../wizard/options'
import '../nodes'
import { cardWidth } from '../ui/nodes/nodeBodies'

/** Enough of a gap that two cards read as separate. Cosmetic; overlap is the real failure. */
const MIN_GAP = 24

/**
 * How wide this node draws — through `cardWidth`, which is what lays these graphs out.
 *
 * This was a local `Math.max` over `defaultSize` and `NODE_BODIES`, written before `cardWidth`
 * existed; that helper's own header names this file as one of its three callers, and it was not
 * one. The difference is load-bearing rather than cosmetic: `cardWidth` counts a third source
 * this did not, a viewer that declares no width reaching `WIDE_CARD_WIDTH` the moment it has
 * something to draw. So a viewer card measured 232 here and 360 in `wizard/demo.ts`'s `place`,
 * and the demo graphs below were being checked with a different ruler from the one that placed
 * them — the exact drift this file exists to catch.
 *
 * A node's own `size` still wins: that is a card somebody resized, and `resolveSize` reads it
 * first for the same reason.
 */
function widthOf(node: GraphNode): number {
  return node.size?.width ?? cardWidth(node.type)
}

/** Cards on the same band of canvas, near enough vertically that a horizontal clash would show. */
function sharesRow(a: GraphNode, b: GraphNode): boolean {
  return Math.abs(a.position.y - b.position.y) < 100
}

/*
 * Every graph the Workflow Wizard can build, rather than the four bundled examples this used to
 * walk. The check is worth more here: an example was laid out by hand once and looked at, while
 * a generated chain's geometry is arithmetic — `xOf` plus a per-analysis column index — and the
 * combination nobody tried is exactly the one that overlaps. The Explore card is 520px against a
 * 416px column, which is what `EXPLORE_SHIFT` exists for and what this would catch if it went.
 */
// The option space is gated on `capabilityOf`, which needs the sources registered — and this is
// read at *collection* time, before any hook runs. `wizard.test.ts` records what goes wrong.
registerBuiltinSources({ mockLatencyMs: 0 })

/**
 * Every pair of cards on one row that is closer than `MIN_GAP`, named with its numbers.
 *
 * Named rather than counted because the fix is a judgement — widen `COL_WIDTH`, move the node,
 * or narrow the card — and the message should say which pair forced it.
 */
function clashesIn(nodes: readonly GraphNode[]): string[] {
  const clashes: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!
      const b = nodes[j]!
      if (!sharesRow(a, b)) continue
      const [left, right] = a.position.x <= b.position.x ? [a, b] : [b, a]
      const gap = right.position.x - (left.position.x + widthOf(left))
      if (gap < MIN_GAP) {
        clashes.push(
          `${left.type} (${widthOf(left)}px) → ${right.type}: ${Math.round(gap)}px gap`,
        )
      }
    }
  }
  return clashes
}

describe('the generated graphs', () => {
  for (const answers of everyCombination([DEMO_DATASET])) {
    const name = `${answers.start}/${answers.analysis}/${answers.visualisations.join('+')}`
    it(`lays "${name}" out with no card on top of another`, () => {
      expect(clashesIn(buildWorkflow(answers).nodes)).toEqual([])
    })
  }

  /*
   * `everyCombination` walks one viewer at a time, which is right for what it is for — a second
   * viewer is the same chain with another card on the same port. The influence arm is the one
   * place that is not true: ticking a heatmap *and* a table builds a Group By and a Sort on a
   * second row that neither singleton has, so the shape nobody enumerated is the one to place.
   */
  /*
   * And the shape the wizard now *opens* with: every viewer an analysis offers, ticked. That
   * used to be the rare answer and is the default one, so a row of three cards stepped by
   * `cardWidth` is what most generated graphs are — the arithmetic `everyCombination`'s
   * singletons never exercise.
   */
  for (const analysis of analysisOptions([DEMO_DATASET])) {
    const views = visualisationOptions([DEMO_DATASET], analysis.id)
    if (views.length < 2) continue
    for (const start of startOptions([DEMO_DATASET])) {
      it(`lays "${start.id}/${analysis.id}" out with every viewer ticked`, () => {
        const nodes = buildWorkflow({
          datasets: [DEMO_DATASET],
          start: start.id,
          analysis: analysis.id,
          visualisations: views.map((view) => view.id),
          notes: true,
          dashboard: false,
        }).nodes
        expect(clashesIn(nodes)).toEqual([])
      })
    }
  }

  /*
   * The cross-dataset shapes, which are the only ones that put cards on more than one **row** of
   * their own: an arm per dataset running down, the shared chain running right. `everyCombination`
   * above walks one dataset, so nothing there exercises the band spacing — and a head card is the
   * tallest thing the wizard places, which is what `ARM_ROW` is measured against.
   */
  for (const datasets of GROWING_CROSS_SETS) {
    for (const answers of everyCombination(datasets)) {
      const name = `${datasets.join('+')}/${answers.start}/${answers.analysis}/${answers.visualisations.join('+')}`
      it(`lays "${name}" out with no card on top of another`, () => {
        expect(clashesIn(buildWorkflow(answers).nodes)).toEqual([])
      })
    }
  }

  it('lays the two-viewer influence chain out with no card on top of another', () => {
    const nodes = buildWorkflow({
      datasets: [DEMO_DATASET],
      start: 'search',
      analysis: 'influence',
      visualisations: ['heatmap', 'table'],
      notes: true,
      dashboard: false,
    }).nodes
    expect(clashesIn(nodes)).toEqual([])
  })
})

/*
 * The node guide's demo workflows, which are the wizard's graphs with a node or three appended —
 * so they inherit the layout above and then extend it, which is its own way to overlap.
 *
 * It did: `place` measured the right edge with `boundsOf`, and `layout/elkGraph`'s `resolveSize`
 * cannot read `NODE_BODIES` (`src/layout` may not import `src/ui`), so an Explore card measured
 * 232 where it draws 520 and the appended card landed on top of it — 53 pairs across the 102
 * demos while the wizard's own graphs had none. `cardWidth` is the reader that sees all four
 * width sources, and this is what says so.
 */
describe('the node guide demo workflows', () => {
  for (const [type, plan] of demoPlans()) {
    it(`lays the ${type} demo out with no card on top of another`, () => {
      expect(clashesIn(demoGraph(type, plan)!.nodes)).toEqual([])
    })
  }
})
