/**
 * Screen-space ambient occlusion for the 3D viewer: the pass, and the composer that drives it.
 *
 * Ported from octarine, where the same effect is a hand-written WGSL pass because pygfx has
 * none. three does — `GTAOPass`, ground-truth ambient occlusion — so what carries over here is
 * not the estimator but the two findings around it: that the radius has to be derived from the
 * scene's own extent (`aoRadiusFor`), and that lines and points have no surface to occlude, so
 * a scene made of them is one the effect should not be paying for at all
 * (`wantsAmbientOcclusion`). Both are in `viewer3dScene.ts` where a test can reach them.
 *
 * `GTAOPass` over `SSAOPass`, which is also in three: same effect, better estimator — GTAO
 * integrates a visibility horizon per direction where SSAO counts occluded samples, and it
 * comes with a Poisson denoise instead of a box blur.
 *
 * ### Why this is a whole `EffectComposer`
 *
 * A post-processing pass cannot run under React Three Fiber's ordinary render: R3F calls
 * `gl.render(scene, camera)` and presents. Taking the render over means `useFrame` at a
 * priority above 0, which switches R3F's own render off and makes this component responsible
 * for producing every frame. Two consequences worth naming, because both are silent:
 *
 *  - **`OutputPass` is not optional.** A composer renders into a linear float target, and the
 *    conversion to the display's colour space happens at the end of the chain rather than in
 *    the beauty pass. Without it every colour in the scene shifts — and this viewer's colours
 *    are a validated palette that has to agree with neuroglancer's hash, so a shift is a
 *    correctness bug and not a matter of taste.
 *  - **The PNG export renders its own frame** and has to render it through here, or a figure
 *    exported from a scene with AO on comes out without it. `Viewer3D` hands this component a
 *    ref for that; see `CaptureBridge`.
 *
 * ### Why it is mounted conditionally rather than switched off
 *
 * An idle `EffectComposer` still holds its render targets — two full-size colour buffers, plus
 * `GTAOPass`'s normal, AO and denoise targets. `docs/viewers.md` records what a WebGL viewer's
 * memory does when it is per-surface rather than per-node, and this is the same arithmetic one
 * level down. Not mounting is the only way to actually not pay.
 */

import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'

import { aoThicknessFor } from './viewer3dScene'

/**
 * `GTAOPass`, plus the two kinds of object in this scene that must not reach its g-buffer.
 *
 * `_renderOverride` sets `scene.overrideMaterial`, so an object's own material is replaced
 * outright — which is what makes the stock visibility pass necessary at all, and what makes
 * its list too short here.
 *
 * **Surfaces you can see through.** The replacement takes the `transparent` flag with it, so a
 * neuropil shell at 0.12 opacity writes normals and depth as though it were solid, and the
 * arbour inside it is occluded by a surface it is plainly visible through. It reads as dirt on
 * the render rather than as shading. This catches **dimming** for free, which the mount-time
 * check in `wantsAmbientOcclusion` cannot: `surfaceStyle` turns a dimmed mesh translucent, so
 * selecting one neuron drops the other twenty out of the g-buffer on the same rule as a shell.
 *
 * **Fat lines.** three's own list is `isPoints || isLine || isLine2`, and `LineSegments2` — the
 * class every skeleton drawn above a width of 1 uses — matches none of them: it is a `Mesh`
 * subclass carrying `isLineSegments2`, and `isLine2` belongs to `Line2`, which is a *different*
 * subclass this viewer does not use. So a fat skeleton was reaching the normal pass, where
 * `MeshNormalMaterial` runs over `LineSegmentsGeometry`'s instanced template quad without the
 * line shader that positions it — putting a two-unit box at the model origin into the normal
 * and depth buffers on every AO frame. Subpixel in a scene 10^5 nm across, which is why it
 * never showed; wrong regardless, and it stops being subpixel the moment somebody views a
 * single small neuron.
 *
 * Objects are pushed onto the same `_visibilityCache` the base class restores from, so nothing
 * here has to know about restoring.
 */
