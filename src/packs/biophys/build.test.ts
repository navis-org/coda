import { describe, expect, it } from 'vitest'
import { getColumn } from '../../core/values'
import { CODE_AXON, CODE_DENDRITE } from '../../core/values'
import { simulate } from '../../biophys/solver'
import { MAX_SOMA_RADIUS_UM, buildCellModel, placePoints } from './build'
import { modelNode } from './model'
import { defaultParams, makeInferContext, validationMessage } from '../../core/node'
import {
  CHANNEL_OPTIONS,
  changeChannel,
  densityStep,
  describeChannel,
  newChannelRow,
} from './channelRows'
import { libraryChannels } from '../../biophys/channels'
import { cellModelOf, eventsFor } from './solverInputs'
import {
  HH,
  OPTIONS,
  build,
  cloud,
  emSoma,
  exc,
  input,
  neuron,
  noted,
  regionsWith,
} from './testFixtures'
import type { RegionStroke } from './regions'
import type { CellModelValue } from '../../core/values'

describe('buildCellModel', () => {
  it('refuses voxels, an empty wire and several neurons', () => {
    expect(() => buildCellModel(neuron({ units: 'voxels' }), {}, OPTIONS)).toThrow(
      /nanometres|nm/,
    )
    const none = { ...neuron(), items: [] }
    expect(() => buildCellModel(none, {}, OPTIONS)).toThrow(/no neuron/)
    const two = neuron()
    const many = { ...two, items: [two.items[0]!, { ...two.items[0]!, id: '8' }] }
    expect(() => buildCellModel(many, {}, OPTIONS)).toThrow(/For Each/)
  })

  it('makes a labelled soma one sphere-equivalent section, the fibre starting at its own radius', () => {
    const value = build()
    expect(value.soma.source).toBe('labelled')
    expect(value.soma.diameter).toBe(6)
    const soma = value.regionNames.indexOf('soma')
    let somaArea = 0
    let total = 0
    for (let c = 0; c < value.compartments.count; c++) {
      total += value.compartments.area[c]!
      if (value.compartments.region[c] === soma) somaArea += value.compartments.area[c]!
    }
    // A cylinder as long as it is wide has a sphere's area: π d².
    expect(somaArea).toBeCloseTo(Math.PI * 36, 6)
    // Nothing else is soma-sized: the fibre is 0.3 µm, so no cone from 3 µm down was drawn.
    expect(total - somaArea).toBeLessThan(2 * Math.PI * 0.3 * 80)
    expect(value.compartments.area[value.soma.compartment]).toBeGreaterThan(0)
    expect(value.nodeCompartment[0]).toBe(value.soma.compartment)
    expect(value.nodeCompartment[1]).toBe(value.soma.compartment)
  })

  it('says when no soma is labelled, and adds one when given a diameter', () => {
    const bare = buildCellModel(neuron({ labels: false }), {}, OPTIONS)
    expect(bare.soma.source).toBe('root')
    expect(noted(bare, /No soma is labelled/)).toBe(true)
    const added = buildCellModel(
      neuron({ labels: false }),
      {},
      {
        ...OPTIONS,
        ...regionsWith({ somaDiameter: 2.6 }),
      },
    )
    expect(added.soma.source).toBe('added')
    expect(added.soma.diameter).toBe(2.6)
    expect(noted(added, /No soma is labelled/)).toBe(false)
  })

  it('takes the soma’s fat neighbours and dead-end stubs into it, never the fibre leaving it', () => {
    const skeletons = emSoma()
    const value = buildCellModel(skeletons, {}, OPTIONS)
    const soma = value.soma.compartment
    const at = (node: number) => value.nodeCompartment[node]
    expect([0, 1, 2, 3, 4].map(at)).toEqual([soma, soma, soma, soma, soma])
    expect([5, 6, 7, 8].map(at)).not.toContain(soma)
    // The soma's own membrane (π d²) and cable only from its surface out: 4 → 5 from 3 µm to
    // 10 µm at 1.6 µm, the cone 5 → 6 down to 0.3 µm, and the thin neurite's 1 µm past the surface
    // and 26 more. Kept as cable, the neighbour, the stub and the stretches inside the soma would
    // add some 60 µm².
    const total = value.compartments.area.reduce((a, b) => a + b, 0)
    const cone = Math.PI * (1.6 + 0.3) * Math.hypot(30, 1.3)
    const expected = Math.PI * 36 + 2 * Math.PI * 1.6 * 7 + cone + 2 * Math.PI * 0.3 * 27
    expect(total).toBeCloseTo(expected, 6)
  })

  it('places a point past the soma’s surface on the fibre, and one inside it on the soma', () => {
    const value = buildCellModel(emSoma(), {}, OPTIONS)
    const soma = value.soma.compartment
    // 4.4 µm out along 4 → 5, whose skeleton edge starts at a replaced node 3 µm out while its
    // cable starts at the centre: outside the 3 µm soma, so on the fibre's cable, with membrane.
    // 2 µm down 0 → 7, inside the soma: the soma's compartment, not the junction at its centre.
    const placed = placePoints(
      value,
      cloud([
        ['7', '-', 'post', 4400, 0],
        ['7', '-', 'post', 0, -2000],
      ]),
    )
    const [fibre, inside] = Array.from(placed.compartment)
    expect(fibre).not.toBe(soma)
    expect(value.compartments.area[fibre!]).toBeGreaterThan(0)
    expect(inside).toBe(soma)
  })

  it('leaves an ignored branch out, its synapses counted, and keeps the skeleton’s soma when asked', () => {
    const p = emSoma().items[0]!.positions
    const at = (k: number) => [p[k * 3]!, p[k * 3 + 1]!, 0] as [number, number, number]
    const ignore: RegionStroke = {
      neuron: '7',
      at: at(7),
      scope: 'distal',
      region: '',
      ignore: true,
      root: at(0),
    }
    // One synapse on the thin neurite, one on the fibre.
    const synapses = exc(
      input([
        ['3', '7', 'post', 0, -20_000],
        ['3', '7', 'post', 20_000, 0],
      ]),
    )
    const kept = buildCellModel(emSoma(), synapses, OPTIONS)
    const without = buildCellModel(emSoma(), synapses, {
      ...OPTIONS,
      ...regionsWith({ strokes: [ignore] }),
    })
    expect([7, 8].map((v) => without.nodeCompartment[v])).toEqual([-1, -1])
    const area = (v: CellModelValue) => v.compartments.area.reduce((a, b) => a + b, 0)
    // The thin neurite's 1 + 26 µm at 0.3 µm, gone.
    expect(area(kept) - area(without)).toBeCloseTo(2 * Math.PI * 0.3 * 27, 6)
    expect(without.synapses.compartment).toHaveLength(1)
    expect(noted(without, /1 synapse lies on branches painted ignored/)).toBe(true)

    // As is: no idealised soma, the fat neighbour and the stub kept as the cable they were drawn as.
    const asIs = buildCellModel(
      emSoma(),
      {},
      { ...OPTIONS, ...regionsWith({ somaMode: 'asIs' }) },
    )
    expect(asIs.soma.source).toBe('labelled')
    expect(asIs.soma.diameter).toBeUndefined()
    expect(asIs.nodeCompartment[1]).not.toBe(asIs.soma.compartment)
    expect(area(asIs)).toBeGreaterThan(area(kept))
  })

  it('never smooths kept cable into an ignored branch, whose radii are unfilled', () => {
    const p = emSoma().items[0]!.positions
    const at = (k: number) => [p[k * 3]!, p[k * 3 + 1]!, 0] as [number, number, number]
    // Node 5 has one child, 6; ignoring 6 cuts the stretch there, so node 5 keeps its radius.
    const ignore: RegionStroke = {
      neuron: '7',
      at: at(6),
      scope: 'distal',
      region: '',
      ignore: true,
      root: at(0),
    }
    const area = (smoothWindow: number) =>
      buildCellModel(
        emSoma(),
        {},
        { ...OPTIONS, smoothWindow, ...regionsWith({ strokes: [ignore] }) },
      ).compartments.area.reduce((a, b) => a + b, 0)
    expect(area(5)).toBeCloseTo(area(0), 9)
  })

  it('names a remedy the card shows, under either soma mode', () => {
    const lone = {
      ...neuron(),
      items: [
        {
          ...neuron().items[0]!,
          positions: Float32Array.of(0, 0, 0),
          radii: Float32Array.of(0),
          parents: Int32Array.of(-1),
          compartments: Uint8Array.of(0),
        },
      ],
    }
    expect(() =>
      buildCellModel(lone, {}, { ...OPTIONS, ...regionsWith({ somaMode: 'asIs' }) }),
    ).toThrow(/Set Soma to cut off and replace, and give a Soma diameter, to add one/)
  })

  it('warns of a soma larger than any neuron’s, typed or labelled, and not at the boundary', () => {
    const issues = (diameter: number) =>
      modelNode.validate!(
        makeInferContext(
          modelNode,
          { ...defaultParams(modelNode), somaDiameter: diameter },
          {},
        ),
      ).map(validationMessage)
    // 2000 µm, meant as nm: the slip this exists for.
    expect(issues(2000).join(' ')).toMatch(/Soma diameter makes a soma 2,000 µm across/)
    expect(issues(2 * MAX_SOMA_RADIUS_UM)).toEqual([])
    expect(issues(0)).toEqual([])
    // A typed one is validate's alone, or the card says it twice.
    expect(noted(build(regionsWith({ somaDiameter: 2000 })), /larger than any neuron/)).toBe(
      false,
    )
    const huge = neuron()
    ;(huge.items[0]!.radii as Float32Array)[0] = 60_000
    const labelled = buildCellModel(huge, {}, OPTIONS)
    expect(labelled.soma.diameter).toBe(120)
    expect(
      noted(
        labelled,
        /The soma the skeleton labels is 120 µm across.*Give a Soma diameter to replace it/,
      ),
    ).toBe(true)
    expect(noted(build(), /larger than any neuron/)).toBe(false)
  })

  it('leaves out fragments off the soma, and fills only the radii it keeps', () => {
    const value = build()
    expect(value.nodeCompartment[10]).toBe(-1)
    expect(value.nodeCompartment[11]).toBe(-1)
    expect(value.notes.find((n) => /fragments/.test(n))).toMatch(/^2 nodes \(10 µm of cable\)/)
    // One radius-less node on the arbour; the fragment's two are not counted.
    expect(value.notes.find((n) => /had no radius/.test(n))).toMatch(/^1 of 10 nodes/)
  })

  it('takes every row of Synapses Between on its default Location, whose polarity is all `pre`', () => {
    // The points are drawn at the presynaptic end, and polarity says so in every row; that is
    // not a role, and reading it as one would drop every synapse.
    const value = buildCellModel(
      neuron(),
      exc(
        input([
          ['A', '7', 'pre', 45_000, 0],
          ['A', '7', 'pre', 45_000, 0],
          ['B', '7', 'pre', 30_000, 15_000],
        ]),
      ),
      OPTIONS,
    )
    expect(value.synapses.compartment.length).toBe(3)
    expect(Array.from(value.partners.id)).toEqual(['A', 'B'])
    expect(Array.from(value.partners.synapses)).toEqual([2, 1])
    expect(noted(value, /postsynaptic/)).toBe(false)
  })

  it('places each input on its edge, and counts every row left out by reason', () => {
    const value = buildCellModel(
      neuron(),
      exc(
        input([
          ['A', '7', 'pre', 45_000, 0],
          // Neuron 7's own output, and a synapse between two other neurons.
          ['7', 'C', 'pre', 20_000, 0],
          ['X', 'Y', 'pre', 20_000, 0],
          ['D', '7', 'pre', 20_000, 50_000],
          ['E', '7', 'pre', 505_000, 0],
        ]),
      ),
      OPTIONS,
    )
    expect(Array.from(value.partners.id)).toEqual(['A'])
    // Halfway between the nodes at 40 and 50 µm, not on either.
    const c = value.synapses.compartment[0]!
    expect(Math.abs(value.compartments.position[c * 3]! - 45_000)).toBeLessThan(5000)
    expect(value.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^2 rows of 5 do not have 7 as the postsynaptic neuron/),
        expect.stringMatching(/^1 synapse is more than 2 µm from the arbour and was left out/),
        expect.stringMatching(/^1 synapse lies on fragments off the soma's piece/),
      ]),
    )
  })

  it('reads a Synapses cloud by flipping its `post` rows', () => {
    // Queried neuron 7 in neuronId; polarity is its role, partnerId the other neuron.
    const value = buildCellModel(
      neuron(),
      exc(
        input(
          [
            ['7', 'A', 'post', 45_000, 0],
            ['7', 'B', 'pre', 20_000, 0],
            ['7', 'C', '', 30_000, 15_000],
          ],
          'polarity',
        ),
      ),
      OPTIONS,
    )
    expect(Array.from(value.partners.id)).toEqual(['A'])
    expect(value.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^1 row of 3 does not have 7 as the postsynaptic neuron/),
        expect.stringMatching(/^1 row has a polarity that is neither/),
      ]),
    )
  })

  it('says when no row is an input, and what to check', () => {
    const value = buildCellModel(neuron(), exc(input([['7', 'A', 'pre', 45_000, 0]])), OPTIONS)
    expect(value.synapses.compartment.length).toBe(0)
    expect(value.notes.join(' ')).toMatch(/None is an input: check Orientation/)
  })

  it('takes every row as an input, and says so, when no Postsynaptic column resolves', () => {
    const value = buildCellModel(
      neuron(),
      { excitatory: { points: cloud([['A', '7', 'pre', 45_000, 0]]), orientation: 'fixed' } },
      OPTIONS,
    )
    expect(value.synapses.compartment.length).toBe(1)
    expect(Array.from(value.partners.id)).toEqual(['-'])
    expect(noted(value, /No Postsynaptic column/)).toBe(true)
  })

  it('lumps every synapse into one partner, `-`, with no Presynaptic column, and says so', () => {
    // Points placed on the neuron itself: `neuronId` is the neuron they sit on, so Postsynaptic.
    const points = cloud([
      ['7', '', '', 45_000, 0],
      ['7', '', '', 30_000, 15_000],
    ])
    const value = buildCellModel(
      neuron(),
      {
        excitatory: {
          points,
          postsynaptic: getColumn(points.attributes, 'neuronId'),
          orientation: 'fixed',
        },
      },
      OPTIONS,
    )
    expect(Array.from(value.partners.id)).toEqual(['-'])
    expect(Array.from(value.partners.synapses)).toEqual([2])
    expect(noted(value, /No Presynaptic column, so every synapse is one partner/)).toBe(true)
  })

  it('smooths radii along unbranched stretches only, leaving the soma out', () => {
    const plain = build()
    const smooth = build({ smoothWindow: 5 })
    // The filled 100 nm node at 50 µm is averaged with its 300 nm neighbours: more membrane there.
    const at = (v: typeof plain) => v.compartments.area[v.nodeCompartment[6]!]!
    expect(at(smooth)).toBeGreaterThan(at(plain))
    // The soma is read before smoothing and kept out of it: still 6 µm, not averaged with its fibre.
    expect(smooth.soma.diameter).toBe(plain.soma.diameter)
    expect(smooth.compartments.area[smooth.soma.compartment]).toBeCloseTo(
      plain.compartments.area[plain.soma.compartment]!,
      9,
    )
  })

  it('stores a temperature only for a model with channels', () => {
    expect(build().temperature).toBeUndefined()
    expect(build({ ...HH }).temperature).toBe(22)
  })

  it('says when channels on the soma have no soma to sit on, once, with the soma’s remedy', () => {
    const value = buildCellModel(neuron({ labels: false }), {}, { ...OPTIONS, ...HH })
    const said = value.notes.filter((note) => /soma/.test(note) && /sit nowhere/.test(note))
    expect(said).toEqual([expect.stringMatching(/no soma cable.*Give a Soma diameter/)])
  })

  it('runs: a partner firing depolarises the soma, after its delay', () => {
    const value = buildCellModel(neuron(), exc(input([['A', '7', 'pre', 45_000, 0]])), OPTIONS)
    const run = simulate({
      model: cellModelOf(value),
      dt: 0.025,
      duration: 30,
      initial: { v: -60 },
      events: eventsFor(value, new Map([[0, [5]]])),
      record: Int32Array.of(value.soma.compartment),
    })
    const v = run.v[0]!
    const at = (ms: number) => v[Math.round(ms / 0.025)]!
    expect(at(5.9)).toBeCloseTo(-60, 9)
    expect(Math.max(...v) + 60).toBeGreaterThan(0.1)
  })

  it('puts the HH channels on the soma and nowhere else', () => {
    const value = build({ ...HH })
    const model = cellModelOf(value)
    const na = model.channels[1]!
    const soma = value.regionNames.indexOf('soma')
    for (let c = 0; c < value.compartments.count; c++) {
      expect(na.gbar[c]! > 0).toBe(value.compartments.region[c] === soma)
    }
    expect(model.temperature).toBe(22)
  })

  it('indexes regions into its own names table, by the compartment they are, not by SWC code', () => {
    const value = build()
    // SWC 1 (soma) and 3 (basal dendrite); the index is the table's, the soma always at 1.
    expect(value.regionNames).toEqual(['unlabelled', 'soma', 'dendrite'])
    expect(new Set(value.compartments.region)).toEqual(new Set([1, 2]))
  })

  it('reads a computed split where the skeleton carries one, the soma still the source’s', () => {
    const skeletons = neuron()
    const item = skeletons.items[0]!
    // Split codes: every node on the long branch axon, the rest dendrite.
    const split = Uint8Array.from(item.parents, (_, v) =>
      v >= 5 && v <= 7 ? CODE_AXON : CODE_DENDRITE,
    )
    const value = buildCellModel({ ...skeletons, items: [{ ...item, split }] }, {}, OPTIONS)
    expect(value.regionNames).toEqual(expect.arrayContaining(['soma', 'axon', 'dendrite']))
    expect(value.regionNames[1]).toBe('soma')
  })

  it('reads polarity as Synapses to Edges does, case and spaces aside', () => {
    const value = build(
      {},
      exc(
        input(
          [
            ['7', 'A', 'Post', 45_000, 0],
            ['7', 'B', ' pre ', 20_000, 0],
          ],
          'polarity',
        ),
      ),
    )
    expect(Array.from(value.partners.id)).toEqual(['A'])
  })

  it('gives one solver model per value, so every run of it shares one preparation', () => {
    const value = build({}, exc(input([['A', '7', 'pre', 45_000, 0]])))
    expect(cellModelOf(value)).toBe(cellModelOf(value))
    const early = eventsFor(value, new Map([[0, [2]]]))
    const late = eventsFor(value, new Map([[0, [9]]]))
    expect(Array.from(early.slot)).toEqual(Array.from(late.slot))
    expect(late.time[0]! - early.time[0]!).toBe(7)
  })

  it('drives every synapse of a partner from its one train, in time order', () => {
    const value = build(
      {},
      exc(
        input([
          ['A', '7', 'pre', 45_000, 0],
          ['B', '7', 'pre', 20_000, 0],
          ['A', '7', 'pre', 30_000, 15_000],
        ]),
      ),
    )
    // Partner A (index 0) holds two synapses, B one; B fires before A's second spike.
    const events = eventsFor(
      value,
      new Map([
        [0, [1, 10]],
        [1, [4]],
      ]),
    )
    expect(Array.from(events.time)).toEqual([2, 2, 5, 11, 11])
    // A's two synapses share each of A's spikes; nothing fires for a partner left out.
    expect(eventsFor(value, new Map([[1, [4]]])).time.length).toBe(1)
  })

  it('reuses the geometry of one skeleton and cloud across rebuilds', () => {
    const skeletons = neuron()
    const synapses = input([['A', '7', 'pre', 45_000, 0]])
    const a = buildCellModel(skeletons, exc(synapses), OPTIONS)
    const b = buildCellModel(skeletons, exc(synapses), {
      ...OPTIONS,
      rule: { kind: 'maxLength', length: 2 },
    })
    expect(b.compartments.count).toBeGreaterThan(a.compartments.count)
    expect(Array.from(b.partners.id)).toEqual(Array.from(a.partners.id))
  })
})

