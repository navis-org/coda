/**
 * The one rule that four fixes to "unlit synapses are opaque" all missed.
 *
 * Runs against real three materials — no WebGL is needed to construct one, which is the whole
 * reason this is a test and not a fifth browser probe. What a browser had to say is recorded in
 * `materialOpacity.ts`; what is checkable here is that flipping transparency asks three to
 * rebuild, which is the step whose absence is invisible until a frame is drawn.
 */

import { describe, expect, it } from 'vitest'
import { PointsMaterial } from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

import { applyOpacity } from './materialOpacity'

describe('fading a material that has already been drawn', () => {
  /*
   * **`version`, not `needsUpdate`.** `Material.needsUpdate` is a setter with no getter — it
   * increments `version`, which is what the renderer compares against the program it cached — so
   * reading it back gives `undefined` and an assertion on it passes or fails for the wrong
   * reason. `version` is the thing three actually consults, which makes it the honest observable.
   */
  const drawn = () => new PointsMaterial({ vertexColors: true })

  it('rebuilds when a solid material becomes transparent', () => {
    /*
     * The bug, exactly. The card opens with no partner lit and draws one opaque cloud; lighting a
     * partner reuses that material for the dim half. Without the rebuild three keeps the program
     * and blending state it compiled while `transparent` was false, so the cloud stays solid and
     * the opacity slider does nothing to it — for as long as the card stays open.
     */
    const material = drawn()
    const before = material.version
    applyOpacity(material, 0.1)
    expect(material.transparent).toBe(true)
    expect(material.opacity).toBe(0.1)
    expect(material.version).toBeGreaterThan(before)
  })

  it('rebuilds again on the way back to solid', () => {
    const material = drawn()
    material.transparent = true
    const before = material.version
    applyOpacity(material, 1)
    expect(material.transparent).toBe(false)
    expect(material.version).toBeGreaterThan(before)
  })

  it('does not rebuild for a move inside the faded range', () => {
    // A slider drag is a uniform write. Recompiling per pointermove would rebuild a shader sixty
    // times a second for a number the program does not depend on.
    const material = drawn()
    applyOpacity(material, 0.1)
    const before = material.version
    applyOpacity(material, 0.4)
    expect(material.opacity).toBe(0.4)
    expect(material.version).toBe(before)
  })

  it('takes depth writing off with the fade and puts it back', () => {
    /*
     * Not cosmetic: a faded cloud that still writes depth occludes what is behind it, so the dots
     * somebody dimmed the rest to find disappear behind the ones they pushed back.
     */
    const material = drawn()
    applyOpacity(material, 0.2)
    expect(material.depthWrite).toBe(false)
    applyOpacity(material, 1)
    expect(material.depthWrite).toBe(true)
  })

  it('works on the fat-line material too, whose opacity is a shader uniform', () => {
    /*
     * `LineMaterial.opacity` is a getter/setter onto `uniforms.opacity`, not a plain field — so
     * one function has to serve both or the skeleton and the synapses fade by different rules.
     * This is the copy that was already right, kept honest by sharing the code.
     */
    const material = new LineMaterial({ vertexColors: true })
    const before = material.version
    applyOpacity(material, 0.3)
    expect(material.opacity).toBe(0.3)
    expect(material.transparent).toBe(true)
    expect(material.version).toBeGreaterThan(before)
  })
})
