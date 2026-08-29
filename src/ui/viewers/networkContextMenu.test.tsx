// @vitest-environment jsdom

/**
 * The network viewer's right-click menu.
 *
 * Unlike the rest of this viewer the menu is ordinary DOM, so which rows it offers *is*
 * reachable from a test — and row visibility is a real decision rather than a detail. Two of
 * them would be silent if wrong: an undirected network must not offer upstream/downstream,
 * because the walk behind them ignores direction there and three rows would do one thing; and
 * a right-click on empty canvas must not offer to expand from anchors it does not have.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NetworkContextMenu } from './NetworkContextMenu'
import type { NetworkContextMenuProps } from './NetworkContextMenu'

afterEach(cleanup)

function show(extra: Partial<NetworkContextMenuProps> = {}) {
  const props: NetworkContextMenuProps = {
    at: { x: 40, y: 40 },
    seeds: ['a'],
    caption: 'LC4',
    directed: true,
    selected: 0,
    total: 13,
    onExpand: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
    onCopy: vi.fn(),
    onFit: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  }
  render(<NetworkContextMenu {...props} />)
  return props
}

const rows = () => screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '')

describe('anchored on a mark', () => {
  it('offers the four scopes on a directed network', () => {
    show()
    expect(rows()).toEqual(
      expect.arrayContaining([
        'Select connected',
        'Select downstream',
        'Select upstream',
        'Select connected component',
      ]),
    )
  })

  it('drops the directed pair on an undirected network', () => {
    show({ directed: false })
    const text = rows()
    expect(text).toContain('Select connected')
    expect(text).toContain('Select connected component')
    expect(text).not.toContain('Select downstream')
    expect(text).not.toContain('Select upstream')
  })

  it('names what was right-clicked', () => {
    show({ caption: 'LC4 · 720575940621039145' })
    expect(screen.getByText('LC4 · 720575940621039145')).toBeTruthy()
  })

  it('reports the scope pressed and then closes', () => {
    const props = show()
    fireEvent.click(screen.getByText('Select connected component'))
    expect(props.onExpand).toHaveBeenCalledWith('component')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('counts the ids it would copy', () => {
    show({ seeds: ['a', 'b', 'c'] })
    expect(screen.getByText('Copy 3 ids')).toBeTruthy()
  })

  it('says "id" for one', () => {
    show()
    expect(screen.getByText('Copy id')).toBeTruthy()
  })

  it('offers no whole-graph verbs', () => {
    show()
    const text = rows()
    expect(text.some((t) => t.startsWith('Select all'))).toBe(false)
    expect(text).not.toContain('Fit to view')
  })
})

describe('on empty canvas', () => {
  it('offers the whole-graph verbs and nothing to expand from', () => {
    show({ seeds: [], caption: '13 nodes' })
    const text = rows()
    expect(text.some((t) => t.startsWith('Select all'))).toBe(true)
    expect(text).toContain('Fit to view')
    expect(text).toContain('Copy all ids')
    expect(text).not.toContain('Select connected')
  })
})

describe('clearing', () => {
  it('is disabled with nothing selected, since it would do nothing', () => {
    show()
    expect(screen.getByText(/Clear selection/).closest('button')?.disabled).toBe(true)
  })

  it('is live once something is', () => {
    const props = show({ selected: 4 })
    const button = screen.getByText(/Clear selection/).closest('button')
    expect(button?.disabled).toBe(false)
    fireEvent.click(button!)
    expect(props.onClear).toHaveBeenCalled()
  })
})
