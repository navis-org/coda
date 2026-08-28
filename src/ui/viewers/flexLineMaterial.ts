/**
 * `LineMaterial` with a width per vertex instead of one width for the whole line.
 *
 * three's fat-line stack (`LineSegments2` + `LineMaterial`) takes a single `linewidth` uniform,
 * so a skeleton drawn through it is a constant-calibre wire — which is exactly the thing a
 * neuron is not. Every source Coda reads publishes a radius per node and
 * `SkeletonGeometry.radii` has carried them all along; this is what lets the viewer draw them.
 *
 * **It is a patch to three's own shader, not a shader of its own**, and that is deliberate. The
 * stock `line` shader already solves the hard parts — the camera-facing quad, the endcaps, the
 * clip-space trim near the camera plane, the round-cap anti-aliasing — and reimplementing them
 * to change how one number is read would mean inheriting none of the fixes upstream makes to
 * any of it. `ShaderLib['line']` is plain text and `LineMaterial extends ShaderMaterial`, so a
 * subclass that rewrites the sites where the width is read is the whole change.
 *
 * The same approach as `octarine/shaders/lines.py` takes against pygfx's `line.wgsl` — the two
 * viewers hit the identical limitation one graphics API apart, and pygfx's `thickness_space`
 * is what the two width spaces below are called over there.
 *
 * ### Two width spaces, five sites
 *
 * The stock shader reads `linewidth` in three places, and which of them matter depends on
 * `worldUnits`:
 *
 *  - **Screen space** (`worldUnits: false`), where a width is in CSS pixels. One site:
 *    `offset *= linewidth` in the vertex shader. The anti-aliasing runs in the normalised
 *    `vUv` space that the quad's own extent already scales, so a width per vertex needs no
 *    varying and no fragment change at all.
 *  - **World units** (`worldUnits: true`), where a width is in the scene's own units — which
 *    for every source Coda reads is nanometres, so this is the mode that draws a 200 nm
 *    neurite 200 nm wide and thickens it as you zoom in. Two sites, and they have to agree:
 *    `hw` in the vertex shader extrudes the box, and `len / linewidth` in the fragment shader
 *    carves the tube out of it. Patching only the first widens the box and leaves the silhouette
 *    where it was, i.e. draws nothing extra; patching only the second carves a tube wider than
 *    its own box and clips it flat.
 *
 * Both spaces are patched into one shader source, guarded by the `WORLD_UNITS` define that was
 * already deciding between them, so `worldUnits` stays a runtime flag rather than a second
 * material class.
 *
 * ### What world units do *not* buy
 *
 * A world-units line looks like a tube and is not one, and the difference is worth naming
 * because it is invisible until something else reads the depth buffer. The geometry is still a
 * camera-facing box; the tube is *discarded* out of it in the fragment shader; and the vertex
 * shader deliberately overwrites depth with the depth of the segment's nearer endpoint
 * (`clip.z = clipPose.z * clip.w`) so that consecutive segments overlap without z-fighting. So
 * the depth buffer holds a staircase of flat discs rather than a surface, and the pass in
 * `ambientOcclusion.tsx` — which reads depth and normals, and replaces every material with
 * `MeshNormalMaterial` besides — cannot shade one of these. Skeletons in AO would need real
 * swept geometry, which is a different feature and a much larger one.
 *
 * ### The endcaps come out right for free
 *
 * In both spaces the width is applied *after* the endcap extension, so scaling by the vertex's
 * own width gives each end of a segment the cap of the node it sits on — a segment between two
 * different calibres is drawn as a trapezoid in screen space and as a cone in world units. That
 * is what makes a taper continuous across a node rather than stepping at every join.
 */

import { InstancedInterleavedBuffer, InterleavedBufferAttribute, ShaderLib } from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

