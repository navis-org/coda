#!/usr/bin/env node
/**
 * Read a real segmentation cutout through Coda's own volume reader, in a browser.
 *
 *   pnpm probe:volume                     # needs a dev server on 5178, or pass --url
 *
 * **What this checks that `volume.test.ts` cannot.** The unit tests pin the decoder against the
 * reference encoder's own output and the addressing against hand-computed chunk names, both on
 * fixtures. What they cannot show is that the two halves meet correctly over a *real* volume:
 * that the `info` at a live URL parses, that the chunk names this builds are the objects the
 * store actually serves, that eight of them assemble into one box the right way round, and that
 * the result is the same box the reference decoder produces in Python.
 *
 * The comparison is against `__fixtures__/aedesCutout.json`, which was made by decoding the same
 * eight chunks with the `compressed_segmentation` package — the library cloudvolume calls — at
 * `order='F'`. It carries the distinct-label count, the non-zero voxel count and **forty named
 * voxels**, and the named voxels are the point: a transposed or offset read matches both counts
 * exactly, because a wrong-but-consistent read of a box holds the same labels in the same
 * proportions. Only asking "what is at 177, 117, 91" tells the two apart.
 *
 * **If the segmentation is rebuilt, every check here fails at once** — that pattern is the
 * signal, and it means the golden is stale rather than the reader broken. One check failing
 * alone is the reader. To regenerate: fetch the chunks named in `chunk_names` and decode each
 * with `compressed_segmentation.decompress(..., order='F')`, crop to `lo`/`hi`, and rewrite the
 * counts and the forty samples.
 *
 * SEAM invariant 7 and Coda's rule both hold here: this reads a public bucket and writes
 * nothing. The bucket needs no credential — that it is CORS-open is half of what makes the
 * search a browser phase at all, so the probe reports it rather than assuming it.
 */

import { readFileSync } from 'node:fs'

import {
  APP_MODULE,
  deleteProfileOnExit,
  launchChrome,
  probeArgs,
  probeReport,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const golden = JSON.parse(
  readFileSync(new URL('../src/data/precomputed/__fixtures__/aedesCutout.json', import.meta.url)),
)
/**
 * The second half: one chunk of the MaleCNS EM, which is `jpeg` **and** sharded.
 *
 * Those were the two paths nothing exercised — the tests reach only their refusals, because
 * jsdom has neither `createImageBitmap` nor `OffscreenCanvas`, and Aedes' segmentation is
 * unsharded. One volume covers both, and it is public and CORS-open like the other.
 */
const em = JSON.parse(
  readFileSync(new URL('../src/data/precomputed/__fixtures__/cnsEmChunk.json', import.meta.url)),
)

const report = probeReport()
const PROFILE = '/tmp/coda-volume-profile'
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9372, profile: PROFILE })
// No credential here — the bucket is public — but the profile is still this script's to clean
// up, and `launchChrome` only clears it at the *next* launch.
deleteProfileOnExit(PROFILE, close)

