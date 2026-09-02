/**
 * The Heatmap node's Order tab, without the drawing and without Python.
 *
 * What is pinned is the *meaning* of each criterion and of "the other axis follows", because
 * every one of them has an obvious wrong reading: a total that read the colour scale, a
 * follower matched by index rather than label, a label sort that put LC10 before LC4.
 */

import { describe, expect, it } from 'vitest'

import { makeMatrix } from '../../core/values'
import {
  applyOrderPlan,
  axisTotals,
  axisVector,
  followOrder,
  labelOrder,
  orderAxis,
  orderByScores,
  orderPlan,
  keptLabels,
  parseLabelFilter,
  readFilterOptions,
  takeMatrix,
  readOrderOptions,
  reverseOrder,
} from './matrixShape'

/** A 3 x 3 over one population, deliberately not symmetric — an Adjacency, in shape. */
function square() {
  return makeMatrix(
    ['LC4', 'LC10', 'DNp02'],
    ['LC4', 'LC10', 'DNp02'],
    // rows: LC4 → [1, 9, 2] ; LC10 → [0, 0, 3] ; DNp02 → [5, 1, 0]
    Float64Array.from([1, 9, 2, 0, 0, 3, 5, 1, 0]),
    'synapses',
  )
}

describe('the criteria', () => {
  it('totals each axis over the finite cells', () => {
    const m = makeMatrix(['a', 'b'], ['x', 'y', 'z'], Float64Array.from([1, 2, Number.NaN, 4, 5, 6]))
    expect([...axisTotals(m, 'rows')]).toEqual([3, 15])
    expect([...axisTotals(m, 'columns')]).toEqual([5, 7, 6])
  })

  it('reads one column for the rows and one row for the columns', () => {
    const m = square()
    expect([...axisVector(m, 'rows', 'LC10')!]).toEqual([9, 0, 1])
    expect([...axisVector(m, 'columns', 'LC10')!]).toEqual([0, 0, 3])
    expect(axisVector(m, 'rows', 'nobody')).toBeUndefined()
  })

  it('orders largest first, stably, with NaN last', () => {
    const order = orderByScores(Float64Array.from([3, Number.NaN, 7, 3, 9]))
    expect([...order]).toEqual([4, 2, 0, 3, 1])
    expect([...orderByScores(Float64Array.from([3, 7]), false)]).toEqual([0, 1])
  })

  it('sorts labels naturally and case-blind', () => {
    const order = labelOrder(['LC10', 'lc4', 'DNp02', 'LC4', 'LC9'])
    // LC4 and lc4 tie under a base-sensitivity compare, so they keep arrival order.
    expect(Array.from(order, (i) => ['LC10', 'lc4', 'DNp02', 'LC4', 'LC9'][i])).toEqual([
      'DNp02',
      'lc4',
      'LC4',
      'LC9',
      'LC10',
    ])
  })

  it('reverses', () => {
    expect([...reverseOrder(Int32Array.from([2, 0, 1]))]).toEqual([1, 0, 2])
  })
})

describe('the plan', () => {
  it('leads with the chosen axis and lets the other follow, unless both', () => {
    expect(orderPlan({ axis: 'rows', follow: true })).toEqual({ lead: ['rows'], follower: 'columns' })
    expect(orderPlan({ axis: 'columns', follow: true })).toEqual({ lead: ['columns'], follower: 'rows' })
    expect(orderPlan({ axis: 'rows', follow: false })).toEqual({ lead: ['rows'] })
    // Independent, so nothing follows even when asked to.
    expect(orderPlan({ axis: 'both', follow: true })).toEqual({ lead: ['rows', 'columns'] })
  })

  it('reads the params with the node defaults', () => {
    expect(readOrderOptions({})).toEqual({
      by: 'none',
      axis: 'rows',
      follow: true,
      reverse: false,
      key: '',
      method: 'average',
      metric: 'euclidean',
    })
    expect(readOrderOptions({ sortBy: 'value', sortKey: '  LC4 ', sortAxis: 'both' })).toMatchObject({
      by: 'value',
      key: 'LC4',
      axis: 'both',
    })
    // A name from nowhere is "as they arrive", not a throw.
    expect(readOrderOptions({ sortBy: 'random' }).by).toBe('none')
  })
})

