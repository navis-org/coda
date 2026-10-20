/**
 * The NEURON `.mod` files the reference harness runs are the specs', written by `pnpm biophys:mods`:
 * a hand-edit to one, or a spec changed without regenerating, is a second transcription of the
 * kinetics that the NEURON comparison would then hold the solver to.
 */

import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { libraryChannels } from './channels'
import { modFileText, modMechanism, writesMod } from './modFile'

const dir = new URL('../../scripts/biophys-mod/', import.meta.url)

describe('the generated NEURON mechanisms', () => {
  const specs = libraryChannels().filter(writesMod)

  it('are exactly what each fitted library channel writes, and nothing else', () => {
    expect(specs.length).toBeGreaterThan(0)
    const files = readdirSync(dir).filter((f) => f.endsWith('.mod'))
    expect(files.sort()).toEqual(specs.map((s) => `${modMechanism(s.id)}.mod`).sort())
    for (const spec of specs) {
      const committed = readFileSync(new URL(`${modMechanism(spec.id)}.mod`, dir), 'utf8')
      expect(committed, `${spec.id}: run pnpm biophys:mods`).toBe(modFileText(spec))
    }
  })

  it('are plain ASCII, which nocmodl requires even of comments', () => {
    for (const spec of specs) {
      const outside = [...modFileText(spec)].filter((ch) => ch.codePointAt(0)! > 0x7e)
      expect(outside, spec.id).toEqual([])
    }
  })
})
