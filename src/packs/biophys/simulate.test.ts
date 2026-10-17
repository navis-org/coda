import { describe, expect, it } from 'vitest'
import { frameCount } from '../../biophys/solver'
import { column, tableSchema } from '../../core/types'
import { defaultParams } from '../../core/node'
import { getColumn, makeTable } from '../../core/values'
import { simulateNode } from './simulate'
import { writeManualPoint } from '../../nodes/lib/skeletonPoints'
import { PEAK_VOLTAGE } from './nodeValues'
import { HH, OPTIONS, exc, build, cloud, input } from './testFixtures'
import { partnerTrain } from './stimulus'
import {
  MOVIE_BUDGET_BYTES,
  jobSteps,
  movieBasis,
  movieFrameSteps,
  runMovieJob,
  runSimulateJob,
} from './simulateJob'
import type { SimulateJob } from './simulateJob'
import { solverPart } from './solverInputs'
import {
  ARBOUR_SCHEMA,
  INPUT_SPIKES_SCHEMA,
  OUTPUT_SPIKES_SCHEMA,
  arbourValue,
  firingIndices,
  firingPartners,
  clampEnvelope,
  describeClamp,
  inferredTracesSchema,
  inputSpikesTable,
  keepRest,
  partnersSchema,
  partnersTable,
  planRun,
  recordSites,
  outputSpikesTable,
  tracesSchema,
  tracesTable,
  trainsFromTable,
  unrestedNote,
} from './simulateOps'

/** Neuron 7 with two partners: A on the dendrite at 45 µm, B on the branch at 30 µm along y. */
function model() {
  return build(
    {},
    exc(
      input([
        ['A', '7', 'pre', 45_000, 0],
        ['A', '7', 'pre', 45_000, 0],
        ['B', '7', 'pre', 30_000, 15_000],
      ]),
    ),
  )
}

/** A job on `model()` recording the soma, nothing firing unless given. */
function job(value: ReturnType<typeof model>, over: Partial<SimulateJob> = {}): SimulateJob {
  return {
    model: solverPart(value),
    dt: 0.025,
    duration: 40,
    sampleEvery: 0.1,
    record: Int32Array.of(value.soma.compartment),
    threshold: 0,
    firing: [],
    clamps: [],
    ...over,
  }
}

describe('partnerTrain', () => {
  const regular = { start: 5, number: 4, interval: 10, noise: 0 }

  it('fires at start, start + interval, … with no noise', () => {
    expect(partnerTrain(regular, 1, 'A')).toEqual([5, 15, 25, 35])
  })

  it('is the same train for one partner whatever else fires, and differs between partners', () => {
    const noisy = { ...regular, number: 20, noise: 1 }
    expect(partnerTrain(noisy, 3, 'A')).toEqual(partnerTrain(noisy, 3, 'A'))
    expect(partnerTrain(noisy, 3, 'A')).not.toEqual(partnerTrain(noisy, 3, 'B'))
    expect(partnerTrain(noisy, 4, 'A')).not.toEqual(partnerTrain(noisy, 3, 'A'))
  })

  it('is Poisson at noise 1: intervals average the mean, and are not all equal', () => {
    const times = partnerTrain({ start: 0, number: 4000, interval: 10, noise: 1 }, 7, 'A')
    const gaps = times.slice(1).map((t, i) => t - times[i]!)
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    expect(mean).toBeGreaterThan(9.5)
    expect(mean).toBeLessThan(10.5)
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(100)
  })
})

