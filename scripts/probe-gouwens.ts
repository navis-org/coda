/**
 * The middle step of `pnpm probe:gouwens`: our model of each DM1 cell `probe-gouwens.py` exported,
 * cut by d_lambda, and the same two answers NEURON gave — the input resistance at the root, and each
 * tip's steady-state share of the root's voltage. See that file.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { leakChannel } from '../src/biophys/channels'
import { discretize } from '../src/biophys/discretize'
import type { ReferenceCase } from '../src/biophys/referenceCases'
import { caseTree } from '../src/biophys/referenceCases'
import { NO_SYNAPSES, steadyState } from '../src/biophys/solver'

const PATH = '/tmp/coda-gouwens-probe.json'
type Exported = Pick<ReferenceCase, 'tree' | 'rule' | 'ra' | 'cm' | 'gLeak' | 'eLeak'> & {
  readonly tips: readonly number[]
}
const cases = JSON.parse(readFileSync(PATH, 'utf8')) as Exported[]

const out = cases.map((c) => {
  const tree = discretize(caseTree(c), { rule: c.rule, ra: c.ra, cm: c.cm })
  const model = {
    tree,
    cm: new Float64Array(tree.count).fill(c.cm),
    channels: [{ spec: leakChannel(c.eLeak), gbar: new Float64Array(tree.count).fill(c.gLeak) }],
    temperature: 22,
    synapses: NO_SYNAPSES,
  }
  // 1 nA into the root: mV above rest is MΩ there, and a share of it everywhere else.
  const root = tree.nodeCompartment[0]!
  const injection = new Float64Array(tree.count)
  injection[root] = 1
  const v = steadyState(model, injection)
  const rin = v[root]! - c.eLeak
  const atten = c.tips.map((node) => (v[tree.nodeCompartment[node]!]! - c.eLeak) / rin)
  const nseg = tree.sections.reduce((n, s) => n + s.nseg, 0)
  return { ...c, ours: { rin, atten, nseg } }
})
writeFileSync(PATH, JSON.stringify(out))
