/**
 * Transform Neurons: the star's one edge, and what it refuses.
 *
 * The arithmetic is fastcore's and the landmark files are checked against navis by
 * `scripts/check-mirror.py` and `scripts/probe-transform.mjs`. What is left for a unit test is
 * everything that decides *whether the spline runs at all* — which space it thinks it is in,
 * what happens at the hub, and what it does with a nerve cord. Those are the branches that
 * produce a plausible neuron in the wrong place rather than an error.
 *
 * The spline is mocked here, on `nblast.test.ts`' precedent: Pyodide under vitest would mean a
 * 13 MB dependency, a network fetch inside the suite, and a boot per test file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { isSkeletonsValue } from '../../core/values'
import type { TransformValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { COMMON_SPACE, allSpaces, spaceById } from '../../data/transforms/spaces'
import { loadLandmarks, resetLandmarks } from '../../data/transforms/landmarks'
import '../index'

vi.mock('../../pyodide/warp', () => ({ warpPoints: vi.fn() }))
const { warpPoints } = await import('../../pyodide/warp')
const mockedWarp = vi.mocked(warpPoints)

const source: DataSource = new MockSource({ latencyMs: 0 })

function landmarkCsv(rows: number): string {
  const lines = ['x,y,z,jrc2018u_x,jrc2018u_y,jrc2018u_z']
  for (let i = 0; i < rows; i++) lines.push(`${i},${i},${i},${i / 1000},${i / 1000},${i / 1000}`)
  return lines.join('\n')
}

/**
 * A stub file of the *right length* for whichever set was asked for.
 *
 * `parseLandmarks` refuses a file whose row count disagrees with the manifest — the check that
 * catches a stale CSV against a regenerated manifest — and it is as true of a stub as of a real
 * file. A fixed length happened to work while only one set was ever loaded and failed the moment
 * a second leg asked for another, which is the check doing its job.
 */
function landmarksFor(url: string): string {
  const file = url.slice(url.lastIndexOf('/') + 1)
  const spec = allSpaces().find((space) => space.toCommon?.file === file)?.toCommon
  if (!spec) throw new Error(`no manifest entry for ${file}`)
  return landmarkCsv(spec.landmarks)
}

