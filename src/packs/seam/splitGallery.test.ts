import { describe, expect, it } from 'vitest'
import type { SplitCandidate, SplitGalleryInput } from './splitGallery'
import type { Toy } from './__fixtures__/splitToy'
import { FANC_LAYOUT, MANY_SPLITS, toy, TWO_NEURONS } from './__fixtures__/splitToy'
import { chunkOfMembers, distancesAlong, splitCandidates, splitOf } from './splitGallery'
import { boxCellCount, MAX_BOX_CELLS, splitBoxCells } from './splitGalleryRun'

/** Which chunks a candidate puts with `chunk`. */
const sideWith = (candidate: SplitCandidate, chunk: string) =>
  [...candidate.chunkSides]
    .filter(([, side]) => side === candidate.chunkSides.get(chunk))
    .map(([c]) => c)
    .sort()

/** The candidates offered, without the `undefined` between checked joins. */
const all = (input: SplitGalleryInput, max = 6) =>
  [...splitCandidates(input, { max, minPiece: 3 })].filter(
    (c): c is SplitCandidate => c !== undefined,
  )

/** Three neurons: B touches A at A2, C touches A at A3 more weakly. */
const THREE_NEURONS: Toy = {
  chains: { A: { length: 6, y: 0 }, B: { length: 6, y: 0.5 }, C: { length: 6, y: -0.5 } },
  contacts: [
    ['A2', 'B2', 0.3],
    ['A3', 'C3', 0.1],
  ],
  wide: [1, 4],
  inner: [2, 3],
  click: [2000, 250, 0],
}

describe('splitCandidates', () => {
  it('offers the false merge first, as a split of the whole neuron', () => {
    const [first] = all(toy(TWO_NEURONS))
    expect(first).toBeDefined()
    expect(first!.cut.map((e) => [e.source, e.sink].sort().join('-'))).toEqual(['A2.0-B2.0'])
    expect(sideWith(first!, 'A0')).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5'])
    expect(sideWith(first!, 'B5')).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5'])
    expect(first!.sizes).toEqual({ a: 6, b: 6 })
  })

  it('never offers a cut the neuron stays joined across, however far away the join is', () => {
    // A5 and B5 joined outside the box: cutting A2–B2 leaves one neuron.
    const input = toy({ ...TWO_NEURONS, links: [['A5', 'B5']] })
    for (const candidate of all(input)) {
      expect(
        candidate.cut.some((e) => e.source.startsWith('A2') && e.sink.startsWith('B2')),
      ).toBe(false)
    }
  })

  it('cuts the rest of a contact that runs past the click box, inside the wide box', () => {
    // A second contact at A4–B4: in the wide box, not the click's box.
    const [first] = all(
      toy({
        ...TWO_NEURONS,
        contacts: [
          ['A2', 'B2', 0.1],
          ['A4', 'B4', 0.3],
        ],
      }),
    )
    expect(first!.cut.map((e) => [e.source, e.sink].sort().join('-')).sort()).toEqual([
      'A2.0-B2.0',
      'A4.0-B4.0',
    ])
    expect(sideWith(first!, 'A0')).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5'])
  })

  it('offers the nearer of two false merges first', () => {
    const input = toy(THREE_NEURONS)
    // Cuts through the chains themselves are on offer too; the two merges' order is the point.
    const offered = all(input)
    const b = offered.findIndex((c) => sideWith(c, 'B0').join() === 'B0,B1,B2,B3,B4,B5')
    const c = offered.findIndex((c) => sideWith(c, 'C0').join() === 'C0,C1,C2,C3,C4,C5')
    expect(b).toBe(0)
    expect(c).toBeGreaterThan(b)
    expect(offered[b]!.alongNm).toBeLessThan(offered[c]!.alongNm)
  })

  it('puts a trim after the splits, even when it is nearer', () => {
    // C is one chunk: cutting it off takes 1 chunk, under the 3 a trim is.
    const input = toy({
      chains: { A: { length: 6, y: 0 }, B: { length: 6, y: 0.5 }, C: { length: 1, y: -0.5 } },
      contacts: [
        ['A3', 'B3', 0.3],
        ['A2', 'C0', 0.1],
      ],
      wide: [0, 4],
      inner: [0, 3],
      click: [2000, -250, 0],
    })
    const offered = all(input)
    const smaller = offered.map((c) => Math.min(c.sizes.a, c.sizes.b))
    const firstTrim = smaller.findIndex((n) => n < 3)
    expect(firstTrim).toBeGreaterThan(0)
    expect(smaller.slice(firstTrim).every((n) => n < 3)).toBe(true)
    // C, the nearest split, is among the trims, after B.
    const c = offered.findIndex((c) => sideWith(c, 'C0').join() === 'C0')
    const b = offered.findIndex((c) => sideWith(c, 'B0').join() === 'B0,B1,B2,B3,B4,B5')
    expect(b).toBeGreaterThanOrEqual(0)
    expect(c).toBeGreaterThan(b)
    expect(offered[c]!.alongNm).toBeLessThan(offered[b]!.alongNm)
  })

  it('stops at max', () => {
    const input = toy(THREE_NEURONS)
    expect(all(input, 1)).toHaveLength(1)
  })

  it('puts the cut’s two ends on opposite sides, the first source end on `a`', () => {
    const [first] = all(toy(TWO_NEURONS))
    const edge = first!.cut[0]!
    expect(first!.chunkSides.get(edge.source.split('.')[0]!)).toBe('a')
    expect(first!.chunkSides.get(edge.sink.split('.')[0]!)).toBe('b')
  })
})

