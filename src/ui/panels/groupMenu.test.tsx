// @vitest-environment jsdom

/**
 * Groups on screen: the frame, its menu, and the four surfaces that can make one.
 *
 * What jsdom can see here is everything except the pointer. It performs no layout and dispatches
 * no real pointer sequences, so **the drag is not asserted anywhere, and cannot be** — that the
 * outline is grabbable, that the interior still pans and box-selects, and that the canvas does
 * not slide out from under a frame being moved each need a real browser. `docs/canvas.md` lists
 * those checks and records that they have not been run against this implementation yet.
 * What is observable here is the DOM the frame draws, the menu's rows, the keys and the palette
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { serializeGraph } from '../../core/graph'
import { configurableParams } from '../../core/node'
import { measureCardSizes } from '../cardSizes'
import { getNodeDef, requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { GROUP_GRAB } from '../GroupLayer'
import { GROUP_PADDING } from '../../layout/groupBounds'
import { buildCommandItems } from './paletteItems'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.setState({ locked: false, autoLayout: false })
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    useGraphStore.getState().setSelection([])
  })
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const nodeIds = () => store().graph.nodes.map((n) => n.id)
const frames = () => document.querySelectorAll('.group-frame')
const frame = () => document.querySelector('.group-frame')
const card = (id: string) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el
}

/** Two cards framed, the app rendered, with the frame's menu open on it. */
function openFrameMenu(): string {
  const [a, b] = nodeIds()
  act(() => {
    store().setSelection([a!, b!])
    store().groupSelection()
  })
  const el = document.querySelector('.group-frame__grab')
  if (!el) throw new Error('no frame on the canvas')
  fireEvent.contextMenu(el)
  return store().graph.groups![0]!.id
}

function commands() {
  return buildCommandItems({
    store: useGraphStore.getState(),
    fitView: () => {},
    fitSelected: () => {},
  })
}
const command = (id: string) => commands().find((item) => item.id === id)

describe('the frame on the canvas', () => {
  it('draws one box per group, and none at all before anything is grouped', () => {
    render(<App />)
    expect(frames().length).toBe(0)
    act(() => {
      store().setSelection(nodeIds().slice(0, 2))
      store().groupSelection()
    })
    expect(frames().length).toBe(1)
  })

  /*
   * Outline-only, light grey and rounded is the default the frame was asked for, and it is
   * expressed as an *absence* in the document — a plain frame stores neither a colour nor a
   * fill. So what is asserted is the attribute the stylesheet keys on, both ways.
   */
  it('is grey and unfilled until somebody says otherwise', () => {
    render(<App />)
    openFrameMenu()
    expect(frame()?.getAttribute('data-color')).toBe('grey')
    expect(frame()?.hasAttribute('data-filled')).toBe(false)
    expect(frame()?.hasAttribute('data-dashed')).toBe(false)
  })

  /*
   * The whole reason the box is derived rather than stored: six things move a frame's contents,
   * and none of them knows the frame exists. Asserted against the members' raw positions rather
   * than against `groupBoxes`, so this cannot pass by agreeing with the same arithmetic twice.
   */
  it('is placed from its members, and follows one of them when it moves', () => {
    render(<App />)
    const [a, b] = nodeIds()
    act(() => {
      store().setSelection([a!, b!])
      store().groupSelection()
    })

    const corner = () => {
      const members = store().graph.nodes.filter((n) => n.id === a || n.id === b)
      const x = Math.min(...members.map((n) => n.position.x))
      const y = Math.min(...members.map((n) => n.position.y))
      return `translate(${x - GROUP_PADDING - GROUP_GRAB / 2}px, ${
        y - GROUP_PADDING - GROUP_GRAB / 2
      }px)`
    }

    expect((frame() as HTMLElement).style.transform).toBe(corner())
    act(() => store().moveNodes([{ id: a!, position: { x: -640, y: -480 } }], true))
    expect((frame() as HTMLElement).style.transform).toBe(corner())
  })

  it('shows a title once there is one, and nothing when there is not', () => {
    render(<App />)
    const id = openFrameMenu()
    expect(document.querySelector('.group-frame__title')).toBeNull()
    act(() => store().renameGroup(id, 'Sensory block'))
    expect(document.querySelector('.group-frame__title')?.textContent).toBe('Sensory block')
  })

  /*
   * The interior has to stay click-through, which is what keeps panning, box-select and clicking
   * a card inside a frame behaving as they do on bare canvas. Only two things take the pointer:
   * the band over the outline, and the title. jsdom cannot hit-test, but it can read the
   * declaration that decides it.
   */
  it('takes the pointer on its outline only', () => {
    render(<App />)
    openFrameMenu()
    expect(document.querySelector('.group-frame__grab')?.classList).toContain('nopan')
    expect(document.querySelector('.group-frame__fill')).toBeTruthy()
  })
})

