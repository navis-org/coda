/**
 * The zip writer.
 *
 * Every assertion here is about bytes, because that is the only thing that distinguishes a
 * working archive from one that opens and is quietly missing files — the failure the whole
 * module exists to avoid. So the tests parse the archive back out of the central directory
 * rather than trusting the writer's own bookkeeping.
 */

import { describe, expect, it } from 'vitest'

import { ZIP_MAX_ENTRIES, zipFiles } from './zip'

const FIXED = new Date(2026, 7, 27, 14, 32, 10)

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Read an archive the way an extractor does: from the end-of-central-directory record backwards,
 * never from the local headers.
 *
 * That is the point of testing it this way. A writer whose local headers are right and whose
 * central directory offsets are wrong produces a file that some tools open and others do not,
 * and reading the locals in order would agree with the bug.
 */
async function readEntries(
  archive: Blob,
): Promise<Array<{ name: string; text: string; crc: number }>> {
  const data = await bytes(archive)
  const view = new DataView(data.buffer)
  const decoder = new TextDecoder()

  // End-of-central-directory: last 22 bytes when there is no archive comment, which this writer
  // never emits.
  const eocd = data.length - 22
  expect(view.getUint32(eocd, true)).toBe(0x06054b50)
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)

  const out: Array<{ name: string; text: string; crc: number }> = []
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const localAt = view.getUint32(at + 42, true)
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength))

    // Follow the offset the directory gave us into the local header, which is what proves the
    // two halves agree.
    expect(view.getUint32(localAt, true)).toBe(0x04034b50)
    const localNameLength = view.getUint16(localAt + 26, true)
    const extraLength = view.getUint16(localAt + 28, true)
    const start = localAt + 30 + localNameLength + extraLength
    out.push({ name, crc, text: decoder.decode(data.subarray(start, start + size)) })

    at += 46 + nameLength
  }
  return out
}

describe('zipFiles', () => {
  it('round-trips names and contents through the central directory', async () => {
    const archive = await zipFiles(
      [
        { name: 'a.swc', parts: ['# one\n1 0 0 0 0 1 -1\n'] },
        { name: 'b.swc', parts: ['# two\n1 0 5 5 5 1 -1\n'] },
      ],
      FIXED,
    )
    const entries = await readEntries(archive)
    expect(entries.map((e) => e.name)).toEqual(['a.swc', 'b.swc'])
    expect(entries[0]!.text).toContain('# one')
    expect(entries[1]!.text).toContain('# two')
  })

  it('keeps a path, so a loop can write one folder per group', async () => {
    const archive = await zipFiles([{ name: 'LC4/720575940624.swc', parts: ['x'] }], FIXED)
    // No separate directory entry, which is legal and what every extractor expects.
    expect((await readEntries(archive)).map((e) => e.name)).toEqual(['LC4/720575940624.swc'])
  })

  /**
   * CRC-32 against a known value.
   *
   * Pinned to a constant rather than recomputed by the test, because a test that computes the
   * checksum the same way the writer does agrees with a wrong implementation. `"123456789"` is
   * the standard CRC-32 check vector: 0xCBF43926.
   */
  it('computes a CRC an extractor will accept', async () => {
    const archive = await zipFiles([{ name: 'check', parts: ['123456789'] }], FIXED)
    expect((await readEntries(archive))[0]!.crc).toBe(0xcbf43926)
  })

  it('handles an empty archive without a malformed record', async () => {
    expect(await readEntries(await zipFiles([], FIXED))).toEqual([])
  })

  /*
   * The one refusal, and it earns its place on docs/limits.md's terms: past 65,535 the entry
   * count field wraps, and what comes out is an archive that opens with the wrong number of
   * files in it. There is no useful answer on the other side to warn about.
   */
  it('refuses past the entry count the format can express', async () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `${i}.txt`,
      parts: ['x'],
    }))
    await expect(zipFiles(many, FIXED)).rejects.toThrow(/at most 65,535 files/)
  })

  it('is byte-identical for the same input and the same stamp', async () => {
    const make = () => zipFiles([{ name: 'a', parts: ['hello'] }], FIXED)
    expect(await bytes(await make())).toEqual(await bytes(await make()))
  })
})