/**
 * The screen width a world-units line is widened up to, in CSS pixels.
 *
 * A world-units width has no lower bound of its own: a node whose source recorded no radius is
 * 0 nm wide and draws as nothing, and *every* node draws as nothing once the camera is far
 * enough out — a whole-brain view is around 1 µm per pixel, which is wider than most of an
 * arbour. Both read as missing data rather than as a zoom level.
 *
 * pygfx applies the same floor at `1.415 / l2p` (√2, for the diagonal) and three does not, so
 * this is the one part of the world-units path that is an addition rather than a substitution.
 *
 * `MIN_LINE_WIDTH` in `viewer3dScene.ts` is the screen-space twin, at 1 rather than 1.5. Its
 * note carries why they are apart and why they disagree; change neither without the other.
 */
export const MIN_WORLD_PIXELS = 1.5

/*
 * Every anchor below is written as explicit `\t` escapes rather than as a template literal
 * holding real tabs. three's shader sources are tab-indented and an anchor is matched byte for
 * byte, so an editor or a formatter that converts indentation to spaces would turn all five of
 * these into a throw — and the tabs would be invisible in the diff that did it.
 */
const glsl = (...lines: string[]): string => lines.join('\n')

/**
 * Where the widths are declared, mirroring the two `instanceColor*` attributes beside them.
 *
 * Anchored on the colour attributes rather than on the `linewidth` uniform because the colour
 * pair is what these are modelled on: same interleaved layout, same start/end split, same
 * `position.y < 0.5` selection in the body. Outside either `#ifdef`, so both spaces see them.
 */
const DECLARE_ANCHOR = glsl(
  '\t\tattribute vec3 instanceColorStart;',
  '\t\tattribute vec3 instanceColorEnd;',
)

const DECLARE_PATCH = glsl(
  DECLARE_ANCHOR,
  '',
  '\t\tattribute float instanceWidthStart;',
  '\t\tattribute float instanceWidthEnd;',
)

/**
 * Where the width is applied in the screen-space (`#else`) branch of the vertex shader.
 *
 * The comment above the line is part of the anchor on purpose. `offset *= linewidth;` on its
 * own is a short, plausible string; keeping three's own comment with it means a version that
 * has moved this logic somewhere else fails the match instead of patching the wrong statement.
 */
const APPLY_ANCHOR = glsl('\t\t\t\t// adjust for linewidth', '\t\t\t\toffset *= linewidth;')

const APPLY_PATCH = glsl(
  '\t\t\t\t// adjust for linewidth — per vertex, so a segment between two calibres',
  '\t\t\t\t// is a trapezoid and the endcap above takes the width of its own node',
  '\t\t\t\toffset *= ( position.y < 0.5 ) ? instanceWidthStart : instanceWidthEnd;',
)

/**
 * The two varyings the world-units fragment shader needs, declared beside three's own.
 *
 * The identical three lines appear in the vertex and the fragment shader, which is why this is
 * applied to each source separately rather than to one concatenated string — a single global
 * replace would be ambiguous between them, and the two must stay in step or the program does
 * not link.
 */
const VARYING_ANCHOR = glsl(
  '\t\t\tvarying vec4 worldPos;',
  '\t\t\tvarying vec3 worldStart;',
  '\t\t\tvarying vec3 worldEnd;',
)

const VARYING_PATCH = glsl(
  VARYING_ANCHOR,
  '\t\t\tvarying float vWidthStart;',
  '\t\t\tvarying float vWidthEnd;',
)

/**
 * Where the box is extruded in the world-units branch, and where the pixel floor goes.
 *
 * `clipStart`/`clipEnd` are already in scope. Their `w` is the view depth under a perspective
 * projection and exactly 1 under an orthographic one, which is the whole difference between
 * the two world-units-per-pixel formulas — so one expression covers both cameras, and
 * `projectionMatrix[1][1]` (`1/tan(fov/2)`, or `2/(top-bottom)`) is the other half of it.
 *
 * The floored widths go into the varyings rather than the raw attributes, because the fragment
 * shader has to carve the tube at the same width the box was built at. Flooring in one and not
 * the other is the "widened box, unchanged silhouette" failure named at the top.
 */
const WORLD_ANCHOR = glsl('\t\t\t\t// height offset', '\t\t\t\tfloat hw = linewidth * 0.5;')

