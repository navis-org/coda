// @vitest-environment jsdom

/**
 * The dendrogram card.
 *
 * The geometry is pinned in `dendrogramLayout.test.ts`; what is left for here is everything
 * that file cannot see — that the card renders through **`ValuePreview`** rather than only as
 * a component, that a click on a bracket hands back exactly the leaves under it, and that the
 * caption admits what is not on screen.
 *
 * It drives `ValuePreview` on the datasetSummary lesson: a dispatch branch in the wrong place
 * fails no type check and leaves the card showing its empty state forever, which a test that
 * renders the viewer directly cannot reach.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValue } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { LinkageValue, TableValue } from '../../core/values'
import { makeLinkage, tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { caterpillar } from './linkageFixture'
import { ValuePreview } from './ValuePreview'
import '../../nodes'

beforeAll(() => {
  installJsdomStubs({ width: 560, height: 420 })
})

afterEach(cleanup)

/**
 *   a ─┐ 0.1
 *   b ─┴────┐
 *   c ─┐    ├── 0.8
 *   d ─┴────┘ 0.2
 */
function tree(clusters?: Int32Array): LinkageValue {
  return makeLinkage(
    Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.8, 4]),
    ['a', 'b', 'c', 'd'],
    Int32Array.from([0, 1, 2, 3]),
    { method: 'average', distanceLabel: '1 − NBLAST score', ...(clusters ? { clusters } : {}) },
  )
}

/**
 * `annotations` is the port's *value*; its **type** is derived from the same table, because a
 * wired-but-unrun graph is the state where the pickers resolve and the card must still draw the
 * tree's own labels — which `renders the tree unchanged when the port is wired but has not run`
 * covers by passing nothing at all.
 */
interface DrawOptions {
  onSelectionChange?: (labels: string[]) => void
  annotations?: TableValue
  compact?: boolean
}

function draw(
  value: LinkageValue,
  params: Record<string, ParamValue> = {},
  { onSelectionChange, annotations, compact = false }: DrawOptions = {},
) {
  const def = requireNodeDef('out.dendrogram')
  const merged = { ...defaultParams(def), ...params }
  const node = {
    id: 'dendro',
    type: 'out.dendrogram',
    position: { x: 0, y: 0 },
    params: merged,
  }
  const ctx = makeInferContext(def, merged, {
    in: T.linkage(),
    ...(annotations ? { annotations: T.neurons(annotations.schema) } : {}),
  })
  return render(
    <ValuePreview
      node={node as never}
      value={value}
      ctx={ctx}
      compact={compact}
      {...(annotations ? { inputValues: { annotations } } : {})}
      {...(onSelectionChange ? { onSelectionChange } : {})}
    />,
  )
}

/** A neuron table naming two of the tree's four leaves. */
function annotationTable(): TableValue {
  return tableFromRows(tableSchema(column('neuronId', 'str'), column('type', 'str')), [
    { neuronId: 'a', type: 'LC4' },
    { neuronId: 'b', type: 'LC4' },
  ])
}

