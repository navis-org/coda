/**
 * The Compartment Model's two synapse sockets as params: the excitatory socket keeps the ids a
 * saved graph has, the inhibitory one is the same names prefixed; a preset hides the numbers it
 * sets, g max only where it states one; and a socket offers only its own sign's presets.
 */

import { describe, expect, it, vi } from 'vitest'

import { defaultParams } from '../../core/node'
import type { ParamDef } from '../../core/node'
import { modelNode } from './model'
import {
  EXCITATORY,
  INHIBITORY,
  socketRefusal,
  synapseParams,
  synapseInput,
  synapseType,
} from './synapseParams'
import { cloud } from './testFixtures'
import { SYNAPSE_PRESETS } from './synapsePresets'

const ids = (params: ParamDef[]) => params.map((p) => p.id)
const shown = (params: ParamDef[], values: Record<string, unknown>) =>
  params.filter((p) => !p.visibleIf || p.visibleIf(values as never)).map((p) => p.id)

describe('synapseParams', () => {
  it('keeps the excitatory socket’s ids, and prefixes the inhibitory one’s', () => {
    expect(ids(synapseParams(EXCITATORY))).toEqual([
      'presynaptic',
      'postsynaptic',
      'orientation',
      'polarity',
      'partnerType',
      'synapsePreset',
      'gmax',
      'tau1',
      'tau2',
      'eRev',
      'delay',
    ])
    expect(ids(synapseParams(INHIBITORY))).toEqual([
      'inhPresynaptic',
      'inhPostsynaptic',
      'inhOrientation',
      'inhPolarity',
      'inhPartnerType',
      'inhSynapsePreset',
      'inhGmax',
      'inhTau1',
      'inhTau2',
      'inhERev',
      'inhDelay',
    ])
    expect(
      (modelNode.inputs ?? []).map((port) => ('id' in port ? port.id : undefined)),
    ).toEqual(['neuron', 'synapses', 'inhSynapses'])
  })

  it('offers each socket its own sign’s presets, and starts inhibitory on GABA_A', () => {
    const options = (params: ParamDef[], id: string) => {
      const param = params.find((p) => p.id === id)
      return param?.kind === 'enum' && Array.isArray(param.options)
        ? param.options.map((o) => o.value)
        : []
    }
    expect(options(synapseParams(EXCITATORY), 'synapsePreset')).toEqual([
      'orn-pn-nicotinic',
      'nicotinic-cultured',
      'pn-kc-nicotinic',
      'custom',
    ])
    expect(options(synapseParams(INHIBITORY), 'inhSynapsePreset')).toEqual([
      'gaba-a',
      'glutamate-glucl',
      'custom',
    ])
    const fresh = defaultParams(modelNode)
    expect(fresh.synapsePreset).toBe('custom')
    expect(fresh.inhSynapsePreset).toBe('gaba-a')
  })

  it('hides what a preset sets, g max only where the preset states one', () => {
    const exc = synapseParams(EXCITATORY)
    const numbers = ['gmax', 'tau1', 'tau2', 'eRev']
    const visible = (preset: string) =>
      shown(exc, { synapsePreset: preset }).filter((id) => numbers.includes(id))
    expect(visible('custom')).toEqual(numbers)
    expect(visible('nicotinic-cultured')).toEqual(['gmax'])
    expect(visible('orn-pn-nicotinic')).toEqual([])
  })

  it('reads a socket’s mechanism: the preset’s numbers, the card’s g max where it states none', () => {
    const fresh = defaultParams(modelNode)
    // A graph from before presets: Custom, with the numbers it was saved with.
    expect(synapseType(fresh, EXCITATORY)).toEqual({
      scheme: 'exp2syn',
      sign: 'excitatory',
      tau1: 0.1,
      tau2: 10,
      eRev: 0,
      gmax: 0.0005,
      delay: 1,
    })
    const gaba = SYNAPSE_PRESETS.find((p) => p.id === 'gaba-a')!
    expect(synapseType(fresh, INHIBITORY)).toMatchObject({
      sign: 'inhibitory',
      preset: { id: 'gaba-a', label: gaba.label },
      tau1: gaba.tau1,
      tau2: gaba.tau2,
      eRev: gaba.eRev,
      gmax: 0.0005,
    })
    // 0.1 nS stated by the preset, whatever the card says; µS in the value.
    expect(
      synapseType({ ...fresh, synapsePreset: 'orn-pn-nicotinic', gmax: 7 }, EXCITATORY).gmax,
    ).toBeCloseTo(0.0001, 12)
    // A preset of the other sign is not this socket's: Custom.
    expect(
      synapseType({ ...fresh, synapsePreset: 'gaba-a' }, EXCITATORY).preset,
    ).toBeUndefined()
  })

  it('refuses pickers that cannot tell this neuron’s inputs from its outputs', () => {
    const columns =
      (map: Record<string, string>) =>
      (id: string): string | undefined =>
        map[id]
    const fresh = defaultParams(modelNode)
    // A Synapses cloud with no partner column: rule 3 puts both ends on neuronId.
    expect(
      socketRefusal(
        columns({ presynaptic: 'neuronId', postsynaptic: 'neuronId' }),
        fresh,
        EXCITATORY,
      ),
    ).toMatch(/^Synapses \(exc\.\): Presynaptic and Postsynaptic both read "neuronId"/)
    // Polarity with no Presynaptic column: swapping a row's ends empties it.
    expect(
      socketRefusal(
        columns({ inhPostsynaptic: 'neuronId' }),
        { ...fresh, inhOrientation: 'polarity' },
        INHIBITORY,
      ),
    ).toMatch(/^Synapses \(inh\.\): reading ends from a polarity column needs a Presynaptic/)
    // Synapses Between's two ends, or no Presynaptic under fixed orientation: fine.
    expect(
      socketRefusal(
        columns({ presynaptic: 'neuronId', postsynaptic: 'partnerId' }),
        fresh,
        EXCITATORY,
      ),
    ).toBeUndefined()
    expect(
      socketRefusal(columns({ postsynaptic: 'partnerId' }), fresh, EXCITATORY),
    ).toBeUndefined()
  })

  it('warns where None under fixed orientation meets a cloud with outputs in a polarity column', () => {
    const fresh = defaultParams(modelNode)
    const warn = vi.fn()
    const ctx = (rows: Parameters<typeof cloud>[0]) =>
      ({
        input: () => cloud(rows),
        column: (id: string) => (id === 'postsynaptic' ? 'neuronId' : undefined),
        params: fresh,
        warn,
      }) as unknown as Parameters<typeof synapseInput>[0]
    synapseInput(ctx([['7', '-', 'post', 45_000, 0]]), EXCITATORY)
    expect(warn).not.toHaveBeenCalled()
    synapseInput(ctx([['7', '-', 'pre', 45_000, 0]]), EXCITATORY)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/polarity column with outputs/))
  })
})