type GtaoInternals = {
  _overrideVisibility(): void
  _visibilityCache: THREE.Object3D[]
}

/**
 * Objects three's own `_overrideVisibility` misses, stated as the rule rather than the instance.
 *
 * The gap is generic: `_renderOverride` sets `scene.overrideMaterial`, so **the object's own
 * vertex shader does not run**. Anything whose vertices are positioned by that shader is drawn
 * somewhere else entirely in the normal and depth buffers — for `LineSegments2` that is
 * `LineSegmentsGeometry`'s instanced template quad, a two-unit box at the model origin. three's
 * list names three classes that happen to have this property (`isPoints`, `isLine`, `isLine2`)
 * and misses the one Coda actually draws, because a fat line is a `Mesh` carrying
 * `isLineSegments2` and `isLine2` belongs to `Line2`, a subclass this viewer does not use.
 *
 * Testing for a `ShaderMaterial` names the property instead of a fourth class. It catches
 * `LineSegments2` through `LineMaterial`, and it catches whatever custom-shader object gets
 * added next without anybody having to remember this. Over-exclusion is the safe direction: a
 * `ShaderMaterial` that *would* have survived the override loses only its contribution to the
 * occlusion, where a missed one puts geometry in the g-buffer that is not in the picture.
 *
 * A predicate rather than an inline test so `ambientOcclusion.test.ts` can assert it against
 * three's real classes with no GL context.
 */
export function hidesFromGtao(object: THREE.Object3D): boolean {
  const material = (object as THREE.Mesh).material
  if (!material) return false
  return Array.isArray(material)
    ? material.some((m) => (m as THREE.ShaderMaterial).isShaderMaterial === true)
    : (material as THREE.ShaderMaterial).isShaderMaterial === true
}

/**
 * Whether three still calls the hook `SurfaceGtaoPass` overrides.
 *
 * `_overrideVisibility` is a runtime internal — `@types/three` does not declare it, so a
 * rename upstream is not a type error and would not be a crash either: the base class would
 * simply call its new name and the override would never run, putting occlusion back onto the
 * shells. Silent, and looking like dirt on the render.
 *
 * Exported so `ambientOcclusion.test.ts` can check it with no GL context, the same discipline
 * `flexLineVertexShader` follows. The difference is what each does about it: the line shader
 * *throws*, because a patch that stops applying takes the whole feature with it, where this
 * one degrades to an artefact on one class of surface. A render pass that throws on a `three`
 * bump would break the viewer for everybody, which is worse than what it is guarding against.
 */
export function gtaoVisibilityHookExists(): boolean {
  const proto = GTAOPass.prototype as unknown as Partial<GtaoInternals>
  return typeof proto._overrideVisibility === 'function'
}

export class SurfaceGtaoPass extends GTAOPass {
  _overrideVisibility(): void {
    const self = this as unknown as GtaoInternals
    ;(GTAOPass.prototype as unknown as GtaoInternals)._overrideVisibility.call(this)
    this.scene.traverse((object) => {
      if (!object.visible) return
      const material = (object as THREE.Mesh).material
      const transparent = Array.isArray(material)
        ? material.some((m) => m.transparent)
        : material?.transparent
      if (transparent || hidesFromGtao(object)) {
        object.visible = false
        self._visibilityCache.push(object)
      }
    })
  }
}

/**
 * Renders every frame through a composer with an AO pass in it.
 *
 * Mounted only when `wantsAmbientOcclusion` says there is something to occlude, so the common
 * skeleton-only scene never constructs any of this.
 */