describe('the dendrogram card', () => {
  it('renders the tree through ValuePreview, not just as a component', () => {
    draw(tree())
    expect(screen.getByRole('img', { name: /Dendrogram of 4 leaves/ })).toBeTruthy()
    expect(screen.queryByText(/No result yet/)).toBeNull()
  })

  it('draws one bracket per merge, each with a fat hit path behind it', () => {
    const { container } = draw(tree())
    // Three merges, two paths each: the transparent 10px target and the visible hairline. A
    // hairline bracket with no target behind it is unclickable at any realistic tree size.
    const paths = container.querySelectorAll('svg path')
    expect(paths.length).toBe(6)
    expect(container.querySelectorAll('path[stroke="transparent"]').length).toBe(3)
  })

  it('hands back exactly the leaves under the branch that was clicked', () => {
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), {}, { onSelectionChange })
    const targets = container.querySelectorAll('path[stroke="transparent"]')

    // Positions, not names: a label column can call two leaves the same thing.
    fireEvent.click(targets[1]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['2', '3'])

    fireEvent.click(targets[2]!)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['0', '1', '2', '3'])
  })

  it('clears when the same branch is clicked twice, rather than needing empty canvas', () => {
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), { selection: ['2', '3'] }, { onSelectionChange })
    fireEvent.click(container.querySelectorAll('path[stroke="transparent"]')[1]!)
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('adds to the selection under a modifier rather than replacing it', () => {
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), { selection: ['0'] }, { onSelectionChange })
    fireEvent.click(container.querySelectorAll('path[stroke="transparent"]')[1]!, {
      metaKey: true,
    })
    expect(onSelectionChange).toHaveBeenCalledWith(['0', '2', '3'])
  })

  it('selects a single leaf from its label', () => {
    const onSelectionChange = vi.fn()
    draw(tree(), {}, { onSelectionChange })
    fireEvent.click(screen.getByText('b'))
    expect(onSelectionChange).toHaveBeenCalledWith(['1'])
  })

  it('lights only the branch that was picked, though the labels repeat', () => {
    /*
     * Found in a real browser and invisible everywhere else. With `Label by: type` on an
     * NBLAST, fourteen neurons carry five distinct names — so a selection held as *labels*
     * matched every branch whose leaves happened to share a name, and two thirds of the tree
     * lit up for a three-leaf click. The caption said "3 selected" throughout, which is why
     * no assertion on it would have caught this.
     */
    const repeated = makeLinkage(
      Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.8, 4]),
      ['LC4', 'LC4', 'LC4', 'LC4'],
      Int32Array.from([0, 1, 2, 3]),
    )
    const { container } = draw(repeated, { selection: ['0', '1'] })
    const visible = [...container.querySelectorAll('svg path')].filter(
      (p) => p.getAttribute('stroke') !== 'transparent',
    )
    // Exactly one bracket is the selected one; the other two are not, though every leaf under
    // them is called LC4.
    const lit = visible.filter((p) => Number(p.getAttribute('stroke-width')) > 2)
    expect(lit).toHaveLength(1)
  })

  it('says what it is holding, and what has been picked', () => {
    const { container } = draw(tree(), { selection: ['0', '1'] })
    // One line rather than three: the caption is a single span, and asserting on `/4 leaves/`
    // alone also matches the SVG's own `<title>`.
    expect(container.querySelector('.viewer__caption span')?.textContent).toBe(
      '4 leaves · average · 2 selected',
    )
  })

  it('counts the clusters when the tree has been cut', () => {
    draw(tree(Int32Array.from([1, 1, 2, 2])))
    expect(screen.getByText(/2 clusters/)).toBeTruthy()
  })

  it('admits that colours repeat past the palette, rather than hiding the fold', () => {
    // Everywhere else a ninth category goes achromatic, because in a legend a repeated hue
    // claims two series are the same thing. A dendrogram is the case that rule does not fit —
    // clusters sit in leaf order, so two sharing a hue are visibly far apart — but the reader
    // still has to be told. Same idiom as `labels thinned`.
    const labels = Array.from({ length: 12 }, (_, i) => `n${i}`)
    const merges = new Float64Array(11 * 4)
    for (let i = 0; i < 11; i++) {
      merges[i * 4] = i === 0 ? 0 : 12 + i - 1
      merges[i * 4 + 1] = i + 1
      merges[i * 4 + 2] = (i + 1) / 12
      merges[i * 4 + 3] = i + 2
    }
    const many = makeLinkage(merges, labels, Int32Array.from(labels.map((_, i) => i)), {
      clusters: Int32Array.from(labels.map((_, i) => i + 1)),
    })
    draw(many)
    expect(screen.getByText('colours repeat')).toBeTruthy()
  })

  it('drops leaf labels when the card cannot hold them, and says so', () => {
    draw(caterpillar(300))
    expect(screen.getByText('labels thinned')).toBeTruthy()
  })

  it('draws a tree with more leaves than it can label, and says that is what it is', () => {
    // It refused at three thousand. The shape of a ten-thousand-leaf clustering is a real
    // picture even when no single leaf can be read — and Cut Tree is the node for the question
    // that needs the leaves.
    draw(caterpillar(4000))
    expect(screen.queryByText(/more than one card can hold/)).toBeNull()
    expect(screen.getByText('structure only')).toBeTruthy()
  })

  it('still refuses the tree that is more SVG than a card can hold', () => {
    draw(caterpillar(20_001))
    expect(screen.getByText(/more than one card can hold/)).toBeTruthy()
  })
})

/**
 * The zoom's surface.
 *
 * The window arithmetic is `dendrogramLayout.test.ts`' — jsdom lays nothing out and dispatches
 * no real wheel — so what is left for here is the two questions a headless test cannot ask:
 * whether the gesture is offered at all, and whether offering it took the click away from the
 * brackets, which is what this viewer exists for.
 */
