/**
 * `compressed_segmentation`, neuroglancer's encoding for label volumes.
 *
 * A chunk is cut into small blocks — `8×8×8` by convention, but the `info` states it — and each
 * block is stored as a **lookup table of the labels it contains** plus a bit-packed index per
 * voxel, using only as many bits as that block's table needs. A block of one label costs zero
 * bits a voxel; a block of two costs one. That is why a segmentation chunk is a couple of
 * megabytes rather than the thirty-three its voxels would be, and it is also why this decoder is
 * worth having over a `raw` fallback: the format is already factored the way a reader wants it.
 *
 * ## Two things that are silent when wrong
 *
 * **Axis order is x-fastest (Fortran), not C.** The spec says so and cloudvolume passes
 * `order='F'` explicitly, but nothing in a decoded chunk announces the mistake: a transposed
 * block of segmentation is still a plausible block of segmentation, with the same labels, the
 * same voxel counts and the same histogram. It is only wrong *in space*, which is exactly the
 * thing a caller is reading it for. The goldens in `__fixtures__/compressedSegmentation.json`
 * are flattened `order='F'` by the reference encoder for this reason, and the ragged and
 * asymmetric-block cases are there because a cubic block size hides an axis swap completely.
 *
 * **A block's table is addressed from the chunk's start, not the block's.** Offsets in the
 * header are in 32-bit words from the beginning of the channel, and a decoder that reads them
 * as block-relative gets the first block right — its offset happens to be small — and garbage
 * after it.
 *
 * ## Decoding only what is wanted
 *
 * `decodeCompressedSegmentation` takes the sub-box a caller actually needs and visits only the
 * blocks that meet it. That is not a micro-optimisation: a cutout of 188³ voxels sits inside chunks of 256×256×64,
 * so a whole-chunk decode does about eight times the work and allocates eight times the memory
 * for the same answer. The saving is in *decoding*, not in fetching — the chunk arrives whole
 * either way, because that is the unit the store serves.
 */

/** Three numbers, in `x, y, z`. Declared here because `volume.ts` imports this file, not the reverse. */
export type Triple = readonly [number, number, number]

/**
 * The widest `bits` a real encoder emits is 16 — 32 would mean a block whose every voxel is a
 * distinct label, which costs more than storing the labels. This is a guard against a misread
 * header, not a statement about the format.
 */
const MAX_TABLE_BITS = 16

/** What the `info` says about a scale's blocks, and what the header arithmetic needs. */
export interface CompressedSegmentationSpec {
  /** The chunk's extent in voxels, `[x, y, z]`. */
  readonly size: Triple
  /** The block's extent in voxels, `[x, y, z]` — `compressed_segmentation_block_size`. */
  readonly block: Triple
}

/**
 * A decoded region: the distinct labels, and one index per voxel into them.
 *
 * **Factored rather than expanded**, which is the shape the format is already in and the shape
 * every consumer so far wants. A 4.7 M-voxel cutout is 38 MB as `BigUint64Array` and 19 MB as
 * `Uint32Array` indices beside a few thousand labels — and the question actually being asked of
 * it ("which objects are here, and where is each one") is a question about the indices.
 * `expandLabels` is there for a caller that genuinely wants the voxels.
 */
export interface LabelBox {
  /** The distinct labels, ascending. Index 0 is not special; `0` is an ordinary label (no object). */
  readonly labels: BigUint64Array
  /** One index into `labels` per voxel, **x fastest**. See `VoxelIndex` for the two widths. */
  readonly index: VoxelIndex
  /** The region's extent in voxels, `[x, y, z]`. */
  readonly size: Triple
}

/**
 * One slot of a box's label table per voxel, at the narrowest width that can name every slot.
 *
 * **A union because a box is mostly small tables and huge voxel counts.** A 6 M-voxel cutout of
 * a real neuron holds some 14,000 distinct supervoxels, so every index fits in sixteen bits and
 * the second half of a 32-bit array is zeroes — 12 MB of them. `readLabelBox` reads narrow and
 * widens only if the table passes `NARROW_INDEX_LABELS`, so the common case never allocates the
 * wide form at all.
 *
 * It matters most at the Pyodide seam, where the array is copied into a wasm heap that is never
 * given back to the operating system (`docs/python-pyodide.md`): what crosses is what is paid,
 * permanently, for the life of the worker.
 *
 * **Only `readLabelBox` narrows.** The two per-chunk decoders here always return the wide form,
 * because a chunk's table is not known until it has been decoded and a chunk is small enough
 * (about 1.5 MB transient on the measured box) that the dance is not worth it. So the union is
 * what a `LabelBox` promises and narrowness is what the box reader delivers; anything handing a
 * *decoded chunk* across the Pyodide seam would want the same treatment first.
 *
 * **Read it through `ArrayLike<number>` wherever the width does not matter** — which is almost
 * everywhere, since both answer `[i]` with a number.
 */
