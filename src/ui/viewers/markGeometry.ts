/**
 * What each mark *is*, in one place, for both renderers that draw it.
 *
 * The shapes are drawn twice by two unrelated back-ends: as polygons on a 2D canvas and in SVG
 * (`scatterDraw.ts`), and as signed distance functions in a WebGL fragment shader
 * (`nodeShapeProgram.ts`). They were written out separately, in two languages, with a comment
 * on each saying the numbers matched the other — `SQUARE` and `ARM` declared twice with
 * identical bodies, and `1.1`, `1.25`, `1.15`, `0.32` as bare literals on both sides.
 *
 * That is the wrong thing to hold together with a comment. The failure it invites is a network
 * and a scatter drawing one category at visibly different weights, which turns shape into an
 * accidental magnitude channel — exactly what `SQUARE` exists to prevent. And nothing could
 * catch it: `nodeShapeProgram.ts` cannot be imported by a test at all, because `sigma/rendering`
 * touches WebGL globals at module scope.
 *
 * So the constants live here and **both** back-ends are derived from them, including the GLSL,
 * which is generated rather than transcribed. This module imports no sigma and no DOM, so
 * `markGeometry.test.ts` can check the two agree.
 */

import type { MarkerShape } from '../encoding'

/**
 * Half-side of a square with the same area as a circle of radius 1.
 *
 * Marks of different shapes have to carry the same weight, or shape starts encoding magnitude
 * by accident — a square drawn at the circle's radius is 27% larger.
 */
export const SQUARE = Math.sqrt(Math.PI) / 2

/** Arm half-width of the plus and cross, as a fraction of the radius. */
export const ARM = 0.38

/** How far the plus and cross arms, and the dash, reach from the centre. */
export const REACH = 1.15

/** Half-height of the dash. */
export const DASH = 0.32

/** Circumradius of the equilateral triangle — the distance from centre to apex. */
export const TRIANGLE = 1.1

/** Distance from centre to each diamond vertex. */
export const DIAMOND = 1.25

/**
 * The widest any mark reaches from its centre, in radius units.
 *
 * The WebGL program needs this to size the quad it rasterises: the marks are sized for equal
 * *area*, not equal extent, so several of them stick out past radius 1 and a quad sized to 1
 * clips their corners. Derived rather than guessed, so adding a mark cannot silently overflow.
 */
export const MARK_EXTENT = Math.max(SQUARE * Math.SQRT2, REACH, TRIANGLE, DIAMOND)

/**
 * Vertices of a mark, centred on the origin and scaled to radius 1.
 *
 * **Screen convention: y runs down**, so the triangle's apex is at negative y and points up.
 * The shader has to undo that, because sigma's graph space runs the other way — see
 * `SHAPE_SDF`.
 *
 * Circle is absent on purpose: it has no vertices, and every back-end draws it with its own
 * arc primitive rather than as a polygon approximation.
 */
export function markVertices(shape: MarkerShape): number[][] {
  switch (shape) {
    case 'square':
      return [
        [-SQUARE, -SQUARE],
        [SQUARE, -SQUARE],
        [SQUARE, SQUARE],
        [-SQUARE, SQUARE],
      ]
    case 'triangle': {
      // Equilateral, point up, centroid at the origin: apex at the circumradius, base at half
      // of it, half-width from the 30° base angle.
      const half = TRIANGLE / 2
      const width = TRIANGLE * Math.cos(Math.PI / 6)
      return [
        [0, -TRIANGLE],
        [width, half],
        [-width, half],
      ]
    }
    case 'diamond':
      return [
        [0, -DIAMOND],
        [DIAMOND, 0],
        [0, DIAMOND],
        [-DIAMOND, 0],
      ]
    case 'plus':
      return plusVertices(0)
    case 'cross':
      // The same outline turned an eighth, which is what makes the two readably different
      // rather than two variations on a thin blob.
      return plusVertices(Math.PI / 4)
    case 'dash':
      return [
        [-REACH, -DASH],
        [REACH, -DASH],
        [REACH, DASH],
        [-REACH, DASH],
      ]
    default:
      return []
  }
}

function plusVertices(rotation: number): number[][] {
  const w = ARM
  const a = REACH
  const base = [
    [-w, -a],
    [w, -a],
    [w, -w],
    [a, -w],
    [a, w],
    [w, w],
    [w, a],
    [-w, a],
    [-w, w],
    [-a, w],
    [-a, -w],
    [-w, -w],
  ]
  if (!rotation) return base
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return base.map(([x, y]) => [x! * cos - y! * sin, x! * sin + y! * cos])
}

/** A number GLSL will read as a float, so `1` cannot be emitted where `1.0` is meant. */
const glsl = (value: number): string => value.toFixed(6)

/**
 * The same marks as signed distance functions, in GLSL.
 *
 * Generated from the constants above rather than transcribed, so the two back-ends cannot
 * drift. Signed rather than an in/out test because the border and the antialiasing both need
 * to know *how far* a fragment is from the edge: a boolean gives a jagged outline and a border
 * that varies in width around a corner.
 *
 * **`p.y` is negated on entry**, and that is the one thing here that is not a proportion.
 * `markVertices` is in screen space, where y runs down and the triangle's apex is at negative
 * y; the shader runs in sigma's graph space, where y runs up. Without the flip the only mark
 * that is not symmetric about y — the triangle — renders point-down on the canvas while the
 * legend and the SVG export draw it point-up, from the same numbers.
 */
export const SHAPE_SDF = /* glsl */ `
float sdShape(vec2 raw, float shape) {
  // Into the screen convention markGeometry.ts is written in: sigma graph y runs up.
  vec2 p = vec2(raw.x, -raw.y);
  if (shape < 0.5) {
    return length(p) - 1.0;
  } else if (shape < 1.5) {
    vec2 d = abs(p) - vec2(${glsl(SQUARE)});
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  } else if (shape < 2.5) {
    // The outer edge of three half-planes. Exact inside and along the edges, a slight
    // over-estimate past a corner, which costs a fraction of a pixel of antialiasing.
    return max(
      p.y - ${glsl(TRIANGLE / 2)},
      ${glsl(Math.cos(Math.PI / 6))} * abs(p.x) - 0.5 * p.y - ${glsl(TRIANGLE / 2)}
    );
  } else if (shape < 3.5) {
    return (abs(p.x) + abs(p.y) - ${glsl(DIAMOND)}) * ${glsl(Math.SQRT1_2)};
  } else if (shape < 5.5) {
    // Cross is the plus turned an eighth — the same outline, which is what makes the two
    // readably different rather than two variations on a thin blob.
    vec2 q = p;
    if (shape < 4.5) {
      float c = ${glsl(Math.SQRT1_2)};
      q = vec2(p.x * c + p.y * c, -p.x * c + p.y * c);
    }
    vec2 a = abs(q) - vec2(${glsl(REACH)}, ${glsl(ARM)});
    vec2 b = abs(q) - vec2(${glsl(ARM)}, ${glsl(REACH)});
    float da = length(max(a, 0.0)) + min(max(a.x, a.y), 0.0);
    float db = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0);
    return min(da, db);
  }
  vec2 d = abs(p) - vec2(${glsl(REACH)}, ${glsl(DASH)});
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`
