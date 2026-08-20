/**
 * murmurhash3_x86_128, reduced to the 64 bits neuroglancer's sharded format needs.
 *
 * This exists only because `neuroglancer_uint64_sharded_v1` specifies it as the key→shard
 * hash. It has to match bit for bit or lookups land in the wrong shard and every mesh
 * appears to be missing, so it is a direct transcription of the reference algorithm rather
 * than anything clever.
 *
 * All arithmetic is forced through `Math.imul` and `>>> 0`: JavaScript numbers are doubles,
 * and a plain `*` on two 32-bit values silently loses the low bits it is supposed to keep.
 */

const C1 = 0x239b961b
const C2 = 0xab0e9789
const C3 = 0x38b34ae5
const C4 = 0xa1e38b93

function rotl(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0
}

function fmix(h: number): number {
  let x = h
  x ^= x >>> 16
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return x >>> 0
}

/**
 * The four 32-bit words of the 128-bit hash.
 *
 * Only the 16-byte-tail path for lengths < 16 is exercised by this codebase (keys are 8
 * bytes), but the block loop is kept so the function is the real algorithm and can be
 * checked against published vectors.
 */
export function murmurHash3x86_128(
  data: Uint8Array,
  seed = 0,
): [number, number, number, number] {
  let h1 = seed >>> 0
  let h2 = seed >>> 0
  let h3 = seed >>> 0
  let h4 = seed >>> 0

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const blocks = Math.floor(data.length / 16)

  for (let i = 0; i < blocks; i++) {
    let k1 = view.getUint32(i * 16, true)
    let k2 = view.getUint32(i * 16 + 4, true)
    let k3 = view.getUint32(i * 16 + 8, true)
    let k4 = view.getUint32(i * 16 + 12, true)

    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2)
    h1 = (h1 ^ k1) >>> 0
    h1 = rotl(h1, 19)
    h1 = (h1 + h2) >>> 0
    h1 = (Math.imul(h1, 5) + 0x561ccd1b) >>> 0

    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3)
    h2 = (h2 ^ k2) >>> 0
    h2 = rotl(h2, 17)
    h2 = (h2 + h3) >>> 0
    h2 = (Math.imul(h2, 5) + 0x0bcaa747) >>> 0

    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4)
    h3 = (h3 ^ k3) >>> 0
    h3 = rotl(h3, 15)
    h3 = (h3 + h4) >>> 0
    h3 = (Math.imul(h3, 5) + 0x96cd1c35) >>> 0

    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1)
    h4 = (h4 ^ k4) >>> 0
    h4 = rotl(h4, 13)
    h4 = (h4 + h1) >>> 0
    h4 = (Math.imul(h4, 5) + 0x32ac3b17) >>> 0
  }

  let k1 = 0
  let k2 = 0
  let k3 = 0
  let k4 = 0
  const tail = blocks * 16
  const left = data.length - tail

  if (left >= 15) k4 = (k4 ^ (data[tail + 14]! << 16)) >>> 0
  if (left >= 14) k4 = (k4 ^ (data[tail + 13]! << 8)) >>> 0
  if (left >= 13) {
    k4 = (k4 ^ data[tail + 12]!) >>> 0
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1)
    h4 = (h4 ^ k4) >>> 0
  }
  if (left >= 12) k3 = (k3 ^ (data[tail + 11]! << 24)) >>> 0
  if (left >= 11) k3 = (k3 ^ (data[tail + 10]! << 16)) >>> 0
  if (left >= 10) k3 = (k3 ^ (data[tail + 9]! << 8)) >>> 0
  if (left >= 9) {
    k3 = (k3 ^ data[tail + 8]!) >>> 0
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4)
    h3 = (h3 ^ k3) >>> 0
  }
  if (left >= 8) k2 = (k2 ^ (data[tail + 7]! << 24)) >>> 0
  if (left >= 7) k2 = (k2 ^ (data[tail + 6]! << 16)) >>> 0
  if (left >= 6) k2 = (k2 ^ (data[tail + 5]! << 8)) >>> 0
  if (left >= 5) {
    k2 = (k2 ^ data[tail + 4]!) >>> 0
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3)
    h2 = (h2 ^ k2) >>> 0
  }
  if (left >= 4) k1 = (k1 ^ (data[tail + 3]! << 24)) >>> 0
  if (left >= 3) k1 = (k1 ^ (data[tail + 2]! << 16)) >>> 0
  if (left >= 2) k1 = (k1 ^ (data[tail + 1]! << 8)) >>> 0
  if (left >= 1) {
    k1 = (k1 ^ data[tail]!) >>> 0
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2)
    h1 = (h1 ^ k1) >>> 0
  }

  const len = data.length
  h1 = (h1 ^ len) >>> 0
  h2 = (h2 ^ len) >>> 0
  h3 = (h3 ^ len) >>> 0
  h4 = (h4 ^ len) >>> 0

  h1 = (h1 + h2) >>> 0
  h1 = (h1 + h3) >>> 0
  h1 = (h1 + h4) >>> 0
  h2 = (h2 + h1) >>> 0
  h3 = (h3 + h1) >>> 0
  h4 = (h4 + h1) >>> 0

  h1 = fmix(h1)
  h2 = fmix(h2)
  h3 = fmix(h3)
  h4 = fmix(h4)

  h1 = (h1 + h2) >>> 0
  h1 = (h1 + h3) >>> 0
  h1 = (h1 + h4) >>> 0
  h2 = (h2 + h1) >>> 0
  h3 = (h3 + h1) >>> 0
  h4 = (h4 + h1) >>> 0

  return [h1, h2, h3, h4]
}

/**
 * Hash a uint64 key down to the 64-bit value the shard/minishard split is taken from.
 *
 * The key is hashed as its 8 little-endian bytes, and the result is the first two output
 * words as (h2 << 32) | h1 — which is what neuroglancer uses.
 */
export function hashUint64(key: bigint): bigint {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, key & 0xffffffffffffffffn, true)
  const [h1, h2] = murmurHash3x86_128(bytes)
  return (BigInt(h2) << 32n) | BigInt(h1)
}