export function AmbientOcclusion({
  radius,
  intensity,
  renderFrame,
}: {
  /** In world units — nanometres here. `aoRadiusFor` derives it from the scene's extent. */
  radius: number
  /**
   * How much of the estimated occlusion reaches the image, 0 to 1.
   *
   * Straight onto `GTAOPass.blendIntensity`, which is a plain field the pass reads into its
   * blend uniform at render time — so it needs no `updateGtaoMaterial` and no rebuild, just a
   * frame. This component is never mounted at 0: that is `wantsAmbientOcclusion`'s job, and
   * compositing an image with itself is not worth four passes.
   */
  intensity: number
  /**
   * Filled with a "render one frame through the composer" function while this is mounted.
   *
   * The PNG export's read-back is the only other thing that renders, and it has to go through
   * the same chain or the file comes out without the effect that is on screen.
   */
  renderFrame: React.RefObject<(() => void) | null>
}) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)

  /*
   * The pass comes *out of* the memo rather than being stashed in a ref from inside it, and
   * that is a fix rather than a preference.
   *
   * It was `passRef.current = ao` in the memo body with `passRef.current = null` in an effect
   * cleanup, which is a mismatch: a cleanup runs on every unmount, where a `useMemo` is free
   * to hand back its cached value without re-running the body. React 19's double-invoked
   * effects are enough to trigger it — mount, clean up, mount again — and the second mount
   * reused the composer, so the ref stayed null for the rest of the component's life. The
   * symptom was that the *first* strength change applied and every later one silently did not.
   */
  const { composer, pass } = useMemo(() => {
    const made = new EffectComposer(gl)
    made.addPass(new RenderPass(scene, camera))
    const ao = new SurfaceGtaoPass(scene, camera)
    made.addPass(ao)
    // Last, and required: see the note at the top of this file.
    made.addPass(new OutputPass())
    return { composer: made, pass: ao }
    // `size` is deliberately not a dependency — a resize is `setSize`, not a rebuild.
  }, [gl, scene, camera])

  useEffect(
    () => () => {
      /*
       * The passes first, and this is the line that makes "not mounting is the only way to not
       * pay" true. `EffectComposer.dispose` frees `renderTarget1`, `renderTarget2` and its copy
       * pass — it never walks `this.passes`, so `GTAOPass`'s normal, AO and denoise targets plus
       * its two noise textures would survive every unmount, and three does not reclaim GPU
       * textures on GC. Tens of megabytes per trip through a strength of 0.
       */
      for (const pass of composer.passes) pass.dispose?.()
      composer.dispose()
    },
    [composer],
  )

  /**
   * Sizing is **CSS pixels plus a pixel ratio**, not the drawing buffer.
   *
   * `EffectComposer` multiplies by its own `_pixelRatio` on the way to every render target and
   * to every pass's `setSize`, so handing it `getDrawingBufferSize` applies the ratio twice —
   * quadruple-area targets on any retina display, sampled at the wrong scale. It reads as a
   * soft, misaligned AO rather than as an error. `setPixelRatio` is the seam that exists for
   * this and it re-runs `setSize` itself.
   */
  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio())
    composer.setSize(size.width, size.height)
    invalidate()
  }, [composer, gl, size, invalidate])

  useEffect(() => {
    /*
     * Both, together. `thickness` is a world-unit depth cutoff like `radius` is a world-unit
     * search distance, and scaling one without the other leaves the estimator rejecting every
     * sample it takes — see `aoThicknessFor` for what that looked like.
     */
    pass.updateGtaoMaterial({ radius, thickness: aoThicknessFor(radius) })
    invalidate()
  }, [pass, radius, invalidate])

  useEffect(() => {
    pass.blendIntensity = intensity
    invalidate()
  }, [pass, intensity, invalidate])

  useEffect(() => {
    renderFrame.current = () => {
      /*
       * Re-synced rather than assumed, because the export raises the pixel ratio to ≥2 for one
       * frame, so the composer's targets have to follow or the AO is sampled at half the
       * resolution it is composited at. `RenderTarget.setSize` no-ops when the numbers already
       * match, so the ordinary path pays nothing for this.
       */
      const css = new THREE.Vector2()
      gl.getSize(css)
      composer.setPixelRatio(gl.getPixelRatio())
      composer.setSize(css.x, css.y)
      composer.render()
    }
    return () => {
      renderFrame.current = null
    }
  }, [composer, gl, renderFrame])

  /*
   * Priority 1 takes the render away from R3F. Under `frameloop="demand"` this still runs only
   * when something asked for a frame, so an idle card costs nothing here either.
   */
  useFrame(() => composer.render(), 1)

  return null
}
