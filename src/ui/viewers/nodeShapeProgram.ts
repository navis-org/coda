/**
 * The network viewer's node program: a shape per node, drawn in WebGL.
 *
 * Sigma draws every node as a disc. `@sigma/node-border` — which this replaces — generates a
 * shader whose whole geometry is `length(v_diffVector)`, so there is no per-node shape to be
 * had from it at any setting. What is here is that program rewritten with two changes: the
 * circle test becomes a **signed distance function chosen per node**, and the border logic is
 * written out rather than generated (it was only ever an outline plus a fill).
 *
 * **Ours rather than a patch, deliberately.** The precedent in this repo is `flexLineMaterial.ts`,
 * which rewrites three's own shaders and has to throw when a patch site stops matching, because
 * a silent miss draws every skeleton at the wrong width. That cost is worth paying where the
 * library's shader is doing something irreplaceable; here it is doing `length()`, and owning
 * ~200 lines is cheaper than owning a dependency on someone else's shader text.
 *
 * **Nothing here is reachable from a test, and the module cannot even be imported by one.**
 * `sigma/rendering` touches `WebGL2RenderingContext` at module scope, which jsdom does not
 * define — so this is loaded through the same dynamic `import()` as sigma itself, inside the
 * viewer's effect. A static import here took every test that renders a network down with it.
 * The shaders are verified by looking at a real browser, the rule the 3D viewer already lives
 * under.
 *
 * What *is* testable is kept out of the shader on purpose: the shape vocabulary and its
 * assignment live in `src/ui/encoding.ts`, and the number the buffer carries is that module's
 * `ALL_SHAPES` index rather than a table here that could drift from it.
 */

import { NodeProgram } from 'sigma/rendering'
import type { NodeDisplayData, RenderParams } from 'sigma/types'
import { numberToGLSLFloat } from 'sigma/rendering'
import { floatColor } from 'sigma/utils'

import type { MarkerShape } from '../encoding'
import { ALL_SHAPES } from '../encoding'
import { MARK_EXTENT, SHAPE_SDF } from './markGeometry'

/**
 * How far past `v_radius` a mark may reach.
 *
 * The vertex shader's triangle inscribes a circle of exactly `v_radius`, so without headroom
 * every mark would have to fit inside the circle's own outline — and they do not, because they
 * are sized for **equal area** rather than equal extent (a square's corner sits at 1.25).
 * Getting it wrong clips corners off squares and diamonds, which reads as a rendering artefact
 * rather than as a bug.
 *
 * `MARK_EXTENT` is derived from the geometry, so adding a mark cannot silently overflow it.
 * The margin is spent in the vertex shader by growing the quad and shrinking `v_radius` to
 * compensate, so `v_radius` keeps meaning what the rest of sigma thinks it means.
 *
 * **Spent per shape, not per node.** A circle needs none of it, and it is the default and by
 * far the commonest mark: paying the full margin for every node would rasterise 1.8× the
 * fragments a plain network needs, and node fill is the dominant fragment cost in a dense one.
 */
const CIRCLE_EXTENT = 1

const VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec4 a_borderColor;
attribute vec2 a_position;
attribute float a_size;
attribute float a_borderSize;
attribute float a_shape;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec4 v_borderColor;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_borderSize;
varying float v_shape;

const float bias = 255.0 / 254.0;

