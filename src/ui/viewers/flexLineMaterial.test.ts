/**
 * The one part of the fat-line path a test without WebGL can reach.
 *
 * `FlexLineMaterial` works by rewriting five sites across three's own `line` shaders, which
 * makes it exactly the kind of thing that breaks silently: a three upgrade that renames a
 * variable or moves a branch leaves the patch matching nothing, the material compiles, and
 * every skeleton draws at the uniform width with no error anywhere. `ShaderLib` is plain text
 * and needs no GL context, so the patch itself is testable even though nothing that *renders*
 * it is.
 */

import { describe, expect, it } from 'vitest'
import { ShaderLib } from 'three'

import {
  MIN_WORLD_PIXELS,
  flexLineFragmentShader,
  flexLineVertexShader,
} from './flexLineMaterial'

/**
 * The `varying` declarations a source makes, sorted. The two stages must agree to link.
 *
 * Sorted rather than in source order, because three itself declares `vLineDistance` in a
 * different position in each stage — comparing order would fail on stock three and say
 * nothing about this patch.
 */
const varyings = (source: string): string[] =>
  source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('varying '))
    .sort()

describe('flexLineVertexShader', () => {
  it('still finds all four of its anchors in the installed three', () => {
    // The assertion that earns this file: if this throws after a `three` bump, the taper is
    // gone and nothing else would have said so.
    expect(() => flexLineVertexShader()).not.toThrow()
  })

  it('declares the two width attributes beside the colour pair it is modelled on', () => {
    const patched = flexLineVertexShader()
    expect(patched).toContain('attribute float instanceWidthStart;')
    expect(patched).toContain('attribute float instanceWidthEnd;')
  })

  it('reads the width per vertex where the screen-space branch read the uniform', () => {
    const patched = flexLineVertexShader()
    expect(patched).toContain(
      'offset *= ( position.y < 0.5 ) ? instanceWidthStart : instanceWidthEnd;',
    )
    // The stock statement is gone rather than shadowed: a leftover `offset *= linewidth`
    // would multiply the width in twice.
    expect(patched).not.toContain('offset *= linewidth;')
  })

  it('extrudes the world-units box per vertex, with a pixel floor under it', () => {
    const patched = flexLineVertexShader()
    expect(patched).toContain('float hw = ( ( position.y < 0.5 ) ? vWidthStart : vWidthEnd ) * 0.5;')
    expect(patched).not.toContain('float hw = linewidth * 0.5;')
    // Both cameras through one expression: `clip.w` is the view depth under a perspective
    // projection and 1 under an orthographic one.
    expect(patched).toContain('float worldPerPixel = 2.0 / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );')
    expect(patched).toContain(`float minWidth = ${MIN_WORLD_PIXELS.toFixed(1)} * worldPerPixel;`)
    expect(patched).toContain('vWidthStart = max( instanceWidthStart, minWidth * abs( clipStart.w ) );')
    expect(patched).toContain('vWidthEnd = max( instanceWidthEnd, minWidth * abs( clipEnd.w ) );')
  })

  it('leaves the rest of three’s shader alone', () => {
    const stock = ShaderLib.line!.vertexShader
    const patched = flexLineVertexShader()
    // The clip-space trim near the camera plane, the endcaps and the branch structure are all
    // untouched — the point of patching rather than writing a shader is inheriting them.
    expect(patched).toContain('trimSegmentAlpha')
    expect(patched).toContain('#ifdef WORLD_UNITS')
    // The depth flattening that makes consecutive segments overlap, and the reason a
    // world-units line is not a surface anything can shade. See the note in the module.
    expect(patched).toContain('clip.z = clipPose.z * clip.w;')
    expect(patched.length).toBeGreaterThan(stock.length)
  })

  it('throws, rather than quietly not patching, when a site has moved', () => {
    /*
     * octarine's `pcf.py` warns and falls back in the same situation, and the difference is
     * the point: that is an always-on tweak whose stock behaviour is still correct, where
     * `by radius` is a mode somebody selected by name. Falling back silently would draw a
     * uniform width at four times the vertex cost and report nothing.
     */
    expect(() => flexLineVertexShader('void main() {}')).toThrow(/no longer applies/)
  })
})

describe('flexLineFragmentShader', () => {
  it('still finds both of its anchors in the installed three', () => {
    expect(() => flexLineFragmentShader()).not.toThrow()
  })

  it('carves the tube at the cone’s radius rather than at one radius per segment', () => {
    const patched = flexLineFragmentShader()
    expect(patched).toContain('float norm = len / mix( vWidthStart, vWidthEnd, params.x );')
    // Leaving the stock line in would carve at the uniform width inside a box built at the
    // per-vertex one — a widened box with an unchanged silhouette, i.e. no visible taper.
    expect(patched).not.toContain('float norm = len / linewidth;')
  })

  it('scales the view ray to the segment instead of three’s 1e5', () => {
    /*
     * The bug this catches, and it is a unit bug rather than a maths one: `1e5` is a long ray
     * in a scene measured in metres and 100 µm in one measured in nanometres. Past that the
     * ray stops short of the neuron, `closestLineToLine` clamps to the ray's own end, and every
     * fragment discards — the skeleton vanishes whole, in one zoom step, with nothing in the
     * frame to say why. Measured: a neuron drawn `to scale` disappeared between an on-screen
     * extent of 73 px and 60 px while the screen-space modes drew on down to 32 px.
     */
    const patched = flexLineFragmentShader()
    expect(patched).toContain(
      'vec3 rayEnd = normalize( worldPos.xyz ) * 2.0 * max( length( worldStart ), length( worldEnd ) );',
    )
    // The stock statement, not the string: the replacement's own comment names 1e5 to say
    // what it is replacing.
    expect(patched).not.toContain('normalize( worldPos.xyz ) * 1e5')
  })

  it('throws when its site has moved', () => {
    expect(() => flexLineFragmentShader('void main() {}')).toThrow(/no longer applies/)
  })
})

describe('the two stages together', () => {
  it('declare the same varyings, which is what lets the program link', () => {
    /*
     * The world-units width is the one thing that has to cross the stage boundary, and a
     * varying declared in one stage and not the other is a link error at first draw — in a
     * viewer jsdom cannot render, so nowhere a test would otherwise see it.
     */
    expect(varyings(flexLineVertexShader())).toEqual(varyings(flexLineFragmentShader()))
    expect(varyings(flexLineVertexShader())).toContain('varying float vWidthStart;')
    expect(varyings(flexLineVertexShader())).toContain('varying float vWidthEnd;')
  })
})
