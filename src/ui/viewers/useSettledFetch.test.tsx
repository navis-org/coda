// @vitest-environment jsdom

/**
 * `useSettledFetch`'s cancellation: an unshared request is aborted when its key moves on, and a
 * cached one, which another caller may be sharing, is never handed a signal to abort.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { keyedCache } from './keyedCache'
import type { KeyedCache } from './keyedCache'
import { useSettledFetch } from './useSettledFetch'

afterEach(cleanup)

function Probe({
  id,
  signals,
  cache,
}: {
  id: string
  signals: (AbortSignal | undefined)[]
  cache?: KeyedCache<string>
}) {
  useSettledFetch(
    id,
    (signal) => {
      signals.push(signal)
      return new Promise<string>(() => {})
    },
    cache ? { cache } : {},
  )
  return null
}

describe('useSettledFetch', () => {
  it('aborts an unshared request when the key moves on, and on unmount', () => {
    const signals: (AbortSignal | undefined)[] = []
    const { rerender, unmount } = render(<Probe id="a" signals={signals} />)
    rerender(<Probe id="b" signals={signals} />)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    unmount()
    expect(signals[1]!.aborted).toBe(true)
  })

  it('hands a cached loader no signal, its request being shareable', () => {
    const signals: (AbortSignal | undefined)[] = []
    render(<Probe id="a" signals={signals} cache={keyedCache<string>(4)} />)
    expect(signals).toEqual([undefined])
  })
})