describe('what to run', () => {
  it('records the soma first, then each record point on the arbour, named and counted', () => {
    const value = model()
    const points = cloud([
      ['out1', '', '', 60_000, 0],
      ['out1', '', '', 20_000, 0],
      ['far', '', '', 20_000, 80_000],
    ])
    const notes: string[] = []
    const label = getColumn(points.attributes, 'neuronId')
    const sites = recordSites(value, { points, label }, 2, notes)
    expect(sites.labels).toEqual(['soma', 'out1', 'out1 (2)'])
    expect(sites.compartments[0]).toBe(value.soma.compartment)
    expect(notes.join(' ')).toMatch(/^1 record point more than 2 µm/)
  })

  it('places a record point by the rule a synapse at the same place was placed', () => {
    const value = model()
    const sites = recordSites(value, { points: cloud([['x', '', '', 45_000, 0]]) }, 2, [])
    expect(sites.compartments[1]).toBe(value.synapses.compartment[0])
  })

  it('fires every partner but the silenced, and says which silenced ids are not partners', () => {
    const value = model()
    const notes: string[] = []
    expect(firingPartners(value, [], notes, undefined)).toEqual([0, 1])
    expect(firingPartners(value, ['A', 'Q'], notes, undefined)).toEqual([1])
    expect(notes).toEqual(['1 silenced partner is not a partner of this model: Q.'])
  })

  it('fires the top N by synapses of the partners not silenced, ties to the first listed', () => {
    const value = model()
    // A has two synapses, B one.
    expect(firingPartners(value, [], [], 1)).toEqual([0])
    expect(firingPartners(value, ['A'], [], 1)).toEqual([1])
    expect(firingPartners(value, [], [], 5)).toEqual([0, 1])
    const tie = { id: ['x', 'y', 'z'], synapses: Int32Array.of(2, 5, 5) }
    expect(firingIndices(tie, [], 1)).toEqual([1])
    expect(firingIndices(tie, [], 2)).toEqual([1, 2])
  })

  it('reads Fire from the card: every partner unless it says top N', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), drive: 'trains' }
    const plan = (over: object) =>
      planRun(value, { ...params, ...over }, {}).job.firing.map(([p]) => p)
    expect(plan({})).toEqual([0, 1])
    expect(plan({ fire: 'top', top: 1 })).toEqual([0])
  })

  it('reads trains from a table for the firing partners, naming ones the model has no synapses from', () => {
    const value = model()
    const table = makeTable(tableSchema(column('partnerId', 'str'), column('time', 'f64')), {
      partnerId: ['B', 'A', 'B', 'Z'],
      time: [9, 5, 3, 1],
    })
    const notes: string[] = []
    const read = (allowed: number[]) =>
      trainsFromTable(
        value,
        getColumn(table, 'partnerId'),
        getColumn(table, 'time'),
        allowed,
        notes,
      )
    expect([...read([0, 1])]).toEqual([
      [1, [3, 9]],
      [0, [5]],
    ])
    expect([...read([1])]).toEqual([[1, [3, 9]]])
    expect(notes[0]).toMatch(/1 partner in the spike table has no synapses.*: Z\./)
  })

  it('plans a job from the params: trains for the unsilenced, the summary over the same partners', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), silenced: ['A'], perPartner: true }
    const { job, labels } = planRun(value, params, {})
    expect(labels).toEqual(['soma'])
    expect(job.firing).toEqual([[1, [10]]])
    expect(job.summary).toEqual({ onset: 5, window: 50 })
    expect(jobSteps(job)).toBe(4000 + 2000)
    expect(planRun(value, { ...params, drive: 'none' }, {}).job.firing).toEqual([])
    expect(() => planRun(value, { ...params, drive: 'table' }, {})).toThrow(/Input spikes/)
    // A model with no synapses: said, whichever drive, and never for None.
    const bare = build({})
    for (const drive of ['trains', 'table']) {
      expect(planRun(bare, { ...params, silenced: [], drive }, {}).notes).toEqual([
        expect.stringMatching(/^This model has no synapses, so .* nothing: wire Synapses/),
      ])
    }
    expect(planRun(bare, { ...params, silenced: [], drive: 'none' }, {}).notes).toEqual([])
    // A rest kept from a run at this dt is handed to the next job, and only at this dt.
    const rest = { state: { v: new Float64Array(1), gates: [] }, time: 1, converged: true }
    keepRest(value, 0.025, rest)
    expect(planRun(value, params, {}).job.rest).toBe(rest)
    expect(planRun(value, { ...params, dt: 0.01 }, {}).job.rest).toBeUndefined()
  })

  it('says when the summary window closes before a spike arrives, and measures nobody then', async () => {
    const value = model()
    const params = {
      ...defaultParams(simulateNode),
      perPartner: true,
      window: 5,
      summaryOnset: 5,
    }
    const plan = planRun(value, params, {})
    expect(plan.notes).toEqual([
      expect.stringMatching(/^2 partners are left out of the per-partner summary/),
    ])
    const result = await runSimulateJob({ ...plan.job, duration: 10 })
    // Unmeasured, not noise: empty cells rather than a ratio of two near-zeros.
    expect(Array.from(result.summary!.somaPeak).every(Number.isNaN)).toBe(true)
  })

  it('leaves out a response still at its peak when the window closes, rather than cutting it short', async () => {
    const value = model()
    const job = (window: number) =>
      planRun(
        value,
        { ...defaultParams(simulateNode), perPartner: true, window, summaryOnset: 5 },
        {},
      ).job
    // The spike arrives at 6 ms: one millisecond is not enough to peak.
    const short = await runSimulateJob({ ...job(7), duration: 10 })
    expect(short.summary!.cut).toBe(2)
    expect(Array.from(short.summary!.somaPeak).every(Number.isNaN)).toBe(true)
    const long = await runSimulateJob({ ...job(50), duration: 10 })
    expect(long.summary!.cut).toBe(0)
    expect(Array.from(long.summary!.somaPeak).every((v) => v > 0)).toBe(true)
  })

  it('measures a slow response that has peaked and is still decaying when the window closes', async () => {
    // τ 5/80 ms: the soma peaks about 20 ms after onset and is still near it at 50.
    const value = build(
      { excitatory: { ...OPTIONS.excitatory, tau1: 5, tau2: 80 } },
      exc(input([['A', '7', 'pre', 45_000, 0]])),
    )
    const { job } = planRun(
      value,
      { ...defaultParams(simulateNode), perPartner: true, window: 50, summaryOnset: 5 },
      {},
    )
    const result = await runSimulateJob({ ...job, duration: 10 })
    expect(result.summary!.cut).toBe(0)
    expect(result.summary!.somaPeak[0]).toBeGreaterThan(0)
  })

  it('refuses traces that would not fit in a tab, before allocating them', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), duration: 1e7, sampleEvery: 0.025 }
    expect(() => planRun(value, params, {})).toThrow(
      /^Refused: 1 trace sampled every 0\.025 ms/,
    )
  })

  it('cuts every train at the end of the run, and refuses more events than a tab can hold', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), number: 20, interval: 10, duration: 100 }
    const { job } = planRun(value, params, {})
    // Spikes at 10, 20, … 90: the ten from 100 on could not reach the run.
    expect(job.firing.every(([, times]) => times.length === 9 && times.at(-1)! < 100)).toBe(
      true,
    )
    // A spike at 99.5 ms reaches its synapses at 100.5, after the end: cut on arrival, not time.
    const late = planRun(value, { ...params, start: 10, interval: 89.5, number: 2 }, {}).job
    expect(late.firing.every(([, times]) => times.length === 1)).toBe(true)
    const many = { ...params, number: 4e6, interval: 0.001, duration: 1e4 }
    expect(() => planRun(value, many, {})).toThrow(/^Refused: 12,000,000 synaptic events/)
  })

  it('records Playback’s traces as well, named apart, and leaves the movie’s basis alone', () => {
    const value = model()
    const base = defaultParams(simulateNode)
    const traces = [
      writeManualPoint({ neuron: '7', at: [40_000, 0, 0], name: 'tip' }),
      writeManualPoint({ neuron: '7', at: [30_000, 15_000, 0], name: 'soma' }),
    ]
    const plain = planRun(value, base, {})
    const traced = planRun(value, { ...base, traces }, {})
    // The soma, then each trace: a column of the Traces output, a name the soma's cannot take.
    expect(traced.labels).toEqual(['soma', 'tip', 'soma (2)'])
    expect(traced.job.record).toHaveLength(3)
    // Playback draws the plan's own traces, so a line and its column carry one name.
    expect(traced.traces.placed.map((trace) => trace.label)).toEqual(traced.labels.slice(1))
    expect(plain.traces).toEqual({ placed: [], off: 0 })
    expect(Array.from(traced.job.record.subarray(0, 1))).toEqual(Array.from(plain.job.record))
    // What it records is not what a movie shows: one basis, so Playback keeps its movie.
    expect(movieBasis(traced.job)).toBe(movieBasis(plain.job))
    expect(movieBasis(planRun(value, { ...base, duration: 50 }, {}).job)).not.toBe(
      movieBasis(plain.job),
    )
  })

  it('injects at the sites Inject at names, by the run’s own names, and says what it cannot', () => {
    const value = model()
    const base = { ...defaultParams(simulateNode), clamp: true, drive: 'none' }
    const traces = [writeManualPoint({ neuron: '7', at: [40_000, 0, 0], name: 'tip' })]
    // A graph from before sites were picked: the soma, a step, as it always was.
    const old = planRun(value, base, {})
    expect(old.job.clamps).toEqual([
      { compartment: value.soma.compartment, delay: 10, duration: 50, amplitude: 0.05 },
    ])
    const picked = planRun(
      value,
      { ...base, traces, clampSites: ['tip', 'gone'], clampShape: 'ramp', rampFrom: -0.1 },
      {},
    )
    expect(picked.job.clamps).toEqual([
      {
        compartment: picked.job.record[1],
        delay: 10,
        duration: 50,
        amplitude: 0.05,
        shape: { kind: 'ramp', from: -0.1 },
      },
    ])
    expect(picked.notes).toContainEqual(expect.stringMatching(/^Inject at names "gone", which/))
    // Two names on one compartment: injected there once, and said.
    const twice = planRun(value, { ...base, traces, clampSites: ['tip', 'tip', 'soma'] }, {})
    expect(twice.job.clamps).toHaveLength(2)
    expect(planRun(value, { ...base, clamp: false }, {}).job.clamps).toEqual([])
    expect(planRun(value, { ...base, clampSites: [] }, {}).notes).toContain(
      'Current injection is on, but no site is ticked in the Sites tab.',
    )
  })

  it('folds a waveform into columns by their extremes, so a narrow pulse still shows', () => {
    const pulses = {
      delay: 10,
      duration: 50,
      amplitude: 0.3,
      shape: { kind: 'pulses' as const, width: 0.1, interval: 20 },
    }
    // 100 ms in 20 columns: 5 ms each, a 0.1 ms pulse a fiftieth of one.
    const { lo, hi } = clampEnvelope(pulses, 0.025, 100, 20)
    expect(Array.from(hi, (v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)).toEqual([2, 6, 10])
    expect(Math.min(...lo)).toBe(0)
  })

  it('describes each shape as the Sites tab says it', () => {
    const p = { ...defaultParams(simulateNode), clamp: true }
    expect(describeClamp(p)).toBe('a 0.05 nA step from 10 ms for 50 ms')
    expect(describeClamp({ ...p, clampShape: 'ramp', rampFrom: -0.1 })).toBe(
      'a ramp from −0.1 nA to 0.05 nA from 10 ms for 50 ms',
    )
    expect(describeClamp({ ...p, clampShape: 'sine' })).toBe(
      'a 10 Hz sine of 0.05 nA about 0 nA from 10 ms for 50 ms',
    )
    expect(describeClamp({ ...p, clampShape: 'pulses' })).toBe(
      '0.05 nA pulses of 2 ms every 10 ms from 10 ms for 50 ms',
    )
  })

  it('names an unset spike column rather than asking for a table that is wired', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), drive: 'table' }
    expect(() => planRun(value, params, { spikesUnresolved: true })).toThrow(/no column chosen/)
  })
})

