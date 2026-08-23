/**
 * `lz4js` ships no types.
 *
 * Only the frame decoder is used, and only to satisfy `apache-arrow`'s compression registry —
 * which validates a codec by round-tripping it, so `compress` has to be declared even though
 * nothing here ever writes an Arrow file. See `data/edges/binary.ts`.
 */
declare module 'lz4js' {
  export function compress(data: Uint8Array): Uint8Array
  export function decompress(data: Uint8Array): Uint8Array
  const lz4: { compress: typeof compress; decompress: typeof decompress }
  export default lz4
}