export type VoxelIndex = Uint16Array | Uint32Array

/**
 * How many labels a 16-bit index can name: slots `0…65535`, so 65,536 of them.
 *
 * `labels.length <= NARROW_INDEX_LABELS`, never `< `: a table of exactly 65,536 entries has its
 * last slot at 65,535, which is `Uint16Array`'s largest value. Off by one here is not a crash —
 * it is every index above the cut wrapping to a different label, which draws a different neuron.
 */
export const NARROW_INDEX_LABELS = 65536

/**
 * A label → slot folder over a caller's own table.
 *
 * The three places that build a `LabelBox` each wrote this out, each with its own `Map`/array
 * pair to keep in step. Keyed on the `bigint` rather than on a `Number` of it, which is invariant
 * 8: a segmentation id is routinely eighteen digits, and two distinct ones collide as doubles.
 *
 * Not on any per-voxel path in either decoder — both resolve a voxel through a typed-array
 * lookup and reach this only once per distinct label. In the block decoder that is once per
 * distinct label **per block**, since the `resolved` memo is per block: measured at roughly
 * 130,000 calls for a 4.7 M-voxel cutout, against 4.7 million voxels. A few milliseconds of the
 * 71 ms decode, not a hot path. (`decodeRawLabels` is the exception and says so itself.)
 */
export function internInto(
  labels: bigint[],
  seen: Map<bigint, number> = new Map(),
): (label: bigint) => number {
  return (label: bigint) => {
    const known = seen.get(label)
    if (known !== undefined) return known
    const slot = labels.length
    labels.push(label)
    seen.set(label, slot)
    return slot
  }
}

/**
 * A `LabelBox` with its labels ascending and every slot used, indices rewritten to match.
 *
 * Both the decoder and the box assembly ended with their own copy of this, and the two did not
 * agree about whether an unused slot could survive — so the property callers were promised
 * depended on which one they happened to call. One statement of it, used by both.
 *
 * **It rewrites in place and never changes the width**, which is safe for a reason worth stating
 * exactly. Sorting does *not* only lower an index — a table of `[0, 10, 5]` sorts to `[0, 5, 10]`
 * and raises slot 1 to index 2. What holds is the bound: an index after this is below
 * `keep.length`, which is at most `labels.length`, which the width already had to name. Choosing
 * the width is `readLabelBox`'s, where the array is allocated; doing it here as well would mean
 * two rules for one property, and this one would have to allocate a second buffer to apply it.
 */
export function canonicalLabels(
  labels: readonly bigint[],
  index: VoxelIndex,
  size: Triple,
): LabelBox {
  const used = new Uint8Array(labels.length)
  for (let i = 0; i < index.length; i++) used[index[i]!] = 1
  const keep = labels
    .map((label, slot) => ({ label, slot }))
    .filter((entry) => used[entry.slot])
  keep.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  const remap = new Uint32Array(labels.length)
  for (let i = 0; i < keep.length; i++) remap[keep[i]!.slot] = i
  for (let i = 0; i < index.length; i++) index[i] = remap[index[i]!]!
  return { labels: BigUint64Array.from(keep.map((entry) => entry.label)), index, size }
}

/** The voxels themselves, for a caller that wants them rather than the factored form. */
export function expandLabels(box: LabelBox): BigUint64Array {
  const out = new BigUint64Array(box.index.length)
  for (let i = 0; i < box.index.length; i++) out[i] = box.labels[box.index[i]!]!
  return out
}

/**
 * A reader over the packed bits of one block.
 *
 * Values are packed **little-endian within 32-bit words**, low bits first, and a value never
 * straddles a word: the encoder pads to the word rather than splitting, so `32 % bits` wasted
 * bits per word is the format's own choice and not an approximation here.
 */
