/**
 * The one thing about the AO pass a test without WebGL can check, and it is the one that
 * would otherwise fail silently.
 *
 * `SurfaceGtaoPass` exists to stop translucent surfaces casting occlusion, and it does that by
 * overriding a method `@types/three` does not declare. A rename upstream is therefore not a
 * type error and not a crash — the base class would call its new name, the override would
 * never run, and neuropil shells would start darkening the arbours you can see through them.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'

import { gtaoVisibilityHookExists, hidesFromGtao } from './ambientOcclusion'
import { aoRadiusFor, aoThicknessFor, wantsAmbientOcclusion } from './viewer3dScene'

describe('SurfaceGtaoPass', () => {
  it('still has three’s visibility hook to extend', () => {
    expect(gtaoVisibilityHookExists()).toBe(true)
  })
})

describe('wantsAmbientOcclusion', () => {
  it('declines a scene of skeletons, which is most of them', () => {
    /*
     * Not a cost optimisation — every line and point is hidden before the normal buffer is
     * rendered (`GTAOPass` hides the first two classes, `hidesFromGtao` the fat-line one), so
     * the estimator would run over an empty g-buffer and blend a uniform white result: four
     * passes and three render targets to multiply the image by 1.
     */
    expect(
      wantsAmbientOcclusion({
        strength: 1,
        meshes: 0,
        meshOpacity: 1,
        volumes: 0,
        volumeOpacity: 0.12,
      }),
    ).toBe(false)
  })

  it('takes a scene with opaque meshes in it', () => {
    expect(
      wantsAmbientOcclusion({
        strength: 1,
        meshes: 3,
        meshOpacity: 1,
        volumes: 0,
        volumeOpacity: 0.12,
      }),
    ).toBe(true)
  })

  it('declines when the only surfaces are ones you can see through', () => {
    // A shell at 0.12 is context. Occluding the arbour inside it with a surface the arbour is
    // plainly visible through reads as dirt on the render rather than as shading.
    expect(
      wantsAmbientOcclusion({
        strength: 1,
        meshes: 0,
        meshOpacity: 1,
        volumes: 63,
        volumeOpacity: 0.12,
      }),
    ).toBe(false)
    expect(
      wantsAmbientOcclusion({
        strength: 1,
        meshes: 4,
        meshOpacity: 0.5,
        volumes: 0,
        volumeOpacity: 0.12,
      }),
    ).toBe(false)
  })

  it('takes a volume set somebody has made solid', () => {
    // Same rule from the other side: opacity decides, not which socket it arrived on.
    expect(
      wantsAmbientOcclusion({
        strength: 1,
        meshes: 0,
        meshOpacity: 1,
        volumes: 5,
        volumeOpacity: 1,
      }),
    ).toBe(true)
  })

  it('reads a strength of 0 as off, whatever is in the scene', () => {
    /*
     * 0 is the off state rather than a weak one, which is what lets one number replace a
     * toggle plus a strength. The blend is `mix(vec3(1.), ao, intensity)`, so at 0 the pass
     * composites the image with itself — four passes to change nothing.
     */
    expect(
      wantsAmbientOcclusion({
        strength: 0,
        meshes: 30,
        meshOpacity: 1,
        volumes: 5,
        volumeOpacity: 1,
      }),
    ).toBe(false)
  })

  it('mounts for any strength above 0, including a barely visible one', () => {
    expect(
      wantsAmbientOcclusion({
        strength: 0.05,
        meshes: 30,
        meshOpacity: 1,
        volumes: 0,
        volumeOpacity: 0.12,
      }),
    ).toBe(true)
  })

  it('treats a missing or nonsense strength as off rather than as full', () => {
    // `NaN > 0` is false, which is the answer that cannot darken a scene by surprise.
    expect(
      wantsAmbientOcclusion({
        strength: Number.NaN,
        meshes: 30,
        meshOpacity: 1,
        volumes: 0,
        volumeOpacity: 0.12,
      }),
    ).toBe(false)
  })
})