const WORLD_PATCH = glsl(
  '\t\t\t\t// height offset — per vertex, so a segment between two calibres is a cone,',
  `\t\t\t\t// and floored to ${MIN_WORLD_PIXELS.toFixed(1)} px on screen so a node whose source recorded no`,
  '\t\t\t\t// radius is still a hairline rather than nothing at all',
  '\t\t\t\tfloat worldPerPixel = 2.0 / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );',
  `\t\t\t\tfloat minWidth = ${MIN_WORLD_PIXELS.toFixed(1)} * worldPerPixel;`,
  '\t\t\t\tvWidthStart = max( instanceWidthStart, minWidth * abs( clipStart.w ) );',
  '\t\t\t\tvWidthEnd = max( instanceWidthEnd, minWidth * abs( clipEnd.w ) );',
  '\t\t\t\tfloat hw = ( ( position.y < 0.5 ) ? vWidthStart : vWidthEnd ) * 0.5;',
)

/**
 * Where the tube is carved out of the box, in the world-units fragment shader.
 *
 * `params.x` is where the view ray comes closest to the segment, already clamped to `[0, 1]` by
 * three's own `closestLineToLine`, so interpolating the two widths there is the radius of the
 * cone at that point. Strictly this is the radius measured perpendicular to the *axis* rather
 * than to the cone's surface, so the silhouette is off by the cosine of the taper half-angle;
 * across a node-to-node radius change that is far below a pixel.
 */
const NORM_ANCHOR = '\t\t\t\tfloat norm = len / linewidth;'

/**
 * Where the view ray is built, and where three assumes the scene is a few units across.
 *
 * `normalize( worldPos.xyz ) * 1e5` is a ray from the camera through this fragment, made long
 * enough to pass the segment — in a scene measured in metres. Coda's are measured in
 * **nanometres**, so 1e5 is 100 µm, and the moment the camera is further from a neuron than
 * that the ray stops short of it. `closestLineToLine` clamps its parameter to `[0, 1]`, so the
 * closest point on the ray becomes the ray's own end, `len` is the distance from there to the
 * segment, `norm` is enormous, and **every fragment discards**: the skeleton disappears in one
 * step, whole, with nothing in the frame to say why.
 *
 * Measured on the optic-lobe mock: a single neuron drawn `to scale` vanished between an
 * on-screen extent of 73 px and 60 px, while the same neuron in the two screen-space modes went
 * on drawing down to 32 px. Zooming out is not an unusual thing to do.
 *
 * Scaling the ray to the segment's own view-space distance removes the assumption rather than
 * moving it — and is better conditioned besides, since the stock ray overshoots a nanometre
 * scene by nine orders of magnitude before the dot products in `closestLineToLine`.
 */
const RAY_ANCHOR = glsl(
  '\t\t\t\t// Find the closest points on the view ray and the line segment',
  '\t\t\t\tvec3 rayEnd = normalize( worldPos.xyz ) * 1e5;',
)

const RAY_PATCH = glsl(
  '\t\t\t\t// Find the closest points on the view ray and the line segment. The ray is scaled',
  '\t\t\t\t// to this segment rather than to three’s 1e5, which is 100 µm in a scene measured',
  '\t\t\t\t// in nanometres — and past that the ray stops short and every fragment discards.',
  '\t\t\t\tvec3 rayEnd = normalize( worldPos.xyz ) * 2.0 * max( length( worldStart ), length( worldEnd ) );',
)

const NORM_PATCH = glsl(
  '\t\t\t\t// the cone’s radius where the view ray passes closest, not one radius for the segment',
  '\t\t\t\tfloat norm = len / mix( vWidthStart, vWidthEnd, params.x );',
)

/**
 * The patched sources, or a throw naming the site that moved.
 *
 * A throw rather than a warn-and-fall-back, following the rule octarine's `pcf.py` records: a
 * silent fallback is right for an always-on tweak whose stock behaviour is still correct, and
 * wrong for an effect somebody asked for by name. `by radius` and `to scale` are asked for by
 * name — falling back would draw a uniform width at four times the vertex cost and report
 * nothing.
 *
 * Exported so a test can run the patch without a WebGL context. `ShaderLib` is plain text, so
 * this is the one part of the fat-line path that jsdom *can* cover, and it is the part most
 * likely to break silently under a three upgrade.
 */