describe('distancesAlong', () => {
  it('grows along the neuron from the chunk nearest the click', () => {
    const input = toy({
      chains: { A: { length: 4, y: 0 } },
      wide: [0, 3],
      inner: [0, 3],
      click: [0, 0, 0],
    })
    const chunkOf = chunkOfMembers(input.members)
    const along = distancesAlong(input.wide, chunkOf, input.positions, input.click)
    expect(along.get('A0.0')).toBe(0)
    expect(along.get('A1.0')!).toBeGreaterThan(along.get('A0.3')!)
    expect(along.get('A3.0')!).toBeGreaterThan(along.get('A2.0')! + 900)
  })
})

describe('splitOf', () => {
  it('names the two sides of a cut that separates, and nothing for one that does not', () => {
    const input = toy(TWO_NEURONS)
    const cut = [{ source: 'A2.0', sink: 'B2.0', affinity: 10, area: 100, userMerge: false }]
    expect(splitOf(input, cut)?.sizes).toEqual({ a: 6, b: 6 })
    const joined = { ...input, links: [...input.links, ['A5', 'B5'] as const] }
    expect(splitOf(joined, cut)).toBeUndefined()
    expect(splitOf(input, [])).toBeUndefined()
  })

  it('says which side each supervoxel of a chunk the cut runs through is on', () => {
    // One neuron, cut inside its chunk A2: A2.0–A2.1 on one side, A2.2–A2.3 on the other.
    const input = toy({
      chains: { A: { length: 6, y: 0 } },
      wide: [1, 4],
      inner: [2, 3],
      click: [2000, 0, 0],
    })
    const cut = [{ source: 'A2.1', sink: 'A2.2', affinity: 90, area: 100, userMerge: false }]
    const split = splitOf(input, cut)!
    expect(split.sizes).toEqual({ a: 3, b: 3 })
    expect(Object.fromEntries(split.divided.get('A2')!)).toEqual({
      'A2.0': 'a',
      'A2.1': 'a',
      'A2.2': 'b',
      'A2.3': 'b',
    })
    expect(split.divided.size).toBe(1)
  })

  it('removes every row of a pair the reply lists twice, in both directions', () => {
    const input = toy(TWO_NEURONS)
    const wide = input.wide
    const at = wide.a.findIndex((a, i) => a === 'A2.0' && wide.b[i] === 'B2.0')
    const doubled = {
      ...input,
      wide: {
        a: [...wide.a, 'B2.0'],
        b: [...wide.b, 'A2.0'],
        affinity: Float64Array.from([...wide.affinity, wide.affinity[at]!]),
        area: Float64Array.from([...wide.area, wide.area[at]!]),
      },
    }
    const cut = [{ source: 'A2.0', sink: 'B2.0', affinity: 10, area: 100, userMerge: false }]
    expect(splitOf(doubled, cut)?.sizes).toEqual({ a: 6, b: 6 })
  })
})

describe('splitBoxCells', () => {
  const fanc = FANC_LAYOUT

  it('reads the point’s box one chunk wider, within the cap', () => {
    const { inner, wide } = splitBoxCells(fanc, [100_000, 100_000, 100_000])
    // The point's own cell (45, 45, 17) is inside.
    const cell = [45, 45, 17]
    expect(cell.every((v, a) => v >= inner[0][a]! && v <= inner[1][a]!)).toBe(true)
    expect(wide[0].map((v, a) => inner[0][a]! - v)).toEqual([1, 1, 1])
    expect(boxCellCount(wide)).toBeLessThanOrEqual(MAX_BOX_CELLS)
  })

  it('shrinks the box on a grid of small chunks rather than read more', () => {
    const small = { ...fanc, chunkSize: [64, 64, 16] as const }
    const { wide } = splitBoxCells(small, [100_000, 100_000, 100_000])
    expect(boxCellCount(wide)).toBeLessThanOrEqual(MAX_BOX_CELLS)
  })
})

describe('another set of splits (Regenerate)', () => {
  it('passes over every split offered before, until there are none left', () => {
    const input = toy(MANY_SPLITS)
    const cutOf = (c: { cut: readonly { source: string; sink: string }[] }) =>
      c.cut
        .map((e) => [e.source, e.sink].sort().join('-'))
        .sort()
        .join(',')
    const shown: SplitCandidate[] = []
    const sets: number[] = []
    for (let round = 0; round < 4; round++) {
      const next = [...splitCandidates(input, { exclude: shown })].filter(
        (c): c is SplitCandidate => c !== undefined,
      )
      for (const one of next) expect(shown.map(cutOf)).not.toContain(cutOf(one))
      sets.push(next.length)
      shown.push(...next)
    }
    expect(sets).toEqual([6, 6, 1, 0])
  })
})
