/**
 * The pack's two drawings are Skeletons' arbour with a mark on top, copied rather than imported
 * (`ui/glyphs.ts` loads the pack tables eagerly, so a value import back from it would read the
 * shapes before they exist). This holds the copy to the original: redraw Skeletons and the two
 * cards must follow.
 */

import { describe, expect, it } from 'vitest'

import { NODE_GLYPHS } from '../../ui/glyphs'

/** A shape with its fading stripped: the simulate glyph draws the arbour faint. */
const plain = ([tag, attrs]: readonly [
  string,
  Readonly<Record<string, string>>,
  ...unknown[],
]) => {
  const { strokeOpacity: _faint, ...rest } = attrs
  return [tag, rest]
}

describe('the biophysics glyphs', () => {
  it('draw the arbour exactly as Skeletons does', () => {
    const arbour = NODE_GLYPHS['neuron.skeletons']!.map(plain)
    for (const type of ['biophys:model', 'biophys:simulate']) {
      expect(NODE_GLYPHS[type]!.slice(0, arbour.length).map(plain), type).toEqual(arbour)
    }
  })
})