describe('runSimulateJob', () => {
  it('depolarises the soma when a partner fires, and not before', async () => {
    const value = model()
    const result = await runSimulateJob(job(value, { firing: [[0, [10]]] }))
    const soma = result.traces[0]!
    const at = (ms: number) => soma[Math.round(ms / 0.1)]!
    expect(at(10)).toBeCloseTo(-60, 6)
    expect(Math.max(...soma) + 60).toBeGreaterThan(0.1)
    expect(result.t.length).toBe(soma.length)
  })

  it('runs each partner alone for the summary: a distal input attenuates on its way to the soma', async () => {
    const value = model()
    const result = await runSimulateJob(
      job(value, {
        firing: [
          [0, []],
          [1, []],
        ],
        summary: { onset: 5, window: 40 },
      }),
    )
    const { somaPeak, localPeak } = result.summary!
    for (const p of [0, 1]) {
      expect(somaPeak[p]).toBeGreaterThan(0)
      expect(localPeak[p]).toBeGreaterThan(somaPeak[p]!)
    }
    // A holds two synapses at one place, B one: A moves the soma more.
    expect(somaPeak[0]).toBeGreaterThan(somaPeak[1]!)
  })

  it('measures an inhibitory partner as the fall it causes, signed, and says which partner is which', async () => {
    // A on the excitatory socket, C on the inhibitory one at the same place, B on both.
    const value = build(
      {},
      {
        excitatory: input([
          ['A', '7', 'pre', 45_000, 0],
          ['B', '7', 'pre', 30_000, 15_000],
        ]),
        inhibitory: input([
          ['C', '7', 'pre', 45_000, 0],
          ['B', '7', 'pre', 30_000, 15_000],
        ]),
      },
    )
    const result = await runSimulateJob(
      job(value, {
        firing: [
          [0, []],
          [2, []],
        ],
        summary: { onset: 5, window: 40 },
      }),
    )
    const { somaPeak, localPeak } = result.summary!
    expect(somaPeak[0]).toBeGreaterThan(0)
    // C reverses at −68 mV, below the −60 mV rest: a fall, larger where it lands.
    expect(somaPeak[2]).toBeLessThan(0)
    expect(localPeak[2]).toBeLessThan(somaPeak[2]!)
    const table = partnersTable(value, [0, 2], result.summary)
    expect(getColumn(table, 'sign')).toEqual(['excitatory', 'mixed', 'inhibitory'])
    // Two falls are a positive share, as two rises are.
    expect(getColumn(table, 'attenuation')[2]).toBeGreaterThan(0)
    expect(getColumn(inputSpikesTable(value, [[2, [10]]]), 'sign')).toEqual(['inhibitory'])
  })

  it('settles an active model before the run, and counts spikes every step', async () => {
    const value = build({ ...HH, somaDiameter: 6 }, exc(input([['A', '7', 'pre', 45_000, 0]])))
    const result = await runSimulateJob(
      job(value, {
        duration: 60,
        clamps: [
          { compartment: value.soma.compartment, delay: 10, duration: 40, amplitude: 0.5 },
        ],
      }),
    )
    expect(result.settle?.converged).toBe(true)
    expect(result.spikes[0]!.length).toBeGreaterThan(0)
  })

  it('starts from a rest it is handed rather than settling again', async () => {
    const value = build({ ...HH, somaDiameter: 6 }, exc(input([['A', '7', 'pre', 45_000, 0]])))
    const first = await runSimulateJob(job(value, { duration: 5 }))
    const again = await runSimulateJob(job(value, { duration: 5, rest: first.settle }))
    expect(again.settle).toBe(first.settle)
    expect(Array.from(again.traces[0]!)).toEqual(Array.from(first.traces[0]!))
  })

  it('rejects when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runSimulateJob(job(model()), { signal: controller.signal })).rejects.toThrow(
      /Abort/,
    )
  })
})

