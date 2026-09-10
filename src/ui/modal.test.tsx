// @vitest-environment jsdom
/**
 * `Modal`'s ways out and `ContextMenu`'s placement, asked of the two components directly — every
 * dialog and menu in the app is one of these, so a surface's own suite only needs to say which
 * departure it takes.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from './Modal'
import { ContextMenu } from './menu/ContextMenu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const escape = () => fireEvent.keyDown(window, { key: 'Escape' })
const backdrop = () => document.querySelector('.overlay')!

describe('Modal', () => {
  it('closes on Escape and on a press on the backdrop, and not on a press inside', () => {
    const onClose = vi.fn()
    render(
      <Modal className="overlay__panel" label="One" onClose={onClose}>
        body
      </Modal>,
    )
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'One' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
    escape()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  /*
   * What the stack is for. Help opened from a full-size viewer, or the start page reopened over
   * one, are both capture listeners on `window`, where `stopPropagation` does not stop a sibling
   * — so one Escape closed both.
   */
  it('lets only the surface opened last take Escape', () => {
    const under = vi.fn()
    const over = vi.fn()
    render(
      <>
        <Modal className="overlay__panel" label="Under" onClose={under}>
          under
        </Modal>
        <Modal className="overlay__panel" label="Over" onClose={over}>
          over
        </Modal>
      </>,
    )
    escape()
    expect(over).toHaveBeenCalledTimes(1)
    expect(under).not.toHaveBeenCalled()
  })

  /*
   * The menu is on the same stack, opened after the dialog — so it answers first. Opened with a
   * rerender rather than rendered together: the stack's order is *opened*, and React runs a
   * child's effects before its parent's.
   */
  it('lets a menu opened inside it take Escape first', () => {
    const dialog = vi.fn()
    const menu = vi.fn()
    const { rerender } = render(
      <Modal className="overlay__panel" label="One" onClose={dialog}>
        {null}
      </Modal>,
    )
    rerender(
      <Modal className="overlay__panel" label="One" onClose={dialog}>
        <ContextMenu at={{ x: 0, y: 0 }} onClose={menu}>
          rows
        </ContextMenu>
      </Modal>,
    )
    escape()
    expect(menu).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveBeenCalled()
  })

  /*
   * A rename inside a dialog reverts on Escape. Taken by the dialog first, the field unmounts and
   * its blur commits the draft the key was meant to discard.
   */
  it('leaves Escape to a field that cancels its own edit, and closes on the next press', () => {
    const onClose = vi.fn()
    render(
      <Modal className="overlay__panel" label="One" onClose={onClose}>
        <input aria-label="Name" data-owns-escape />
      </Modal>,
    )
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the backdrop out of it when asked, and still takes Escape', () => {
    const onClose = vi.fn()
    render(
      <Modal className="overlay__panel" label="Gate" onClose={onClose} backdrop={false}>
        gate
      </Modal>,
    )
    fireEvent.pointerDown(backdrop())
    expect(onClose).not.toHaveBeenCalled()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks ignoreEscape at the press', () => {
    const onClose = vi.fn()
    let ignoring = true
    render(
      <Modal
        className="overlay__panel"
        label="Viewer"
        onClose={onClose}
        ignoreEscape={() => ignoring}
      >
        viewer
      </Modal>,
    )
    escape()
    expect(onClose).not.toHaveBeenCalled()
    ignoring = false
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ContextMenu', () => {
  /*
   * The point of measuring: a menu near the bottom-right corner is pulled back by its *own* size,
   * where each menu used to clamp against a size typed beside it and run off the window whenever
   * it grew past the guess.
   */
  it('clamps its measured box inside the window', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 300,
      toJSON: () => ({}),
    })
    render(
      <ContextMenu at={{ x: 950, y: 700 }} onClose={() => {}}>
        rows
      </ContextMenu>,
    )
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('800px')
    expect(menu.style.top).toBe('500px')
  })

  it('closes on Escape and on a press elsewhere', () => {
    const onClose = vi.fn()
    render(
      <ContextMenu at={{ x: 10, y: 10 }} onClose={onClose}>
        rows
      </ContextMenu>,
    )
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    escape()
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
