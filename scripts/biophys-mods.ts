/**
 * Write `scripts/biophys-mod/`: every fitted library channel as a NEURON `.mod`, from its spec.
 *
 *   pnpm biophys:mods
 *
 * `pnpm biophys:reference` runs this first. See `src/biophys/modFile.ts`.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { libraryChannels } from '../src/biophys/channels'
import { modFileText, modMechanism, writesMod } from '../src/biophys/modFile'

const DIR = fileURLToPath(new URL('./biophys-mod/', import.meta.url))
const specs = libraryChannels().filter(writesMod)
const written = new Set(specs.map((s) => `${modMechanism(s.id)}.mod`))
for (const spec of specs) {
  const path = DIR + `${modMechanism(spec.id)}.mod`
  const text = modFileText(spec)
  // Only a change is written: a new mtime is what tells the harness to recompile.
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text)
}
// A `.mod` no spec writes any more is a channel the library dropped.
for (const f of readdirSync(DIR)) if (f.endsWith('.mod') && !written.has(f)) rmSync(DIR + f)
console.error(`${specs.length} mechanisms → ${DIR}`)
