/**
 * Which rows a long list draws. The arithmetic is the part that fails without throwing: an
 * off-by-one leaves a blank row at the bottom of the view, and spacers that do not add up to the
 * rows left out make the scrollbar lie about where the reader is.
 */

import { describe, expect, it } from 'vitest'

import { rowWindow } from './useRowWindow'

describe('the rows a list draws', () => {
  it('draws the rows in view and a margin past the bottom', () => {
    // 10 rows of 50px fill 500px; 3 more as a margin.
    expect(rowWindow(1000, 50, 0, 500, 3)).toEqual({
      start: 0,
      end: 13,
      before: 0,
      after: 987 * 50,
    })
  })

  it('draws a margin above as well, once scrolled', () => {
    // Row 100 is at the top of the view.
    const rows = rowWindow(1000, 50, 5000, 500, 3)
    expect(rows).toEqual({ start: 97, end: 113, before: 97 * 50, after: 887 * 50 })
  })

  /** The spacers and the rows drawn always add up to the whole list. */
  it('keeps the scroll height of the whole list wherever it is scrolled', () => {
    for (const top of [0, 1234, 49_000, 60_000]) {
      const rows = rowWindow(1000, 50, top, 500, 3)
      expect(rows.before + (rows.end - rows.start) * 50 + rows.after).toBe(1000 * 50)
    }
  })

  it('draws everything when the list is shorter than the view', () => {
    expect(rowWindow(4, 50, 0, 500)).toEqual({ start: 0, end: 4, before: 0, after: 0 })
  })

  /** A list that just got shorter can be scrolled past its new end for a frame. */
  it('draws the last rows rather than nothing when scrolled past the end', () => {
    const rows = rowWindow(20, 50, 10_000, 500, 3)
    expect(rows.end).toBe(20)
    expect(rows.start).toBeLessThan(rows.end)
    expect(rows.after).toBe(0)
  })

  it('draws nothing for an empty list', () => {
    expect(rowWindow(0, 50, 0, 500)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })
})
