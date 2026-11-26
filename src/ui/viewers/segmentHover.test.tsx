// @vitest-environment jsdom

/**
 * The segment under the pointer in a neuroglancer frame, shared with the review card
 * (`segmentHover.ts`): who may clear it, and when a rest counts.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useGraphStore } from '../../store/graphStore'
import type { PointedSegment } from './segmentHover'
import {
  REST_MS,
  hoveredSegment,
  restedPoint,
  setHoveredSegment,
  useHoveredSegment,
  useRestedSegment,
  useSegmentPick,
} from './segmentHover'

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

  it('keeps where the pointer is on a segment, without a render for every move', () => {
    vi.useFakeTimers()
    let renders = 0
    renderHook(() => {
      renders += 1
      return useHoveredSegment()
    })
    act(() => setHoveredSegment(A, '1', [1, 2, 3]))
    const before = renders
    act(() => setHoveredSegment(A, '1', [4, 5, 6]))
    expect(renders).toBe(before)
    act(() => void vi.advanceTimersByTime(REST_MS))
    expect(restedPoint()).toEqual({ segment: '1', positionNm: [4, 5, 6] })
    // The last rest outlives the pointer leaving: the card's button is pressed off the frame.
    act(() => setHoveredSegment(A, '2', [7, 8, 9]))
    act(() => setHoveredSegment(A, undefined))
    expect(restedPoint()).toEqual({ segment: '1', positionNm: [4, 5, 6] })
  })
})

describe('the pick key', () => {
  const press = (init: KeyboardEventInit) =>
    act(
      () => void window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', ...init })),
    )

  it('hands a card the segment under the pointer, once, on J alone and not held', () => {
    const took: [string, PointedSegment][] = []
    const card = (id: string) => (pointed: PointedSegment) => took.push([id, pointed])
    // One card drawn on two surfaces.
    const one = renderHook(() => useSegmentPick('n1', card('n1')))
    const second = renderHook(() => useSegmentPick('n1', card('n1')))
    press({})
    expect(took).toEqual([])
    setHoveredSegment(A, '5', [1, 2, 3])
    press({ shiftKey: true })
    press({ code: 'KeyK' })
    press({ repeat: true })
    press({})
    expect(took).toEqual([['n1', { segment: '5', positionNm: [1, 2, 3] }]])
    // The newest surface going, the older one answers again.
    second.unmount()
    press({})
    expect(took).toHaveLength(2)
    one.unmount()
    press({})
    expect(took).toHaveLength(2)
  })

  it('goes to one card of several — the one alone selected — or to none, saying so', () => {
    const took: string[] = []
    renderHook(() => useSegmentPick('n1', () => took.push('n1')))
    renderHook(() => useSegmentPick('n2', () => took.push('n2')))
    setHoveredSegment(A, '5', [1, 2, 3])
    useGraphStore.setState({ selection: [], notice: undefined } as never)
    press({})
    expect(took).toEqual([])
    expect(useGraphStore.getState().notice).toMatch(/Several Proofread Merges cards/)
    useGraphStore.setState({ selection: ['n2', 'x'] } as never)
    press({})
    expect(took).toEqual(['n2'])
  })
})