function readPacked(words: Uint32Array, wordOffset: number, bits: number, at: number): number {
  if (bits === 0) return 0
  const perWord = Math.floor(32 / bits)
  const word = words[wordOffset + Math.floor(at / perWord)]
  /*
   * Checked rather than asserted, and the difference is a silent answer against a loud one. A
   * typed array reads past its end as `undefined`, and `undefined >>> shift` is `0` — so a
   * chunk that arrived short (a Range request served partially, a store returning a truncated
   * object) decoded as label-index 0 for every voxel past the cut, which is an ordinary-looking
   * region of empty space in the middle of a neuron. Found by the truncation test, which is why
   * that test exists.
   */
  if (word === undefined) {
    throw new Error('compressed_segmentation: chunk ends inside its packed values')
  }
  const shift = (at % perWord) * bits
  // No 32-bit arm: `MAX_TABLE_BITS` refuses anything wider before this is ever called, so a
  // `bits === 32` branch here would describe a width the decoder deliberately does not accept.
  return (word >>> shift) & ((1 << bits) - 1)
}

/**
 * Decode one channel of a `compressed_segmentation` chunk, over a sub-box of it.
 *
 * `lo`/`hi` are in the chunk's own voxel coordinates, `lo` inclusive and `hi` exclusive; pass
 * `[0,0,0]` and `spec.size` for the whole chunk. The result's labels are the distinct labels
 * **of the sub-box**, not of the chunk — a caller asking for a corner should not be handed the
 * ten thousand objects it did not ask about.
 */
