/**
 * `lz4js` ships no types.
 *
 * Only the block decoder and its size bound are used — `libraries.ts` walks the frame itself,
 * `lz4js`' own frame walk misreading block checksums — plus `compress`, which only
 * `libraries.test.ts` calls, to hold that walk to a frame `lz4js` wrote. See `arrow()` in
 * `data/libraries.ts`.
 */
declare module 'lz4js' {
  export function compress(data: Uint8Array): Uint8Array
  /** An upper bound on a frame's decoded size, read from its header and block sizes. */
  export function decompressBound(src: Uint8Array): number
  /** One block `src[sIndex, sIndex + sLength)` into `dst` at `dIndex`; the index after it. */
  export function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ): number
  const lz4: {
    compress: typeof compress
    decompressBound: typeof decompressBound
    decompressBlock: typeof decompressBlock
  }
  export default lz4
}
