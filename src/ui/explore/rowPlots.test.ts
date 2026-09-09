/**
 * What the inline row marks mean.
 *
 * The arithmetic is here because the SVG cannot be: jsdom performs no layout and draws nothing,
 * so a mark that only existed inside a component would be checked by nothing at all.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { balanceOf, distributionsFor, percentileOf, plotSpec } from './rowPlots'
import { splitByFill } from './rowFields'

const numbers = (name: string, values: number[]) =>
  makeTable(tableSchema(column('neuronId', 'i64'), column(name, 'i64')), {
    neuronId: values.map((_, i) => i + 1),
    [name]: values,
  })

describe('balanceOf', () => {
  it('splits the two counts', () => {
    expect(balanceOf(30, 70)).toEqual({ pre: 0.3, preCount: 30, postCount: 70 })
  })

  /*
   * Both or neither. A bar drawn from one half is not a balance — it would read as "entirely
   * presynaptic", which is a claim the data did not make.
   */
  it('refuses a half-measured neuron rather than drawing it lopsided', () => {
    expect(balanceOf(30, null)).toBeNull()
    expect(balanceOf(null, 70)).toBeNull()
    expect(balanceOf(30, 'many')).toBeNull()
  })

  it('refuses a neuron with no synapses at all, which is not a 50/50 one', () => {
    expect(balanceOf(0, 0)).toBeNull()
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
