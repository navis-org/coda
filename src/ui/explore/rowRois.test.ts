/**
 * Folding a page of per-region rows into one bar per neuron.
 *
 * The two rules that decide whether these bars mean anything — the nesting filter and the shared
 * ranking — are both invisible from a rendered bar, so they are pinned here.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { MAX_REGIONS, donutArcs, regionShares } from './rowRois'
import { OTHER_LABEL } from '../colors'

const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('roi', 'str'),
  column('pre', 'i64'),
  column('post', 'i64'),
)

const rows = (entries: Array<[string, string, number, number]>) =>
  makeTable(SCHEMA, {
    neuronId: entries.map((e) => e[0]),
    roi: entries.map((e) => e[1]),
    pre: entries.map((e) => e[2]),
    post: entries.map((e) => e[3]),
  })

describe('regionShares', () => {
  it('sums pre and post, since the bar is about where the neuron is', () => {
    const byNeuron = regionShares(
      rows([
        ['1', 'A', 30, 70],
        ['1', 'B', 50, 50],
      ]),
      ['A', 'B'],
    )
    const shares = byNeuron.get('1')!
    expect(shares.map((s) => s.roi)).toEqual(['A', 'B'])
    expect(shares[0]!.share).toBeCloseTo(0.5)
  })

  /*
   * The nesting trap. `roiInfo` counts a synapse in `LO(R)` again in `OL(R)`, so an unfiltered
   * sum reports roughly twice the neuron's synapses — and every share is then drawn from a total
   * nobody could reproduce.
   */
  it('counts only the primary regions, or the totals double', () => {
    const byNeuron = regionShares(
      rows([
        ['1', 'LO(R)', 100, 0],
        ['1', 'OL(R)', 100, 0],
      ]),
      ['LO(R)'],
    )
    const shares = byNeuron.get('1')!
    expect(shares).toHaveLength(1)
    expect(shares[0]!.count).toBe(100)
    expect(shares[0]!.share).toBe(1)
  })

  it('draws nothing at all when the primary list has not arrived', () => {
    // Not "no filter": an unfiltered sum double-counts, so nothing is the only honest picture.
    expect(regionShares(rows([['1', 'A', 5, 5]]), undefined).size).toBe(0)
    expect(regionShares(rows([['1', 'A', 5, 5]]), []).size).toBe(0)
  })

  /*
   * The ranking rule. A bar whose first segment is `ME(R)` on one row and `LO(L)` on the next is
   * five colours meaning five different things per line — worse than no bar at all.
   */
  it('ranks regions across the whole page, so a colour means one region down the column', () => {
    const byNeuron = regionShares(
      rows([
        // B is the page's biggest region even though neuron 1 has more A.
        ['1', 'A', 10, 0],
        ['1', 'B', 5, 0],
        ['2', 'B', 100, 0],
      ]),
      ['A', 'B'],
    )
    // Ranked across the page through `foldByRank`, whose tie break is deterministic.
    // Neuron 1's segments follow the page order, not its own.
    expect(byNeuron.get('1')!.map((s) => s.roi)).toEqual(['B', 'A'])
    // And the rank is the palette index, so B is one colour on both rows.
    expect(byNeuron.get('1')!.find((s) => s.roi === 'B')!.rank).toBe(0)
    expect(byNeuron.get('2')!.find((s) => s.roi === 'B')!.rank).toBe(0)
  })

  it('folds the tail into one segment rather than dropping it', () => {
    // A bar whose segments did not sum to the neuron's synapses would be a proportion of nothing
    // in particular. Fold where the mark folds.
    const many = Array.from(
      { length: MAX_REGIONS + 3 },
      (_, i): [string, string, number, number] => ['1', `R${i}`, 10 - i, 0],
    )
    const primary = many.map((e) => e[1])
    const shares = regionShares(rows(many), primary).get('1')!
    expect(shares).toHaveLength(MAX_REGIONS + 1)
    // `colors.ts`' own spelling, so the donut's title reads like every legend beside it.
    expect(shares.at(-1)!.roi).toBe(OTHER_LABEL)
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1)
  })

  it('keeps what the tail folded, this neuron’s largest first, for the preview to name', () => {
    /*
     * Neuron 2's large R5 ranks R5 above R6 and R7 on the page, so neuron 1's tail arrives in page
     * order R5, R7, R6 — and is named in its own order, R7, R6, R5. Nothing in the list is
     * coloured, so nothing in it has to agree down the column.
     */
    const top = Array.from(
      { length: MAX_REGIONS },
      (_, i): [string, string, number, number] => ['1', `R${i}`, 100, 0],
    )
    const entries: Array<[string, string, number, number]> = [
      ...top,
      ['1', 'R5', 1, 0],
      ['1', 'R6', 2, 0],
      ['1', 'R7', 3, 0],
      ['2', 'R5', 50, 0],
    ]
    const shares = regionShares(rows(entries), [...top.map((e) => e[1]), 'R5', 'R6', 'R7'])
    const own = shares.get('1')!
    const other = own.at(-1)!
    expect(other.roi).toBe(OTHER_LABEL)
    expect(other.folded).toEqual([
      { roi: 'R7', count: 3 },
      { roi: 'R6', count: 2 },
      { roi: 'R5', count: 1 },
    ])
    expect(other.folded!.reduce((a, r) => a + r.count, 0)).toBe(other.count)
    // Only the fold carries a list; a named region is its own entry.
    expect(own.slice(0, -1).every((s) => s.folded === undefined)).toBe(true)
  })

  it('skips a neuron with nothing in any primary region', () => {
    expect(regionShares(rows([['1', 'A', 0, 0]]), ['A']).size).toBe(0)
  })
})

describe('donutArcs', () => {
  const shares = (fractions: number[]) =>
    fractions.map((share, rank) => ({ roi: `R${rank}`, share, count: share * 100, rank }))

  it('lays the segments end to end around the ring', () => {
    const arcs = donutArcs(shares([0.5, 0.25, 0.25]), 100)
    expect(arcs.map((a) => Math.round(a.length))).toEqual([50, 25, 25])
    // Offsets accumulate, so two arcs meant to touch cannot drift apart by rounding.
    expect(arcs.map((a) => Math.round(a.offset))).toEqual([-0, -50, -75])
  })

  it('fills the whole ring for a neuron entirely in one region', () => {
    /*
     * The case that decided the shape. A segment covering the whole ring is a 360° path arc whose
     * start and end coincide, which SVG draws as *nothing* — and a neuron wholly within one
     * region is the ordinary case for a fragment, not an edge case. As a dash pattern it is a
     * full-length dash, which draws.
     */
    const [only] = donutArcs(shares([1]), 100)
    expect(only!.length).toBe(100)
    expect(only!.offset).toBe(-0)
  })

  it('carries the rank through, so a region keeps one colour down the column', () => {
    const arcs = donutArcs(shares([0.6, 0.4]), 100)
    expect(arcs.map((a) => a.rank)).toEqual([0, 1])
  })

  it('draws nothing for a neuron with no measured regions', () => {
    expect(donutArcs([], 100)).toEqual([])
  })
})