try {
  await send('Page.navigate', { url })
  await waitFor('Boolean(document.querySelector("#root"))', 'the app')

  const script = `(async () => {
    const load = ${APP_MODULE}
    const volume = await load('/src/data/precomputed/volume.ts')

    const base = ${JSON.stringify(golden.volume)}
    const started = performance.now()
    const info = await volume.openVolume(base)
    const openedAt = performance.now() - started

    // The scale SEAM asks for by resolution rather than by name, since that is how a caller that
    // does not know the volume picks one.
    const scale = volume.scaleNear(info, 64)
    const box = volume.boxAround(scale, ${JSON.stringify(golden.centre_nm)}, ${golden.half_width_nm})
    const chunks = volume.chunksCovering(scale, box)

    const readStarted = performance.now()
    let fetched = 0
    const read = await volume.readLabelBox(base, scale, box, {
      onProgress: (done) => { fetched = done },
    })
    const readMs = performance.now() - readStarted

    let nonZero = 0
    const zeroAt = read.labels.indexOf(0n)
    for (let i = 0; i < read.index.length; i++) if (read.index[i] !== zeroAt) nonZero += 1

    const at = (p) => {
      const slot = read.index[p[0] + p[1] * read.size[0] + p[2] * read.size[0] * read.size[1]]
      return read.labels[slot].toString()
    }
    return {
      scaleKey: scale.key,
      resolution: scale.resolution,
      voxelOffset: scale.voxelOffset,
      dataType: scale.dataType,
      encoding: scale.encoding,
      lo: box.lo, hi: box.hi, size: [...read.size],
      chunks: chunks.length,
      chunkNames: chunks.map((c) => c.name),
      distinct: read.labels.length,
      nonZero,
      samples: ${JSON.stringify(golden.samples.map((s) => s.at))}.map(at),
      openedAt: Math.round(openedAt),
      readMs: Math.round(readMs),
      fetched,
    }
  })()`

  const got = await evaluate(script, 180_000)
  if (!got || got.error) throw new Error(got?.error ?? 'the page returned nothing')

  console.log(JSON.stringify({ ...got, chunkNames: undefined, samples: undefined }, null, 2))

  report.check(got.scaleKey === golden.scale, `the 64 nm ask lands on ${golden.scale}`)
  report.check(
    got.encoding === 'compressed_segmentation' && got.dataType === 'uint64',
    `the scale reads as ${got.encoding}/${got.dataType}`,
  )
  report.check(
    JSON.stringify(got.lo) === JSON.stringify(golden.lo) &&
      JSON.stringify(got.hi) === JSON.stringify(golden.hi),
    `the box is ${got.lo} to ${got.hi}`,
  )
  report.check(
    JSON.stringify(got.size) === JSON.stringify(golden.size),
    `the box is ${got.size.join('×')} voxels`,
  )
  report.check(got.chunks === 8 && got.fetched === 8, `${got.chunks} chunks, all fetched`)
  /*
   * The names, not just the count. These are the strongest assertion available for the
   * voxel-offset trap: a grid anchored on zero instead of on `[1024, 1536, 0]` still asks for
   * eight real chunks that all return data, so a count cannot tell the two apart and these can.
   */
  report.check(
    JSON.stringify(got.chunkNames) === JSON.stringify(golden.chunk_names),
    `the eight chunk names are the store's own`,
  )
  report.check(
    got.distinct === golden.distinct_labels,
    `${got.distinct} distinct labels (reference ${golden.distinct_labels})`,
  )
  report.check(
    got.nonZero === golden.nonzero_voxels,
    `${got.nonZero} non-zero voxels (reference ${golden.nonzero_voxels})`,
  )

  /*
   * The check the counts cannot make. A box read transposed, or offset by a chunk, holds exactly
   * the same labels in the same proportions as the right one — so both counts above pass while
   * every voxel is in the wrong place. These forty are the discrimination.
   */
  const wrong = golden.samples.flatMap((sample, at) =>
    got.samples[at] === sample.label ? [] : [{ ...sample, got: got.samples[at] }],
  )
  report.check(
    wrong.length === 0,
    wrong.length === 0
      ? `all ${golden.samples.length} named voxels hold the reference's label`
      : `${wrong.length} of ${golden.samples.length} named voxels differ, e.g. at ` +
        `${wrong[0].at.join(',')}: ${wrong[0].got} against ${wrong[0].label}`,
  )

  console.log(
    `\nOne 6 µm cutout: ${got.chunks} chunks, ${got.readMs} ms in the browser ` +
      `(the info took ${got.openedAt} ms).`,
  )

  // ── The image and sharded arms ───────────────────────────────────────────────────────────
  const imageScript = `(async () => {
    const load = ${APP_MODULE}
    const volume = await load('/src/data/precomputed/volume.ts')
    const base = ${JSON.stringify(em.volume)}
    const info = await volume.openVolume(base)
    const scale = info.scales.find((one) => one.key === ${JSON.stringify(em.scale)})
    if (!scale) return { error: 'no scale ' + ${JSON.stringify(em.scale)} }

    const lo = ${JSON.stringify(em.voxelLo)}
    const chunk = ${JSON.stringify(em.chunk)}
    const box = { lo, hi: [lo[0] + chunk[0], lo[1] + chunk[1], lo[2] + chunk[2]] }
    const started = performance.now()
    const read = await volume.readScalarBox(base, scale, box, { info })
    const readMs = performance.now() - started

    let total = 0
    for (let i = 0; i < read.values.length; i++) total += read.values[i]
    const mean = total / read.values.length
    let variance = 0
    for (let i = 0; i < read.values.length; i++) variance += (read.values[i] - mean) ** 2
    const at = (p) =>
      read.values[p[0] + p[1] * read.size[0] + p[2] * read.size[0] * read.size[1]]
    /*
     * Two z sections compared directly. A reader that takes the tall 2-D image as one
     * chunkX × chunkY plane gets section 0 right and repeats it down the stack, which is the
     * one silent failure decodeImageChunk names — and it would pass a mean or an sd.
     */
    const section = (z) => {
      let sum = 0
      for (let i = 0; i < read.size[0] * read.size[1]; i++) {
        sum += read.values[z * read.size[0] * read.size[1] + i]
      }
      return sum
    }
    return {
      encoding: scale.encoding,
      sharded: Boolean(scale.sharding),
      size: [...read.size],
      missingChunks: read.missingChunks,
      mean: Number(mean.toFixed(4)),
      sd: Number(Math.sqrt(variance / read.values.length).toFixed(4)),
      samples: ${JSON.stringify(em.samples.map((one) => one.at))}.map(at),
      sections: [section(0), section(32)],
      readMs: Math.round(readMs),
    }
  })()`

  const image = await evaluate(imageScript, 180_000)
  if (!image || image.error) throw new Error(image?.error ?? 'the page returned nothing')
  console.log(`\n${JSON.stringify({ ...image, samples: undefined }, null, 2)}`)

  report.check(
    image.encoding === 'jpeg' && image.sharded,
    `the EM scale is ${image.encoding} and sharded — the two paths nothing else reaches`,
  )
  report.check(image.missingChunks === 0, 'the sharded chunk was found, not read as absent')
  report.check(
    JSON.stringify(image.size) === JSON.stringify(em.chunk),
    `the box is ${image.size.join('×')} voxels`,
  )
  report.check(
    Math.abs(image.mean - em.mean) < 1.5 && Math.abs(image.sd - em.sd) < 1.5,
    `mean ${image.mean} and sd ${image.sd} against Pillow's ${em.mean} and ${em.sd}`,
  )
  /*
   * The check a mean cannot make, and the reason this arm exists: a reader that treats the tall
   * 2-D image as one plane repeats section 0 down the whole stack. Its mean and its sd are then
   * perfectly ordinary and every voxel past the first section is wrong.
   */
  report.check(
    image.sections[0] !== image.sections[1],
    'z sections 0 and 32 differ, so the tall 2-D image was unstacked',
  )
  const off = em.samples.flatMap((one, at) =>
    image.samples[at] === one.value ? [] : [{ ...one, got: image.samples[at] }],
  )
  /*
   * Exact, not approximate. `createImageBitmap` is permitted to colour-manage on the way in,
   * which is the inexactness `decodeImageChunk`'s doc admits to — `colorSpaceConversion: 'none'`
   * is meant to prevent it, and this is what says whether it does.
   */
  report.check(
    off.length === 0,
    off.length === 0
      ? `all ${em.samples.length} named voxels match Pillow's byte for byte`
      : `${off.length} of ${em.samples.length} named voxels differ, e.g. at ` +
        `${off[0].at.join(',')}: ${off[0].got} against ${off[0].value}`,
  )
  console.log(`\nOne EM chunk through the sharded jpeg path: ${image.readMs} ms.`)
} finally {
  await close()
}

report.finish()
