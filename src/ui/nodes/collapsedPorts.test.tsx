// @vitest-environment jsdom

/**
 * Putting a card's sockets on its header — which two controls now do: Collapse, which keeps
 * nothing else, and the `☰` fold, which keeps the body and the footer.
 *
 * The load-bearing fact is that the handles are **moved, never removed**. React Flow finds a
 * node's anchors with `nodeElement.querySelectorAll('.source' | '.target')` and returns `null`
 * when there are none — so unmounting the ports would leave every wire on the card with nowhere
 * to attach, and `display: none` would give each one a zero-size rect at the card's top-left
 * corner, which is worse because it looks deliberate. Neither fails a typecheck.
 *
 * jsdom does no layout, so where the sockets actually land cannot be measured here. What is
 * checked is the DOM they are laid out from and the declarations that place them — the same
 * standing `runRing.placement.test.tsx` has, and for the same reason: this class of bug is
 * silent to every other kind of test.
 */

import { readFileSync } from 'node:fs'

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('morphology')
  })
})

afterEach(cleanup)

function nodeIdOfType(type: string): string {
  const found = useGraphStore.getState().graph.nodes.find((n) => n.type === type)
  if (!found) throw new Error(`no ${type} in the example`)
  return found.id
}

async function wrapperFor(nodeId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    if (!found?.querySelector('.coda-node')) throw new Error(`no card for ${nodeId}`)
    return found as HTMLElement
  })
}

const cardIn = (wrapper: HTMLElement) => wrapper.querySelector('.coda-node') as HTMLElement
const collapse = (id: string) => act(() => useGraphStore.getState().toggleCollapsed([id]))

describe('the sockets survive the collapse', () => {
  it('keeps every handle mounted, so no wire loses its anchor', async () => {
    render(<App />)
    // Skeletons: two inputs, one output — enough that a dropped row would show in the count.
    const skeletons = nodeIdOfType('neuron.skeletons')
    const wrapper = await wrapperFor(skeletons)
    const def = requireNodeDef('neuron.skeletons')
    const expected = (def.inputs ?? []).length + (def.outputs ?? []).length
    expect(wrapper.querySelectorAll('.react-flow__handle')).toHaveLength(expected)

    collapse(skeletons)
    await waitFor(() => expect(cardIn(wrapper).dataset.collapsed).toBe('true'))

    // The whole point: same handles, somewhere else. Not fewer, and not zero.
    expect(wrapper.querySelectorAll('.react-flow__handle')).toHaveLength(expected)
    expect(cardIn(wrapper).querySelector('.coda-node__ports')).not.toBeNull()
  })

  it('keeps each socket addressable by its own port id', async () => {
    // Fanned rather than stacked on one point, so a link dragged at a particular input still
    // has something to hit. Overlapping them exactly would leave the topmost winning every
    // pointer event, and the drag-off anchors coincident.
    render(<App />)
    const viewer = nodeIdOfType('out.viewer3d')
    const wrapper = await wrapperFor(viewer)
    collapse(viewer)
    await waitFor(() => expect(cardIn(wrapper).dataset.collapsed).toBe('true'))

    const ids = [...wrapper.querySelectorAll('.react-flow__handle')].map((h) =>
      h.getAttribute('data-handleid'),
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining(requireNodeDef('out.viewer3d').inputs!.map((p) => p.id)),
    )
  })

  it('drops the labels, which is the whole of what the rows were made of', async () => {
    render(<App />)
    const skeletons = nodeIdOfType('neuron.skeletons')
    const wrapper = await wrapperFor(skeletons)
    expect(wrapper.querySelectorAll('.port-label').length).toBeGreaterThan(0)
    collapse(skeletons)
    await waitFor(() => expect(cardIn(wrapper).dataset.collapsed).toBe('true'))
    // Still in the DOM — the rule that hides them is asserted below, since jsdom applies no
    // stylesheet — but the socket's `title` is what carries the name now, so it has to say it.
    const socket = wrapper.querySelector('.react-flow__handle')!
    expect(socket.getAttribute('title')).toMatch(/.+:.+/)
  })
})

