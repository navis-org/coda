// @vitest-environment jsdom

/**
 * The segment under the pointer in a neuroglancer frame, shared with the review card
 * (`segmentHover.ts`): who may clear it, and when a rest counts.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { REST_MS, hoveredSegment, setHoveredSegment, useRestedSegment } from './segmentHover'

const A = {}
const B = {}

afterEach(() => {
  setHoveredSegment(A, undefined)
  setHoveredSegment(B, undefined)
  vi.useRealTimers()
})

describe('the hovered segment', () => {
  it('is what the last frame said, and only that frame clears it', () => {
    setHoveredSegment(A, '720575940621522189')
    setHoveredSegment(B, '720575940630442210')
    // A frame going away cannot wipe what another has under its pointer.
    setHoveredSegment(A, undefined)
    expect(hoveredSegment()).toBe('720575940630442210')
    setHoveredSegment(B, undefined)
    expect(hoveredSegment()).toBeUndefined()
  })

  it('counts a rest only once the pointer has stayed, and again after it moved off', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useRestedSegment())
    act(() => setHoveredSegment(A, '1'))
    act(() => void vi.advanceTimersByTime(REST_MS - 1))
    expect(result.current).toBeUndefined()
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current).toEqual({ segment: '1', count: 1 })
    // Passing over another segment is no rest on it.
    act(() => setHoveredSegment(A, '2'))
    act(() => void vi.advanceTimersByTime(REST_MS / 2))
    act(() => setHoveredSegment(A, '1'))
    act(() => void vi.advanceTimersByTime(REST_MS))
    expect(result.current).toEqual({ segment: '1', count: 2 })
  })
})
