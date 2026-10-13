/**
 * The middle step of `pnpm probe:biophys`: discretise and simulate the cases `probe-biophys.py`
 * exported, and add our sections and traces for NEURON to be compared against. See that file.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ReferenceCase } from '../src/biophys/referenceCases'
import { buildCase, neuronExport } from '../src/biophys/referenceCases'
import { simulate } from '../src/biophys/solver'

const PATH = '/tmp/coda-biophys-probe.json'
const cases = JSON.parse(readFileSync(PATH, 'utf8')) as ReferenceCase[]

const out = cases.map((c) => {
  const { request, tree } = buildCase(c)
  const t0 = performance.now()
  const result = simulate(request)
  const ms = performance.now() - t0
  return {
    ...neuronExport(c, tree),
    compartments: tree.count,
    ms,
    ours: result.v.map((v) => Array.from(v)),
  }
})
writeFileSync(PATH, JSON.stringify(out))
