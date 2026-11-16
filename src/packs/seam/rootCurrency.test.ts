/**
 * The review card's currency check (`rootCurrency.ts`), against fake servers and a fake clock:
 * what is asked, when, how often, and how long an answer holds — built for a queue that is still
 * arriving from Suggest Merges.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GrapheneSource } from '../../data/cave/graphene'
import type { CurrencyServices } from './rootCurrency'
import {
  BATCH,
  CURRENT_FOR_MS,
  GATHER_MS,
  RETRY_AFTER_MS,
  createRootCurrency,
} from './rootCurrency'

const GRAPHENE: GrapheneSource = { server: 'https://cave.example.org', table: 't', base: '' }
const AT = { deployment: 'https://global.example.org', datastack: 'test' }

/** Servers that call every root in `edited` outdated, and keep what they were asked. */
function servers(edited: string[] = [], fail = false) {
  const asked: string[][] = []
  let clock = 0
  const services: CurrencyServices = {
    chunkedgraph: async () => GRAPHENE,
    latest: async (_, roots, options) => {
      expect(options.quiet).toBe(true)
      asked.push([...roots])
      if (fail) throw new Error('503')
      return roots.map((root) => !edited.includes(root))
    },
    now: () => clock,
  }
  return { services, asked, tick: (ms: number) => (clock += ms) }
}

/** Let the gathering wait run out and every ask land. */
async function settle() {
  await vi.advanceTimersByTimeAsync(GATHER_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('rootCurrency', () => {
  it('asks once for what it is given, and answers from it', async () => {
    const { services, asked } = servers(['8'])
    const currency = createRootCurrency(services)
    const heard = vi.fn()
    currency.subscribe(heard)
    currency.ask(AT, ['100', '7', '8'])
    expect(currency.current(AT, '7')).toBeUndefined()
    await settle()
    expect(asked).toEqual([['100', '7', '8']])
    expect([currency.current(AT, '7'), currency.current(AT, '8')]).toEqual([true, false])
    expect(heard).toHaveBeenCalled()
    expect(currency.version()).toBeGreaterThan(0)
  })

  /** A stream: each published partial brings more candidates, and only those are asked. */
  it('gathers a stream’s arrivals, and asks only roots it does not know', async () => {
    const { services, asked } = servers()
    const currency = createRootCurrency(services)
    currency.ask(AT, ['100', '7'])
    currency.ask(AT, ['100', '7', '8'])
    await settle()
    currency.ask(AT, ['100', '7', '8', '9'])
    currency.ask(AT, ['100', '7', '8', '9'])
    await settle()
    expect(asked).toEqual([['100', '7', '8'], ['9']])
  })

  it('splits a long list into batches, one after another', async () => {
    const { services, asked } = servers()
    const currency = createRootCurrency(services)
    const roots = Array.from({ length: BATCH + 5 }, (_, i) => String(i + 1))
    currency.ask(AT, roots)
    await settle()
    expect(asked.map((batch) => batch.length)).toEqual([BATCH, 5])
  })

  it('keeps “outdated” for good, and asks about “current” again once it has run out', async () => {
    const { services, asked, tick } = servers(['8'])
    const currency = createRootCurrency(services)
    currency.ask(AT, ['7', '8'])
    await settle()
    tick(CURRENT_FOR_MS)
    currency.ask(AT, ['7', '8'])
    await settle()
    expect(asked).toEqual([['7', '8'], ['7']])
  })

  it('waits before asking again after a failure, and knows nothing meanwhile', async () => {
    const { services, asked, tick } = servers([], true)
    const currency = createRootCurrency(services)
    currency.ask(AT, ['7'])
    await settle()
    currency.ask(AT, ['7'])
    await settle()
    expect(asked).toHaveLength(1)
    expect(currency.current(AT, '7')).toBeUndefined()
    tick(RETRY_AFTER_MS)
    currency.ask(AT, ['7'])
    await settle()
    expect(asked).toHaveLength(2)
  })

  it('keeps one datastack’s answers apart from another’s', async () => {
    const { services } = servers(['7'])
    const currency = createRootCurrency(services)
    currency.ask(AT, ['7'])
    await settle()
    expect(currency.current({ ...AT, datastack: 'other' }, '7')).toBeUndefined()
  })
})