describe('zoom and pan', () => {
  it('offers a fit control off the canvas, and none on it', () => {
    draw(tree())
    expect(screen.getByLabelText('Fit to view')).toBeTruthy()
    cleanup()
    // Compact is the card on the canvas: a 150px preview React Flow already zooms, where a
    // wheel belongs to the pane rather than to the tree.
    draw(tree(), {}, { compact: true })
    expect(screen.queryByLabelText('Fit to view')).toBeNull()
  })

  it('starts fitted, so the control is dead and the caption says nothing', () => {
    draw(tree())
    expect(screen.getByLabelText('Fit to view').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/^×/)).toBeNull()
  })

  it('keeps the wheel and the drag off React Flow, which owns the pane underneath', () => {
    const { container } = draw(tree())
    const box = container.querySelector('.viewer__scroll')!
    expect(box.classList.contains('nowheel')).toBe(true)
    expect(box.classList.contains('nodrag')).toBe(true)
  })

  it('still selects a branch on a click, which the pan must never take away', () => {
    // The regression this guards is the one a pointer-capture-on-press implementation causes:
    // the click after `pointerup` goes to the capturing element rather than to the bracket, so
    // selection stops working the moment anybody zooms in.
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), {}, { onSelectionChange })
    const hit = container.querySelectorAll('path[stroke="transparent"]')[0]!
    fireEvent.click(hit)
    expect(onSelectionChange).toHaveBeenCalledWith(['0', '1'])
  })
})

/**
 * Naming the leaves from a wired table.
 *
 * Through `ValuePreview` for the file's stated reason, and here it is load-bearing twice over:
 * the annotation table arrives on `inputValues` and the two columns are resolved by
 * `ctx.column`, so a branch that read `node.params` instead would pass a component test and
 * name a column the run never used.
 */
describe('leaf labels from an annotation table', () => {
  /** The labels actually drawn, in leaf order. */
  function drawn(container: HTMLElement): string[] {
    return [...container.querySelectorAll('svg text')].map((t) => t.textContent ?? '')
  }

  it('draws the annotation column in place of the label the matrix carried', () => {
    const { container } = draw(tree(), {}, { annotations: annotationTable() })
    expect(drawn(container)).toEqual(['LC4', 'LC4', 'c', 'd'])
  })

  it('needs nothing set: the declared defaults are neuronId and type', () => {
    // `defaultParams` writes both at creation, so wiring the neuron table that fed the
    // clustering is the whole gesture. A regression here is a port that looks inert.
    const { container } = draw(tree(), {}, { annotations: annotationTable() })
    expect(container.textContent).toContain('by type')
  })

  it('keeps its own label for a leaf the table says nothing about, and counts them', () => {
    const { container } = draw(tree(), {}, { annotations: annotationTable() })
    expect(drawn(container)).toContain('c')
    expect(screen.getByText('2 unnamed')).toBeTruthy()
  })

  it('keeps the identity on the leaf as a title, since two leaves now read the same', () => {
    // The tree above names `a` and `b` both `LC4`, which is the ordinary case for cell types —
    // so the only thing left saying which leaf is which is this.
    const { container } = draw(tree(), {}, { annotations: annotationTable() })
    const titles = [...container.querySelectorAll('svg g > title')].map((t) => t.textContent)
    expect(titles).toEqual(['a', 'b'])
  })

  it('draws the tree unchanged when the port is wired but has not run', () => {
    // A wire says a table is coming; only a run says what is in it. Every viewer here reads the
    // value rather than the type for exactly this reason.
    const { container } = draw(tree())
    expect(drawn(container)).toEqual(['a', 'b', 'c', 'd'])
    expect(container.textContent).not.toContain('by type')
    expect(screen.queryByText(/unnamed/)).toBeNull()
  })

  it('draws the tree unchanged when Label by is cleared, because empty is a decision', () => {
    // Both pickers are `optional`, so an empty one means off rather than "fall back to the
    // default" — `resolveColumn`'s rule, and what stops a cleared picker naming every leaf
    // after whichever column comes first in the table.
    const { container } = draw(tree(), { labelColumn: '' }, { annotations: annotationTable() })
    expect(drawn(container)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never lets a name reach the Selected output, which is the identity downstream', () => {
    const def = requireNodeDef('out.dendrogram')
    const params = { ...defaultParams(def), selection: ['0'] }
    const result = def.evaluate!({
      input: () => tree(),
      params,
      column: () => undefined,
      columns: () => [],
      inputs: {},
      warn: () => {},
      progress: () => {},
    } as never) as unknown as { selected: { data: Record<string, unknown[]> } }
    // `a`, not `LC4`: `Selected to Neurons` matches this column against a neuron table, and a
    // cell type there resolves one clade to every neuron of that type in the connectome.
    expect(result.selected.data.label).toEqual(['a'])
  })
})
