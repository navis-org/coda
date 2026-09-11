// @vitest-environment jsdom
/**
 * `useListNav`'s `skip`, which is what let the command palette give up its own copy: the active
 * row lands on the first usable one after a reset, and the arrows step over the rest.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { useListNav } from './useListNav'

beforeAll(() => {
  // jsdom lays nothing out, so it has no `scrollIntoView` for the hook's keep-in-view effect.
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(cleanup)

function List({ rows, off = [] }: { rows: string[]; off?: number[] }) {
  const nav = useListNav(rows.length, rows, off.length ? (i) => off.includes(i) : undefined)
  return (
    <>
      <input aria-label="Search" onKeyDown={(event) => nav.onKeyDown(event)} />
      <div ref={nav.listRef}>
        {rows.map((row, i) => (
          <div key={row} aria-selected={i === nav.activeIndex}>
            {row}
          </div>
        ))}
      </div>
    </>
  )
}

const active = () => document.querySelector('[aria-selected="true"]')?.textContent
const press = (key: string) => fireEvent.keyDown(screen.getByLabelText('Search'), { key })

describe('useListNav', () => {
  it('lands on the first row it may, and steps over the ones it may not', () => {
    render(<List rows={['a', 'b', 'c', 'd']} off={[0, 2]} />)
    expect(active()).toBe('b')
    press('ArrowDown')
    expect(active()).toBe('d')
    press('ArrowDown')
    expect(active()).toBe('b')
    press('ArrowUp')
    expect(active()).toBe('d')
  })

  it('steps and wraps over every row without a skip', () => {
    render(<List rows={['a', 'b', 'c']} />)
    expect(active()).toBe('a')
    press('ArrowUp')
    expect(active()).toBe('c')
  })
})