describe('the arbour', () => {
  it('records every compartment’s peak, read every step', async () => {
    const value = model()
    const result = await runSimulateJob(job(value, { sampleEvery: 0.025, firing: [[0, [10]]] }))
    expect(result.peak).toHaveLength(value.compartments.count)
    // Sampled every step, the soma's trace holds its own peak.
    expect(result.peak[value.soma.compartment]).toBeCloseTo(Math.max(...result.traces[0]!), 9)
  })

  it('puts each node’s compartment peak on the model’s skeleton, NaN off the modelled piece', async () => {
    const value = model()
    const result = await runSimulateJob(job(value, { firing: [[0, [10]]] }))
    const arbour = arbourValue(value, result.peak)
    expect(arbour.attributes.schema).toEqual(ARBOUR_SCHEMA)
    expect(arbour.attributes.data.neuronId).toEqual([value.neuronId])
    expect(arbour.units).toBe('nm')
    const voltage = arbour.items[0]!.nodeValues![PEAK_VOLTAGE]!
    expect(voltage).toHaveLength(value.skeleton.parents.length)
    value.nodeCompartment.forEach((c, node) => {
      if (c < 0) expect(voltage[node]).toBeNaN()
      else expect(voltage[node]).toBeCloseTo(result.peak[c]!, 4)
    })
    // The model's own skeleton is left as it was.
    expect(value.skeleton.nodeValues?.[PEAK_VOLTAGE]).toBeUndefined()
  })
})

