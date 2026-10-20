/**
 * Write the synthetic biophysics cases as NEURON should build them, for `biophys-reference.py`.
 *
 *   pnpm biophys:reference
 *
 * See `src/biophys/referenceCases.ts`.
 */

import { writeFileSync } from 'node:fs'
import { REFERENCE_CASES, neuronExport } from '../src/biophys/referenceCases'

const out = process.argv[2]
if (!out) throw new Error('usage: vite-node scripts/biophys-cases.ts <out.json>')
writeFileSync(out, JSON.stringify(REFERENCE_CASES.map((c) => neuronExport(c))))
// stderr, as the other TypeScript scripts here report: `no-console` is lifted for .mjs only.
console.error(`${REFERENCE_CASES.length} cases → ${out}`)
