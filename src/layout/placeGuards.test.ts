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
import { getNodeDef } from '../core/registry'
import { registerBuiltinSources } from '../data/builtins'
import { DEMO_DATASET, buildWorkflow } from '../wizard/build'
import { everyCombination } from '../wizard/options'
import '../nodes'
import { NODE_BODIES } from '../ui/nodes/nodeBodies'

/** The default card width, from `.coda-node`'s `--node-width`. */
const DEFAULT_NODE_WIDTH = 232
/** Enough of a gap that two cards read as separate. Cosmetic; overlap is the real failure. */
const MIN_GAP = 24

/**
 * How wide this node draws.
 *
 * Both declarations, because a node can carry either: `defaultSize` sizes React Flow's wrapper
 * and a viewer's card fills one, while everything else that only wants to be wider sets
 * `NODE_BODIES[type].width`. Taking the larger covers both without needing to know which kind
 * this is.
 */
function widthOf(node: GraphNode): number {
  if (node.size) return node.size.width
  const declared = getNodeDef(node.type)?.defaultSize?.width ?? 0
  const body = NODE_BODIES[node.type]?.width ?? DEFAULT_NODE_WIDTH
  return Math.max(declared, body)
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

describe('the generated graphs', () => {
  for (const answers of everyCombination(DEMO_DATASET)) {
    const name = `${answers.start}/${answers.analysis}/${answers.visualisations.join('+')}`
    it(`lays "${name}" out with no card on top of another`, () => {
      const nodes = buildWorkflow(answers).nodes
      const clashes: string[] = []

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!
          const b = nodes[j]!
          if (!sharesRow(a, b)) continue
          const [left, right] = a.position.x <= b.position.x ? [a, b] : [b, a]
          const gap = right.position.x - (left.position.x + widthOf(left))
          if (gap < MIN_GAP) {
            // Named with the numbers, because the fix is a judgement — widen `COL_WIDTH`, move
            // the node, or narrow the card — and the message should say which pair forced it.
            clashes.push(
              `${left.type} (${widthOf(left)}px) → ${right.type}: ${Math.round(gap)}px gap`,
            )
          }
        }
      }

      expect(clashes).toEqual([])
    })
  }

  /*
   * `everyCombination` walks one viewer at a time, which is right for what it is for — a second
   * viewer is the same chain with another card on the same port. The influence arm is the one
   * place that is not true: ticking a heatmap *and* a table builds a Group By and a Sort on a
   * second row that neither singleton has, so the shape nobody enumerated is the one to place.
   */
  it('lays the two-viewer influence chain out with no card on top of another', () => {
    const nodes = buildWorkflow({
      dataset: DEMO_DATASET,
      start: 'search',
      analysis: 'influence',
      visualisations: ['heatmap', 'table'],
      notes: true,
      dashboard: false,
    }).nodes
    const clashes: string[] = []
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!
        const b = nodes[j]!
        if (!sharesRow(a, b)) continue
        const [left, right] = a.position.x <= b.position.x ? [a, b] : [b, a]
        const gap = right.position.x - (left.position.x + widthOf(left))
        if (gap < MIN_GAP) {
          clashes.push(`${left.type} (${widthOf(left)}px) → ${right.type}: ${Math.round(gap)}px gap`)
        }
      }
    }
    expect(clashes).toEqual([])
  })
})
