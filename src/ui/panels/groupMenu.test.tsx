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
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
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
    useGraphStore.getState().loadExample('partners')
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
