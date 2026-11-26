/**
 * Find path's pure half (`findPath.ts`): which chunk each end is on, the route between them, how
 * each step along it is joined, and the layer that draws it. Nothing here reaches a server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseGrapheneSource } from '../../data/cave/graphene'
import type { SupervoxelGraph } from '../../data/cave/subgraph'
import { parseHex, sequentialColor } from '../../style/colors'
import { FANC_LAYOUT } from './__fixtures__/splitToy'
import type { PathStep } from './findPath'
import {
  chunkRoute,
  endChunk,
  FIND_PATH_LAYER,
  pathLayer,
  pathShader,
  pathSteps,
  readPathSteps,
  stepColor,
  strongestPath,
  thinnestOf,
  weakestStep,
} from './findPath'
import type { SplitNeuron } from './splitGalleryRun'

type Triple = readonly [number, number, number]

/**
 * Four chunks in a line along x, a micrometre apart, and a fifth branching off `c1` beside `c2`
 * — in `c2`'s grid cell (FANC's cells are 2.2 µm wide), half a micrometre off it in y.
 */
const AT: Record<string, Triple> = {
  c0: [500, 500, 20],
  c1: [1500, 500, 20],
  c2: [2500, 500, 20],
  c3: [3500, 500, 20],
  side: [2600, 1000, 20],
}
const NEURON: SplitNeuron = {
  root: '1',
  chunks: Object.keys(AT),
  links: [
    ['c0', 'c1'],
    ['c1', 'c2'],
    ['c2', 'c3'],
    ['c1', 'side'],
  ],
  positions: new Map(Object.entries(AT)),
  cells: new Map(
    Object.entries(AT).map(([chunk, at]) => [
      chunk,
      [
        Math.floor(at[0] / 2201.6),
        Math.floor(at[1] / 2201.6),
        Math.floor(at[2] / 5760),
      ] as Triple,
    ]),
  ),
  placed: 'l2cache',
}

/** Supervoxel `cN.k` is in chunk `cN`. */
const CHUNK_OF = new Map(
  NEURON.chunks.flatMap((chunk) => [0, 1].map((k) => [`${chunk}.${k}`, chunk] as const)),
)

function graph(
  edges: ReadonlyArray<readonly [string, string, number, number]>,
): SupervoxelGraph {
  return {
    a: edges.map((e) => e[0]),
    b: edges.map((e) => e[1]),
    affinity: Float64Array.from(edges.map((e) => e[2])),
    area: Float64Array.from(edges.map((e) => e[3])),
  }
}

describe('endChunk', () => {
  it('takes the nearest chunk in the point’s own grid cell, not the nearest overall', () => {
    // `side` (0.1 µm) and `c2` (0.52 µm) share the point's cell: the nearer of the two.
    expect(endChunk(NEURON, FANC_LAYOUT, [2600, 900, 20])).toBe('side')
    // `c2` is nearer (0.35 µm) but over the cell border at 2.2 µm; `c1` (0.65 µm) is in the cell.
    expect(endChunk(NEURON, FANC_LAYOUT, [2150, 500, 20])).toBe('c1')
  })

  it('falls back on the nearest anywhere where the point’s cell holds none of the neuron', () => {
    expect(endChunk(NEURON, FANC_LAYOUT, [9000, 500, 20])).toBe('c3')
  })
})

describe('chunkRoute', () => {
  it('is a shortest route of level-2 chunks, in order', () => {
    expect(chunkRoute(NEURON, 'c0', 'c3')).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(chunkRoute(NEURON, 'side', 'c0')).toEqual(['side', 'c1', 'c0'])
  })

  it('is the start alone where nothing joins the two', () => {
    const apart = { ...NEURON, links: [['c0', 'c1']] as const }
    expect(chunkRoute(apart, 'c0', 'c3')).toEqual(['c0'])
  })
})

