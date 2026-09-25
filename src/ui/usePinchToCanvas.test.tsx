// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'

import { usePinchToCanvas } from './usePinchToCanvas'

/** React Flow's shape: its zoom listens on the renderer, above the viewport the cards sit in. */
function Canvas() {
  const wrapper = useRef<HTMLDivElement>(null)
  usePinchToCanvas(wrapper)
  return (
    <div ref={wrapper}>
      <div data-testid="renderer">
        <div className="react-flow__viewport">
          <div className="nowheel">
            <span data-testid="scroll" />
          </div>
          <div className="nowheel" data-testid="zooms-itself">
            <span data-testid="chart" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Whether the target has a `nowheel` ancestor at the moment React Flow's listener runs. */
function blockedAtRenderer(target: string, ctrlKey: boolean) {
  const { getByTestId, unmount } = render(<Canvas />)
  getByTestId('zooms-itself').addEventListener('wheel', (e) => e.preventDefault())
  let blocked: boolean | undefined
  getByTestId('renderer').addEventListener('wheel', (e) => {
    blocked = (e.target as Element).closest('.nowheel') !== null
  })
  getByTestId(target).dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey }),
  )
  unmount()
  return blocked
}

describe('usePinchToCanvas', () => {
  it('hands a pinch over a scrolling card to the canvas', () => {
    expect(blockedAtRenderer('scroll', true)).toBe(false)
  })

  it('leaves a plain scroll to the card', () => {
    expect(blockedAtRenderer('scroll', false)).toBe(true)
  })

  // A viewer that zooms itself cancels the wheel; that is the whole of the opt-out.
  it('leaves a pinch a viewer has claimed', () => {
    expect(blockedAtRenderer('chart', true)).toBe(true)
  })

  it('puts the class back once the event has been handled', async () => {
    const { getByTestId, container } = render(<Canvas />)
    getByTestId('scroll').dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true }),
    )
    expect(container.querySelectorAll('.nowheel')).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve))
    expect(container.querySelectorAll('.nowheel')).toHaveLength(2)
  })
})
