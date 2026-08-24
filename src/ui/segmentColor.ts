/**
 * Neuroglancer's segment colours, reproduced exactly.
 *
 * A connectome id is not a category. Twenty neurons of one cell type share a type, a side and
 * a status, and what tells them apart in a picture is *which one they are* — so the honest
 * encoding is one colour per id, drawn from the id itself. Coda's categorical palette cannot
 * do that: it has eight validated slots and folds the ninth value into grey, which is the
 * right rule for a series and the wrong one for identity.
 *
 * ## Why neuroglancer's hash and not one of our own
 *
 * Because people already have these colours on screen. Every FlyWire, hemibrain and CAVE view
 * anyone opens colours segments this way, so a neuron that is teal there being teal here is
 * the difference between two views of one dataset and two unrelated pictures. Inventing a
 * hash would have produced colours that are *fine* and match nothing.
 *
 * The match is exact rather than approximate, and it is checkable: this is a transcription of
 * `segment_color.ts` and `gpu_hash/hash_function.ts` from google/neuroglancer (Apache-2.0),
 * down to the rotation amounts. `SegmentColorHash.getDefault()` is seeded with **0**, and its
 * `toJSON` omits the seed when it is 0 — so a link that carries no `segmentColorSeed` is a
 * link using seed 0, which is every link the Neuroglancer node emits. Colours agree by
 * construction, not by eye.
 *
 * ## What it is not
 *
 * Not accessible, and not claimed to be. The hues are spread over the whole circle with no
 * regard for the colourblind-safety gate `colors.ts` documents, and two neurons out of a
 * hundred will land near each other. That is the trade an identity encoding makes — the
 * alternative is eight neurons distinguishable and ninety-two grey — and it is why this lives
 * in its own file rather than joining the validated palette, which must stay the thing that
 * gets used when colour carries meaning rather than identity.
 */

/** MurmurHash3's two mixing constants, verbatim from `gpu_hash/hash_function.ts`. */
const K1 = 0xcc9e2d51
const K2 = 0x1b873593

/**
 * One MurmurHash3 round: mix `value` into `state`.
 *
 * Deliberately *not* a complete Murmur — neuroglancer omits the final avalanche, and adding it
 * would produce a perfectly good hash that gives different colours. Every `>>> 0` is load
 * bearing: JS bitwise operators yield signed int32, and one missing coercion turns a colour
 * into a different colour rather than into an error.
 */
export function hashCombine(state: number, value: number): number {
  value >>>= 0
  state >>>= 0
  value = Math.imul(value, K1) >>> 0
  value = ((value << 15) | (value >>> 17)) >>> 0
  value = Math.imul(value, K2) >>> 0
  state = (state ^ value) >>> 0
  state = ((state << 13) | (state >>> 19)) >>> 0
  state = (state * 5 + 0xe6546b64) >>> 0
  return state
}

/** Low 32 bits first, then high — the order `SegmentColorHash.compute` combines them in. */
const LOW_32 = 0xffffffffn
const UINT64 = 0xffffffffffffffffn

/**
 * The hash a segment id resolves to.
 *
 * Ids arrive as **text**, per invariant 8, and that is exactly what this needs: an 18-digit
 * CAVE root id is not representable as a float64, so a hash taken after `Number(id)` would be
 * the hash of a *different id* — silently, and only for the ids that matter most.
 *
 * A value that is not a run of digits is not a segment id at all, and neuroglancer has no
 * answer for one. Rather than refuse, the same round is folded over the string's code units:
 * a cell type name gets a stable colour of its own, which is the useful behaviour when
 * somebody points this mode at a `type` column. Nothing about that case claims to match
 * neuroglancer, because there is nothing there to match.
 */
function hashOf(id: string, seed: number): number {
  if (/^\d+$/.test(id)) {
    // Masked to 64 bits rather than rejected: that is the width a segment id has, and it is
    // what the two 32-bit halves below can express between them.
    const value = BigInt(id) & UINT64
    return hashCombine(hashCombine(seed, Number(value & LOW_32)), Number(value >> 32n))
  }
  let state = seed
  for (let i = 0; i < id.length; i++) state = hashCombine(state, id.charCodeAt(i))
  return state >>> 0
}

/**
 * HSV to RGB, transcribed from neuroglancer's `util/colorspace.ts`.
 *
 * Written out rather than pulled from a colour library for the reason the whole file exists:
 * the point is bit-for-bit agreement with a particular implementation, and a library's
 * rounding at the sector boundaries is a place where "nearly the same colour" could creep in.
 */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const scaled = h * 6
  const sector = Math.floor(scaled)
  const remainder = scaled - sector
  const val1 = v * (1 - s)
  const val2 = v * (1 - s * remainder)
  const val3 = v * (1 - s * (1 - remainder))
  switch (sector % 6) {
    case 0:
      return [v, val3, val1]
    case 1:
      return [val2, v, val1]
    case 2:
      return [val1, v, val3]
    case 3:
      return [val1, val2, v]
    case 4:
      return [val3, val1, v]
    default:
      return [v, val1, val2]
  }
}

const hex2 = (channel: number) =>
  Math.round(Math.min(1, Math.max(0, channel)) * 255)
    .toString(16)
    .padStart(2, '0')

/**
 * The colour neuroglancer draws this segment in, as `#rrggbb`.
 *
 * Hue and saturation come out of the hash; **value is pinned at 1**, which is neuroglancer's
 * own choice and worth knowing about: every colour this returns is fully bright, so the set
 * reads on a black background and washes out on a white one. That is one more reason the
 * scene's `Background` control exists.
 *
 * `seed` is neuroglancer's `segmentColorSeed`. 0 is the default state — the one a link with no
 * seed in it is using — so it is the default here too.
 */
export function segmentColor(id: string, seed = 0): string {
  const h = hashOf(id, seed)
  const hue = (h & 0xff) / 255
  const saturation = 0.5 + 0.5 * (((h >>> 8) & 0xff) / 255)
  const [r, g, b] = hsvToRgb(hue, saturation, 1)
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}