describe('pathSteps', () => {
  const route = ['c0', 'c1', 'c2', 'c3']

  it('takes the strongest supervoxel path and gives each step its weakest join', () => {
    const steps = pathSteps(
      route,
      CHUNK_OF,
      graph([
        // c0 → c1: the strong way (mean 0.8) beats the weak one (0.1) — the weak one is never taken.
        ['c0.0', 'c1.0', 8, 10],
        ['c0.1', 'c1.1', 1, 10],
        // Inside c1, the two supervoxels joined at mean 0.3: on the way, so the step reaching c1.
        ['c1.0', 'c1.1', 3, 10],
        // c1 → c2 from c1.1 only: one supervoxel's halves.
        ['c1.1', 'c2.0', Infinity, 9],
        // c2 → c3: a proofreader's merge, the only way.
        ['c2.0', 'c3.0', 1e-38, 0],
        // Off the route: never part of the path.
        ['c1.0', 'side.0', 0.99, 1],
      ]),
    )
    expect(steps.map((s) => [s.from, s.to, s.kind])).toEqual([
      ['c0', 'c1', 'contact'],
      ['c1', 'c2', 'piece'],
      ['c2', 'c3', 'userMerge'],
    ])
    // The weakest join on the first stretch is inside c1 (0.3), not the strong contact (0.8).
    expect(steps[0]!.affinity).toBeCloseTo(0.3)
    expect(steps[0]!.area).toBe(10)
    expect(steps[1]!.affinity).toBeNaN()
  })

  /**
   * Past the weakest join every path scores the same overall; each step must still show the
   * strongest way along its own stretch (code review, 2026-11-24).
   */
  it('gives a step after the weakest the strongest join on its own stretch', () => {
    const steps = pathSteps(
      ['c0', 'c1', 'c2'],
      CHUNK_OF,
      graph([
        // c0 → c1: one way only, weak (0.1): the route's weakest.
        ['c0.0', 'c1.0', 1, 10],
        // c1 → c2: a contact (0.3), and one supervoxel through — the second must win.
        ['c1.0', 'c2.0', 3, 10],
        ['c1.0', 'c2.1', Infinity, 9],
      ]),
    )
    expect(steps.map((s) => s.kind)).toEqual(['contact', 'piece'])
    expect(steps[0]!.affinity).toBeCloseTo(0.1)
  })

  it('prefers a measured contact to a proofreader’s merge beside it', () => {
    const [step] = pathSteps(
      ['c0', 'c1'],
      CHUNK_OF,
      graph([
        ['c0.0', 'c1.0', 1e-38, 0],
        ['c0.0', 'c1.1', 0.6, 2],
      ]),
    )
    expect(step!.kind).toBe('contact')
    expect(step!.affinity).toBeCloseTo(0.3)
  })

  it('gives a join across a bend to every step it passes over', () => {
    const steps = pathSteps(route, CHUNK_OF, graph([['c0.0', 'c3.0', 2, 10]]))
    expect(steps.map((s) => s.affinity)).toEqual([0.2, 0.2, 0.2])
  })

  it('says every step is unread where nothing joins the ends', () => {
    const steps = pathSteps(route, CHUNK_OF, graph([['c0.0', 'c1.0', 0.9, 5]]))
    expect(steps.map((s) => s.kind)).toEqual(['unread', 'unread', 'unread'])
  })
})

describe('strongestPath', () => {
  it('maximises the weakest edge, not the sum or the number of steps', () => {
    // a–d directly at 0.2; a–b–c–d at 0.5, 0.9, 0.6: the long way's weakest (0.5) is stronger.
    const g = graph([
      ['a', 'd', 2, 10],
      ['a', 'b', 5, 10],
      ['b', 'c', 9, 10],
      ['c', 'd', 6, 10],
    ])
    const path = strongestPath(g, new Set(['a', 'b', 'c', 'd']), ['a'], new Set(['d']))
    expect(path).toEqual([1, 2, 3])
  })

  it('keeps to the allowed supervoxels', () => {
    const g = graph([
      ['a', 'x', 9, 10],
      ['x', 'd', 9, 10],
      ['a', 'd', 1, 10],
    ])
    expect(strongestPath(g, new Set(['a', 'd']), ['a'], new Set(['d']))).toEqual([2])
  })
})

/** A line's properties by id, whatever order the layer lists them in. */
function propsOf(
  layer: Readonly<Record<string, unknown>>,
  line: Record<string, unknown>,
): Record<string, number> {
  const ids = (layer['annotationProperties'] as Array<{ id: string }>).map((p) => p.id)
  const values = line['props'] as number[]
  return Object.fromEntries(ids.map((id, i) => [id, values[i]!]))
}

const glsl = (hex: string) =>
  `vec3(${parseHex(hex)
    .map((v) => (v / 255).toFixed(4))
    .join(', ')})`