describe('following', () => {
  it('matches by label, then keeps the rest in their own order', () => {
    // The leader's new order names c, a; the follower has a, b, c, d.
    expect([...followOrder(['c', 'a'], ['a', 'b', 'c', 'd'])]).toEqual([2, 0, 1, 3])
  })

  it('is a no-op when the axes share no labels', () => {
    expect([...followOrder(['x', 'y'], ['a', 'b'])]).toEqual([0, 1])
  })

  it('takes every copy of a repeated label, once', () => {
    expect([...followOrder(['a'], ['a', 'b', 'a'])]).toEqual([0, 2, 1])
  })
})

describe('taking rows and columns', () => {
  it('moves labels with their lines', () => {
    const m = takeMatrix(square(), Int32Array.from([2, 0, 1]), Int32Array.from([1, 0, 2]))
    expect(m.rowLabels).toEqual(['DNp02', 'LC4', 'LC10'])
    expect(m.colLabels).toEqual(['LC10', 'LC4', 'DNp02'])
    // DNp02's row was [5, 1, 0] over (LC4, LC10, DNp02); columns now read LC10, LC4, DNp02.
    expect([...m.values.subarray(0, 3)]).toEqual([1, 5, 0])
    expect(m.valueLabel).toBe('synapses')
  })

  it('returns the very same value for an identity, so a cache key does not have to know', () => {
    const m = square()
    expect(takeMatrix(m, Int32Array.from([0, 1, 2]), undefined)).toBe(m)
  })

  it('takes a subset, which is what makes a filter and a sort one mechanism', () => {
    // Shorter than the axis: rows LC10 and DNp02, columns LC4 and DNp02.
    const m = takeMatrix(square(), Int32Array.from([1, 2]), Int32Array.from([0, 2]))
    expect(m.rowLabels).toEqual(['LC10', 'DNp02'])
    expect(m.colLabels).toEqual(['LC4', 'DNp02'])
    // LC10 → [0, 0, 3] and DNp02 → [5, 1, 0], keeping columns 0 and 2.
    expect([...m.values]).toEqual([0, 3, 5, 0])
    expect(m.valueLabel).toBe('synapses')
  })

  it('keeps nothing when the list is empty', () => {
    const m = takeMatrix(square(), new Int32Array(0))
    expect(m.rowLabels).toEqual([])
    expect(m.colLabels).toEqual(['LC4', 'LC10', 'DNp02'])
    expect(m.values).toHaveLength(0)
  })

  it('refuses an index outside the matrix rather than filling it with NaN', () => {
    expect(() => takeMatrix(square(), Int32Array.from([0, 9]))).toThrow(/outside a matrix of 3/)
  })
})

describe('the label filter', () => {
  const labels = ['LC4', 'LC10', 'lc6', 'DNp02', 'SMP001(a)']
  const keep = (query: string) => {
    const { filter, error } = parseLabelFilter(query)
    expect(error).toBeUndefined()
    return filter ? Array.from(keptLabels(labels, filter), (i) => labels[i]) : labels
  }

  it('is nothing at all when nothing is typed', () => {
    expect(parseLabelFilter('')).toEqual({})
    expect(parseLabelFilter('   ')).toEqual({})
  })

  it('matches a bare term as a case-insensitive substring', () => {
    expect(keep('lc')).toEqual(['LC4', 'LC10', 'lc6'])
    expect(keep('LC1')).toEqual(['LC10'])
  })

  it('treats a bare term as a literal, metacharacters and all', () => {
    // The reason the pattern is opted into: this is a label, not a group.
    expect(keep('SMP001(a)')).toEqual(['SMP001(a)'])
  })

  it('compiles a term starting with a slash, closing slash optional', () => {
    expect(keep('/^LC[0-9]+$')).toEqual(['LC4', 'LC10', 'lc6'])
    expect(keep('/^LC[0-9]+$/')).toEqual(['LC4', 'LC10', 'lc6'])
    // Case-insensitive by flag, so the pattern's own classes are left alone.
    expect(keep('/^[A-Z]+4$')).toEqual(['LC4'])
  })

  it('negates on ! or -', () => {
    expect(keep('!lc')).toEqual(['DNp02', 'SMP001(a)'])
    expect(keep('-/^LC')).toEqual(['DNp02', 'SMP001(a)'])
  })

  it('narrows nothing for a lone slash or a lone negation, which is a box mid-typing', () => {
    expect(parseLabelFilter('/')).toEqual({})
    expect(keep('!')).toEqual(labels)
  })

  it('reports a pattern that will not compile rather than throwing', () => {
    const bad = parseLabelFilter('/^LC[')
    expect(bad.filter).toBeUndefined()
    expect(bad.error).toBeTruthy()
  })

  it('reads both params, trimmed', () => {
    expect(readFilterOptions({ rowFilter: '  LC  ', colFilter: '/^DN' })).toEqual({
      rows: 'LC',
      columns: '/^DN',
    })
    expect(readFilterOptions({})).toEqual({ rows: '', columns: '' })
  })
})

