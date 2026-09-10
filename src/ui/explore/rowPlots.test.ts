/**
 * What the inline row marks mean.
 *
 * The arithmetic is here because the SVG cannot be: jsdom performs no layout and draws nothing,
 * so a mark that only existed inside a component would be checked by nothing at all.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import {
  axisAt,
  barFraction,
  distributionsFor,
  spreadFor,
  spreadOf,
  percentileOf,
  plotSpec,
  sharesOf,
} from './rowPlots'
import { splitByFill } from './rowFields'

const numbers = (name: string, values: number[]) =>
  makeTable(tableSchema(column('neuronId', 'i64'), column(name, 'i64')), {
    neuronId: values.map((_, i) => i + 1),
    [name]: values,
  })

describe('sharesOf', () => {
  it('splits the counts into shares of their own sum', () => {
    expect(sharesOf(['pre', 'post'], [30, 70])).toEqual([
      { name: 'pre', count: 30, share: 0.3 },
      { name: 'post', count: 70, share: 0.7 },
    ])
  })

  it('reads any number of parts, and they sum to the whole', () => {
    // fish2's 100010701: axonIn, axonOut, dendriteIn, dendriteOut.
    const parts = sharesOf(['aIn', 'aOut', 'dIn', 'dOut'], [36, 3029, 342, 8])!
    expect(parts.map((p) => p.name)).toEqual(['aIn', 'aOut', 'dIn', 'dOut'])
    expect(parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 12)
  })

  /*
   * All or nothing. A bar drawn from the parts that happen to be present is not a split — a
   * neuron with `pre` and no `post` would read as "entirely presynaptic", which is a claim the
   * data did not make.
   */
  it('refuses a half-measured neuron rather than drawing it lopsided', () => {
    expect(sharesOf(['pre', 'post'], [30, null])).toBeNull()
    expect(sharesOf(['pre', 'post'], [null, 70])).toBeNull()
    expect(sharesOf(['pre', 'post'], [30, 'many'])).toBeNull()
  })

  it('refuses a neuron with no synapses at all, which is not an even one', () => {
    expect(sharesOf(['pre', 'post'], [0, 0])).toBeNull()
  })

  it('refuses a negative part, which has no share', () => {
    expect(sharesOf(['a', 'b'], [-5, 10])).toBeNull()
  })
})

describe('barFraction', () => {
  it('reads a value against the largest in the whole column, not the sample', () => {
    // The largest value is one row among 20,000, which the 4,000-point stride skips — the bar
    // must still be read against it, or everything above the sample's top is a full bar.
    const values = Array.from({ length: 20_000 }, (_, i) =>
      i === 12_345 ? 1_000_000 : i % 100,
    )
    const dist = distributionsFor(numbers('size', values), [], ['size'])
    expect(dist.max.get('size')).toBe(1_000_000)
    // And a bar pays for no sorted sample it would never read.
    expect(dist.sorted.size).toBe(0)
    expect(barFraction(dist, 'size', 500_000, false)).toBeCloseTo(0.5, 6)
    expect(barFraction(dist, 'size', 1_000_000, false)).toBe(1)
  })

  it('on a log scale, gives a small value a visible length', () => {
    const dist = distributionsFor(numbers('size', [0, 10, 10_000]), [], ['size'])
    const linear = barFraction(dist, 'size', 10, false)!
    const log = barFraction(dist, 'size', 10, true)!
    expect(linear).toBeLessThan(0.01)
    expect(log).toBeGreaterThan(0.2)
    expect(barFraction(dist, 'size', 10_000, true)).toBeCloseTo(1, 12)
  })

  it('answers nothing where there is nothing to read against', () => {
    const dist = distributionsFor(numbers('size', [0, 0]), [], ['size'])
    expect(barFraction(dist, 'size', 0, false)).toBeNull()
    expect(barFraction(dist, 'other', 5, false)).toBeNull()
    expect(barFraction(dist, 'size', null, false)).toBeNull()
  })
})

