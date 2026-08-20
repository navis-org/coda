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
import { T } from '../../core/types'
import type { LinkageValue } from '../../core/values'
import { makeLinkage } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
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

function draw(
  value: LinkageValue,
  params: Record<string, ParamValue> = {},
  onSelectionChange?: (labels: string[]) => void,
) {
  const def = requireNodeDef('out.dendrogram')
  const merged = { ...defaultParams(def), ...params }
  const node = { id: 'dendro', type: 'out.dendrogram', position: { x: 0, y: 0 }, params: merged }
  const ctx = makeInferContext(def, merged, { in: T.linkage() })
  return render(
    <ValuePreview
      node={node as never}
      value={value}
      ctx={ctx}
      {...(onSelectionChange ? { onSelectionChange } : {})}
    />,
  )
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
    const { container } = draw(tree(), {}, onSelectionChange)
    const targets = container.querySelectorAll('path[stroke="transparent"]')

    // Positions, not names: a label column can call two leaves the same thing.
    fireEvent.click(targets[1]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['2', '3'])

    fireEvent.click(targets[2]!)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['0', '1', '2', '3'])
  })

  it('clears when the same branch is clicked twice, rather than needing empty canvas', () => {
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), { selection: ['2', '3'] }, onSelectionChange)
    fireEvent.click(container.querySelectorAll('path[stroke="transparent"]')[1]!)
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('adds to the selection under a modifier rather than replacing it', () => {
    const onSelectionChange = vi.fn()
    const { container } = draw(tree(), { selection: ['0'] }, onSelectionChange)
    fireEvent.click(container.querySelectorAll('path[stroke="transparent"]')[1]!, { metaKey: true })
    expect(onSelectionChange).toHaveBeenCalledWith(['0', '2', '3'])
  })

  it('selects a single leaf from its label', () => {
    const onSelectionChange = vi.fn()
    draw(tree(), {}, onSelectionChange)
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
    const n = 300
    const labels = Array.from({ length: n }, (_, i) => `n${i}`)
    const merges = new Float64Array((n - 1) * 4)
    for (let i = 0; i < n - 1; i++) {
      merges[i * 4] = i === 0 ? 0 : n + i - 1
      merges[i * 4 + 1] = i + 1
      merges[i * 4 + 2] = (i + 1) / n
      merges[i * 4 + 3] = i + 2
    }
    draw(makeLinkage(merges, labels, Int32Array.from(labels.map((_, i) => i))))
    expect(screen.getByText('labels thinned')).toBeTruthy()
  })

  it('refuses a tree too big to draw rather than emitting a smear', () => {
    const n = 4000
    const labels = Array.from({ length: n }, (_, i) => `n${i}`)
    const merges = new Float64Array((n - 1) * 4)
    for (let i = 0; i < n - 1; i++) {
      merges[i * 4] = i === 0 ? 0 : n + i - 1
      merges[i * 4 + 1] = i + 1
      merges[i * 4 + 2] = (i + 1) / n
      merges[i * 4 + 3] = i + 2
    }
    draw(makeLinkage(merges, labels, Int32Array.from(labels.map((_, i) => i))))
    expect(screen.getByText(/too many to draw/)).toBeTruthy()
  })
})