describe('drawing the route', () => {
  const contact = (affinity: number, from = 'c0', to = 'c1'): PathStep => ({
    from,
    to,
    kind: 'contact',
    affinity,
    area: 10,
  })

  it('names the weakest contact, passing over steps that are not contacts', () => {
    const steps: PathStep[] = [
      contact(0.8),
      { from: 'c1', to: 'c2', kind: 'userMerge', affinity: Number.NaN, area: 0 },
      contact(0.2, 'c2', 'c3'),
    ]
    expect(weakestStep(steps)).toBe(steps[2])
    expect(weakestStep([steps[1]!])).toBeUndefined()
  })

  it('colours a weaker step differently from a stronger one, and every kind apart', () => {
    const colours = [
      stepColor(contact(0.1)),
      stepColor(contact(0.9)),
      stepColor({ ...contact(0), kind: 'userMerge' }),
      stepColor({ ...contact(0), kind: 'unread' }),
    ]
    expect(new Set(colours).size).toBe(4)
  })

  it('draws the start alone, both points while the route is read, then a line per step', () => {
    const start = pathLayer([0, 0, 0])
    expect(start['name']).toBe(FIND_PATH_LAYER)
    expect(start['annotations']).toEqual([
      expect.objectContaining({ type: 'point', id: 'start' }),
    ])
    const reading = pathLayer([0, 0, 0], [9, 9, 9])
    expect((reading['annotations'] as unknown[]).map((a) => (a as { id: string }).id)).toEqual([
      'start',
      'end',
    ])

    const steps: PathStep[] = [
      contact(0.5, 'c0', 'c1'),
      { from: 'c1', to: 'c2', kind: 'userMerge', affinity: Number.NaN, area: 0 },
    ]
    const layer = pathLayer([400, 500, 20], [2400, 500, 20], {
      steps,
      positions: NEURON.positions,
    })
    const lines = (layer['annotations'] as Array<Record<string, unknown>>).filter(
      (a) => a['type'] === 'line',
    )
    expect(lines.map((l) => [l['pointA'], l['pointB']])).toEqual([
      [
        [400, 500, 20],
        [1500, 500, 20],
      ],
      [
        [1500, 500, 20],
        [2400, 500, 20],
      ],
    ])
    expect(lines[0]!['description']).toMatch(/step 1 of 2: mean affinity 0\.50/)
  })

  /** What neuroglancer shows on hover: the properties, in `annotationProperties`' order. */
  it('gives each line its step, its kind by name and its affinity as properties — no colour', () => {
    const steps: PathStep[] = [
      contact(0.5, 'c0', 'c1'),
      { from: 'c1', to: 'c2', kind: 'userMerge', affinity: Number.NaN, area: 0 },
    ]
    const layer = pathLayer([400, 500, 20], [2400, 500, 20], {
      steps,
      positions: NEURON.positions,
    })
    const specs = layer['annotationProperties'] as Array<Record<string, unknown>>
    // The measure the colour shows first: neuroglancer's layer bar shows only the first on hover.
    expect(specs.map((p) => p['id'])).toEqual(['affinity', 'radius', 'kind', 'step'])
    const kind = specs.find((p) => p['id'] === 'kind')!
    const label = (value: number) =>
      (kind['enum_labels'] as string[])[(kind['enum_values'] as number[]).indexOf(value)]
    const lines = (layer['annotations'] as Array<Record<string, unknown>>).filter(
      (a) => a['type'] === 'line',
    )
    const [first, second] = lines.map((l) => propsOf(layer, l))
    expect(first!['step']).toBe(1)
    expect(label(first!['kind']!)).toBe('contact')
    expect(first!['affinity']).toBe(0.5)
    expect(second!['step']).toBe(2)
    expect(label(second!['kind']!)).toBe('proofreader merge')
    // JSON has no NaN: a step with no contact says -1, as the property's description does.
    expect(second!['affinity']).toBe(-1)
    expect(String(specs[0]!['description'])).toMatch(/-1 where the step has none/)
    // No radii given: every step's radius is not known.
    expect([first!['radius'], second!['radius']]).toEqual([-1, -1])
  })

  /**
   * The skeleton's measure, the route's only thickness: a chunk's `max_dt_nm` is one number for
   * ~8 µm, and read a false merge's thin neck as thick (user, 2026-11-24).
   */
  it('draws each skeleton piece by its nodes’ radius where there is one', () => {
    const steps: PathStep[] = [contact(0.5, 'c0', 'c1'), contact(0.4, 'c1', 'c2')]
    const along = {
      points: [
        [0, 0, 0],
        [250, 0, 0],
        [500, 0, 0],
        [750, 0, 0],
      ] as Triple[],
      steps: [0, 1, 1],
      vertices: [[1], [2], [3]],
    }
    const route = {
      steps,
      positions: NEURON.positions,
      // A surface route too: the skeleton's is drawn in its place.
      surface: {
        points: [[0, 0, 0] as Triple, [750, 9, 0] as Triple],
        steps: [1],
        vertices: [[0]],
      },
      skeleton: { along, radii: [150, 35, undefined] },
      colour: 'thickness' as const,
    }
    const layer = pathLayer([0, 0, 0], [750, 0, 0], route)
    const lines = (layer['annotations'] as Array<Record<string, unknown>>).filter(
      (a) => a['type'] === 'line',
    )
    // The last piece has no measure, and stays unmeasured.
    expect(lines.map((l) => propsOf(layer, l)['radius'])).toEqual([150, 35, -1])
    expect(lines.map((l) => l['pointB'])).toEqual([
      [250, 0, 0],
      [500, 0, 0],
      [750, 0, 0],
    ])
    expect(thinnestOf(route)).toEqual({ step: 1, radius: 35 })
    expect(thinnestOf({ steps, positions: NEURON.positions })).toBeUndefined()
    // Colouring by thickness, the radius is what hover shows first (the layer bar's one value).
    const specs = layer['annotationProperties'] as Array<Record<string, unknown>>
    expect(specs[0]!['id']).toBe('radius')
    expect(String(lines[1]!['description'])).toMatch(/radius 35 nm/)
    // The ramp runs over the route's own range, thinnest brightest, on the blue ramp.
    const shader = String(layer['shader'])
    expect(shader).toMatch(/ramp\(1\.0 - \(prop_radius\(\) - 35\.0\) \/ 115\.0\)/)
    expect(shader).toContain(glsl(sequentialColor(1, 'dark', 'blue')))
    expect(shader).not.toContain('prop_affinity')
  })

  it('colours in the shader from the palette: the ramp’s two ends and every other kind', () => {
    const shader = pathShader()
    for (const hex of [
      stepColor(contact(1)),
      stepColor(contact(0)),
      stepColor({ ...contact(0), kind: 'piece' }),
      stepColor({ ...contact(0), kind: 'userMerge' }),
      stepColor({ ...contact(0), kind: 'unread' }),
    ]) {
      expect(shader).toContain(glsl(hex))
    }
    expect(shader).toMatch(/prop_kind\(\)/)
    expect(shader).toMatch(/ramp\(1\.0 - prop_affinity\(\)\)/)
  })
})