describe('the frame’s menu', () => {
  it('names the group, and offers to rename it or take it apart', () => {
    render(<App />)
    openFrameMenu()
    expect(screen.getByText('Untitled group')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Name this group/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Select 2 nodes/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Ungroup/ })).toBeTruthy()
  })

  it('restyles the frame from the swatches and the two toggles', () => {
    render(<App />)
    openFrameMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }))
    expect(frame()?.getAttribute('data-color')).toBe('violet')
    fireEvent.click(screen.getByRole('button', { name: /Filled/ }))
    expect(frame()?.hasAttribute('data-filled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Dashed/ }))
    expect(frame()?.hasAttribute('data-dashed')).toBe(true)
  })

  it('puts the title into edit mode from Rename, since the frame is inside the viewport', () => {
    render(<App />)
    openFrameMenu()
    fireEvent.click(screen.getByRole('button', { name: /Name this group/ }))
    const input = screen.getByLabelText('Group title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Left hemisphere' } })
    fireEvent.blur(input)
    expect(store().graph.groups?.[0]?.title).toBe('Left hemisphere')
  })

  /* Escape reverts, and the flag is why — unmounting a focused input fires blur on the way out. */
  it('leaves the title alone when the edit is abandoned', () => {
    render(<App />)
    const id = openFrameMenu()
    act(() => store().renameGroup(id, 'Kept'))
    fireEvent.doubleClick(document.querySelector('.group-frame__title')!)
    const input = screen.getByLabelText('Group title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(store().graph.groups?.[0]?.title).toBe('Kept')
  })

  it('ungroups, leaving every card where it was', () => {
    render(<App />)
    openFrameMenu()
    const positions = store().graph.nodes.map((n) => n.position)
    fireEvent.click(screen.getByRole('button', { name: /Ungroup/ }))
    expect(store().graph.groups).toBeUndefined()
    expect(store().graph.nodes.map((n) => n.position)).toEqual(positions)
    expect(frames().length).toBe(0)
  })
})

/**
 * Folding a frame into one box.
 *
 * The arithmetic is `layout/collapse.test.ts`; what is asserted here is the half that only the
 * canvas can answer — that the members stop being drawn, that one box is drawn in their place,
 * and that both ways of asking for it reach the same store action. The pointer half (dragging
 * the box) is `ui/groupDrag.ts` and needs a real browser, exactly as the frame's drag does.
 */
