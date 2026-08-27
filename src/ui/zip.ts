/**
 * A minimal ZIP writer, for the loop that has more files than a browser will download.
 *
 * `downloadFiles` writes one `<a download>` per file, and browsers stop honouring those
 * somewhere past about fifty from a single gesture — with no error, which is why
 * `MAX_MORPHOLOGY_FILES` exists and caps at fifty rather than letting an export half-work. A
 * `For Each` over four hundred neurons writes four hundred files, so it needs a route that is
 * not one download each. There are two, and this is the one that works everywhere.
 *
 * ## Stored, not deflated, and that is a measurement rather than laziness
 *
 * Everything a loop writes is text — SWC, OBJ, CSV — and text is exactly what `Content-Encoding`
 * already compresses on the way in and what the filesystem compresses on the way out. Deflating
 * it here would mean shipping an inflate/deflate implementation or pulling in a dependency, to
 * spend CPU on the main thread, per file, during a loop somebody is watching a progress bar for.
 * `CompressionStream` exists in every browser this targets and would avoid the dependency, but
 * it is async per entry and its output length is not known until it finishes, which is exactly
 * the field a local header has to carry. Method 0 keeps the writer synchronous and the sizes
 * known, and a 4 MB skeleton set becomes a 4 MB zip that every tool opens.
 *
 * ## What it does not do
 *
 * **ZIP64.** The format's 32-bit fields cap an archive at 4 GB and 65,535 entries, and past
 * either the central directory silently describes the wrong offsets — an archive that opens and
 * is missing files, which is the failure mode this whole file exists to avoid. So `zipFiles`
 * refuses past them rather than producing one, and `ZIP_MAX_*` are the numbers. That is one of
 * the few refusals in the codebase and it earns it on `docs/limits.md`'s own terms: there is no
 * useful answer on the other side, only a corrupt archive.
 *
 * **Directories.** A name containing `/` makes a path inside the archive and every extractor
 * creates the folders; there is no separate directory entry, which is legal and universal.
 */

/** 32-bit fields: past this the central directory's offsets are wrong. */
export const ZIP_MAX_BYTES = 0xffffffff
/** The end-of-central-directory record counts entries in 16 bits. */
export const ZIP_MAX_ENTRIES = 0xffff

export interface ZipEntry {
  /** Path inside the archive. `/` makes folders; no leading slash. */
  name: string
  parts: BlobPart[]
}

/**
 * CRC-32, table-driven.
 *
 * Built once and lazily: 256 entries of shifting is a millisecond nobody should pay for opening
 * a graph that never zips anything, and the loop that does pay is running four hundred network
 * fetches beside it.
 */
let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array, seed = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) {
    crc = (crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS date and time, which is what a ZIP local header carries.
 *
 * Two-second resolution and a 1980 epoch, both the format's. Taken as an argument rather than
 * read from a clock so a test can byte-compare an archive — the same rule `ZooIndex.updatedAt`
 * follows, and for the same reason: a generated artefact that differs from itself on every run
 * cannot be checked.
 */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear())
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

async function bytesOf(parts: BlobPart[]): Promise<Uint8Array> {
  return new Uint8Array(await new Blob(parts).arrayBuffer())
}

/**
 * Build a ZIP archive from a list of named byte blobs.
 *
 * Async because the parts arrive as `BlobPart[]` — the shape every existing exporter already
 * produces — and reading a Blob back as bytes is the only way to get a CRC and a length out of
 * one. Everything else here is synchronous.
 */
export async function zipFiles(entries: ZipEntry[], now: Date = new Date()): Promise<Blob> {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error(
      `A zip holds at most ${ZIP_MAX_ENTRIES.toLocaleString('en-US')} files and this run made ` +
        `${entries.length.toLocaleString('en-US')}. Split the loop with “First N”, or write to a ` +
        `folder instead — that route has no limit.`,
    )
  }

  const encoder = new TextEncoder()
  const { time, date } = dosStamp(now)
  const locals: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0
  let centralSize = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = await bytesOf(entry.parts)
    const crc = crc32(data)

    if (offset + data.length > ZIP_MAX_BYTES) {
      throw new Error(
        `A zip holds at most 4 GB and this run passed it. Write to a folder instead — that ` +
          `route streams to disk and has no limit — or narrow the loop with “First N”.`,
      )
    }

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header signature
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 0, true) // method 0 — stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true) // extra field length
    /*
     * `entry.parts`, not the decoded `data`. The bytes were read to take a CRC and a length;
     * pushing the array as well would keep a second full copy of the archive in the JS heap
     * beside the one the final `Blob` makes — on the documented 400 x 2 MB case, several hundred
     * megabytes for nothing. `Blob` holds the original parts by reference either way.
     */
    locals.push(local.buffer, name, ...entry.parts)

    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true) // central directory header signature
    dir.setUint16(4, 20, true) // version made by
    dir.setUint16(6, 20, true) // version needed
    dir.setUint16(8, 0x0800, true)
    dir.setUint16(10, 0, true)
    dir.setUint16(12, time, true)
    dir.setUint16(14, date, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, data.length, true)
    dir.setUint32(24, data.length, true)
    dir.setUint16(28, name.length, true)
    dir.setUint16(30, 0, true) // extra
    dir.setUint16(32, 0, true) // comment
    dir.setUint16(34, 0, true) // disk number
    dir.setUint16(36, 0, true) // internal attributes
    dir.setUint32(38, 0, true) // external attributes
    dir.setUint32(42, offset, true) // offset of local header
    central.push(dir.buffer, name)

    offset += 30 + name.length + data.length
    // Accumulated here rather than re-derived from `central` afterwards: that meant an
    // `instanceof` and an unchecked cast guarding an invariant this loop already controls, and a
    // third part shape pushed above would have made the size silently wrong — which is exactly
    // an archive whose directory cannot be read.
    centralSize += 46 + name.length
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory signature
  end.setUint16(4, 0, true) // disk number
  end.setUint16(6, 0, true) // disk with central directory
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  end.setUint16(20, 0, true) // comment length

  return new Blob([...locals, ...central, end.buffer], { type: 'application/zip' })
}
