/**
 * NRRD image stacks (`.nrrd`), read whole into memory for a slice viewer.
 *
 * A format, not a backend — like `obj.ts` and `swc.ts` beside it — so whoever fetches one (VFB's
 * file server, `data/vfb/stacks.ts`, today) hands the bytes here rather than growing a parser.
 * Only what is read exactly is read: 8-bit, three-dimensional, raw or gzip. Anything else is
 * refused by name rather than misread.
 *
 * The decoded size is known from the header before anything is inflated, so a stack past the
 * crash floor is refused first, and a gzip body is inflated **straight into one buffer of that
 * size**, so the peak is the stack once — VFB's stacks decode to 115–325 MB.
 */

import { refuseIfOverCrashFloor } from '../core/limits'

export interface ImageStack {
  readonly width: number
  readonly height: number
  readonly depth: number
  /** µm per voxel along x, y, z. Unread by the slice viewer; kept for the volume kind to come. */
  readonly spacing: readonly [number, number, number]
  /** `width × height × depth` voxels, x fastest, then y, then z. */
  readonly data: Uint8Array
}

const EIGHT_BIT = new Set(['uint8', 'unsigned char', 'uchar', 'uint8_t'])

/** The header's fields, keyed by lower-case name; the body starts after the first blank line. */
export function readNrrdHeader(bytes: Uint8Array): {
  fields: Map<string, string>
  bodyStart: number
} {
  // The header ends at its first blank line, written `\n\n` or, by a Windows tool, `\r\n\r\n`.
  let end = -1
  let bodyStart = -1
  for (let i = 0; i < Math.min(bytes.length - 1, 64 * 1024); i++) {
    if (bytes[i] !== 10) continue
    const blank = bytes[i + 1] === 10 ? 1 : bytes[i + 1] === 13 && bytes[i + 2] === 10 ? 2 : 0
    if (blank) {
      end = i
      bodyStart = i + 1 + blank
      break
    }
  }
  if (end < 0) throw new Error('Not an NRRD file: no end of header.')
  const lines = new TextDecoder('latin1').decode(bytes.subarray(0, end)).split(/\r?\n/)
  if (!lines[0]?.startsWith('NRRD')) throw new Error('Not an NRRD file.')
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
  }
  return { fields, bodyStart }
}

/** `(0.519,0,0) (0,0.519,0) (0,0,1)` → `[0.519, 0.519, 1]`: the diagonal, µm per voxel. */
function spacingOf(fields: ReadonlyMap<string, string>): [number, number, number] {
  const vectors = [...(fields.get('space directions') ?? '').matchAll(/\(([^)]*)\)/g)].map(
    (m) => m[1]!.split(',').map(Number),
  )
  const diagonal = [0, 1, 2].map((i) => Math.abs(vectors[i]?.[i] ?? 1) || 1)
  return [diagonal[0]!, diagonal[1]!, diagonal[2]!]
}

/** Decode one stack from the file's bytes. `signal` stops an inflate nobody is waiting for. */
export async function decodeNrrd(bytes: Uint8Array, signal?: AbortSignal): Promise<ImageStack> {
  const { fields, bodyStart } = readNrrdHeader(bytes)
  const type = (fields.get('type') ?? '').toLowerCase()
  if (!EIGHT_BIT.has(type))
    throw new Error(
      `This stack is ${type || 'of an unknown type'}; only 8-bit stacks are read.`,
    )
  const sizes = (fields.get('sizes') ?? '').split(/\s+/).map(Number)
  if (sizes.length !== 3 || sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(
      `This stack is not three-dimensional (sizes: ${fields.get('sizes') ?? '?'}).`,
    )
  }
  const [width, height, depth] = sizes as [number, number, number]
  // One byte a voxel, the only type read.
  const voxels = width * height * depth
  refuseIfOverCrashFloor(`This ${width}×${height}×${depth} stack`, voxels)
  const encoding = (fields.get('encoding') ?? 'raw').toLowerCase()
  const body = bytes.subarray(bodyStart)
  let data: Uint8Array
  if (encoding === 'gzip' || encoding === 'gz') {
    data = await inflateInto(body, voxels, signal)
  } else if (encoding === 'raw') {
    if (body.length < voxels) throw shortfall(body.length, voxels)
    data = body.subarray(0, voxels)
  } else {
    throw new Error(`This stack's encoding is ${encoding}; only raw and gzip are read.`)
  }
  return { width, height, depth, spacing: spacingOf(fields), data }
}

const shortfall = (held: number, voxels: number) =>
  new Error(`This stack holds ${held} voxels where its header says ${voxels}.`)

/** Inflate gzip into a buffer of exactly `voxels` bytes, chunk by chunk. */
async function inflateInto(
  body: Uint8Array,
  voxels: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot inflate gzip (no DecompressionStream)')
  }
  const out = new Uint8Array(voxels)
  const reader = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader()
  const stop = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', stop, { once: true })
  try {
    let at = 0
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      // Trailing bytes past the header's size are ignored, as the raw branch's `subarray` ignores them.
      out.set(value.subarray(0, Math.max(0, voxels - at)), at)
      at += value.length
    }
    if (at < voxels) throw shortfall(at, voxels)
    return out
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

/** One z-slice's grey values, `width × height`, as a view onto the stack — nothing is copied. */
export function slicePlane(stack: ImageStack, z: number): Uint8Array {
  const plane = stack.width * stack.height
  const at = Math.min(Math.max(0, Math.round(z)), stack.depth - 1) * plane
  return stack.data.subarray(at, at + plane)
}

/**
 * The maximum projection along z, `width × height` grey values: under a megabyte where the stack
 * is hundreds. Measured on 2026-10-14's sizes at 125 ms for a JRC2018U brain stack and 330 ms for a
 * VNC one, so a caller makes it once.
 */
export function maxProjection(stack: ImageStack): Uint8Array {
  const { width, height, depth, data } = stack
  const plane = width * height
  const max = new Uint8Array(plane)
  for (let z = 0; z < depth; z++) {
    const at = z * plane
    for (let i = 0; i < plane; i++) {
      const v = data[at + i]!
      if (v > max[i]!) max[i] = v
    }
  }
  return max
}

/**
 * A plane of grey values as RGBA pixels — what a canvas `ImageData` holds, built without one so
 * this module stays free of the DOM. Pass `out` (an `ImageData`'s `data`) to fill it in place: a
 * slider drag is one slice per step, and a fresh 3 MB array per step is all garbage.
 */
export function planePixels(
  values: Uint8Array,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(values.length * 4),
): Uint8ClampedArray<ArrayBuffer> {
  // One store a pixel: grey needs no channel order, and alpha is the high byte on every
  // little-endian platform a browser runs on.
  const words = new Uint32Array(out.buffer, out.byteOffset, values.length)
  for (let i = 0; i < values.length; i++) words[i] = 0xff000000 | (values[i]! * 0x010101)
  return out
}

/**
 * `planePixels` for the plane turned a quarter clockwise: `values` is `width × height`, and the
 * pixels are `height` wide and `width` tall, the plane's left edge at the top. Turned as the pixels
 * are written, so a turned slice costs a step no more than an unturned one.
 */
export function turnedPlanePixels(
  values: Uint8Array,
  width: number,
  height: number,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(values.length * 4),
): Uint8ClampedArray<ArrayBuffer> {
  const words = new Uint32Array(out.buffer, out.byteOffset, values.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    const column = height - 1 - y
    for (let x = 0; x < width; x++) {
      words[x * height + column] = 0xff000000 | (values[row + x]! * 0x010101)
    }
  }
  return out
}