describe('readPathSteps, a box refused', () => {
  /** Four chunks in a row, one supervoxel each, in FANC's first four cells along x. */
  const CHUNKS = ['10', '11', '12', '13']
  const NEURON4: SplitNeuron = {
    root: '1',
    chunks: CHUNKS,
    links: [],
    positions: new Map(CHUNKS.map((c, i) => [c, [i * 2201.6 + 1000, 1000, 1000] as Triple])),
    cells: new Map(CHUNKS.map((c, i) => [c, [i, 0, 0] as Triple])),
    placed: 'l2cache',
  }
  const GRAPHENE = parseGrapheneSource(
    'graphene://https://cave.example.org/segmentation/table/t',
  )!

  afterEach(() => vi.unstubAllGlobals())

  it('marks the steps no answered box holds unread, rather than a weaker way round', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      const answer = (status: number, body: unknown) =>
        Promise.resolve({
          ok: status === 200,
          status,
          text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        } as Response)
      if (url.includes('/leaves_many')) {
        return answer(200, Object.fromEntries(CHUNKS.map((c, i) => [c, [String(1000 + i)]])))
      }
      // The run box over cells 0–2 answers; the one over cells 2–3 is the server's 500.
      if (url.includes('bounds=0-')) {
        return answer(200, {
          // And a weak way round to the last chunk, as an overlapping box could hold: without the
          // refused box's edges, the path would take it and name it the route's weakest step.
          nodes: [
            ['1000', '1001'],
            ['1001', '1002'],
            ['1002', '1003'],
          ],
          affinities: [5, 4, 0.5],
          areas: [10, 10, 10],
        })
      }
      return answer(500, 'index 0 is out of bounds for axis 0 with size 0')
    })
    const steps = await readPathSteps(GRAPHENE, FANC_LAYOUT, '1', NEURON4, CHUNKS, {
      deployment: 'https://global.example.org',
      token: 'test-token',
    })
    expect(steps.map((s) => s.kind)).toEqual(['contact', 'contact', 'unread'])
  })

  it('says a refused sign-in, rather than drawing every step unread', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('no'),
      } as Response),
    )
    await expect(
      readPathSteps(GRAPHENE, FANC_LAYOUT, '1', NEURON4, CHUNKS, {
        deployment: 'https://global.example.org',
        token: 'test-token',
      }),
    ).rejects.toThrow()
  })
})
