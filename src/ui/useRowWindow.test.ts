/**
 * Which rows a long list draws. The arithmetic is the part that fails without throwing: an
 * off-by-one leaves a blank row at the bottom of the view, and spacers that do not add up to the
 * rows left out make the scrollbar lie about where the reader is.
 */

import { describe, expect, it } from 'vitest'

import { anchoredScroll, rowWindow, scrollToShow } from './useRowWindow'

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

/** A row the pointer rests on in a viewer, brought into view (`ReviewBody.tsx`). */
describe('scrolling a row into view', () => {
  it('leaves a list alone where the row is in view already', () => {
    expect(scrollToShow(3, 50, 0, 500)).toBeUndefined()
    expect(scrollToShow(9, 50, 0, 500)).toBeUndefined()
  })

  it('centres a row out of view, below or above', () => {
    // Row 100's top is at 5000; centred in 500px, the view starts 225px above it.
    expect(scrollToShow(100, 50, 0, 500)).toBe(4775)
    expect(scrollToShow(2, 50, 4775, 500)).toBe(0)
    // Half out at the bottom is out.
    expect(scrollToShow(10, 50, 0, 520)).toBe(265)
  })
})

/** Rows arriving under a reader: the row at the top of the view keeps its place. */
describe('holding the list still', () => {
  const keys = (...names: string[]) => names

  it('scrolls down by the rows that arrived above the top of the view, and counts them', () => {
    // Rows of 50px, scrolled to row c (100px). Two arrive above it.
    expect(
      anchoredScroll(keys('a', 'b', 'c', 'd'), keys('x', 'a', 'y', 'b', 'c', 'd'), 100, 50),
    ).toEqual({
      scrollTop: 200,
      above: 2,
    })
  })

  it('keeps the part-scrolled offset of the row at the top', () => {
    expect(anchoredScroll(keys('a', 'b', 'c'), keys('x', 'a', 'b', 'c'), 130, 50)).toEqual({
      scrollTop: 180,
      above: 1,
    })
  })

  it('moves nothing where only rows below arrived', () => {
    expect(
      anchoredScroll(keys('a', 'b', 'c'), keys('a', 'b', 'x', 'c'), 50, 50),
    ).toBeUndefined()
  })

  it('counts a row that moved up from below as no arrival', () => {
    // `d` re-sorted above `b`: the view holds, and nothing is new.
    expect(anchoredScroll(keys('a', 'b', 'c', 'd'), keys('a', 'd', 'b', 'c'), 50, 50)).toEqual({
      scrollTop: 100,
      above: 0,
    })
  })

  it('holds by the next row still listed where the top one has gone', () => {
    // `b` was at the top and is gone; `c`, 50px below it, moved down a row and keeps that offset.
    expect(anchoredScroll(keys('a', 'b', 'c'), keys('x', 'y', 'a', 'c'), 50, 50)).toEqual({
      scrollTop: 100,
      above: 2,
    })
  })

  it('moves nothing where none of the rows from the view is still listed', () => {
    expect(anchoredScroll(keys('a', 'b'), keys('x', 'y'), 50, 50)).toBeUndefined()
    expect(anchoredScroll([], keys('x'), 0, 50)).toBeUndefined()
  })
})
