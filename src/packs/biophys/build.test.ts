import { describe, expect, it } from 'vitest'
import { getColumn } from '../../core/values'
import { CODE_AXON, CODE_DENDRITE } from '../../core/values'
import { simulate } from '../../biophys/solver'
import { buildCellModel } from './build'
import { CHANNEL_OPTIONS, describeChannel, newChannelRow } from './channelRows'
import { libraryChannels } from '../../biophys/channels'
import { cellModelOf, eventsFor } from './solverInputs'
import { HH, OPTIONS, build, cloud, exc, input, neuron, noted } from './testFixtures'
import type { RegionStroke } from './regions'

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
        somaDiameter: 2.6,
      },
    )
    expect(added.soma.source).toBe('added')
    expect(added.soma.diameter).toBe(2.6)
    expect(noted(added, /No soma is labelled/)).toBe(false)
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
      regionStrokes: [stroke({})],
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
    const value = build({ regionStrokes: [stroke({ scope: 'proximal', region: 'rest' })] })
    expect(value.soma).toEqual(plain.soma)
    expect(value.regionNames[value.compartments.region[value.soma.compartment]!]).toBe('rest')
  })

  it('leave an added soma soma, whatever its root was labelled or painted', () => {
    const value = build(
      { somaDiameter: 2.6, regionStrokes: [stroke({ scope: 'proximal', region: 'rest' })] },
      {},
      neuron({ labels: false }),
    )
    expect(value.soma.source).toBe('added')
    expect(value.regionNames[value.compartments.region[value.soma.compartment]!]).toBe('soma')
  })

  it('say when a stroke lands on no node of this neuron', () => {
    const value = build({ regionStrokes: [stroke({ at: [900_000, 0, 0] })] })
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
