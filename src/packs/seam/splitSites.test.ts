import { describe, expect, it } from 'vitest'
import { parseCaveJson } from '../../data/cave/json'
import { edgeKind, readSubgraphReply, unionOf } from '../../data/cave/subgraph'
import type { SupervoxelGraph } from '../../data/cave/subgraph'
import { cutAcross, groupSites, pathCuts, splitSites } from './splitSites'
import { boxesAlong, chunkPaths } from './splitSitesRun'

const TINY = 1.1754943508222875e-38

/** A graph from `[a, b, meanAffinity, area]` rows; a mean of `Infinity` is a chunk-border join. */
function graphOf(
  rows: ReadonlyArray<readonly [string, string, number, number]>,
): SupervoxelGraph {
  return {
    a: rows.map((r) => r[0]),
    b: rows.map((r) => r[1]),
    affinity: Float64Array.from(rows, ([, , mean, area]) =>
      mean === Infinity ? Infinity : mean === 0 ? TINY : mean * area,
    ),
    area: Float64Array.from(rows, ([, , mean, area]) =>
      mean === 0 || mean === Infinity ? 0 : area,
    ),
  }
}

/** Unordered pairs of a cut, for comparing. */
const pairs = (cut: ReadonlyArray<{ source: string; sink: string }>) =>
  cut.map((e) => `${e.source}>${e.sink}`).sort()

describe('edgeKind and unionOf', () => {
  it('names every edge one way: a piece, unread, a proofreader merge, or a contact', () => {
    expect(edgeKind(Infinity, 0)).toBe('piece')
    expect(edgeKind(Number.NaN, 12)).toBe('unread')
    expect(edgeKind(5, Number.NaN)).toBe('unread')
    expect(edgeKind(TINY, 0)).toBe('userMerge')
    expect(edgeKind(TINY, 12)).toBe('userMerge')
    expect(edgeKind(5, 12)).toBe('contact')
  })

  it('keeps each edge once, in either direction', () => {
    const one = graphOf([['a', 'b', 0.5, 10]])
    const two = graphOf([
      ['b', 'a', 0.5, 10],
      ['b', 'c', 0.5, 10],
    ])
    expect(unionOf([one, two]).a).toEqual(['a', 'b'])
  })
})

describe('readSubgraphReply', () => {
  it('reads ids as text and areas sent as text', () => {
    const graph = readSubgraphReply({
      nodes: [['720575940000000001', '720575940000000002']],
      affinities: [12.5],
      areas: ['20'],
    })
    expect(graph.a).toEqual(['720575940000000001'])
    expect(graph.b).toEqual(['720575940000000002'])
    expect(graph.affinity[0]).toBe(12.5)
    expect(graph.area[0]).toBe(20)
  })

  it('reads a missing area as NaN, never as the 0 of a proofreader merge', () => {
    const graph = readSubgraphReply({ nodes: [['1', '2']], affinities: [3], areas: [null] })
    expect(graph.area[0]).toBeNaN()
  })

  it('refuses a 1.x reply, which has edges and no weights, by name', () => {
    expect(() => readSubgraphReply({ atomic_edges: [['1', '2']] })).toThrow(
      /pychunkedgraph 1\.x/,
    )
  })

  /** Asked without `int64_as_str` (slower to answer): `parseCaveJson` quotes a wide id. */
  it('reads ids as text or safe integers, and refuses a number past 2⁵³, which has lost digits', () => {
    const wide = parseCaveJson('{"nodes":[[73747834149376537,2]],"affinities":[1],"areas":[1]}')
    expect(readSubgraphReply(wide).a).toEqual(['73747834149376537'])
    expect(readSubgraphReply({ nodes: [[1, 2]], affinities: [1], areas: [1] }).b).toEqual(['2'])
    expect(() =>
      readSubgraphReply({ nodes: [[2 ** 60, 2]], affinities: [1], areas: [1] }),
    ).toThrow(/not a pair of supervoxel ids/)
  })

  it('refuses mismatched lengths rather than pairing weights with the wrong edges', () => {
    expect(() =>
      readSubgraphReply({ nodes: [['1', '2']], affinities: [1, 2], areas: ['1'] }),
    ).toThrow(/which weight/)
  })
})

