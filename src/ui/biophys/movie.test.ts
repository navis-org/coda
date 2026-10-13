/**
 * Playback's rules: one diverging scale for the whole run centred on rest, every compartment's
 * colour at a frame, and the traces table the line chart draws.
 */

import { describe, expect, it } from 'vitest'

import { getColumn } from '../../core/values'
import type { Movie } from '../../packs/biophys/simulateJob'
import { extentOf } from '../viewers/scatterPlot'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import { build, exc, input } from '../../packs/biophys/testFixtures'
import {
  firedSites,
  baselineOf,
  frameColors,
  inputArrivals,
  largestRise,
  movieStats,
  sitePositions,
  movieRamp,
  risesAboveRest,
  nextTraceName,
  placeTraces,
  timeFormat,
  traceTable,
} from './movie'

/** Three compartments over three frames: at rest, the first depolarising, then the last dipping. */
const MOVIE: Movie = {
  frames: Float32Array.of(-65, -65, -65, -40, -60, -65, -55, -60, -70),
  count: 3,
  length: 3,
  frameMs: 0.5,
  coarse: false,
}

describe('movieRamp', () => {
  it('is one diverging scale over every frame, centred on rest', () => {
    const ramp = movieRamp(
      extentOf(MOVIE.frames)!,
      -65,
      largestRise(MOVIE),
      'dark',
      'diverging',
    )!
    expect(ramp.legend.center).toBe(-65)
    // Rest is the middle; either side of it reads as a different hue.
    expect(ramp.colorOf(-40)).not.toBe(ramp.colorOf(-65))
    expect(ramp.colorOf(-70)).not.toBe(ramp.colorOf(-65))
    expect(ramp.colorOf(-40)).not.toBe(ramp.colorOf(-70))
  })
})

describe('movieRamp, from rest', () => {
  it('spends the whole ramp on each compartment’s rise above its own rest', () => {
    expect(largestRise(MOVIE)).toBe(25)
    // One pass for the range and the rise, kept per movie.
    expect(movieStats(MOVIE)).toEqual({ extent: extentOf(MOVIE.frames), rise: 25 })
    expect(movieStats(MOVIE)).toBe(movieStats(MOVIE))
    const ramp = movieRamp(
      extentOf(MOVIE.frames)!,
      -65,
      largestRise(MOVIE),
      'dark',
      'sequential',
    )!
    expect(ramp.legend.domain).toEqual([0, 25])
    expect(ramp.legend.center).toBeUndefined()
    // A fall below rest takes the lowest colour, as rest does.
    expect(ramp.colorOf(-5)).toBe(ramp.colorOf(0))
    expect(ramp.colorOf(5)).not.toBe(ramp.colorOf(0))
  })

  it('measures each compartment from its own rest, so a non-uniform rest is not a response', () => {
    // An active model settled 0.14 mV higher in the dendrite (compartment 1), then only a dip.
    const settled: Movie = {
      frames: Float32Array.of(-69.11, -68.97, -69.11, -68.97, -75, -78.5),
      count: 2,
      length: 3,
      frameMs: 0.5,
      coarse: false,
    }
    expect(risesAboveRest(largestRise(settled))).toBe(false)
    const ramp = movieRamp(
      extentOf(settled.frames)!,
      -69.11,
      largestRise(settled),
      'dark',
      'sequential',
    )!
    // Held at rest: the resting dendrite and the dipping cell both at the lowest colour.
    const colours = frameColors(settled, 0, ramp.colorOf, baselineOf(settled, 'sequential'))
    expect(colours[1]).toBe(colours[0])
    expect(frameColors(settled, 2, ramp.colorOf, baselineOf(settled, 'sequential'))[1]).toBe(
      colours[0],
    )
  })
})

describe('frameColors', () => {
  it("is every compartment's colour at the frame", () => {
    const ramp = movieRamp(extentOf(MOVIE.frames)!, -65, 0, 'dark', 'diverging')!
    expect(frameColors(MOVIE, 1, ramp.colorOf)).toEqual([
      ramp.colorOf(-40),
      ramp.colorOf(-60),
      ramp.colorOf(-65),
    ])
  })
})

