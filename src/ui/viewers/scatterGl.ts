/**
 * The scatter's zoomed-out pass on the GPU: one WebGL2 context for the whole app.
 *
 * Above `CIRCLES_MAX` visible marks the cost of a frame is overdraw — fish2's 129,325 marks of
 * ~113 device pixels each over a 3.5M-pixel plot — and no CPU raster kept up: the opaque integer
 * blend in `scatterRaster.ts` took 65 ms at 2× and 18 ms even at 1×, where `gl.POINTS` took the
 * whole frame in 6.7 ms of main thread (`pnpm probe:scatter-scale`). So the marks are drawn here,
 * and the 2D canvas keeps everything else — background, grid, axes, trend, hover.
 *
 * **The marks are uploaded once and a pan moves a uniform.** A `ScatterMarks` is everything a pan
 * does not change, so its positions go up as *transformed* coordinates — less the data's centre,
 * which is what keeps float32 exact at a deep zoom into large values — and the vertex shader
 * applies `viewAffine`'s scale and offset, computed in float64 here with the centre folded in. It
 * holds no projection of its own, so it cannot drift from the 2D canvas's. Opacity is a uniform too. A frame then
 * uploads only its selection rings, which are few and in view. The GPU clips what is off the plot,
 * so the whole set is drawn rather than a culled one; what `CIRCLES_MAX` counts is the CPU's
 * business.
 *
 * **One context, not one per scatter.** Each 3D or network viewer holds its own and the app is
 * careful about how many are alive at once (`graphStore.ts`'s pinned/expanded rule, the
 * dashboard swapping surfaces). A scatter on every card would have been one more each. Instead
 * this module owns a single offscreen canvas, draws whichever scatter is repainting into it, and
 * that scatter copies the frame into its own canvas with `drawImage` **in the same task** — which
 * is what makes `preserveDrawingBuffer` unnecessary, the buffer being cleared only once the event
 * loop composites.
 *
 * It has to look like the circle path it stands in for, or the cloud changes as a zoom crosses
 * the threshold, so three things are the CPU raster's: the **stacking** is `ScatterMarks.buckets`
 * order, uploaded in sequence and drawn in one call; the **composite** is premultiplied source-over at
 * the node's `Opacity`; and the **shapes** are `markStamp`'s own coverage, uploaded once as a
 * mipmapped texture array, so a mark's outline has one definition for both passes. The selection
 * ring is analytic in the shader, its radius depending on the mark's.
 *
 * Returns `false` whenever it did not draw — no WebGL2 (jsdom among them), a lost context, a
 * point larger than the driver allows — and the caller then runs the CPU raster, which also
 * remains the export path.
 */

import type { MarkerShape } from '../encoding'
import { ALL_SHAPES } from '../encoding'
import type { ScatterMarks, ScatterSpec } from './scatterPlot'
import { markAlpha, viewAffine } from './scatterPlot'
import { RING_GAP, RING_WIDTH, markRgb, markStamp } from './scatterRaster'

/** Texture side, and the radius the shape is drawn at inside it: `markStamp` reaches 1.5r + 1. */
const TEXTURE = 128
const TEXTURE_RADIUS = 40
/** A sprite's side over the mark's radius, so the texture's half-extent maps onto the sprite. */
const SPRITE_PER_RADIUS = TEXTURE / TEXTURE_RADIUS

const VERTEX = `#version 300 es
in vec2 a_pos;
in float a_radius;
in float a_layer;
in vec4 a_color;
// \`viewAffine\`, with the centre folded into the offset: css = a_pos * scale + offset.
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_origin;
uniform vec2 u_size;
uniform float u_ratio;
uniform float u_alpha;
out vec4 v_color;
out float v_layer;
out float v_size;
out float v_ringR;
out float v_ringW;
void main() {
  vec2 p = (a_pos * u_scale + u_offset) * u_ratio - u_origin;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  if (a_layer < 0.0) {
    v_ringR = (a_radius + ${RING_GAP.toFixed(2)}) * u_ratio;
    v_ringW = ${RING_WIDTH.toFixed(2)} * u_ratio;
    v_size = 2.0 * (v_ringR + v_ringW) + 2.0;
  } else {
    v_size = ${SPRITE_PER_RADIUS.toFixed(4)} * a_radius * u_ratio;
  }
  gl_PointSize = v_size;
  v_color = vec4(a_color.rgb, u_alpha);
  v_layer = a_layer;
}`