function stockShader(): { vertexShader: string; fragmentShader: string } {
  const shader = ShaderLib.line
  if (!shader) {
    throw new Error('FlexLineMaterial: three’s ShaderLib has no “line” entry to patch.')
  }
  return shader
}

function applyPatches(source: string, patches: readonly (readonly [string, string])[]): string {
  let patched = source
  for (const [anchor, replacement] of patches) {
    if (!patched.includes(anchor)) {
      throw new Error(
        'FlexLineMaterial: three’s line shader has changed and the per-vertex width patch no ' +
          `longer applies. Missing anchor:\n${anchor}`,
      )
    }
    patched = patched.replace(anchor, replacement)
  }
  return patched
}

export function flexLineVertexShader(source: string = stockShader().vertexShader): string {
  return applyPatches(source, [
    [DECLARE_ANCHOR, DECLARE_PATCH],
    [VARYING_ANCHOR, VARYING_PATCH],
    [APPLY_ANCHOR, APPLY_PATCH],
    [WORLD_ANCHOR, WORLD_PATCH],
  ])
}

export function flexLineFragmentShader(source: string = stockShader().fragmentShader): string {
  return applyPatches(source, [
    [VARYING_ANCHOR, VARYING_PATCH],
    [RAY_ANCHOR, RAY_PATCH],
    [NORM_ANCHOR, NORM_PATCH],
  ])
}

/**
 * Attach a width per endpoint to a `LineSegmentsGeometry`.
 *
 * One interleaved buffer of stride 2 split into two attributes, which is `setColors`' layout
 * with three floats swapped for one. The array is `segments * 2` long, child then parent per
 * segment — the order `buildSkeletonSegments` writes its endpoints in, so the two agree by
 * construction rather than by a comment.
 *
 * Values are *diameters*, in whichever space the material is in: three's own `hw = linewidth *
 * 0.5` and `norm > 0.5` both read `linewidth` as a full width, and these stand in for it.
 *
 * Required by `FlexLineMaterial`: an absent attribute reads as 0 in WebGL, so a geometry
 * without it draws every line at zero width — in screen space that is nothing at all, and in
 * world units it is a uniform hairline at the pixel floor, which is worse for being plausible.
 */
export function setLineWidths(geometry: LineSegmentsGeometry, widths: Float32Array): void {
  const buffer = new InstancedInterleavedBuffer(widths, 2, 1)
  geometry.setAttribute('instanceWidthStart', new InterleavedBufferAttribute(buffer, 1, 0))
  geometry.setAttribute('instanceWidthEnd', new InterleavedBufferAttribute(buffer, 1, 1))
}

/**
 * The patched sources, built once per session rather than once per material.
 *
 * Lazy rather than eager because the patch *throws* when three moves an anchor, and a throw at
 * module scope would take the whole bundle down instead of the one viewer that asked for a
 * taper. Worth hoisting at all because a material is rebuilt whenever the mode changes, and
 * seven `includes` + `replace` passes over three's ~10 kB line shaders is work with exactly one
 * possible answer. It does not save a shader *compile*: three's `WebGLShaderCache` keys programs
 * by source string, so byte-identical output already reused the cached program.
 */
let patched: { vertexShader: string; fragmentShader: string } | undefined

export class FlexLineMaterial extends LineMaterial {
  constructor(parameters?: ConstructorParameters<typeof LineMaterial>[0]) {
    super(parameters)

    patched ??= {
      vertexShader: flexLineVertexShader(),
      fragmentShader: flexLineFragmentShader(),
    }
    this.vertexShader = patched.vertexShader
    this.fragmentShader = patched.fragmentShader

    /*
     * `linewidth` still matters, and not only as a fallback: `LineSegments2.raycast` measures
     * its pick corridor from the material's uniform, which cannot see the per-vertex widths —
     * in world units as well, where it reads the uniform as a world-space diameter. The caller
     * passes a representative width for the space it is in, so picking a tapered skeleton is
     * as tolerant as picking a uniform one of that calibre. `raycaster.params.Line2.threshold`
     * adds four pixels on top and is what actually makes a twig clickable either way.
     */
  }
}