describe('the movie', () => {
  it('replays the main run to the bit, every compartment every frame', async () => {
    const value = model()
    const base = job(value, {
      firing: [
        [0, [10]],
        [1, [12]],
      ],
    })
    const movie = await runMovieJob(base)
    expect(movie.count).toBe(value.compartments.count)
    // Framed at the card's own Sample every: 40 ms at 0.1 ms, the start included.
    expect(movie.frameMs).toBeCloseTo(base.sampleEvery, 9)
    expect(movie.coarse).toBe(false)
    expect(movie.length).toBe(401)
    expect(movie.frames.length).toBe(movie.length * movie.count)
    // The soma traced at the movie's own frame interval is the movie's soma column.
    const traced = await runSimulateJob({ ...base, sampleEvery: movie.frameMs })
    const soma = value.soma.compartment
    traced.traces[0]!.forEach((v, f) => {
      expect(movie.frames[f * movie.count + soma]).toBeCloseTo(v, 4)
    })
  })

  it('spaces its frames out only as far as it must to stay within its budget', () => {
    const base = job(model())
    const steps = Math.round(base.duration / base.dt) // 1,600
    const sized = (count: number) =>
      ({
        ...base,
        model: { ...base.model, compartments: { ...base.model.compartments, count } },
      }) as SimulateJob
    // Small enough: every Sample every (0.1 ms = 4 steps).
    expect(movieFrameSteps(base)).toBe(4)
    // A model so large that only 100 frames fit: the closest spacing that fits, and no closer.
    const count = MOVIE_BUDGET_BYTES / (4 * 100)
    const every = movieFrameSteps(sized(count))
    expect(frameCount(steps, every)).toBeLessThanOrEqual(100)
    expect(frameCount(steps, every - 1)).toBeGreaterThan(100)
  })
})