const FRAGMENT = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;
uniform sampler2DArray u_shapes;
in vec4 v_color;
in float v_layer;
in float v_size;
in float v_ringR;
in float v_ringW;
out vec4 o;
void main() {
  float cover;
  if (v_layer < 0.0) {
    float d = length((gl_PointCoord - 0.5) * v_size);
    cover = clamp(v_ringW * 0.5 + 0.5 - abs(d - v_ringR), 0.0, 1.0);
  } else {
    cover = texture(u_shapes, vec3(gl_PointCoord, v_layer)).r;
  }
  float a = v_color.a * cover;
  if (a <= 0.0) discard;
  o = vec4(v_color.rgb * a, a);
}`

/** A vertex set on the GPU: interleaved x, y, radius, layer floats, and RGBA bytes beside them. */
interface Uploaded {
  vao: WebGLVertexArrayObject
  floats: WebGLBuffer
  bytes: WebGLBuffer
  count: number
}

/** One marks set's upload, with the centre its positions were taken relative to. */
interface UploadedMarks extends Uploaded {
  cx: number
  cy: number
  /** Set on eviction: the GL objects are gone, and the next draw uploads afresh. */
  deleted: boolean
}

interface GlState {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  attributes: { pos: number; radius: number; layer: number; color: number }
  uniforms: Record<
    'scale' | 'offset' | 'origin' | 'size' | 'ratio' | 'alpha',
    WebGLUniformLocation
  >
  maxPoint: number
  /**
   * Uploaded marks sets, looked up weakly so a set nobody draws any more can be collected — a
   * strong key would pin up to `MARKS_KEPT` × ~6 MB of arrays after their viewers let go — and
   * listed least recently drawn first so the GPU side stays bounded. `LruMap` is not used: it
   * holds its keys strongly and has no hook to delete what it evicts.
   */
  marks: WeakMap<ScatterMarks, UploadedMarks>
  recent: UploadedMarks[]
  /** The selection rings, re-uploaded per frame into one set of buffers. */
  rings: Uploaded
  /** Grown, never shrunk: the ring vertices of a frame, reused. */
  ringFloats: Float32Array
  ringBytes: Uint8Array
}

/**
 * How many marks sets stay on the GPU. A dashboard can repaint several scatters in turn, and one
 * re-upload each per frame is the cost this module exists to avoid; past this many the least
 * recently drawn is deleted, a `WebGLBuffer` being freed only when somebody says so.
 */
const MARKS_KEPT = 8

/** `undefined` not yet tried, `null` unavailable for this session. */
let state: GlState | null | undefined
let lost = false

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
}

/** The marker shapes as one `R8` layer each, built from `markStamp` so both passes agree. */
function uploadShapes(gl: WebGL2RenderingContext): void {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.R8,
    TEXTURE,
    TEXTURE,
    ALL_SHAPES.length,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    null,
  )
  const layer = new Uint8Array(TEXTURE * TEXTURE)
  const centre = TEXTURE / 2
  ALL_SHAPES.forEach((shape, index) => {
    layer.fill(0)
    const stamp = markStamp(shape, TEXTURE_RADIUS)
    for (let k = 0; k < stamp.coverage.length; k++) {
      const x = centre + stamp.dx[k]!
      const y = centre + stamp.dy[k]!
      if (x >= 0 && y >= 0 && x < TEXTURE && y < TEXTURE)
        layer[y * TEXTURE + x] = Math.round(stamp.coverage[k]! * 255)
    }
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      index,
      TEXTURE,
      TEXTURE,
      1,
      gl.RED,
      gl.UNSIGNED_BYTE,
      layer,
    )
  })
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

function create(): GlState | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null
  if (!gl) return null

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vertex || !fragment || !program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)

  const location = (name: string) => gl.getUniformLocation(program, name)
  const uniforms = {
    scale: location('u_scale'),
    offset: location('u_offset'),
    origin: location('u_origin'),
    size: location('u_size'),
    ratio: location('u_ratio'),
    alpha: location('u_alpha'),
  }
  if (Object.values(uniforms).some((u) => !u)) return null
  const attributes = {
    pos: gl.getAttribLocation(program, 'a_pos'),
    radius: gl.getAttribLocation(program, 'a_radius'),
    layer: gl.getAttribLocation(program, 'a_layer'),
    color: gl.getAttribLocation(program, 'a_color'),
  }
  const rings = vertexSet(gl, attributes)
  if (!rings) return null

  uploadShapes(gl)
  gl.uniform1i(gl.getUniformLocation(program, 'u_shapes'), 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    lost = true
  })
  canvas.addEventListener('webglcontextrestored', () => {
    // Every resource went with the context; build afresh on the next draw.
    lost = false
    state = undefined
  })

  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null
  return {
    gl,
    canvas,
    attributes,
    uniforms: uniforms as GlState['uniforms'],
    maxPoint: range ? range[1]! : 1,
    marks: new WeakMap(),
    recent: [],
    rings,
    ringFloats: new Float32Array(0),
    ringBytes: new Uint8Array(0),
  }
}

/** A vertex array over two fresh buffers, laid out as `Uploaded` says. */
function vertexSet(gl: WebGL2RenderingContext, at: GlState['attributes']): Uploaded | null {
  const vao = gl.createVertexArray()
  const floats = gl.createBuffer()
  const bytes = gl.createBuffer()
  if (!vao || !floats || !bytes) return null
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, floats)
  for (const [index, count, offset] of [
    [at.pos, 2, 0],
    [at.radius, 1, 8],
    [at.layer, 1, 12],
  ] as const) {
    gl.enableVertexAttribArray(index)
    gl.vertexAttribPointer(index, count, gl.FLOAT, false, 16, offset)
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, bytes)
  gl.enableVertexAttribArray(at.color)
  gl.vertexAttribPointer(at.color, 4, gl.UNSIGNED_BYTE, true, 4, 0)
  gl.bindVertexArray(null)
  return { vao, floats, bytes, count: 0 }
}

const LAYER = new Map<MarkerShape, number>(ALL_SHAPES.map((shape, index) => [shape, index]))

/**
 * Write the vertices of `buckets` into `floats`/`bytes` — positions relative to (`cx`, `cy`),
 * each bucket at its shape's texture layer, or at `ring` (-1) for selection rings — and upload.
 */
function fill(
  gl: WebGL2RenderingContext,
  set: Uploaded,
  marks: ScatterMarks,
  buckets: readonly { color: string; shape: MarkerShape; indices: ArrayLike<number> }[],
  centre: { cx: number; cy: number },
  scratch: { floats: Float32Array; bytes: Uint8Array },
  ring = false,
): void {
  const { floats, bytes } = scratch
  let v = 0
  for (const bucket of buckets) {
    const [r, g, b] = markRgb(bucket.color)
    const layer = ring ? -1 : (LAYER.get(bucket.shape) ?? 0)
    for (let k = 0; k < bucket.indices.length; k++) {
      const i = bucket.indices[k]!
      floats[v * 4] = marks.xt[i]! - centre.cx
      floats[v * 4 + 1] = marks.yt[i]! - centre.cy
      floats[v * 4 + 2] = marks.radius[i]!
      floats[v * 4 + 3] = layer
      bytes[v * 4] = r
      bytes[v * 4 + 1] = g
      bytes[v * 4 + 2] = b
      bytes[v * 4 + 3] = 255
      v++
    }
  }
  const usage = ring ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW
  gl.bindBuffer(gl.ARRAY_BUFFER, set.floats)
  gl.bufferData(gl.ARRAY_BUFFER, floats.subarray(0, v * 4), usage)
  gl.bindBuffer(gl.ARRAY_BUFFER, set.bytes)
  gl.bufferData(gl.ARRAY_BUFFER, bytes.subarray(0, v * 4), usage)
  set.count = v
}

/** The marks set on the GPU, uploading it the first time it is drawn (or after eviction). */
function uploaded(state: GlState, marks: ScatterMarks): UploadedMarks | null {
  const kept = state.marks.get(marks)
  if (kept && !kept.deleted) {
    // Most recently drawn goes to the back, so eviction takes the front.
    state.recent.splice(state.recent.indexOf(kept), 1)
    state.recent.push(kept)
    return kept
  }
  const { gl } = state
  const set = vertexSet(gl, state.attributes)
  if (!set) return null
  const centre = {
    cx: marks.extent ? (marks.extent.x.min + marks.extent.x.max) / 2 : 0,
    cy: marks.extent ? (marks.extent.y.min + marks.extent.y.max) / 2 : 0,
  }
  const n = marks.rows.length
  fill(gl, set, marks, marks.buckets, centre, {
    floats: new Float32Array(n * 4),
    bytes: new Uint8Array(n * 4),
  })
  const entry: UploadedMarks = { ...set, ...centre, deleted: false }
  state.marks.set(marks, entry)
  state.recent.push(entry)
  if (state.recent.length > MARKS_KEPT) {
    const gone = state.recent.shift()!
    gl.deleteVertexArray(gone.vao)
    gl.deleteBuffer(gone.floats)
    gl.deleteBuffer(gone.bytes)
    gone.deleted = true
  }
  return entry
}

/**
 * Draw a frame's marks (and rings) for the device-pixel `box` and copy them onto `target`, whose
 * transform is `ratio` and whose clip is the plot. `false` means nothing was drawn and the caller
 * has to.
 */
export function drawMarksGl(
  target: CanvasRenderingContext2D,
  options: {
    spec: ScatterSpec
    ratio: number
    box: { originX: number; originY: number; width: number; height: number }
    opacity: number
    /** In range and in view, as `drawScatter` hands them over. */
    ring?: { indices: number[]; color: string }
  },
): boolean {
  if (lost) return false
  if (state === undefined) state = create()
  if (!state) return false
  const { gl, canvas, uniforms } = state
  const { spec, ratio, box } = options
  const { marks, view, plot } = spec
  const rings = options.ring?.indices ?? []

  // Before anything is drawn, so a point too big for the driver can still hand back to the CPU.
  const sprite = SPRITE_PER_RADIUS * marks.largestRadius * ratio
  const ringSize = 2 * ((marks.largestRadius + RING_GAP + RING_WIDTH) * ratio) + 2
  if (Math.max(sprite, rings.length > 0 ? ringSize : 0) > state.maxPoint) return false

  const set = uploaded(state, marks)
  if (!set) return false

  // Grown rather than fitted, so two scatters of different sizes repainting in turn do not
  // reallocate the drawing buffer each time; the frame is drawn into the top-left corner and read
  // from there. Fitted again once it is four times the area asked for, or one fullscreen view
  // would hold ~30 MB of buffer for the rest of the session.
  if (canvas.width * canvas.height > 4 * box.width * box.height) {
    canvas.width = box.width
    canvas.height = box.height
  }
  if (canvas.width < box.width) canvas.width = box.width
  if (canvas.height < box.height) canvas.height = box.height
  gl.viewport(0, canvas.height - box.height, box.width, box.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  // The centre folded into the offset in float64, so float32 only ever sees small numbers.
  const { sx, ox, sy, oy } = viewAffine(view, plot)
  gl.uniform2f(uniforms.scale, sx, sy)
  gl.uniform2f(uniforms.offset, ox + set.cx * sx, oy + set.cy * sy)
  gl.uniform2f(uniforms.origin, box.originX, box.originY)
  gl.uniform2f(uniforms.size, box.width, box.height)
  gl.uniform1f(uniforms.ratio, ratio)

  gl.uniform1f(uniforms.alpha, markAlpha(options.opacity))
  gl.bindVertexArray(set.vao)
  gl.drawArrays(gl.POINTS, 0, set.count)

  if (rings.length > 0) {
    if (state.ringFloats.length < rings.length * 4) {
      state.ringFloats = new Float32Array(rings.length * 4)
      state.ringBytes = new Uint8Array(rings.length * 4)
    }
    fill(
      gl,
      state.rings,
      marks,
      [{ color: options.ring!.color, shape: 'circle', indices: rings }],
      { cx: set.cx, cy: set.cy },
      { floats: state.ringFloats, bytes: state.ringBytes },
      true,
    )
    gl.uniform1f(uniforms.alpha, 1)
    gl.bindVertexArray(state.rings.vao)
    gl.drawArrays(gl.POINTS, 0, state.rings.count)
  }
  gl.bindVertexArray(null)

  target.globalAlpha = 1
  target.drawImage(
    canvas,
    0,
    0,
    box.width,
    box.height,
    box.originX / ratio,
    box.originY / ratio,
    box.width / ratio,
    box.height / ratio,
  )
  return true
}