describe('percentileOf', () => {
  const table = numbers(
    'size',
    Array.from({ length: 101 }, (_, i) => i * 10),
  )
  const dist = distributionsFor(table, ['size'])

  it('places a value in its column’s spread', () => {
    expect(percentileOf(dist, 'size', 0)!.at).toBeCloseTo(0, 2)
    expect(percentileOf(dist, 'size', 500)!.at).toBeCloseTo(0.5, 2)
    expect(percentileOf(dist, 'size', 1000)!.at).toBeCloseTo(1, 2)
  })

  it('is monotonic, which is the only property a reader relies on', () => {
    let last = -1
    for (const value of [0, 120, 333, 700, 999]) {
      const at = percentileOf(dist, 'size', value)!.at
      expect(at).toBeGreaterThanOrEqual(last)
      last = at
    }
  })

  it('answers nothing where there is nothing to compare against', () => {
    // A tick at a position derived from no distribution is a mark that means nothing.
    expect(percentileOf(dist, 'cableLength', 5)).toBeNull()
    expect(percentileOf(dist, 'size', null)).toBeNull()
    expect(percentileOf(distributionsFor(undefined, ['size']), 'size', 5)).toBeNull()
  })

  it('reads the whole column, not its head', () => {
    // Strided sampling: a table whose large values sit at the end must still place them high.
    const ordered = numbers(
      'size',
      Array.from({ length: 20000 }, (_, i) => i),
    )
    const spread = distributionsFor(ordered, ['size'])
    expect(percentileOf(spread, 'size', 19000)!.at).toBeGreaterThan(0.9)
  })
})

/**
 * The histogram a bar's or a rank's hover preview draws a neuron against.
 *
 * Headless for the reason the marks are: what the preview *means* — which bin a value lands in,
 * where the axis starts — is invisible in an SVG jsdom cannot lay out.
 */
describe('spreadOf', () => {
  it('bins every number in the column, and nothing else', () => {
    const h = spreadOf([1, 2, 3, null, 'x', Number.NaN, 4], 'linear', false, 4)!
    expect(h.total).toBe(4)
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(4)
    expect([h.lo, h.hi]).toEqual([1, 4])
  })

  it('puts the largest value in the last bin rather than one past it', () => {
    expect(spreadOf([0, 5, 10], 'linear', false, 2)!.counts).toEqual([1, 2])
  })

  it('starts a bar’s axis at zero, which is where the bar is read from', () => {
    const h = spreadOf([10, 20, 30], 'linear', true, 3)!
    expect(h.lo).toBe(0)
    // 10 is a third of the way along from zero, so the first bin is empty.
    expect(h.counts).toEqual([0, 1, 2])
  })

  it('on a log axis, spreads a long tail a linear one crowds into its first bin', () => {
    const skewed = [...Array.from({ length: 99 }, (_, i) => i + 1), 10_000]
    const linear = spreadOf(skewed, 'linear', false, 10)!
    const log = spreadOf(skewed, 'log', false, 10)!
    expect(linear.counts[0]).toBe(99)
    expect(Math.max(...log.counts)).toBeLessThan(99)
    expect(log.counts.filter((n) => n > 0).length).toBeGreaterThan(3)
  })

  it('answers nothing for a column holding no number', () => {
    expect(spreadOf([null, 'a'], 'linear', false)).toBeNull()
  })
})

describe('axisAt', () => {
  it('runs from 0 at one end to 1 at the other on either scale, clamped outside', () => {
    for (const scale of ['linear', 'log'] as const) {
      const axis = { lo: 10, hi: 1000, scale }
      expect(axisAt(axis, 10)).toBe(0)
      expect(axisAt(axis, 1000)).toBe(1)
      expect(axisAt(axis, 5)).toBe(0)
      expect(axisAt(axis, 5000)).toBe(1)
      expect(axisAt(axis, 100)).toBeGreaterThan(0)
      expect(axisAt(axis, 100)).toBeLessThan(axisAt(axis, 200))
    }
  })

  it('puts a column of one value in the middle rather than dividing by nothing', () => {
    expect(axisAt({ lo: 5, hi: 5, scale: 'log' }, 5)).toBe(0.5)
  })
})