beforeEach(() => {
  resetLandmarks()
  vi.stubGlobal('fetch', async (url: string) => new Response(landmarksFor(url), { status: 200 }))
  mockedWarp.mockImplementation(async (_pairs, points) => ({
    positions: points.slice(),
    fitMs: 0,
    applyMs: 0,
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  mockedWarp.mockReset()
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC4) → skeletons → xform. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('xform-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('geo', 'neuron.skeletons', { limit: 100 }))
  g = addNode(g, node('xf', 'neuron.xform', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'geo', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'geo', targetHandle: 'neurons' })
  g = addEdge(g, { source: 'geo', sourceHandle: 'skeletons', target: 'xf', targetHandle: 'in' })
  return g
}

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

async function run(graph: CodaGraph): Promise<Scheduler> {
  const scheduler = makeScheduler()
  await scheduler.run(graph, { mode: 'full' })
  return scheduler
}

/**
 * Run a graph whose Landmark Transform stands in for a real one.
 *
 * The node itself reads six columns off a table, and building that table here would be testing
 * `landmarkTransform.test.ts`' subject rather than this one. So its params are set to produce
 * the fixture directly: the graph is real, the wire is real, and only the landmarks are stubbed.
 */
async function runSeeded(graph: CodaGraph, transform: TransformValue): Promise<Scheduler> {
  const scheduler = makeScheduler()
  const original = requireNodeDef('core.landmarkTransform').evaluate
  requireNodeDef('core.landmarkTransform').evaluate = () => ({ transform })
  try {
    await scheduler.run(graph, { mode: 'full' })
  } finally {
    requireNodeDef('core.landmarkTransform').evaluate = original
  }
  return scheduler
}

/** Edit-time issues for the transform node, which is where the nerve-cord caveat lands. */
function issuesFor(params: Record<string, unknown>): string[] {
  return (inferGraph(pipeline(params)).nodes['xf']?.issues ?? []).map((issue) => issue.message)
}

describe('neuron.xform', () => {
  it('refuses geometry that does not say where it is', async () => {
    /*
     * The mock connectome is synthetic, so it is bound to no template space at all — which
     * makes it the right fixture rather than an awkward one. Everything here starts in the
     * state a Custom dataset node produces, and the override is the only way through.
     */
    const error = (await run(pipeline())).info('xf').error ?? ''
    expect(error).toMatch(/do not say which template space/)
    expect(mockedWarp).not.toHaveBeenCalled()
  })

  it('lands in the common space, and says so on the value', async () => {
    const scheduler = await run(pipeline({ space: 'MANC' }))
    expect(scheduler.info('xf').error).toBeUndefined()
    const value = scheduler.output('xf', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    // The field earning its keep: from here on everything downstream can tell that these
    // coordinates have moved, which is what a second Transform and NBLAST both read.
    expect(value.space).toBe(COMMON_SPACE.id)
  })

  it('keeps nanometres, though the template is published in micrometres', async () => {
    // `landmarks.ts` scales the hub's µm to nm on load — exact for a 3-D spline, whose kernel
    // is homogeneous — so no value in Coda is ever in anything but nm and NBLAST's units check
    // keeps working downstream of this node.
    const value = (await run(pipeline({ space: 'MANC' }))).output('xf', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.units).toBe('nm')
  })

  it('adds no column, unlike its sibling', async () => {
    // A bridge moves coordinates and touches nothing else. Mirror adds `mirrored` because two
    // copies of one neuron need telling apart; there are no two copies here.
    const scheduler = await run(pipeline({ space: 'MANC' }))
    const before = scheduler.output('geo', 'skeletons')
    const after = scheduler.output('xf', 'out')
    if (!isSkeletonsValue(before) || !isSkeletonsValue(after)) throw new Error('not skeletons')
    expect(after.attributes.schema.columns.map((c) => c.name)).toEqual(
      before.attributes.schema.columns.map((c) => c.name),
    )
  })

  it('refuses a second pass rather than quietly doing nothing', async () => {
    /*
     * A no-op reporting success is how a chain comes to hold two of these, one working and one
     * idle, with nothing on either card saying which. The value already carries the hub's id
     * after the first, so the second can tell.
     */
    let chained = pipeline({ space: 'MANC' })
    chained = addNode(chained, node('xf2', 'neuron.xform'))
    chained = addEdge(chained, {
      source: 'xf',
      sourceHandle: 'out',
      target: 'xf2',
      targetHandle: 'in',
    })

    const error = (await run(chained)).info('xf2').error ?? ''
    expect(error).toMatch(/already in .*JRC2018U/)
  })

  it('warns that a nerve cord is placed rather than registered', () => {
    /*
     * A warning, not a refusal: the answer is usable and is the only one available — JRC2018U
     * is a brain template and has no nerve cord in it. What the reader must not do is take a
     * VNC coordinate in this frame as meaning something anatomical.
     */
    expect(issuesFor({ space: 'MANC' }).join(' ')).toMatch(/placed beside the brain/)
  })

  it('says something different for a dataset that is both brain and nerve cord', () => {
    // MaleCNS reaches the frame by two routes at once, so it has a seam the wholly-VNC case
    // does not. Two cases, two sentences — one message for both would be vague about each.
    expect(issuesFor({ space: 'JRCFIB2022M' }).join(' ')).toMatch(/around the neck/)
  })

  it('says nothing at all about a brain-only dataset', () => {
    expect(issuesFor({ space: 'FLYWIRE' })).toEqual([])
  })
})

describe('neuron.xform — out through the hub and back', () => {
  it('runs two splines, the second one fitted backwards', async () => {
    /*
     * The whole of "arbitrary space to space": there is still no path finding, because two
     * lookups is the entire route. The second leg is the *target's* own registration inverted
     * — a refit rather than an inversion, a spline having no closed form for one — which is
     * why its landmark id has to differ or the coefficient cache would hand back the forward
     * fit for a backward request.
     */
    const scheduler = await run(pipeline({ space: 'MANC', target: 'FLYWIRE' }))
    expect(scheduler.info('xf').error).toBeUndefined()
    expect(mockedWarp).toHaveBeenCalledTimes(2)

    const [outbound, inbound] = mockedWarp.mock.calls.map((call) => call[0])
    // The outbound leg is the source space's own registration, forward.
    expect(outbound!.id).toBe('MANC_JRC2018U.csv')
    // The return leg is the *target's* registration — a different file — read backwards.
    expect(inbound!.id).toBe('FLYWIRE_JRC2018U.csv#inverse')

    // Inverted means the two columns swapped, not a second file or a second parse.
    const forward = await loadLandmarks(spaceById('FLYWIRE')!.toCommon!)
    expect(inbound!.source).toEqual(forward.target)
    expect(inbound!.target).toEqual(forward.source)
  })

  it('lands in the space that was asked for', async () => {
    const value = (await run(pipeline({ space: 'MANC', target: 'FLYWIRE' }))).output('xf', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.space).toBe('FLYWIRE')
  })

  it('feeds each leg what the one before it produced', async () => {
    // Two hops chained rather than two hops from the same input, which would silently discard
    // the outbound leg and land the neurons in the wrong place while reporting success.
    mockedWarp.mockImplementation(async (_pairs, points) => ({
      positions: points.map((v) => v + 1),
      fitMs: 0,
      applyMs: 0,
    }))
    const scheduler = await run(pipeline({ space: 'MANC', target: 'FLYWIRE' }))
    const source = scheduler.output('geo', 'skeletons')
    const value = scheduler.output('xf', 'out')
    if (!isSkeletonsValue(source) || !isSkeletonsValue(value)) throw new Error('not skeletons')
    // +1 per leg, so +2 after both. +1 would mean one leg's output was thrown away.
    expect(value.items[0]!.positions[0]).toBeCloseTo(source.items[0]!.positions[0]! + 2, 4)
  })

  it('says nothing at all about picking a dataset space as the target', () => {
    /*
     * There was a warning here and it was wrong. It said a second hop costs accuracy; measured,
     * two hops cost about what the two one-hops cost added, and on one pair slightly less —
     * two splines' errors cancel as readily as they add. What actually degrades an answer is a
     * target space that does not cover the neuron, which is a fact about the target rather
     * than about the route, and is not something a warning on this node can tell in advance.
     */
    // Brain to brain, so nothing about territory either. MANC → FlyWire is a nerve cord into a
    // brain-only volume and does have something to say — see below.
    expect(issuesFor({ space: 'FLYWIRE', target: 'FAFB14' })).toEqual([])
  })

  it('says so when the two spaces describe different parts of the animal', () => {
    /*
     * The one thing about a dataset-to-dataset target that *is* knowable in advance, and the
     * warning worth having in place of the hop-count one that was wrong. A nerve cord has no
     * coordinate anywhere in a brain-only volume — no spline produces one, and the result is
     * extrapolation throughout rather than a transform of anything.
     */
    const issues = issuesFor({ space: 'MANC', target: 'FLYWIRE' }).join(' ')
    expect(issues).toMatch(/no shared territory/)
    expect(issues).toMatch(/vnc/)
    expect(issues).toMatch(/brain/)
  })

  it('does not blame the hub for a nerve cord passing through it', () => {
    // MANC → FlyWire routes through JRC2018U, where a VNC is *placed* rather than registered —
    // but the return leg undoes exactly that placement, so it is not what is wrong here, and a
    // message naming a brain template the user did not pick would send them looking at it.
    expect(issuesFor({ space: 'MANC', target: 'FLYWIRE' }).join(' ')).not.toMatch(/placed beside/)
  })

  it('refuses a target that is also the source', () => {
    expect(issuesFor({ space: 'MANC', target: 'MANC' }).join(' ')).toMatch(/nothing to do/)
  })
})

describe('neuron.xform — a registration Coda does not ship', () => {
  const custom = {
    kind: 'transform' as const,
    id: 'custom:test',
    source: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    target: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    count: 4,
  }

  function withCustom(params: Record<string, unknown>, transform = custom): CodaGraph {
    let g = pipeline(params)
    g = addNode(g, node('lm', 'core.landmarkTransform'))
    // Any table will do: `runSeeded` replaces what the node makes of it. What has to be real is
    // the *wiring*, since an unconnected input is refused by the scheduler before evaluate runs.
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'lm', targetHandle: 'in' })
    g = addEdge(g, { source: 'lm', sourceHandle: 'transform', target: 'xf', targetHandle: 'transform' })
    seeded = transform
    return g
  }
  let seeded: typeof custom | undefined

  it('uses the wired transform and asks the registry nothing', async () => {
    /*
     * The whole point of the port: a volume Coda ships no binding for at all. Nothing here may
     * consult the space the geometry claims — second-guessing a supplied transform would refuse
     * exactly the case it exists for.
     */
    const graph = withCustom({})
    const scheduler = await runSeeded(graph, seeded!)
    expect(scheduler.info('xf').error).toBeUndefined()
    expect(mockedWarp).toHaveBeenCalledTimes(1)
    expect(mockedWarp.mock.calls[0]![0].id).toBe('custom:test')
    // No landmark file was fetched: the registry was never consulted.
    expect(mockedWarp.mock.calls[0]![0].count).toBe(4)
  })

  it('clears the space when the transform does not say where it lands', async () => {
    /*
     * `withPositions` reads an absent space as "leave it alone", which is right for a mirror and
     * would be a lie here — these coordinates are no longer in the space they started in, and
     * keeping the id would have a later Mirror look up landmarks for a space they have left.
     */
    const scheduler = await runSeeded(withCustom({}), seeded!)
    const value = scheduler.output('xf', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.space).toBeUndefined()
  })

  it('stamps the space the transform names, where it names one', async () => {
    const scheduler = await runSeeded(withCustom({}), { ...custom, targetSpace: 'FLYWIRE' })
    const value = scheduler.output('xf', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.space).toBe('FLYWIRE')
  })

  it('says on the card that Target and Space are being ignored', () => {
    // Two controls that stop working when a wire is plugged in is exactly the thing somebody
    // needs told, rather than left to discover.
    const graph = withCustom({ target: 'FLYWIRE', space: 'MANC' })
    const issues = (inferGraph(graph).nodes['xf']?.issues ?? []).map((i) => i.message)
    expect(issues.join(' ')).toMatch(/Target and Space are ignored/)
  })
})