describe('synapse sites', () => {
  it('keep where each synapse sits on the skeleton, as an edge and a share of it', () => {
    const value = build(
      {},
      exc(
        input([
          ['A', '7', 'pre', 45_000, 0],
          ['B', '7', 'pre', 30_000, 15_000],
        ]),
      ),
    )
    const { node, from, t } = value.sites
    const p = value.skeleton.positions
    expect(node).toHaveLength(value.synapses.compartment.length)
    // Interpolated along its edge, each site is back where its synapse was.
    const at = (s: number, axis: number) =>
      p[from[s]! * 3 + axis]! + t[s]! * (p[node[s]! * 3 + axis]! - p[from[s]! * 3 + axis]!)
    expect([at(0, 0), at(0, 1)]).toEqual([expect.closeTo(45_000, 0), expect.closeTo(0, 0)])
    expect([at(1, 0), at(1, 1)]).toEqual([expect.closeTo(30_000, 0), expect.closeTo(15_000, 0)])
  })
})

describe('the channel list', () => {
  const area = (value: ReturnType<typeof build>, name: string) => {
    const code = value.regionNames.indexOf(name)
    let sum = 0
    value.compartments.area.forEach((a, c) => {
      if (value.compartments.region[c] === code) sum += a
    })
    return sum
  }

  it('places a density by region, mS/cm² to S/cm², and everywhere where no region is named', () => {
    const value = build({
      channels: [
        { ...newChannelRow('pospischil.na'), regions: ['dendrite'], value: 30 },
        { ...newChannelRow('pospischil.k'), value: 5 },
      ],
    })
    const unshifted = { activation: 0, inactivation: 0 }
    expect(value.channels).toEqual([
      { id: 'pospischil.na', regions: ['dendrite'], density: 0.03, shift: unshifted },
      { id: 'pospischil.k', regions: [], density: 0.005, shift: unshifted },
    ])
  })

  it('spreads a total per cell over the named regions by area', () => {
    const value = build({
      channels: [
        {
          ...newChannelRow('pospischil.na'),
          regions: ['dendrite'],
          mode: 'total',
          value: 10,
        },
      ],
    })
    // 10 nS over the dendrite's µm²: 1e-8 S / (area · 1e-8 cm²).
    expect(value.channels[0]!.density).toBeCloseTo((10 * 0.1) / area(value, 'dendrite'), 12)
  })

  it('carries ΔV50 shifts to the solver’s gates', () => {
    const value = build({
      channels: [
        { ...newChannelRow('hh.na'), regions: ['soma'], value: 120, inactivation: -15 },
      ],
    })
    expect(value.channels[0]!.shift).toEqual({ activation: 0, inactivation: -15 })
  })

  it('says when a named region is not on this model, and leaves that row off', () => {
    const value = build({
      channels: [{ ...newChannelRow('pospischil.na'), regions: ['axon'], value: 30 }],
    })
    expect(value.channels).toEqual([])
    expect(noted(value, /no axon cable/)).toBe(true)
  })

  it('counts a region named only on a dropped fragment as missing, density or total', () => {
    // The fragment (nodes 10 and 11) labelled axon: named by the skeleton, no membrane in the model.
    const skeletons = neuron()
    const item = skeletons.items[0]!
    const compartments = Uint8Array.from(item.compartments!, (c, v) => (v >= 10 ? 2 : c))
    const value = build(
      {
        channels: [
          { ...newChannelRow('pospischil.na'), regions: ['axon'] },
          { ...newChannelRow('pospischil.k'), regions: ['axon'], mode: 'total', value: 2 },
        ],
      },
      {},
      { ...skeletons, items: [{ ...item, compartments }] },
    )
    expect(value.channels).toEqual([])
    expect(noted(value, /no axon cable/)).toBe(true)
  })

  it('leaves out a channel this build does not have, and says so at the model', () => {
    const value = build({
      channels: [{ ...newChannelRow('pospischil.na'), channel: 'fly.para' }],
    })
    expect(value.channels).toEqual([])
    expect(noted(value, /1 channel is not in this build's library .*: fly\.para/)).toBe(true)
  })
})

describe('the editor’s channels', () => {
  it('explain themselves from the library: gating, reversal, temperature, starting density', () => {
    const [na, , hh] = CHANNEL_OPTIONS
    const pospischil = describeChannel(na!).join(' ')
    expect(pospischil).toMatch(/Gating m³h, reversal \+50 mV\. No temperature dependence\./)
    expect(pospischil).toMatch(/Starts at 30 mS\/cm²/)
    expect(describeChannel(hh!).join(' ')).toMatch(/Rates ×3 per 10 °C from 6\.3 °C/)
  })

  it('step a density by the order of its channel’s start, at most 1, the same both ways', () => {
    // Persistent sodium starts at 0.0001: one press reaches 0, and a press up undoes a press down.
    expect(densityStep('gunay.nap')).toBeCloseTo(1e-4, 12)
    for (const id of ['gunay.nat', 'gunay.ks', 'pospischil.k', 'hh.na'])
      expect(densityStep(id)).toBe(1)
  })

  it('start a fly row as their model’s axon, and keep a hand placement whatever the clicks', () => {
    const nat = newChannelRow('gunay.nat')
    expect([nat.regions, nat.value]).toEqual([['axon'], 180])
    expect(newChannelRow('pospischil.na').regions).toEqual([])
    // A row at its channel's own placement takes the next channel's, both ways.
    expect(changeChannel(newChannelRow('pospischil.na'), 'gunay.ks').regions).toEqual(['axon'])
    expect(changeChannel(nat, 'pospischil.na').regions).toEqual([])
    // Placed by hand — everywhere on a fly row, or on the soma — it stays.
    expect(changeChannel({ ...nat, regions: [] }, 'gunay.ks').regions).toEqual([])
    const onSoma = { ...newChannelRow('pospischil.na'), regions: ['soma'] }
    expect(changeChannel(onSoma, 'gunay.ks').regions).toEqual(['soma'])
    // A ΔV50 belongs to the channel it was set on.
    const shifted = changeChannel({ ...nat, inactivation: -15 }, 'gunay.kf')
    expect([shifted.activation, shifted.inactivation]).toEqual([0, 0])
  })

  it('are exactly the library’s', () => {
    expect(CHANNEL_OPTIONS.map((o) => o.id).sort()).toEqual(
      libraryChannels()
        .map((c) => c.id)
        .sort(),
    )
  })
})

describe('painted regions', () => {
  const stroke = (over: Partial<RegionStroke>): RegionStroke => ({
    neuron: '7',
    at: [30_000, 10_000, 0],
    scope: 'distal',
    region: 'branch',
    root: [0, 0, 0],
    ...over,
  })

  it('name the cable they paint, and a channel placed there sits only there', () => {
    const value = build({
      ...regionsWith({ strokes: [stroke({})] }),
      channels: [{ ...newChannelRow('pospischil.na'), regions: ['branch'] }],
    })
    expect(value.regionNames).toContain('branch')
    const code = value.regionNames.indexOf('branch')
    const painted = value.compartments.region.filter((r) => r === code).length
    expect(painted).toBeGreaterThan(0)
    expect(value.channels[0]!.regions).toEqual(['branch'])
    expect(noted(value, /no branch cable/)).toBe(false)
  })

  it('relabel the soma’s membrane without moving the soma', () => {
    const plain = build({})
    const value = build(
      regionsWith({ strokes: [stroke({ scope: 'proximal', region: 'rest' })] }),
    )
    expect(value.soma).toEqual(plain.soma)
    expect(value.regionNames[value.compartments.region[value.soma.compartment]!]).toBe('rest')
  })

  it('leave an added soma soma, whatever its root was labelled or painted', () => {
    const value = build(
      regionsWith({
        somaDiameter: 2.6,
        strokes: [stroke({ scope: 'proximal', region: 'rest' })],
      }),
      {},
      neuron({ labels: false }),
    )
    expect(value.soma.source).toBe('added')
    expect(value.regionNames[value.compartments.region[value.soma.compartment]!]).toBe('soma')
  })

  it('say when a stroke lands on no node of this neuron', () => {
    const value = build(regionsWith({ strokes: [stroke({ at: [900_000, 0, 0] })] }))
    expect(noted(value, /1 painted stroke lands on no node/)).toBe(true)
    expect(value.regionNames).not.toContain('branch')
  })
})

describe('two synapse sockets', () => {
  const excitatory = input([
    ['A', '7', 'pre', 45_000, 0],
    ['B', '7', 'pre', 30_000, 15_000],
  ])
  const inhibitory = input([
    ['B', '7', 'pre', 20_000, 0],
    ['C', '7', 'pre', 45_000, 0],
    // Far from the arbour: counted under the inhibitory socket's name.
    ['C', '7', 'pre', 45_000, 90_000],
  ])

  it('give each synapse its socket’s mechanism, and a partner on both is one partner', () => {
    const value = build({}, { excitatory, inhibitory })
    expect(value.synapseTypes.map((t) => t.sign)).toEqual(['excitatory', 'inhibitory'])
    expect(value.partners.id).toEqual(['A', 'B', 'C'])
    expect(Array.from(value.partners.synapses)).toEqual([1, 2, 1])
    expect(Array.from(value.partners.inhibitory)).toEqual([0, 1, 1])
    // Excitatory rows first, then inhibitory: types follow the socket, not the partner.
    expect(Array.from(value.synapses.type)).toEqual([0, 0, 1, 1])
    expect(
      noted(value, /^1 partner has synapses on both sockets\. It fires as one partner/),
    ).toBe(true)
    expect(noted(value, /^Synapses \(inh\.\): 1 synapse is more than 2 µm/)).toBe(true)
  })

  it('take an inhibitory cloud alone, its notes named', () => {
    const value = build({}, { inhibitory })
    expect(Array.from(value.partners.inhibitory)).toEqual(Array.from(value.partners.synapses))
    expect(noted(value, /^Synapses \(inh\.\):/)).toBe(true)
  })

  it('leave an excitatory cloud alone as it was: no inhibitory synapse, notes unnamed', () => {
    const value = build({}, { excitatory })
    expect(Array.from(value.partners.inhibitory)).toEqual([0, 0])
    expect(noted(value, /^Synapses \(/)).toBe(false)
  })
})