describe('spreadFor', () => {
  it('bins a column once per axis, and again only for another', () => {
    const table = numbers('size', [1, 2, 3])
    const once = spreadFor(table, 'size', 'linear', false)
    expect(spreadFor(table, 'size', 'linear', false)).toBe(once)
    expect(spreadFor(table, 'size', 'log', false)).not.toBe(once)
    expect(spreadFor(table, 'absent', 'linear', false)).toBeNull()
  })
})

describe('a rank’s automatic axis', () => {
  const axis = (values: number[]) => spreadOf(values, 'auto', false)!.scale

  it('goes log where more than half the column sits in the first tenth of a linear one', () => {
    expect(axis([...Array.from({ length: 99 }, (_, i) => i + 1), 10_000])).toBe('log')
  })

  it('keeps an even spread linear', () => {
    expect(axis(Array.from({ length: 101 }, (_, i) => i))).toBe('linear')
  })

  it('keeps a column with a negative value linear, and one with no span', () => {
    expect(axis([-5, 0, 1, 2, 1000])).toBe('linear')
    expect(axis([3, 3, 3])).toBe('linear')
  })
})

describe('plotSpec', () => {
  it('offers only what the dataset has the columns for', () => {
    const has = (name: string) => ['pre', 'post', 'size'].includes(name)
    expect(plotSpec(has)).toEqual({ balance: { pre: 'pre', post: 'post' }, percentile: 'size' })
  })

  it('pairs a confidence only with the label it qualifies', () => {
    // A prediction with no confidence beside it reads as a fact; an empty gauge would suggest
    // otherwise, so the pair is all-or-nothing.
    const withBoth = (name: string) =>
      ['predictedNt', 'celltypePredictedNtConfidence'].includes(name)
    expect(plotSpec(withBoth).confidence).toEqual({
      label: 'predictedNt',
      value: 'celltypePredictedNtConfidence',
    })
    expect(plotSpec((name) => name === 'predictedNt').confidence).toBeUndefined()
  })

  it('draws nothing at all for a dataset with none of the columns', () => {
    expect(plotSpec(() => false)).toEqual({})
  })
})

describe('splitByFill', () => {
  const table = (fill: Record<string, (string | null)[]>) => {
    const names = Object.keys(fill)
    const length = fill[names[0]!]!.length
    return {
      data: Object.fromEntries(names.map((n) => [n, fill[n]!])),
      length,
    }
  }

  it('aligns what most neurons have and leaves the sparse tail as chips', () => {
    /*
     * The whole column-versus-chip rule. `class` is on every neuron, so a column of it can be
     * read down; `dimorphism` is on one in five, so a column would be four blanks in five eating
     * width a filled column wanted — as a chip it simply appears where it applies.
     */
    const rows = 10
    const split = splitByFill(
      ['class', 'dimorphism'],
      table({
        class: Array.from({ length: rows }, () => 'descending'),
        dimorphism: Array.from({ length: rows }, (_, i) => (i < 2 ? 'male-specific' : '')),
      }),
    )
    expect(split.columns).toEqual(['class'])
    expect(split.chips).toEqual(['dimorphism'])
  })

  it('keeps priority order rather than re-ranking by how full a field is', () => {
    // `type` before `class` before `superclass` is a hierarchy; sorting it by completeness
    // scrambles the order somebody reads a neuron in.
    const rows = 10
    const split = splitByFill(
      ['class', 'superclass'],
      table({
        class: Array.from({ length: rows }, (_, i) => (i < 6 ? 'a' : '')),
        superclass: Array.from({ length: rows }, () => 'central'),
      }),
    )
    expect(split.columns).toEqual(['class', 'superclass'])
  })

  it('treats an empty string as unfilled, which is how a property arrives unset', () => {
    const rows = 10
    const split = splitByFill(
      ['blank'],
      table({ blank: Array.from({ length: rows }, () => '') }),
    )
    expect(split.columns).toEqual([])
    expect(split.chips).toEqual(['blank'])
  })

  it('caps the columns and hands the rest on, so a wide dataset cannot fill the row', () => {
    const rows = 10
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const split = splitByFill(
      names,
      table(Object.fromEntries(names.map((n) => [n, Array.from({ length: rows }, () => 'x')]))),
    )
    expect(split.columns).toHaveLength(5)
    expect(split.chips).toEqual(['f', 'g'])
  })
})