describe('traceTable', () => {
  it('is time, then one column per trace, a row per frame', () => {
    const table = traceTable(MOVIE, [
      { label: 'soma', compartment: 0 },
      { label: 'branch 1', compartment: 2 },
    ])
    expect(table.schema.columns.map((c) => c.name)).toEqual(['t', 'soma', 'branch 1'])
    expect(getColumn(table, 't')).toEqual([0, 0.5, 1])
    expect(getColumn(table, 'soma')).toEqual([-65, -40, -55])
    expect(getColumn(table, 'branch 1')).toEqual([-65, -65, -70])
  })
})

describe('timeFormat', () => {
  it('writes every frame with the decimals its interval needs', () => {
    const at = (frameMs: number) => timeFormat({ ...MOVIE, frameMs })
    expect([95.25, 96].map(at(0.25))).toEqual(['95.25', '96.00'])
    expect([0.2, 1].map(at(0.2))).toEqual(['0.2', '1.0'])
    expect(at(1)(40)).toBe('40')
  })
})

describe('the stored traces', () => {
  const model = build(
    {},
    exc(
      input([
        ['A', '7', 'pre', 45_000, 0],
        ['A', '7', 'pre', 45_000, 0],
        ['B', '7', 'pre', 30_000, 15_000],
      ]),
    ),
  )
  const arbor = splitArbor(model.skeleton)

  it('land on this model by position, and anything that cannot is counted, not placed', () => {
    const stored: ManualPoint[] = [
      { neuron: '7', at: [55_000, 0, 0], name: 'branch 2' },
      { neuron: '7', at: [30_000, 18_000, 0] },
      // Another neuron's, far off the cable, and at the soma.
      { neuron: '8', at: [55_000, 0, 0] },
      { neuron: '7', at: [55_000, 90_000, 0] },
      { neuron: '7', at: [0, 0, 0] },
    ]
    const { placed, off } = placeTraces(model, arbor, stored)
    // A stored name is the label; an unnamed one is numbered by its place, and a clash is told apart.
    expect(placed.map((trace) => trace.label)).toEqual(['branch 2', 'branch 2 (2)'])
    expect(placed).toHaveLength(2)
    expect(placed[0]!.point).toBe(stored[0])
    expect(placed[0]!.compartment).not.toBe(placed[1]!.compartment)
    expect(off).toBe(3)
  })

  it('name the next trace one past the highest, so a removed name is never reused', () => {
    expect(nextTraceName([])).toBe('branch 1')
    expect(
      nextTraceName([
        { neuron: '7', at: [0, 0, 0], name: 'branch 3' },
        { neuron: '7', at: [0, 0, 0], name: 'tip' },
      ]),
    ).toBe('branch 4')
  })
})

describe('the inputs', () => {
  const model = build(
    {},
    exc(
      input([
        ['A', '7', 'pre', 45_000, 0],
        ['A', '7', 'pre', 45_000, 0],
        ['B', '7', 'pre', 30_000, 15_000],
      ]),
    ),
  )

  it('are the fired partners’ synapses, where they sit', () => {
    const a = model.partners.id.indexOf('A')
    const sites = firedSites(model, [[a, [10]]])
    expect(sites.child).toHaveLength(2)
    expect(Array.from(sites.child)).toEqual(
      Array.from(model.synapses.partner.keys())
        .filter((s) => model.synapses.partner[s] === a)
        .map((s) => model.sites.node[s]),
    )
  })

  it('sit on the cable where their synapses are, for the 3D view', () => {
    const b = model.partners.id.indexOf('B')
    const at = sitePositions(model.skeleton.positions, firedSites(model, [[b, [10]]]))
    expect(Array.from(at)).toEqual([
      expect.closeTo(30_000, 0),
      expect.closeTo(15_000, 0),
      expect.closeTo(0, 0),
    ])
  })

  it('arrive at each spike’s time plus the synaptic delay, each once', () => {
    const delay = model.synapseTypes[0]!.delay
    expect(
      inputArrivals(model, [
        [0, [20, 10]],
        [1, [10]],
      ]),
    ).toEqual([10 + delay, 20 + delay])
  })
})