void main() {
  // Sigma's own line, unchanged, so it stays diffable against upstream.
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;

  /*
   * The quad is grown so a mark may reach past the radius; v_radius is not, so it keeps
   * meaning what the rest of sigma thinks it means. A circle needs no margin and is the
   * default mark, so it does not pay for one — the alternative rasterises 1.8× the fragments
   * on every node of an unshaped network.
   */
  float extent = a_shape < 0.5 ? ${numberToGLSLFloat(CIRCLE_EXTENT)} : ${numberToGLSLFloat(MARK_EXTENT)};
  vec2 diffVector = size * extent * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);

  v_radius = size / 2.0;
  v_diffVector = diffVector;
  v_shape = a_shape;
  v_borderSize = a_borderSize;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  v_borderColor = a_borderColor;
  v_color.a *= bias;
  v_borderColor.a *= bias;
  #endif
}
`

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec4 v_color;
varying vec4 v_borderColor;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_borderSize;
varying float v_shape;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

${SHAPE_SDF}

void main(void) {
  // Back into world units, so the border and the feather are comparable with u_correctionRatio.
  float dist = sdShape(v_diffVector / v_radius, v_shape) * v_radius;

  // No antialiasing for picking mode: a half-covered fragment must belong to exactly one node,
  // or the id read back is a blend of two ids and resolves to neither.
  #ifdef PICKING_MODE
  gl_FragColor = dist > 0.0 ? transparent : v_color;
  #else
  float aa = u_correctionRatio;
  // The outline eats inward from the outline, and never more than a third of a small mark —
  // a 1px border on a size-4 node would otherwise be the whole node.
  float border = min(u_correctionRatio * v_borderSize, v_radius * 0.34);

  float inside = 1.0 - smoothstep(-aa, aa, dist);
  float filled = 1.0 - smoothstep(-border - aa, -border + aa, dist);
  vec4 paint = mix(v_borderColor, v_color, filled);

  /*
   * Mixed from transparent rather than assembled as vec4(paint.rgb, paint.a * inside).
   *
   * Sigma blends premultiplied - blendFunc(ONE, ONE_MINUS_SRC_ALPHA) - so a fragment's rgb
   * must be scaled by its own alpha. Writing straight alpha instead leaks the colour at full
   * intensity wherever alpha is near zero, which paints the WHOLE VERTEX TRIANGLE in the
   * border colour: a grey wedge behind every node, scaled with it. It reads as a geometry or
   * an antialiasing bug and is neither, which is why it is written down. Sigma's own programs
   * all spell this mix(transparent, ...) for the same reason.
   */
  gl_FragColor = mix(transparent, paint, inside);
  #endif
}
`

const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const

const { UNSIGNED_BYTE, FLOAT } = WebGLRenderingContext

const ANGLE_1 = 0
const ANGLE_2 = (2 * Math.PI) / 3
const ANGLE_3 = (4 * Math.PI) / 3

/**
 * A node program that draws whichever of the six marks a node's `shape` attribute names.
 *
 * One program rather than one per shape, with the mark as a vertex attribute. Sigma's own
 * mechanism for this is `nodeProgramClasses` keyed by a node's `type`, which would work and
 * would cost a draw call per shape and a registry entry per shape; a float in the buffer costs
 * neither, and the branch is over a `varying` that is uniform across each triangle.
 */
export class NodeShapeProgram extends NodeProgram<(typeof UNIFORMS)[number]> {
  getDefinition() {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE: VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: FRAGMENT_SHADER,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: FLOAT },
        { name: 'a_size', size: 1, type: FLOAT },
        { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_borderColor', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_borderSize', size: 1, type: FLOAT },
        { name: 'a_shape', size: 1, type: FLOAT },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: FLOAT }],
      CONSTANT_DATA: [[ANGLE_1], [ANGLE_2], [ANGLE_3]],
    }
  }

  processVisibleItem(
    nodeIndex: number,
    startIndex: number,
    data: NodeDisplayData & { borderColor?: string; borderSize?: number; shape?: MarkerShape },
  ): void {
    const array = this.array
    const color = floatColor(data.color)
    // An unstyled node is a plain disc with no outline, which is what sigma would have drawn.
    const border = floatColor(data.borderColor ?? data.color)
    // `indexOf` over seven entries, once per visible node per refresh. A lookup table here
    // would be a second numbering to keep in step with `ALL_SHAPES`, which is the thing this
    // is deliberately not doing.
    // `indexOf` returns -1 for an absent or unknown shape, which `max` turns into the
    // circle at slot 0 — so this is one guard, not a fallback plus a guard.
    const shape = Math.max(0, ALL_SHAPES.indexOf(data.shape as MarkerShape))

    array[startIndex++] = data.x
    array[startIndex++] = data.y
    array[startIndex++] = data.size
    array[startIndex++] = color
    array[startIndex++] = nodeIndex
    array[startIndex++] = border
    array[startIndex++] = data.borderSize ?? 0
    array[startIndex++] = shape
  }

  setUniforms(
    params: RenderParams,
    { gl, uniformLocations }: { gl: WebGLRenderingContext; uniformLocations: Record<string, WebGLUniformLocation> },
  ): void {
    const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations
    gl.uniform1f(u_sizeRatio!, params.sizeRatio)
    gl.uniform1f(u_correctionRatio!, params.correctionRatio)
    gl.uniformMatrix3fv(u_matrix!, false, params.matrix)
  }
}