describe('a folded frame', () => {
  const box = () => document.querySelector('.group-collapsed')
  const cards = () => document.querySelectorAll('.react-flow__node')

  function collapsedFrame(): string {
    const [a, b] = nodeIds()
    act(() => {
      store().setSelection([a!, b!])
      store().groupSelection()
    })
    const id = store().graph.groups![0]!.id
    act(() => store().toggleGroupCollapsed(id))
    return id
  }

  it('draws one box and stops drawing the cards inside it', () => {
    render(<App />)
    const before = cards().length
    collapsedFrame()
    expect(box()).toBeTruthy()
    expect(frames().length).toBe(0)
    // Two cards away, one box back.
    expect(cards().length).toBe(before - 1)
    expect(document.querySelector(`.react-flow__node[data-id="${nodeIds()[0]}"]`)).toBeNull()
  })

  it('says how many cards it is holding, and wears the frame’s own colour', () => {
    render(<App />)
    const id = collapsedFrame()
    act(() => store().styleGroup(id, { color: 'violet', dashed: true }))
    expect(document.querySelector('.group-collapsed__count')?.textContent).toBe('2')
    expect(box()?.getAttribute('data-color')).toBe('violet')
    expect(box()?.hasAttribute('data-dashed')).toBe(true)
  })

  it('draws a mini-map cell per member, tinted by the card’s own category', () => {
    render(<App />)
    collapsedFrame()
    const cells = document.querySelectorAll('.group-collapsed__cell')
    expect(cells.length).toBe(2)
    const types = nodeIds()
      .slice(0, 2)
      .map((id) => store().graph.nodes.find((n) => n.id === id)!.type)
    expect([...cells].map((c) => c.getAttribute('data-category'))).toEqual(
      types.map((t) => getNodeDef(t)?.category ?? 'utility'),
    )
  })

  /*
   * The box is not draggable, selectable or deletable as far as React Flow is concerned — the
   * three flags that keep a pseudo id out of the store — and the price of those is silent:
   * `NodeWrapper` puts `pointer-events: none` on any node with none of them and no mouse
   * handlers of its own. The box was then neither grabbable nor right-clickable, and both
   * failures *looked like features working*: the drag reached the pane and panned the canvas,
   * which moves the box on screen, and the right-click reached the pane and opened the node
   * palette. Both reported from a real browser; what is pinned here is the seam that puts it
   * back, since jsdom can read the inline style but cannot dispatch either gesture.
   */
  it('takes the pointer, which React Flow would otherwise withhold from it', () => {
    render(<App />)
    collapsedFrame()
    const wrapper = document.querySelector('.react-flow__node-groupBox') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(wrapper.style.pointerEvents).toBe('all')
  })

  it('opens the frame’s own menu on a right-click, not the canvas palette', () => {
    render(<App />)
    collapsedFrame()
    fireEvent.contextMenu(box()!)
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Ungroup/ })).toBeTruthy()
  })

  /*
   * The chevron is the only way in that is visible without a right-click, and it is on both
   * surfaces: the frame folds from its own corner, the box unfolds from its header.
   */
  it('folds from the frame’s chevron and unfolds from the box’s', () => {
    render(<App />)
    const [a, b] = nodeIds()
    act(() => {
      store().setSelection([a!, b!])
      store().groupSelection()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse group', hidden: true }))
    expect(store().graph.groups?.[0]?.collapsed).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Expand group', hidden: true }))
    expect(store().graph.groups?.[0]?.collapsed).toBeUndefined()
    expect(frames().length).toBe(1)
  })

  it('folds from the frame’s menu, and offers the way back from the box’s', () => {
    render(<App />)
    openFrameMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(store().graph.groups?.[0]?.collapsed).toBe(true)

    fireEvent.contextMenu(box()!)
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(store().graph.groups?.[0]?.collapsed).toBeUndefined()
  })

  /*
   * The wires. In this workflow the two framed cards are the dataset and the search, so folding
   * them hides three wires — one between them and one each into Connectivity — and draws two
   * stand-ins, which are *two* rather than one because they land on different sockets. A merge
   * key that dropped the port would draw one wire here and lose the other silently.
   */
  it('joins the wires that cross its boundary at its edges', () => {
    render(<App />)
    const wires = () => document.querySelectorAll('.react-flow__edge')
    const before = wires().length
    collapsedFrame()
    expect(wires().length).toBe(before - 1)
    expect(document.querySelectorAll('.react-flow__edge.coda-edge--collapsed').length).toBe(2)
  })

  /*
   * React Flow's multi-selection rectangle is drawn around every node it thinks is selected,
   * hidden ones included — so a folded group whose members are still selected drew a box across
   * the empty canvas they left behind, draggable, moving cards nobody could see. Found in
   * Chrome; jsdom draws no such overlay, so what is pinned here is the class the stylesheet
   * keys on, and *that it is not set* for an ordinary multi-selection.
   */
  it('stands React Flow’s selection rectangle down while a folded card is selected', () => {
    render(<App />)
    const pane = () => document.querySelector('.react-flow')
    const [a, b, c] = nodeIds()
    act(() => store().setSelection([a!, b!]))
    expect(pane()?.classList.contains('has-folded-selection')).toBe(false)
    const id = collapsedFrame()
    expect(pane()?.classList.contains('has-folded-selection')).toBe(true)
    act(() => store().setSelection([c!]))
    expect(pane()?.classList.contains('has-folded-selection')).toBe(false)
    expect(id).toBeTruthy()
  })

  /*
   * The promoted controls. What only the canvas can answer is that the row is drawn, that it
   * carries the card's name as well as the param's, and that editing it writes to the *member*
   * — one value with two editors is the whole feature, and a control that wrote somewhere else
   * would look identical until you unfolded the group.
   */
  it('draws a promoted param as a row, and writes it back to the card it belongs to', () => {
    render(<App />)
    const id = collapsedFrame()
    // Whichever of the two framed cards offers a control that can be typed into.
    const target = store()
      .graph.groups![0]!.nodeIds.flatMap((nodeId) => {
        const node = store().graph.nodes.find((n) => n.id === nodeId)!
        const def = requireNodeDef(node.type)
        const param = configurableParams(def, node.params).find(
          (p) => p.kind === 'string' || p.kind === 'number' || p.kind === 'int',
        )
        return param ? [{ node, def, param }] : []
      })[0]!
    act(() => store().toggleExposedParam(id, target.node.id, target.param.id))

    const row = document.querySelector('.group-collapsed__row')
    expect(row?.textContent).toContain(target.param.label)
    expect(row?.querySelector('.group-collapsed__row-owner')?.textContent).toBe(
      target.node.title ?? target.def.label,
    )

    const field = row!.querySelector('input') as HTMLInputElement
    const typed = target.param.kind === 'string' ? 'typed' : '7'
    fireEvent.change(field, { target: { value: typed } })
    fireEvent.blur(field)
    expect(String(store().graph.nodes.find((n) => n.id === target.node.id)!.params[target.param.id])).toBe(
      typed,
    )
  })

  /* The box's height is what ELK is told, so a row the size did not account for is a row drawn
   * over the mini-map. One derivation decides both — asserted here through the DOM. */
  it('grows when it carries a control', () => {
    render(<App />)
    const id = collapsedFrame()
    const height = () => (document.querySelector('.group-collapsed') as HTMLElement).style.height
    const bare = height()
    const [a] = nodeIds()
    const def = requireNodeDef(store().graph.nodes.find((n) => n.id === a)!.type)
    act(() => store().toggleExposedParam(id, a!, def.params![0]!.id))
    expect(parseFloat(height())).toBeGreaterThan(parseFloat(bare))
  })

  /* The picker: closed by default, counted, and it does not close the menu — picking controls
   * is a several-at-a-time job, exactly as the swatches below it are. */
  it('picks the controls from the frame’s menu, without closing it', () => {
    render(<App />)
    openFrameMenu()
    expect(screen.queryByRole('button', { name: /^Controls on the folded box$/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Controls on the folded box/ }))

    const [a] = nodeIds()
    const def = requireNodeDef(store().graph.nodes.find((n) => n.id === a)!.type)
    const param = def.params![0]!
    fireEvent.click(screen.getByRole('button', { name: param.label }))
    expect(store().graph.groups?.[0]?.exposed).toEqual([{ node: a, param: param.id }])
    expect(screen.getByRole('button', { name: /Controls on the folded box \(1\)/ })).toBeTruthy()
  })

  /*
   * Rename has to reach the surface that is *on screen*. A folded frame draws no outline
   * (`groupBoxes` skips it), so the row used to open the title field on the frame — invisible
   * until the group was expanded again, which reads as a menu row that does nothing.
   */
  it('renames from the box, not from the frame nobody can see', () => {
    render(<App />)
    const id = collapsedFrame()
    fireEvent.contextMenu(box()!)
    fireEvent.click(screen.getByRole('button', { name: /Name this group/ }))

    const input = screen.getByLabelText('Group title') as HTMLInputElement
    expect(box()?.contains(input)).toBe(true)
    fireEvent.change(input, { target: { value: 'Search block' } })
    fireEvent.blur(input)
    expect(store().graph.groups?.find((g) => g.id === id)?.title).toBe('Search block')
    expect(document.querySelector('.group-collapsed__title')?.textContent).toBe('Search block')
  })

  it('starts a rename on a double-click of its header', () => {
    render(<App />)
    collapsedFrame()
    fireEvent.doubleClick(document.querySelector('.group-collapsed__header')!)
    expect(screen.getByLabelText('Group title')).toBeTruthy()
  })

  /*
   * Looking inside without unfolding. What only the canvas can answer is that the panel draws
   * the *members'* cards, that both ways in reach it, and that the canvas behind it is untouched
   * — including its measurements, which is the half that would have gone wrong in silence.
   */
  describe('the peek', () => {
    const peek = () => document.querySelector('.group-peek')
    const peekCards = () =>
      [...document.querySelectorAll('.group-peek .react-flow__node')].map((n) =>
        n.getAttribute('data-id'),
      )

    it('opens from a double-click on the box and draws the cards inside it', () => {
      render(<App />)
      collapsedFrame()
      const members = store().graph.groups![0]!.nodeIds
      expect(peek()).toBeNull()

      fireEvent.doubleClick(document.querySelector('.group-collapsed__map')!)
      expect(peek()).toBeTruthy()
      expect(peekCards().sort()).toEqual([...members].sort())
    })

    it('opens from the frame’s menu, and only while it is folded', () => {
      render(<App />)
      openFrameMenu()
      expect(screen.queryByRole('button', { name: 'Look inside' })).toBeNull()

      act(() => store().toggleGroupCollapsed(store().graph.groups![0]!.id))
      fireEvent.contextMenu(box()!)
      fireEvent.click(screen.getByRole('button', { name: 'Look inside' }))
      expect(peek()).toBeTruthy()
    })

    it('closes on Escape and on the backdrop', () => {
      render(<App />)
      collapsedFrame()
      act(() => store().peekGroup(store().graph.groups![0]!.id))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(store().peekGroupId).toBeUndefined()

      act(() => store().peekGroup(store().graph.groups![0]!.id))
      fireEvent.pointerDown(document.querySelector('.group-peek')!.parentElement!)
      expect(store().peekGroupId).toBeUndefined()
    })

    /*
     * The trap: both surfaces draw cards carrying the *same* `data-id`, and while the group is
     * folded the panel's copies are the only ones in the document. Unscoped, `measureCardSizes`
     * would hand ELK the sizes of cards drawn in a dialog and `structureKey` would change the
     * moment a peek opened — an arrange of the canvas behind it, under auto-layout.
     */
    it('is invisible to the canvas’s own measurements', () => {
      render(<App />)
      collapsedFrame()
      const members = store().graph.groups![0]!.nodeIds
      act(() => store().peekGroup(store().graph.groups![0]!.id))

      expect(peekCards().length).toBe(members.length)
      const measured = measureCardSizes()
      expect(members.some((id) => measured.has(id))).toBe(false)
      // And the panel is genuinely in the document, so this is scoping rather than an empty page.
      expect(document.querySelectorAll(`[data-id="${members[0]}"]`).length).toBeGreaterThan(0)
    })

    /*
     * Both found in Chrome, and both invisible from here without the assertion. A card that is
     * neither draggable nor selectable is one React Flow gives `pointer-events: none`, so every
     * control in the panel was inert — and the keystrokes meant for them fell through to the
     * canvas's window listeners, where `d` opened the dashboard behind the dialog.
     */
    it('lets the pointer reach its cards', () => {
      render(<App />)
      collapsedFrame()
      act(() => store().peekGroup(store().graph.groups![0]!.id))
      const cards = document.querySelectorAll<HTMLElement>('.group-peek .react-flow__node')
      expect(cards.length).toBeGreaterThan(0)
      for (const card of cards) expect(card.style.pointerEvents).toBe('all')
    })

    it('keeps the canvas’s shortcuts out while it is up', () => {
      render(<App />)
      collapsedFrame()
      act(() => store().peekGroup(store().graph.groups![0]!.id))
      // Dispatched *inside* the panel, which is the real path: a keystroke bubbles from the
      // focused element up to the window listeners the canvas binds. Fired at `window` directly
      // it would be at-target for both, where `stopPropagation` does not separate them.
      act(() => {
        fireEvent.keyDown(document.querySelector('.group-peek')!, { key: 'd' })
      })
      expect(store().dashboardOpen).toBe(false)
      expect(store().peekGroupId).toBeTruthy()
    })

    /* A peek is a look at *this* document; a group id means nothing in the next one. */
    it('closes when the document under it is replaced', () => {
      render(<App />)
      collapsedFrame()
      act(() => store().peekGroup(store().graph.groups![0]!.id))
      act(() => store().loadGraph(demoWorkflow('partners')))
      expect(store().peekGroupId).toBeUndefined()
      expect(peek()).toBeNull()
    })
  })

  /* Folding is a view of the document, so it travels with it — and it is not a canvas edit. */
  it('is in the file, and is allowed on a locked canvas', () => {
    render(<App />)
    const id = collapsedFrame()
    expect(JSON.parse(serializeGraph(store().graph)).groups[0].collapsed).toBe(true)
    act(() => {
      useGraphStore.setState({ locked: true })
      store().toggleGroupCollapsed(id)
    })
    expect(store().graph.groups?.[0]?.collapsed).toBeUndefined()
  })

  /*
   * Every card put back exactly where it was: folding hides cards, it never moves them. This is
   * what makes a fold safe to undo by unfolding rather than by ⌘Z.
   */
  it('puts every card back where it was', () => {
    render(<App />)
    const before = store().graph.nodes.map((n) => ({ ...n.position }))
    const id = collapsedFrame()
    act(() => store().toggleGroupCollapsed(id))
    expect(store().graph.nodes.map((n) => ({ ...n.position }))).toEqual(before)
  })
})

