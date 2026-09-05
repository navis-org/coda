/**
 * Making a three material see-through, and the one line everybody forgets.
 *
 * **`transparent` is not an ordinary property.** three compiles a material's program and caches
 * the blending state it implies, so assigning `transparent = true` to a material it has already
 * drawn changes nothing until `needsUpdate` says to rebuild. `opacity` is a uniform and
 * `depthWrite` is state read per draw; neither has this problem. Only `transparent` does, and it
 * is the one that decides whether the other two mean anything.
 *
 * This is here rather than inline because it was written twice and only one copy was right.
 * `FatSkeletonLines` set `needsUpdate` by hand, which is why `Skeleton opacity` always worked.
 * The point cloud set the same three fields as **declarative props on `<pointsMaterial>`**, and
 * React Three Fiber does not set `needsUpdate` for any of them — grep its dist and the only
 * occurrence is `shadowMap`. So a material that was built opaque stayed opaque.
 *
 * That failure is invisible to every check short of a rendered frame, and it hid behind a second
 * fact: a material *constructed* transparent is fine. The topology card opens with no partner
 * lit, draws one point cloud at opacity 1, and splits into a dim half and a lit half when a
 * partner is chosen — React reconciles the first by position, so the existing material is reused
 * and mutated. Every test and every screenshot that mounted the scene already split passed. The
 * user's own bisect is what named it: *close the expanded card and re-open it and the fade works*
 * — a remount constructs the material instead of mutating one.
 *
 * `depthWrite` goes off with the fade on purpose. A faded cloud that still writes depth occludes
 * whatever is behind it, so the dots somebody dimmed the rest to find would disappear behind the
 * ones they pushed back — worse than not fading at all.
 */

import type { Material } from 'three'

/**
 * Set a material's opacity, and rebuild it if that changed whether it is transparent at all.
 *
 * Call it from an effect rather than passing these as JSX props: R3F applies props on every
 * render and would overwrite `transparent` without the rebuild, leaving this function's own
 * `needsUpdate` test looking satisfied when nothing had been recompiled.
 */
export function applyOpacity(material: Material, opacity: number): void {
  const faded = opacity < 1
  /*
   * Guarded, so a slider drag inside the faded range is a uniform write rather than a recompile.
   * Note `needsUpdate` is a setter with no getter: it bumps `material.version`, which is what the
   * renderer compares against the program it cached — and what a test has to assert on.
   */
  if (material.transparent !== faded) material.needsUpdate = true
  material.transparent = faded
  material.depthWrite = !faded
  material.opacity = opacity
}