describe('the whole thing on an adjacency', () => {
  it('sorts rows by total and puts the columns in the same order', () => {
    const m = square()
    const options = readOrderOptions({ sortBy: 'total' })
    const rows = orderAxis(m, 'rows', options)
    expect(rows.order && [...rows.order]).toEqual([0, 2, 1]) // 12, 6, 3 → LC4, DNp02, LC10
    const out = applyOrderPlan(m, orderPlan(options), { rows: rows.order })
    expect(out.rowLabels).toEqual(['LC4', 'DNp02', 'LC10'])
    // The columns followed by label, so the diagonal is still the diagonal.
    expect(out.colLabels).toEqual(out.rowLabels)
    expect([...out.values]).toEqual([1, 2, 9, 5, 0, 1, 0, 3, 0])
  })

  it('sorts columns by one row and leaves the rows alone when asked to', () => {
    const m = square()
    const options = readOrderOptions({ sortBy: 'value', sortKey: 'LC4', sortAxis: 'columns', sortFollow: false })
    const cols = orderAxis(m, 'columns', options)
    // LC4's row is [1, 9, 2] → LC10, DNp02, LC4.
    expect(cols.order && [...cols.order]).toEqual([1, 2, 0])
    const out = applyOrderPlan(m, orderPlan(options), { columns: cols.order })
    expect(out.colLabels).toEqual(['LC10', 'DNp02', 'LC4'])
    expect(out.rowLabels).toEqual(['LC4', 'LC10', 'DNp02'])
  })

  it('says why an axis was left alone rather than throwing', () => {
    const m = square()
    expect(orderAxis(m, 'rows', readOrderOptions({ sortBy: 'value' }))).toMatchObject({
      order: undefined,
      problem: expect.stringContaining('needs its label'),
    })
    expect(orderAxis(m, 'rows', readOrderOptions({ sortBy: 'value', sortKey: 'nope' }))).toMatchObject({
      order: undefined,
      problem: expect.stringContaining('"nope"'),
    })
    // …and a follower cannot follow an axis that did not move.
    const out = applyOrderPlan(m, orderPlan(readOrderOptions({ sortBy: 'value' })), {})
    expect(out).toBe(m)
  })

  it('reverses whichever order came out', () => {
    const m = square()
    const rows = orderAxis(m, 'rows', readOrderOptions({ sortBy: 'label', sortReverse: true }))
    expect(Array.from(rows.order!, (i) => m.rowLabels[i])).toEqual(['LC10', 'LC4', 'DNp02'])
  })

  it('does not let the total depend on the colour scale', () => {
    // A presentational param cannot reach the output: a matrix with a negative cell totals
    // the plain sum under every scale.
    const m = makeMatrix(['a', 'b'], ['x'], Float64Array.from([-10, 3]))
    expect([...axisTotals(m, 'rows')]).toEqual([-10, 3])
    const rows = orderAxis(m, 'rows', readOrderOptions({ sortBy: 'total', scale: 'diverging' }))
    expect([...rows.order!]).toEqual([1, 0])
  })
})
