/**
 * Bytes as base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` is the one-liner and it blows the call stack: an Explore
 * select-all packs to roughly 42,000 bytes, which is already past what some engines will spread
 * into arguments, and nothing about the failure names the array that did it.
 *
 * Its own module because two unrelated things need it — the share-link codec and the Cytoscape
 * Web hand-off — and neither should have to import the other to get it.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