export function decodeCompressedSegmentation(
  buffer: ArrayBuffer,
  spec: CompressedSegmentationSpec,
  dtype: 'uint32' | 'uint64',
  lo: Triple = [0, 0, 0],
  hi?: Triple,
  channel = 0,
): LabelBox {
  const end = hi ?? spec.size
  const words = new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4))
  // The channel table at the head of the chunk: one 32-bit word offset per channel.
  const channelOffset = words[channel]
  if (channelOffset === undefined) {
    throw new Error(`compressed_segmentation: no channel ${channel} in this chunk`)
  }

  const [sx, sy] = spec.size
  const [bx, by, bz] = spec.block
  if (bx <= 0 || by <= 0 || bz <= 0) {
    throw new Error('compressed_segmentation: the block size must be positive in every axis')
  }
  // Blocks per x and y, rounded up — the two strides a block's index needs. The last block of
  // an axis is partial where the chunk's extent is not a multiple of it, and its voxels past the
  // edge are encoded but meaningless.
  const nx = Math.ceil(sx / bx)
  const ny = Math.ceil(sy / by)

  const size: [number, number, number] = [end[0] - lo[0], end[1] - lo[1], end[2] - lo[2]]
  if (size[0] <= 0 || size[1] <= 0 || size[2] <= 0) {
    throw new Error('compressed_segmentation: the requested box is empty')
  }
  /*
   * A caller error, like the empty box above, and refused for the same reason. The block loops
   * clamp to the chunk's extent but `size` is computed from `end`, so a box reaching past the
   * chunk came back the size that was *asked for* with the overhang left as index 0 — a band of
   * "no object" along one face, which reads as an ordinary edge of a segmentation. Refusing also
   * lets the per-block `sx`/`sy`/`sz` clamps below go, since nothing can now exceed them.
   */
  for (let axis = 0; axis < 3; axis++) {
    if (end[axis]! > spec.size[axis]!) {
      throw new Error(
        `compressed_segmentation: the box reaches to ${end.join(', ')} where the chunk is ` +
          `${spec.size.join(', ')} voxels — ask only for what the chunk holds`,
      )
    }
  }
  const index = new Uint32Array(size[0] * size[1] * size[2])
  // The box's own table, built as the blocks are visited. `internInto` owns the keying and the
  // invariant-8 reason for it.
  const order: bigint[] = []
  const intern = internInto(order)

  const wide = dtype === 'uint64'
  // Only the blocks that meet the box, which is the whole reason this takes one. The clamp is
  // named rather than packed into the loop header, so there is one place to check it.
  const lastX = Math.ceil(end[0] / bx)
  const lastY = Math.ceil(end[1] / by)
  const lastZ = Math.ceil(end[2] / bz)
  for (let iz = Math.floor(lo[2] / bz); iz < lastZ; iz++) {
    for (let iy = Math.floor(lo[1] / by); iy < lastY; iy++) {
      for (let ix = Math.floor(lo[0] / bx); ix < lastX; ix++) {
        const block = ix + iy * nx + iz * nx * ny
        /*
         * Each block's header is two 32-bit words at `channelOffset + block * 2`:
         *   [0] bits 0..23 the lookup table's offset in words, bits 24..31 the bits per voxel
         *   [1]            the packed values' offset in words
         * Both offsets are from the **channel's** start, which is the trap the header comment
         * above names: read as block-relative, the first block decodes and the rest do not.
         */
        const header = channelOffset + block * 2
        const first = words[header]
        const valuesOffset = words[header + 1]
        if (first === undefined || valuesOffset === undefined) {
          throw new Error(`compressed_segmentation: chunk ends inside block ${block}'s header`)
        }
        const tableOffset = first & 0xffffff
        const bits = (first >>> 24) & 0xff

        const x0 = Math.max(lo[0], ix * bx)
        const y0 = Math.max(lo[1], iy * by)
        const z0 = Math.max(lo[2], iz * bz)
        const x1 = Math.min(end[0], (ix + 1) * bx)
        const y1 = Math.min(end[1], (iy + 1) * by)
        const z1 = Math.min(end[2], (iz + 1) * bz)

        /*
         * One slot per *possible* packed value, filled lazily as each is met. Lazily because a
         * block encoded at 16 bits has 65,536 slots and typically uses a handful, so reading
         * the whole table would be the bulk of the work for a block of 512 voxels.
         *
         * `MAX_TABLE_BITS` is a sanity bound, not a format limit: `bits` comes out of a byte of
         * the header, so a corrupt or misread chunk can claim 255 and ask for a 2^255 array.
         * Refusing names the chunk; allocating would be an unexplained crash.
         *
         * **The cliff is the block size, not the label count.** At the conventional 8×8×8 a
         * block holds 512 voxels, so `bits` is 4 in practice (measured: 8,192 of 8,192 blocks of
         * a real chunk) and this array is sixteen entries — 0.84 ms of allocation over a whole
         * cutout, against 0.36 ms for one reused buffer, so a module-scoped scratch is not worth
         * it. A dataset publishing 16³ or 32³ blocks would make 16 bits reachable and each of
         * these 256 KB, which is what the bound is really for.
         */
        /*
         * A width that does not divide 32 is refused as well as one that is too wide. The
         * packing puts whole values into 32-bit words and pads the remainder, which only makes
         * sense for 0, 1, 2, 4, 8 and 16 — the widths real encoders emit. `readPacked` assumes
         * it, so a header misread as 3 or 9 would decode plausible garbage instead of saying
         * the chunk is not what it claims to be.
         */
        if (bits > MAX_TABLE_BITS || (bits > 0 && 32 % bits !== 0)) {
          throw new Error(
            `compressed_segmentation: block ${block} claims ${bits} bits a voxel, which no ` +
              'encoder produces — the chunk is corrupt or is not this encoding',
          )
        }
        const resolved = new Int32Array(1 << bits).fill(-1)

        for (let z = z0; z < z1; z++) {
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const within = x - ix * bx + (y - iy * by) * bx + (z - iz * bz) * bx * by
              const packed = readPacked(words, channelOffset + valuesOffset, bits, within)
              let slot = resolved[packed]!
              if (slot < 0) {
                const at = channelOffset + tableOffset + packed * (wide ? 2 : 1)
                const low = words[at]
                // Both words checked, not just the first. `?? 0` on the high word turned a
                // chunk truncated *between* the two into a different 18-digit segment id —
                // silently, and a wrong id is a different neuron (invariant 8). The low word's
                // guard made exactly this argument while the high word undid it.
                const high = wide ? words[at + 1] : 0
                if (low === undefined || high === undefined) {
                  throw new Error(
                    `compressed_segmentation: block ${block} names a label past the chunk`,
                  )
                }
                const label = wide
                  ? BigInt(low >>> 0) | (BigInt(high >>> 0) << 32n)
                  : BigInt(low >>> 0)
                slot = intern(label)
                resolved[packed] = slot
              }
              const out = x - lo[0] + (y - lo[1]) * size[0] + (z - lo[2]) * size[0] * size[1]
              index[out] = slot
            }
          }
        }
      }
    }
  }

  /*
   * Ascending, regardless of the order the blocks were walked in — the shared pass, which the
   * box assembly in `volume.ts` also ends with. Without it the table's order is an artefact of
   * this loop, which two cutouts of the same region could differ on after any change to the
   * traversal.
   *
   * It costs two passes over the sub-box, not one: `canonicalLabels` also scans for unused
   * slots, which here can never find any — every label it tables was interned inside the voxel
   * loop and written to an index in the same breath. Measured at ~2.5 ms of a 1,200 ms read, and
   * kept, because the alternative is this invariant having two implementations again.
   */
  return canonicalLabels(order, index, size)
}