describe('the other three ways in', () => {
  it('groups from the node menu, acting on the selection the way Mute does', () => {
    render(<App />)
    const [a, b] = nodeIds()
    act(() => store().setSelection([a!, b!]))
    fireEvent.contextMenu(card(a!))
    fireEvent.click(screen.getByRole('button', { name: /Group Selection/ }))
    expect(store().graph.groups?.[0]?.nodeIds).toEqual([a, b])
  })

  /* A right-click on an *unselected* card is about that card alone — the menu's own rule. */
  it('groups the card under the pointer when it is not in the selection', () => {
    render(<App />)
    const [a, , c] = nodeIds()
    act(() => store().setSelection([a!]))
    fireEvent.contextMenu(card(c!))
    fireEvent.click(screen.getByRole('button', { name: /Group Selection/ }))
    expect(store().graph.groups?.[0]?.nodeIds).toEqual([c])
  })

  it('offers Ungroup on a card that is in a frame, and not on one that is not', () => {
    render(<App />)
    const [a, b, c] = nodeIds()
    act(() => {
      store().setSelection([a!, b!])
      store().groupSelection()
      store().setSelection([])
    })
    fireEvent.contextMenu(card(c!))
    expect(screen.queryByRole('button', { name: /^Ungroup/ })).toBeNull()
    fireEvent.contextMenu(card(a!))
    fireEvent.click(screen.getByRole('button', { name: /^Ungroup/ }))
    expect(store().graph.groups).toBeUndefined()
  })

  it('groups and ungroups from the keyboard', () => {
    render(<App />)
    act(() => store().setSelection(nodeIds().slice(0, 2)))
    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    expect(store().graph.groups?.length).toBe(1)
    fireEvent.keyDown(window, { key: 'g', metaKey: true, shiftKey: true })
    expect(store().graph.groups).toBeUndefined()
  })

  it('offers both as palette rows, live only when there is something to act on', () => {
    act(() => store().setSelection([]))
    expect(command('cmd:group')?.disabled).toBe(true)
    expect(command('cmd:ungroup')?.disabled).toBe(true)

    act(() => store().setSelection(nodeIds().slice(0, 2)))
    expect(command('cmd:group')?.disabled).toBe(false)
    // Nothing framed yet, so Ungroup is still a row that says what it would do rather than
    // one that does nothing.
    expect(command('cmd:ungroup')?.disabled).toBe(true)

    act(() => command('cmd:group')?.perform?.())
    expect(command('cmd:ungroup')?.disabled).toBe(false)
    act(() => command('cmd:ungroup')?.perform?.())
    expect(store().graph.groups).toBeUndefined()
  })
})