describe('splitSites', () => {
  /*
   * Two neurons, s1–s2–s3 and t1–t2–t3, strongly joined inside (mean 0.9). s1, the source, hangs
   * off s2 by a thin strong neck (area 10, mean 0.9: total 9). The two neurons touch at s3–t1 over
   * a wide weak contact (area 200, mean 0.3: total 60). A min-cut takes the neck (9 < 60); the
   * agglomeration joins the neck at 0.9 and refuses the contact at 0.3.
   */
  const twoNeurons: Array<readonly [string, string, number, number]> = [
    ['s1', 's2', 0.9, 10],
    ['s2', 's3', 0.9, 500],
    ['t1', 't2', 0.9, 500],
    ['t2', 't3', 0.9, 500],
    ['s3', 't1', 0.3, 200],
  ]

  it('cuts at the weak contact, not at the thin neck a min-cut would take', () => {
    const result = splitSites({ graph: graphOf(twoNeurons), sources: ['s1'], sinks: ['t3'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pairs(result.cut)).toEqual(['s3>t1'])
    expect(result.counts).toEqual({ source: 3, sink: 3, neither: 0 })
    expect(result.refusals[0]!.score).toBeCloseTo(0.3)
  })

  it('weighs by mean affinity after regions merge, not by single edges', () => {
    // t1 touches s3 twice: a strong small contact (0.8 × 5) and a weak large one (0.1 × 500).
    // Merged boundary mean = (4 + 50) / 505 ≈ 0.107, below t1's own link to t2 at 0.2, so t1 goes
    // with the sink and the cut takes both contacts.
    const result = splitSites({
      graph: graphOf([
        ['s1', 's2', 0.9, 100],
        ['s2', 's3', 0.9, 100],
        ['s3', 't1', 0.8, 5],
        ['s3', 't1b', 0.1, 500],
        ['t1', 't1b', Infinity, 0],
        ['t1', 't2', 0.2, 50],
        ['t2', 't3', 0.9, 100],
      ]),
      sources: ['s1'],
      sinks: ['t3'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pairs(result.cut)).toEqual(['s3>t1', 's3>t1b'])
  })

  /*
   * The two neurons are joined only by a proofreader's merge (s3–t1), and t1 also hangs off t2 by
   * a weak contact. Trusting the merge keeps it and cuts at t1–t2; distrusting it, as CAVE does,
   * cuts the merge.
   */
  const withMerge: Array<readonly [string, string, number, number]> = [
    ['s1', 's2', 0.9, 100],
    ['s2', 's3', 0.9, 100],
    ['s3', 't1', 0, 0],
    ['t1', 't2', 0.4, 100],
    ['t2', 't3', 0.9, 100],
  ]

  it('keeps a trusted proofreader merge and cuts the next-weakest contact', () => {
    const result = splitSites({ graph: graphOf(withMerge), sources: ['s1'], sinks: ['t3'] })
    expect(result.ok && pairs(result.cut)).toEqual(['t1>t2'])
  })

  it('cuts a distrusted proofreader merge first, flagged as one', () => {
    const result = splitSites({
      graph: graphOf(withMerge),
      sources: ['s1'],
      sinks: ['t3'],
      userMerges: 'distrust',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pairs(result.cut)).toEqual(['s3>t1'])
    expect(result.cut[0]!.userMerge).toBe(true)
  })

  it('cuts a trusted merge too, where it joins the two points directly', () => {
    const result = splitSites({
      graph: graphOf([
        ['s1', 't1', 0, 0],
        ['s1', 's2', 0.9, 10],
      ]),
      sources: ['s1'],
      sinks: ['t1'],
    })
    expect(result.ok && pairs(result.cut)).toEqual(['s1>t1'])
  })

  it('skips an edge with no area instead of trusting it as a proofreader merge', () => {
    // s1–t2 has an unreadable area. Read as 0 it would be a trusted merge and land in the cut.
    const graph = graphOf([
      ['s1', 's2', 0.9, 100],
      ['t1', 't2', 0.9, 100],
      ['s2', 't1', 0.3, 100],
    ])
    const withHole: SupervoxelGraph = {
      a: [...graph.a, 's1'],
      b: [...graph.b, 't2'],
      affinity: Float64Array.from([...graph.affinity, 5]),
      area: Float64Array.from([...graph.area, Number.NaN]),
    }
    const result = splitSites({ graph: withHole, sources: ['s1'], sinks: ['t2'] })
    expect(result.ok && pairs(result.cut)).toEqual(['s2>t1'])
  })

  it('drops a seed that shares a supervoxel with the other side, keeping the clicked ones', () => {
    // The two pieces meet across a chunk border through one supervoxel, x|x2 (Infinity): seeding
    // both whole pieces would put a source and a sink on one atom.
    const graph = graphOf([
      ['s1', 'x', 0.9, 100],
      ['x', 'x2', Infinity, 0],
      ['x2', 't1', 0.9, 100],
      ['s1', 't1', 0.2, 100],
    ])
    const seeded = { graph, sources: ['s1', 'x'], sinks: ['t1', 'x2'] }
    expect(splitSites(seeded).ok || (splitSites(seeded) as { reason: string }).reason).toBe(
      'same-supervoxel',
    )
    const result = splitSites({ ...seeded, anchors: { sources: ['s1'], sinks: ['t1'] } })
    expect(result.ok).toBe(true)
  })

  it('refuses points on one supervoxel, joined across a chunk border', () => {
    const result = splitSites({
      graph: graphOf([
        ['a', 'a2', Infinity, 0],
        ['a2', 'b', 0.5, 10],
      ]),
      sources: ['a'],
      sinks: ['a2'],
    })
    expect(result.ok || result.reason).toBe('same-supervoxel')
  })

  it('says so when the points are not joined inside the box', () => {
    const result = splitSites({
      graph: graphOf([
        ['s1', 's2', 0.9, 10],
        ['t1', 't2', 0.9, 10],
      ]),
      sources: ['s1'],
      sinks: ['t1'],
    })
    expect(result.ok || result.reason).toBe('not-connected')
  })

  it('refuses a point whose supervoxel is not in the graph', () => {
    const result = splitSites({ graph: graphOf(twoNeurons), sources: ['nope'], sinks: ['t3'] })
    expect(result.ok || result.reason).toBe('point-not-in-graph')
  })

  it('flags affinities that are only areas (MICrONS)', () => {
    const result = splitSites({
      graph: graphOf(twoNeurons.map(([a, b, , area]) => [a, b, 1, area] as const)),
      sources: ['s1'],
      sinks: ['t3'],
    })
    expect(result.ok && result.affinityIsArea).toBe(true)
  })

  it('puts every supervoxel reached from a point on a side, and the rest on neither', () => {
    const result = splitSites({
      graph: graphOf([...twoNeurons, ['x1', 'x2', 0.9, 10]]),
      sources: ['s1'],
      sinks: ['t3'],
    })
    expect(result.ok && result.counts).toEqual({ source: 3, sink: 3, neither: 2 })
  })
})

describe('splitSites candidates', () => {
  /*
   * What five of nine FANC splits looked like: neuron A (a1–a5) and neuron B (b1–b5), each strong
   * inside (0.9), falsely merged at a5–b1 (0.3). The sink sits on t, a small piece hanging off b5
   * by a weak contact (0.15). Constrained, A and B's bulk merge at 0.3 — neither holds a point —
   * and the cut falls around t. Unconstrained, the step where A's region takes in B's bulk is the
   * weakest step between two large regions.
   */
  const chain = (name: string): Array<readonly [string, string, number, number]> =>
    [1, 2, 3, 4].map((i) => [`${name}${i}`, `${name}${i + 1}`, 0.9, 100] as const)
  const rows = [
    ...chain('a'),
    ...chain('b'),
    ['a5', 'b1', 0.3, 100],
    ['b5', 't', 0.15, 50],
  ] as Array<readonly [string, string, number, number]>

  it('cuts around the weakly attached point when constrained — the failure being fixed', () => {
    const result = splitSites({
      graph: graphOf(rows),
      sources: ['a1'],
      sinks: ['t'],
      minPiece: 3,
    })
    expect(result.ok && pairs(result.cut)).toEqual(['b5>t'])
  })

  it('ranks the merge of the two large regions first', () => {
    const result = splitSites({
      graph: graphOf(rows),
      sources: ['a1'],
      sinks: ['t'],
      minPiece: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first] = result.candidates
    expect(first!.point).toBe('source')
    expect(first!.score).toBeCloseTo(0.3)
    expect(first!.sizes).toEqual([5, 5])
    expect(pairs(first!.cut)).toEqual(['a5>b1'])
  })

  it('drops steps that take in fewer than minPiece supervoxels', () => {
    const result = splitSites({
      graph: graphOf(rows),
      sources: ['a1'],
      sinks: ['t'],
      minPiece: 3,
    })
    // The meeting step (t, one supervoxel, onto ten) is below minPiece, so it is not offered.
    expect(result.ok && result.candidates.every((c) => Math.min(...c.sizes) >= 3)).toBe(true)
    expect(result.ok && result.candidates.some((c) => c.point === 'both')).toBe(false)
  })

  it('orients a step on the sink side with the region taken in as the source end', () => {
    // Mirror: the source on the weakly attached piece, the sink deep in B.
    const result = splitSites({
      graph: graphOf(rows),
      sources: ['t'],
      sinks: ['a1'],
      minPiece: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first] = result.candidates
    expect(first!.point).toBe('sink')
    expect(pairs(first!.cut)).toEqual(['b1>a5'])
  })
})

describe('cutAcross', () => {
  it("classifies another tool's two sides as every cut here is: unread edges left out", () => {
    const graph = graphOf([
      ['s1', 's2', 0.9, 100],
      ['s2', 't1', 0.3, 100],
      ['t1', 't2', 0.9, 100],
    ])
    const withHole: SupervoxelGraph = {
      a: [...graph.a, 't2'],
      b: [...graph.b, 's1'],
      affinity: Float64Array.from([...graph.affinity, 5]),
      area: Float64Array.from([...graph.area, Number.NaN]),
    }
    const cut = cutAcross(withHole, new Set(['s1', 's2']), new Set(['t1', 't2']))
    expect(pairs(cut)).toEqual(['s2>t1'])
    expect(cut[0]!.userMerge).toBe(false)
  })
})

describe('groupSites', () => {
  const edge = (source: string, sink: string, mean: number, area: number) => ({
    source,
    sink,
    affinity: mean === 0 ? TINY : mean * area,
    area: mean === 0 ? 0 : area,
    userMerge: mean === 0,
  })
  const at: Record<string, readonly [number, number, number]> = {
    a: [0, 0, 0],
    b: [100, 0, 0],
    c: [1000, 0, 0],
    d: [1100, 0, 0],
    e: [50_000, 0, 0],
    f: [50_100, 0, 0],
  }

  it('chains nearby edges into one site and keeps far ones apart, strongest first', () => {
    const sites = groupSites(
      [edge('a', 'b', 0.2, 10), edge('c', 'd', 0.4, 30), edge('e', 'f', 0.6, 5)],
      (sv) => at[sv],
      2000,
    )
    expect(sites).toHaveLength(2)
    expect(sites[0]!.edges).toHaveLength(1)
    expect(sites[0]!.meanAffinity).toBeCloseTo(0.6)
    expect(sites[1]!.edges).toHaveLength(2)
    expect(sites[1]!.meanAffinity).toBeCloseTo((2 + 12) / 40)
    expect(sites[1]!.at[0]).toBeCloseTo((50 + 1050) / 2)
  })

  it('counts a proofreader merge apart from the measured mean, and sites with no position last', () => {
    const sites = groupSites(
      [edge('a', 'b', 0, 0), edge('a', 'b', 0.5, 10), edge('x', 'y', 0.9, 10)],
      (sv) => at[sv],
      2000,
    )
    expect(sites[0]!.userMerges).toBe(1)
    expect(sites[0]!.meanAffinity).toBeCloseTo(0.5)
    expect(sites.at(-1)!.unplaced).toBe(1)
  })
})

describe('chunkPaths', () => {
  const graph = new Map<string, string[]>([
    ['a', ['b']],
    ['b', ['a', 'c', 'x']],
    ['c', ['b', 'd']],
    ['d', ['c']],
    ['x', ['b']],
  ])

  it('walks the shortest path from each source to the nearest sink, in order', () => {
    expect(chunkPaths(graph, ['a'], ['d'])).toEqual([['a', 'b', 'c', 'd']])
  })

  it('keeps a source with no way to a sink as its own one-chunk path', () => {
    expect(chunkPaths(graph, ['lonely'], ['d'])).toEqual([['lonely']])
  })

  it('stops at the nearest of several sinks, one path per source', () => {
    expect(chunkPaths(graph, ['a', 'd'], ['x'])).toEqual([
      ['a', 'b', 'x'],
      ['d', 'c', 'b', 'x'],
    ])
  })
})

describe('pathCuts', () => {
  /*
   * A chain along five path positions, 0–4, one supervoxel each, strong inside (0.9) with one
   * weak link between positions 2 and 3. Every window that contains that link cuts there.
   */
  const chain = graphOf([
    ['p0', 'p1', 0.9, 100],
    ['p1', 'p2', 0.9, 100],
    ['p2', 'p3', 0.2, 100],
    ['p3', 'p4', 0.9, 100],
  ])
  const order = (sv: string) => Number(sv.slice(1))

  it('finds the weak link from every window around it, reported once', () => {
    const cuts = pathCuts(chain, order, 0)
    const weak = cuts.filter((c) => pairs(c.cut).join() === 'p2>p3')
    expect(weak).toHaveLength(1)
    expect(weak[0]!.meanAffinity).toBeCloseTo(0.2)
  })

  it('measures each side of a cut against what its supervoxels touch on their own side', () => {
    const [cut] = pathCuts(chain, order, 1).filter((c) => pairs(c.cut).join() === 'p2>p3')
    // Cut area 100; p2 touches p1 over 100 on its side, p3 touches p4 over 100 on its.
    expect(cut!.contact.source).toBeCloseTo(1)
    expect(cut!.contact.sink).toBeCloseTo(1)
  })

  it('reads nothing off the path', () => {
    expect(pathCuts(chain, () => undefined, 0)).toEqual([])
  })
})

describe('boxesAlong', () => {
  // A chunk of one voxel, so a box's corners read as cell ranges.
  const layout = {
    layerBits: 8,
    bitsPerAxis: new Map([[1, 10]]),
    baseMip: 0,
    baseResolutionNm: [1, 1, 1],
    chunkSize: [1, 1, 1],
    voxelOffset: [0, 0, 0],
  } as unknown as Parameters<typeof boxesAlong>[2]
  const holdsBoth = (
    boxes: ReturnType<typeof boxesAlong>['boxes'],
    a: readonly number[],
    b: readonly number[],
  ) =>
    boxes.some(([lo, hi]) =>
      [a, b].every((c) => c.every((v, axis) => v >= lo[axis]! && v <= hi[axis]!)),
    )

  it('puts every two face-neighbouring kept cells in one box, paths side by side included', () => {
    // Two parallel paths along x, one row apart in y: their cells touch across y, but no run
    // of either path holds the other's.
    const one = [0, 1, 2, 3, 4, 5].map((x) => [x, 0, 0] as const)
    const two = [0, 1, 2, 3, 4, 5].map((x) => [x, 1, 0] as const)
    const { boxes, cells } = boxesAlong([one, two], 0, layout)
    expect(cells.size).toBe(12)
    for (const key of cells) {
      const c = key.split(',').map(Number)
      for (let axis = 0; axis < 3; axis++) {
        const n = c.map((v, a) => (a === axis ? v + 1 : v))
        if (cells.has(n.join(','))) expect(holdsBoth(boxes, c, n)).toBe(true)
      }
    }
  })

  it('reads a straight path in runs, an inner cell once', () => {
    const path = [0, 1, 2, 3, 4].map((x) => [x, 0, 0] as const)
    const { boxes } = boxesAlong([path], 0, layout)
    // Runs of three cells sharing their end cell: 0–2 and 2–4.
    expect(boxes.map(([lo, hi]) => [lo[0], hi[0]])).toEqual([
      [0, 2],
      [2, 4],
    ])
  })
})