describe('aoThicknessFor', () => {
  it('follows the radius, because it is a world-unit cutoff too', () => {
    /*
     * The bug this exists to prevent, and it presented as "the slider does nothing at any
     * setting". `GTAOShader` rejects a sample with `if (abs(viewDelta.z) < thickness)`, so at
     * three's default of 1 the cutoff is *one nanometre*: with a 555 nm search radius every
     * sample failed the test, the horizon never moved, and the pass blended a uniform white.
     * Scaling `radius` alone was half a port — a library's world-unit defaults are a set that
     * agree with each other, and all of them have to move together.
     */
    expect(aoThicknessFor(555)).toBe(2220)
    expect(aoThicknessFor(aoRadiusFor(100_000))).toBe(16_000)
  })

  it('keeps three’s own ratio between the two', () => {
    // `GTAOShader` ships `radius: 0.25` beside `thickness: 1`.
    expect(aoThicknessFor(0.25)).toBe(1)
  })
})

describe('aoRadiusFor', () => {
  it('scales with the scene, because a constant is a radius of nothing here', () => {
    /*
     * `GTAOPass` defaults to 0.25 world units — sensible in metres, a quarter of a nanometre
     * in a connectome. The search never leaves the pixel it started in and the effect renders
     * and does nothing, which is the same failure three's 1-unit raycast threshold produced
     * for picking.
     */
    expect(aoRadiusFor(100_000)).toBe(4000)
    expect(aoRadiusFor(1_000)).toBe(40)
  })

  it('has an answer for the placeholder extent of an empty scene', () => {
    // `framingFor(undefined)` reports 1. Meaningless but harmless — there is nothing to occlude.
    expect(aoRadiusFor(1)).toBeGreaterThan(0)
    expect(aoRadiusFor(0)).toBeGreaterThan(0)
  })
})

describe('hidesFromGtao', () => {
  it('catches the fat-line class three’s own visibility pass misses', () => {
    /*
     * The bug this exists for: `_overrideVisibility` tests `isPoints || isLine || isLine2`,
     * and `LineSegments2` is a `Mesh` subclass carrying none of them. So a skeleton drawn
     * above a width of 1 reached the normal pass with `MeshNormalMaterial` swapped in, and
     * `LineSegmentsGeometry`'s instanced template quad drew a two-unit box at the model origin
     * into the depth and normal buffers.
     */
    const fat = new LineSegments2() as unknown as Record<string, unknown>
    // Read as runtime flags, which is how `_overrideVisibility` reads them. `@types/three`
    // does not declare `isLine`/`isLine2` on this class at all — so the type system agrees
    // with the finding and still could not have caught the bug, because three's test is
    // untyped property access on an `Object3D`.
    expect(fat.isLine).toBeUndefined()
    expect(fat.isLine2).toBeUndefined()
    expect(fat.isMesh).toBe(true)
    expect(hidesFromGtao(fat as unknown as THREE.Object3D)).toBe(true)
  })

  it('leaves the meshes that are the whole point of the pass alone', () => {
    // The scene's surfaces are `MeshStandardMaterial`, which `MeshNormalMaterial` can stand in
    // for exactly — same built-in vertex path, so the override positions them correctly.
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    expect(hidesFromGtao(mesh)).toBe(false)
    expect(hidesFromGtao(new THREE.Points())).toBe(false)
  })

  it('states the rule rather than the class, so the next custom shader is covered too', () => {
    /*
     * `LineSegments2` is caught because `LineMaterial` is a `ShaderMaterial`, not because it is
     * named. Anything whose vertex shader does the positioning is drawn somewhere else entirely
     * once `scene.overrideMaterial` replaces it, and that is the property worth testing for.
     */
    const custom = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial())
    expect(hidesFromGtao(custom)).toBe(true)
    // A multi-material object counts if any slot is one.
    const mixed = new THREE.Mesh(new THREE.BufferGeometry(), [
      new THREE.MeshStandardMaterial(),
      new THREE.ShaderMaterial(),
    ])
    expect(hidesFromGtao(mixed)).toBe(true)
  })
})
