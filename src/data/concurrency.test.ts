import { describe, expect, it } from 'vitest'

import { inFlight, slots } from './concurrency'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('inFlight', () => {
  it('runs every item, at most `limit` at a time', async () => {
    let open = 0
    let peak = 0
    const done: number[] = []
    await inFlight([1, 2, 3, 4, 5, 6], 2, async (item) => {
      open += 1
      peak = Math.max(peak, open)
      await tick()
      open -= 1
      done.push(item)
    })
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(peak).toBe(2)
  })

  /**
   * **Nothing new starts after a failure.** The answer is already a rejection, and the items are
   * requests at a shared server — which, at a `429`, is asking for fewer of them.
   */
  it('fails on the first failure and starts nothing after it', async () => {
    const started: number[] = []
    const run = inFlight([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
      started.push(item)
      await tick()
      if (item === 1) throw new Error('429')
    })
    await expect(run).rejects.toThrow('429')
    // Let the other runner finish what it had in hand, and see that it took no more.
    for (let i = 0; i < 5; i++) await tick()
    expect(started).toEqual([1, 2])
  })
})

describe('slots', () => {
  it('holds at most `limit` at once, across callers, and takes them in arrival order', async () => {
    const budget = slots(2)
    let open = 0
    let peak = 0
    const order: number[] = []
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        budget.run(async () => {
          order.push(n)
          open += 1
          peak = Math.max(peak, open)
          await tick()
          open -= 1
        }),
      ),
    )
    expect(peak).toBe(2)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it('lets a caller cancelled while waiting leave the queue, and the rest go on', async () => {
    const budget = slots(1)
    const ran: string[] = []
    const hold = budget.run(async () => {
      await tick()
      ran.push('first')
    })
    const control = new AbortController()
    const leaving = budget.run(async () => void ran.push('cancelled'), control.signal)
    const last = budget.run(async () => void ran.push('last'))
    control.abort()
    await expect(leaving).rejects.toThrow()
    await Promise.all([hold, last])
    expect(ran).toEqual(['first', 'last'])
  })
})
