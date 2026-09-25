// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { ReactFlowProvider, useStoreApi } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CardCanvasScale, useCanvasScale } from './canvasScale'

let store: ReturnType<typeof useStoreApi>
function Probe() {
  store = useStoreApi()
  return <span data-testid="scale">{useCanvasScale()}</span>
}

const zoomTo = (k: number) => act(() => store.setState({ transform: [0, 0, k] }))

describe('CardCanvasScale', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('devicePixelRatio', 1)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // A step change mid-pinch redraws every canvas on the card: the jitter this prevents.
  it('follows the zoom only once it settles', () => {
    render(
      <ReactFlowProvider>
        <CardCanvasScale>
          <Probe />
        </CardCanvasScale>
      </ReactFlowProvider>,
    )
    const scale = () => Number(screen.getByTestId('scale').textContent)
    expect(scale()).toBe(1)

    zoomTo(1.2)
    act(() => vi.advanceTimersByTime(150))
    zoomTo(1.8)
    act(() => vi.advanceTimersByTime(150))
    expect(scale()).toBe(1)

    act(() => vi.advanceTimersByTime(100))
    expect(scale()).toBe(2)
  })
})
