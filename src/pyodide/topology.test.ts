/**
 * The one thing about the split that a JavaScript test can check: that both languages agree
 * about what the numbers mean.
 *
 * The algorithm itself is checked by `pnpm probe:split`, which runs it against navis and needs a
 * Python with navis installed — vitest has neither Pyodide nor a worker, so a test here that
 * claimed to verify the split would be verifying a mock. What *is* checkable, and what would
 * otherwise fail silently, is the compartment vocabulary: `topology.py` and `topology.ts` each
 * name the four codes, and a renumbering on one side mislabels every axon on the card without
 * throwing anything anywhere.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CODE_AXON, CODE_DENDRITE, CODE_LINKER } from '../nodes/lib/topologyOps'
import {
  COMPARTMENT_AXON,
  COMPARTMENT_DENDRITE,
  COMPARTMENT_LINKER,
  COMPARTMENT_UNASSIGNED,
  SPLIT_MULTIPLE_ROOTS,
  SPLIT_NO_SYNAPSES,
  SPLIT_OK,
} from './topology'

const SOURCE = readFileSync(fileURLToPath(new URL('./topology.py', import.meta.url)), 'utf8')

/** `NAME = 3` at the top level of the Python module. */
function pythonConstant(name: string): number {
  const match = new RegExp(`^${name} = (-?\\d+)$`, 'm').exec(SOURCE)
  if (!match) throw new Error(`topology.py declares no constant "${name}"`)
  return Number(match[1])
}

describe('the compartment vocabulary', () => {
  it.each([
    ['UNASSIGNED', COMPARTMENT_UNASSIGNED],
    ['DENDRITE', COMPARTMENT_DENDRITE],
    ['AXON', COMPARTMENT_AXON],
    ['LINKER', COMPARTMENT_LINKER],
  ])('%s means the same number on both sides', (name, ours) => {
    expect(pythonConstant(name)).toBe(ours)
  })

  it.each([
    ['OK', SPLIT_OK],
    ['MULTIPLE_ROOTS', SPLIT_MULTIPLE_ROOTS],
    ['NO_SYNAPSES', SPLIT_NO_SYNAPSES],
  ])('status %s means the same number on both sides', (name, ours) => {
    expect(pythonConstant(name)).toBe(ours)
  })

  it('agrees with the third spelling, in nodes/lib', () => {
    /*
     * `topologyOps.ts` restates these as `CODE_*` rather than importing them, because importing
     * the value would pull `engine.ts` — and a `Worker`-shaped module — into the dependency graph
     * of every table op. That is a fair trade only while something checks the two agree: without
     * this, renumbering both Python and `pyodide/topology.ts` together leaves every test green
     * while `compartmentStats` files axon cable under the dendrite column and the card's swatches
     * invert. Nothing throws; the numbers are simply wrong.
     */
    expect(CODE_DENDRITE).toBe(COMPARTMENT_DENDRITE)
    expect(CODE_AXON).toBe(COMPARTMENT_AXON)
    expect(CODE_LINKER).toBe(COMPARTMENT_LINKER)
  })

  it('keeps the four codes distinct', () => {
    const codes = [
      COMPARTMENT_UNASSIGNED,
      COMPARTMENT_DENDRITE,
      COMPARTMENT_AXON,
      COMPARTMENT_LINKER,
    ]
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('the navis defaults topology.py pins', () => {
  /*
   * Both were wrong on the first pass and neither failed loudly. `split_axon_dendrite` calls
   * `synapse_flow_centrality(x)` with no mode, and *that* function defaults to `sum` — where
   * `centrifugal` is the mode the literature discusses and the one an implementer reaches for.
   * A wrong mode gives a different linker and a neuron that still looks split.
   */
  it("uses navis's own flow mode rather than the one the literature names", () => {
    expect(/^FLOW_MODE = "sum"$/m.test(SOURCE)).toBe(true)
  })

  it('keeps the linker threshold at navis 0.9', () => {
    expect(/flow_thresh\s*=\s*float\(req\.get\("flowThresh", 0\.9\)\)/.test(SOURCE)).toBe(true)
  })

  it('keeps the axon threshold at navis 1, which navis hides inside its `split` argument', () => {
    // `split='prepost'` reads as a plain enum; the threshold is only reachable as
    // `split='prepost:0.5'`. Easy to transcribe as "no such knob" and never notice.
    expect(/^SPLIT_VAL = 1\.0$/m.test(SOURCE)).toBe(true)
    expect(/split_val\s*=\s*float\(req\.get\("splitVal", SPLIT_VAL\)\)/.test(SOURCE)).toBe(true)
  })

  it('compares against the requested axon threshold rather than the default constant', () => {
    /*
     * The silent half of exposing a knob. `np.where(ratio >= SPLIT_VAL, …)` and
     * `np.where(ratio >= split_val, …)` differ by four characters, both run, and both return a
     * plausible split — the first one simply ignores the slider. Nothing downstream can tell:
     * the compartment counts change when the *linker* threshold moves, so the panel still looks
     * responsive while one of its two controls does nothing at all.
     */
    expect(SOURCE).toContain('np.where(ratio >= split_val, AXON, DENDRITE)')
    expect(SOURCE).not.toContain('ratio >= SPLIT_VAL')
  })

  it('applies the branch-point correction navis makes after calling fastcore', () => {
    // The single largest divergence found: without it, 549 of 4,465 nodes on navis's own example
    // neuron carry a different flow and the linker is 216 nodes instead of 391.
    expect(SOURCE).toContain('is_branch = kinds == 2')
    expect(SOURCE).toContain('np.maximum.at(child_max')
  })

  it('reunites fragmented compartments through the linker', () => {
    // The last 10 nodes of disagreement. Axon first, then dendrite against what is left.
    expect(SOURCE).toContain('_connecting_nodes(parents, is_axon | (compartment == LINKER)')
    expect(SOURCE).toContain('_connecting_nodes(parents, is_dend | (compartment == LINKER)')
  })

  it("unpacks geodesic_nearest in fastcore's order, not navis's wrapper's", () => {
    // fastcore returns `(distances, nearest)`; navis's `graph._geodesic_nearest` returns them the
    // other way round. Backwards, this assigns compartments by indexing with a distance — it
    // throws nothing and leaves a plausible-looking result.
    expect(SOURCE).toContain('_, nearest = fc.geodesic_nearest(')
  })
})
