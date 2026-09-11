/**
 * That a built graph does not draw one card on top of another.
 *
 * Written when the builders advanced by a constant `COL_WIDTH` and the width a card renders at was
 * declared somewhere the headless ones could not look (`NODE_BODIES[type].width`, in `src/ui`), so
 * the constant was a figure kept in step with the cards by hand — the arrangement where it goes
 * stale in silence. It overlapped for real: Find Neurons' 360px card spanned two columns of every
 * starter graph, and it took a screenshot to see. The width is on the definition now and every
 * builder places through `layout/columns.ts`, which steps by it; this is what says that holds.
 *
 * So this asserts the property rather than the mechanism: "does any graph a builder produces
 * overlap", which is the thing anybody would actually notice — over every wizard answer, every
 * node guide demo, every starter and the assistant plan shapes that used to overlap. Horizontal
 * only: a card's height is its content, which no builder knows and jsdom cannot measure.
 */

import { describe, expect, it } from 'vitest'

import type { AssistantPlan } from '../assistant/planShape'
import { emptyPlan } from '../assistant/planShape'
import { applyPlan } from '../assistant/apply'
import type { CodaGraph, GraphNode } from '../core/graph'
import { emptyGraph } from '../core/graph'
import {
  CUSTOM_DATASET_NODES,
  DATASET_FAMILIES,
  familyForNodeType,
} from '../nodes/lib/datasetFamilies'
import { registerBuiltinSources } from '../data/builtins'
import type { StarterSpec } from '../wizard/starters'
import { buildStarter, starterFor } from '../wizard/starters'
import { arrangeHeadless } from '../test/arrange'
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
import { cardWidth } from './elkGraph'

/** Enough of a gap that two cards read as separate. Cosmetic; overlap is the real failure. */
const MIN_GAP = 24

/**
 * How wide this node draws — through `cardWidth`, which is what lays these graphs out.
 *
 * This was a local `Math.max` over `defaultSize` and `NODE_BODIES`, which missed a third source:
 * a viewer that declares no width reaching `WIDE_CARD_WIDTH` the moment it has something to draw.
 * So a viewer measured 232 here and 360 where the demos were placed, and the graphs were being
 * checked with a different ruler from the one that placed them — the exact drift this file exists
 * to catch. One reader, `layout/elkGraph`'s, for placement and check alike.
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
 * a generated chain's geometry is arithmetic over its wires, and the combination nobody tried is
 * exactly the one that overlaps.
 */
// The option space is gated on `capabilityOf`, which needs the sources registered — and this is
// read at *collection* time, before any hook runs. `wizard.test.ts` records what goes wrong.
registerBuiltinSources({ mockLatencyMs: 0 })

/**
 * Every pair of cards on one row that is closer than `MIN_GAP`, named with its numbers.
 *
 * Named rather than counted because the fix is a judgement — a row hint, the placement rule, or
 * the card's declared width — and the message should say which pair forced it.
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
 * It did: `place` measured the right edge with `boundsOf`, whose `resolveSize` could not then read
 * the body widths (they lived in `src/ui`), so an Explore card measured 232 where it draws 520 and
 * the appended card landed on top of it — 53 pairs across the 102 demos while the wizard's own
 * graphs had none. The width is on the definition now and `resolveSize` reads it through
 * `cardWidth`, so `boundsOf` is right again, and this is what says so.
 */
describe('the node guide demo workflows', () => {
  for (const [type, plan] of demoPlans()) {
    it(`lays the ${type} demo out with no card on top of another`, () => {
      expect(clashesIn(demoGraph(type, plan)!.nodes)).toEqual([])
    })
  }
})

/*
 * The starters, which are the wizard's output with the dataset node a menu asked for — every
 * family, the synthetic ones included, and every custom dataset node, since a custom node is no
 * family and reaches the builder through `BuildOptions.dataset` rather than through a key.
 */