describe('the input spikes', () => {
  it('are every spike fired at a partner, and when it reached its synapses, in time order', () => {
    const value = model()
    const delay = value.synapseTypes[0]!.delay
    const table = inputSpikesTable(value, [
      [1, [12]],
      [0, [10, 30]],
    ])
    expect(getColumn(table, 'partnerId')).toEqual(['A', 'B', 'A'])
    expect(getColumn(table, 'time')).toEqual([10, 12, 30])
    expect(getColumn(table, 'arrival')).toEqual([10 + delay, 12 + delay, 30 + delay])
  })

  it('replay the drive when wired into another Simulate', () => {
    const value = model()
    const params = { ...defaultParams(simulateNode), drive: 'trains', number: 3, noise: 1 }
    const first = planRun(value, params, {}).job
    const fired = inputSpikesTable(value, first.firing)
    const again = planRun(
      value,
      { ...params, drive: 'table' },
      {
        spikes: {
          partner: getColumn(fired, 'partnerId'),
          time: getColumn(fired, 'time'),
        },
      },
    ).job
    const sorted = (f: typeof first.firing) =>
      [...f]
        .map(([p, t]) => [p, [...t].sort((a, b) => a - b)])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
    expect(sorted(again.firing)).toEqual(sorted(first.firing))
  })

  it('replay a partner on both sockets once, though its synapses carry two delays', () => {
    // A on both sockets, the inhibitory delay 2 ms: one spike, two arrivals.
    const both = input([['A', '7', 'pre', 45_000, 0]])
    const value = build(
      { inhibitory: { ...OPTIONS.inhibitory, delay: 2 } },
      { excitatory: both, inhibitory: both },
    )
    const fired = inputSpikesTable(value, [[0, [10, 20]]])
    expect(getColumn(fired, 'time')).toEqual([10, 20])
    expect(getColumn(fired, 'arrival')).toEqual([11, 21])
    const params = { ...defaultParams(simulateNode), drive: 'table' }
    const again = planRun(value, params, {
      spikes: { partner: getColumn(fired, 'partnerId'), time: getColumn(fired, 'time') },
    }).job
    expect(again.firing).toEqual([[0, [10, 20]]])
  })
})