describe('the fold puts them there too', () => {
  it('takes the port rows with the params, and keeps the footer', async () => {
    // The ☰ fold used to take only the param rows. Its point is to give the space to what is
    // below them, and on a viewer the port rows are the other band in the way.
    render(<App />)
    const find = nodeIdOfType('neuron.findNeurons')
    const wrapper = await wrapperFor(find)
    expect(cardIn(wrapper).dataset.portsFolded).toBeUndefined()

    act(() => useGraphStore.getState().toggleParamRows([find]))
    await waitFor(() => expect(cardIn(wrapper).dataset.portsFolded).toBe('true'))

    // Both bands gone from the flow, the handles still mounted, and — unlike Collapse — the
    // footer still saying what the node is holding.
    expect(cardIn(wrapper).querySelector('.coda-node__params')).toBeNull()
    expect(cardIn(wrapper).querySelector('.coda-node__footer')).not.toBeNull()
    expect(cardIn(wrapper).dataset.collapsed).toBeUndefined()
    const def = requireNodeDef('neuron.findNeurons')
    expect(wrapper.querySelectorAll('.react-flow__handle')).toHaveLength(
      (def.inputs ?? []).length + (def.outputs ?? []).length,
    )
  })

  it('is offered on a card whose only rows are ports', async () => {
    // Skeletons draws no param rows at all — every one of its params is advanced — so the
    // sockets are the only thing a fold can reclaim there. Gating the button on params alone
    // would leave exactly the cards with the most to gain without one.
    render(<App />)
    const skeletons = nodeIdOfType('neuron.skeletons')
    const wrapper = await wrapperFor(skeletons)
    expect(cardIn(wrapper).querySelectorAll('.coda-node__params .param')).toHaveLength(0)
    const button = cardIn(wrapper).querySelector('.coda-node__fold') as HTMLButtonElement
    expect(button).not.toBeNull()

    act(() => button.click())
    await waitFor(() => expect(cardIn(wrapper).dataset.portsFolded).toBe('true'))
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the card keeps its width and gives up its height', () => {
  /**
   * A viewer carrying a `defaultSize`, which is what puts an explicit box on the wrapper.
   * Added rather than found: the morphology example's viewer is `out.viewer3d`, which declares
   * none, so the case would not arise there — and that is most viewers.
   */
  async function boxedViewer(): Promise<HTMLElement> {
    act(() => useGraphStore.getState().addNode('out.scatter', { x: 0, y: 400 }))
    return wrapperFor(nodeIdOfType('out.scatter'))
  }

  it('lets the wrapper hug a collapsed viewer instead of pinning it to the box', async () => {
    /*
     * A viewer's `defaultSize` is written onto React Flow's wrapper. Kept through a collapse it
     * leaves a header floating in the top-left of a 620px rectangle — and `.coda-node::before`
     * is inset against the *wrapper*, so the state bar hangs hundreds of pixels below the card
     * as a coloured line with nothing beside it. Dropping the height is also what makes the
     * wrapper resize, which is what re-measures the handles that just moved.
     */
    render(<App />)
    const wrapper = await boxedViewer()
    const viewer = nodeIdOfType('out.scatter')
    const width = wrapper.style.width
    expect(width).not.toBe('')
    expect(wrapper.style.height).not.toBe('')

    collapse(viewer)
    await waitFor(() => expect(wrapper.style.height).toBe(''))
    // The width is the half that stays: a card that jumped to 232px on the way to a title bar
    // would move every wire on it twice.
    expect(wrapper.style.width).toBe(width)
  })

  it('still fills its box while expanded', async () => {
    render(<App />)
    const wrapper = await boxedViewer()
    expect(cardIn(wrapper).dataset.sized).toBe('true')
    collapse(nodeIdOfType('out.scatter'))
    await waitFor(() => expect(cardIn(wrapper).dataset.collapsed).toBe('true'))
    // `data-sized` survives — it now means "the wrapper has a width" — and the stylesheet is
    // what withholds the height half. Asserted as a declaration below.
    expect(cardIn(wrapper).dataset.sized).toBe('true')
  })
})

describe('the declarations that place them', () => {
  const css = () => readFileSync('src/ui/editor.css', 'utf8')

  function rule(selector: string): string {
    const source = css()
    const start = source.indexOf(`${selector} {`)
    expect(start, `no rule for ${selector}`).toBeGreaterThan(-1)
    return source.slice(start, source.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('lays the band over the header, not over the whole card', () => {
    /*
     * `inset: 0` works only while the card *is* its header, i.e. collapsed. A `☰` fold leaves a
     * preview and a footer underneath, and centring the sockets in those would put them halfway
     * down a chart. So the band takes the header's own height, declared once as `--header-h`
     * and applied to the header as a `min-height` so the two cannot drift.
     */
    const band = rule('.coda-node[data-ports-folded] .coda-node__ports')
    expect(band).toMatch(/position:\s*absolute/)
    expect(band).toMatch(/top:\s*0/)
    expect(band).toMatch(/height:\s*var\(--header-h\)/)
    expect(band).not.toMatch(/inset:\s*0/)
    expect(rule('.coda-node__header')).toMatch(/min-height:\s*var\(--header-h\)/)
  })

  it('lets the header keep its own clicks', () => {
    // The band covers the header, which owns the drag, the run button and the chevron. React
    // Flow puts pointer events back on each handle itself, so `none` here costs the sockets
    // nothing and a missing `none` costs the header everything.
    expect(rule('.coda-node[data-ports-folded] .coda-node__ports')).toMatch(
      /pointer-events:\s*none/,
    )
  })

  it('fans the rows on a fixed pitch rather than collapsing them onto one point', () => {
    const row = rule('.coda-node[data-ports-folded] .port-row')
    expect(row).toMatch(/height:\s*var\(--port-pitch\)/)
    expect(row).toMatch(/min-height:\s*0/)
    expect(rule('.coda-node[data-ports-folded] .coda-node__ports')).toMatch(
      /--port-pitch:\s*\d/,
    )
  })

  it('hides the labels', () => {
    expect(rule('.coda-node[data-ports-folded] .port-label')).toMatch(/display:\s*none/)
  })

  it('withholds the box-filling height from a collapsed card', () => {
    // `height: 100%` against a wrapper that no longer has one resolves to auto, so this is
    // belt-and-braces — but `display: flex` on a card whose preview is gone is not, and the
    // pair is what `data-sized` used to mean unconditionally.
    expect(css()).toContain('.coda-node[data-sized]:not([data-collapsed]) {')
    expect(rule('.coda-node[data-sized]')).not.toMatch(/height:/)
  })
})