describe('the starter graphs', () => {
  const specs: StarterSpec[] = [
    ...DATASET_FAMILIES.map(starterFor),
    ...CUSTOM_DATASET_NODES.map((custom) => ({
      nodeType: custom.type,
      label: custom.type,
      sourceId: custom.sourceId,
    })),
  ]
  for (const spec of specs) {
    it(`lays the ${spec.nodeType} starter out with no card on top of another`, () => {
      expect(clashesIn(buildStarter(spec).nodes)).toEqual([])
    })
  }
})

/*
 * The same starters after the arrange they ask for on arrival, at their declared sizes. Folded
 * members are not on the canvas, so they are checked as the box they draw as; a chain caption is
 * drawn, so a caption the arrange left no room for is an overlap here. Where each caption lands is
 * `companions.test.ts`' question.
 */
describe('the starter graphs after an arrange', () => {
  for (const nodeType of ['dataset.hemibrain', 'dataset.flywire', 'dataset.banc']) {
    it(`arranges the ${nodeType} starter with no card on top of another`, async () => {
      const spec = starterFor(familyForNodeType(nodeType)!)
      expect((await arrangeHeadless(buildStarter(spec))).overlapping).toEqual([])
    })
  }
})

/*
 * The assistant's applier, which placed a plan's cards a constant 416 apart by depth and measured
 * what was already there at 232 a card — so these three shapes overlapped: an Explore Dataset
 * (520) mid-block, an ROI viewer (620) beside a card in the next column, and a plan appended to
 * the right of an Explore already on the canvas. Each is the shape rather than a coincidence of
 * one graph, which is what the constant could not be checked against.
 */
describe('the assistant’s plans', () => {
  const plan = (
    add: AssistantPlan['add'],
    connect: [string, string, string, string][],
  ): AssistantPlan => ({
    ...emptyPlan(),
    add,
    connect: connect.map(([from, fromPort, to, toPort]) => ({
      from: { node: from, port: fromPort },
      to: { node: to, port: toPort },
    })),
  })
  const apply = (graph: CodaGraph, next: AssistantPlan): CodaGraph => {
    const result = applyPlan(graph, next)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    return result.graph
  }

  const browse = plan(
    [
      { ref: 'ds', type: `dataset.${DEMO_DATASET}` },
      { ref: 'explore', type: 'neuron.explore' },
      { ref: 'table', type: 'out.table' },
    ],
    [
      ['ds', 'dataset', 'explore', 'dataset'],
      ['explore', 'selected', 'table', 'in'],
    ],
  )

  it('lays an Explore Dataset mid-block out with no card on top of another', () => {
    expect(clashesIn(apply(emptyGraph(), browse).nodes)).toEqual([])
  })

  it('lays an ROI viewer beside a chain out with no card on top of another', () => {
    const graph = apply(
      emptyGraph(),
      plan(
        [
          { ref: 'ds', type: `dataset.${DEMO_DATASET}` },
          { ref: 'rois', type: 'out.rois' },
          { ref: 'find', type: 'neuron.findNeurons' },
          { ref: 'conn', type: 'neuron.connectivity' },
        ],
        [
          ['ds', 'dataset', 'rois', 'dataset'],
          ['ds', 'dataset', 'find', 'dataset'],
          ['ds', 'dataset', 'conn', 'dataset'],
          ['find', 'neurons', 'conn', 'neurons'],
        ],
      ),
    )
    expect(clashesIn(graph.nodes)).toEqual([])
  })

  it('appends to the right of an Explore already on the canvas, clear of it', () => {
    const first = apply(
      emptyGraph(),
      plan(browse.add.slice(0, 2), [['ds', 'dataset', 'explore', 'dataset']]),
    )
    const explore = first.nodes.find((n) => n.type === 'neuron.explore')!
    const second = apply(
      first,
      plan([{ ref: 'table', type: 'out.table' }], [[explore.id, 'selected', 'table', 'in']]),
    )
    expect(clashesIn(second.nodes)).toEqual([])
  })
})