describe('the tables agree with their schemas', () => {
  it('traces, spikes and partners, with and without the summary', async () => {
    const value = model()
    const result = await runSimulateJob(
      job(value, {
        record: Int32Array.of(value.soma.compartment, value.nodeCompartment[7]!),
        firing: [[0, [10]]],
        summary: { onset: 5, window: 20 },
      }),
    )
    const labels = ['soma', 'tip']
    expect(tracesTable(labels, result, { clamps: [], dt: 0.025 }).schema).toEqual(
      tracesSchema(labels),
    )
    // With current injected, a last column in nA: the waveform at each sample, zero outside it.
    const clamp = { compartment: 0, delay: 10, duration: 5, amplitude: 0.2 }
    const injected = tracesTable(labels, result, { clamps: [clamp], dt: 0.025 })
    expect(injected.schema).toEqual(tracesSchema(labels, 'injected'))
    // Inference agrees with the run either way a switch went since the last one: the sites from
    // the run it saw, the injected column from the params as they are now.
    const uninjected = tracesTable(labels, result, { clamps: [], dt: 0.025 }).schema
    expect(inferredTracesSchema(uninjected, true)).toEqual(injected.schema)
    expect(inferredTracesSchema(injected.schema, false)).toEqual(uninjected)
    expect(inferredTracesSchema(undefined, false)).toEqual(tracesSchema(['soma']))
    const t = getColumn(injected, 't') as number[]
    const current = getColumn(injected, 'injected') as number[]
    expect(current[t.indexOf(5)]).toBe(0)
    expect(current[t.findIndex((x) => x > 12)]).toBe(0.2)
    expect(current.at(-1)).toBe(0)
    // A site already called `injected` keeps its name; the current takes the next.
    expect(
      tracesTable(
        [...labels, 'injected'],
        { ...result, traces: [...result.traces, result.traces[0]!] },
        {
          clamps: [clamp],
          dt: 0.025,
        },
      ).schema.columns.at(-1)?.name,
    ).toBe('injected (2)')
    expect(outputSpikesTable(labels, result).schema).toEqual(OUTPUT_SPIKES_SCHEMA)
    expect(inputSpikesTable(value, [[0, [10]]]).schema).toEqual(INPUT_SPIKES_SCHEMA)
    const plain = partnersTable(value, [0], undefined)
    expect(plain.schema).toEqual(partnersSchema(false))
    const summed = partnersTable(value, [0], result.summary)
    expect(summed.schema).toEqual(partnersSchema(true))
    // B did not run alone: its summary cells are empty rather than zero.
    expect(getColumn(summed, 'somaPeak')).toEqual([expect.any(Number), null])
    expect(getColumn(summed, 'fires')).toEqual([true, false])
  })
})

describe('unrestedNote', () => {
  const value = model()
  // Rm·Cm is 16.6 ms on the fixture, so the note waits 50 ms after the last input.
  const job = { firing: [[0, [10]]] as SimulateJob['firing'], duration: 100, clamps: [] }
  const atRest = new Float64Array(value.compartments.count).fill(-60)
  const stuck = atRest.slice()
  stuck[value.soma.compartment] = -25

  it('says where a cell stayed away from rest long after its last input', () => {
    expect(unrestedNote(value, job, atRest, undefined)).toBeUndefined()
    expect(unrestedNote(value, job, stuck, undefined)).toBe(
      'The cell has not come back to rest: the soma ends the run at −25 mV, 35 mV above its rest, 89 ms after the last input.',
    )
  })

  it('says a fall below rest as one, and nothing where the model never settled', () => {
    const low = atRest.slice()
    low[value.soma.compartment] = -70
    expect(unrestedNote(value, job, low, undefined)).toMatch(/at −70 mV, 10 mV below its rest/)
    const drifting = { state: { v: atRest } as never, time: 2000, converged: false }
    expect(unrestedNote(value, job, stuck, drifting)).toBeUndefined()
  })

  it('stays quiet while a slow tail could still be one, input or clamp', () => {
    expect(unrestedNote(value, { ...job, duration: 40 }, stuck, undefined)).toBeUndefined()
    const clamp = {
      compartment: value.soma.compartment,
      delay: 10,
      duration: 80,
      amplitude: 0.1,
    }
    expect(unrestedNote(value, { ...job, clamps: [clamp] }, stuck, undefined)).toBeUndefined()
  })
})
