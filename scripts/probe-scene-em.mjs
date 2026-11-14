#!/usr/bin/env node
/**
 * What one arm B scene window costs to read, in a browser, on the real Aedes volumes.
 *
 *   pnpm probe:scene-em                       # needs a dev server on 5178, or pass --url
 *   pnpm probe:scene-em -- --sizes 129,192,256
 *
 * **The one number arm B turns on, and nobody had it.** SEAM's arm B scores a tip from a single
 * 256³ window at 32 nm instead of a 129³ patch per candidate, and its whole case is cost: on a
 * laptop it takes steps 5–8 from 69 minutes to 20 (`docs/serving.md`, 2026-11-14). Those numbers
 * were taken with the EM on a local disk or a fast bucket link. A browser reads the same window
 * over `https` from a sharded, jpeg-encoded store and decodes it through `createImageBitmap`,
 * and *that* is what decides whether the window is a fraction of the pair route's cost or a
 * multiple of it.
 *
 * So this reads a real window at a real open end and times it. It asserts little: the checks are
 * the ones that would make the timings meaningless if they failed — the right scale, every chunk
 * present, a box of the extent that was asked for, real sections inside it. The output is the
 * measurement.
 *
 * ## Four things this got wrong, each kept because each produced a plausible number
 *
 * **The box is not the window.** A 256³ window is 256 planes at the *xy* spacing (32 nm),
 * resampled from 45 nm sections — so the box to read is 256 × 256 × ~183 **sections**, and a
 * check that asserted 256³ fails against a perfectly correct read. The window's z is a product
 * of the read, not the shape of it. That arithmetic is now written **once**, in the `PRELUDE`
 * every page script shares: it was written three times, and two of those had hardcoded the 183
 * that the first one derives.
 *
 * **`performance.getEntriesByType('resource')` cannot measure this.** A cross-origin response
 * reports `encodedBodySize` 0 without `Timing-Allow-Origin`, and a route rewrite moves the URL
 * out from under any prefix a probe matches on. Bytes come from CDP `Network.loadingFinished`
 * instead, which sees what the socket saw whatever the route.
 *
 * **Bytes were counted across two reads and divided by one read's time.** The cold read, the
 * second read and the segmentation read all ran inside one `evaluate`, with the CDP traffic
 * drained once afterwards — so "EM MB" was the cold *and* the second read, and MB/s was that
 * doubled numerator over the cold read's time alone. Both were about 2× overstated, in the
 * output and in everything quoted from it. Each read now gets its own `evaluate` with the
 * traffic drained between, which is why the structure below looks heavier than it needs to.
 *
 * **Which route answered is half the measurement.** The EM bucket sends no CORS headers at all,
 * so a direct read is refused and `transport.ts` falls to `gcs-api` — Google's JSON API, which
 * answers CORS for any bucket. That route works in a static deploy; the `proxy` behind it does
 * not. So the probe resets `transportModes()` and reports the route per bucket before timing
 * anything. (The route is *not* where the cost is: the same object by both endpoints reads at
 * the same speed. What costs is asking in small pieces.)
 *
 * **The second read is not "warm".** A sharded chunk is read with a Range header, and a ranged
 * response is routinely not served from the HTTP cache — measured, 0 of 19. It is kept because
 * a second read agreeing with the first is worth having.
 *
 * Reads only, and only public buckets — no credential, nothing written anywhere (SEAM invariant
 * 7; and invariant 8 is why there is no chunkedgraph call in here at all).
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
const sizes = (args.value('--sizes') ?? '129,192,256').split(',').map((one) => Number(one.trim()))

/**
 * The EM, from the datastack's own `aligned_volume.image_source`. A different bucket from the
 * segmentation, a different owner, and — unlike the segmentation — **no CORS policy at all**.
 */
const EM = 'https://storage.googleapis.com/zetta_lee_mosquito_001_alignment_central/img/v2_sharded'
const SEG = 'https://storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain'

/**
 * A real open end, not a point picked for being convenient. `searchEnd.json` is the end
 * `probe:candidate-search` ranks, so the window measured here is one that would actually be cut.
 */
const end = JSON.parse(
  readFileSync(new URL('../src/packs/seam/__fixtures__/searchEnd.json', import.meta.url)),
)

/**
 * The page-side preamble every script shares — the app's module loader, the two volumes, the end
 * being measured, and the one copy of the box arithmetic (`browserProbe.mjs`'s `RECT` is the same
 * pattern, for the same reason).
 *
 * `boxFor` is `patches.sample`'s rule, which is what the vendored file will do with these arrays
 * once they arrive: xy is a plain floor onto the grid; z is the half that is easy to get wrong,
 * because the planes sit at the *xy* spacing and are interpolated between sections, so the read
 * has to hold the section below the first plane and the one above the last.
 */
const PRELUDE = `const load = ${APP_MODULE}
  const volume = await load('/src/data/precomputed/volume.ts')
  const EM = ${JSON.stringify(EM)}
  const SEG = ${JSON.stringify(SEG)}
  const CENTRE = ${JSON.stringify(end.endNm)}
  const boxFor = (scale, size, centre) => {
    const res = scale.resolution
    const half = Math.floor(size / 2)
    const zf = (i) => (centre[2] + (i - half) * res[0]) / res[2] - 0.5
    const lo = [
      Math.floor(centre[0] / res[0]) - half,
      Math.floor(centre[1] / res[1]) - half,
      Math.floor(zf(0)),
    ]
    return { lo, hi: [lo[0] + size, lo[1] + size, Math.floor(zf(size - 1)) + 2] }
  }
  const scalesOf = async () => {
    const emInfo = await volume.openVolume(EM)
    const segInfo = await volume.openVolume(SEG)
    return {
      emInfo, segInfo,
      emScale: emInfo.scales.find((one) => one.key === '32_32_45'),
      segScale: segInfo.scales.find((one) => one.resolution[0] === 32),
    }
  }`

const report = probeReport()
const PROFILE = '/tmp/coda-scene-em-profile'
const { evaluate, waitFor, send, on, close } = await launchChrome({ port: 9374, profile: PROFILE })
// Public buckets, so no credential is handed over — but the profile is still this script's to
// clear, and `launchChrome` only clears it at the *next* launch.
deleteProfileOnExit(PROFILE, close)

/*
 * Bytes off the socket, by CDP rather than from the page. `encodedDataLength` on
 * `Network.loadingFinished` is what was actually transferred, including headers, and it is
 * reported whatever route the request took and whoever refused CORS — neither of which the
 * page's own resource timings survive.
 */
const urlOf = new Map()
let traffic = []
on('Network.requestWillBeSent', (p) => urlOf.set(p.requestId, p.request.url))
on('Network.loadingFinished', (p) => {
  const where = urlOf.get(p.requestId)
  if (where) traffic.push({ url: where, bytes: p.encodedDataLength })
})
/** Take the traffic since the last drain, and start counting again. */
const since = () => {
  const taken = traffic
  traffic = []
  return taken
}
/** Which store a URL belongs to, after every rewrite `transport.ts` may have applied. */
const storeOf = (one) =>
  one.includes('zetta_lee_mosquito') ? 'em' : one.includes('fanc-fly_segmentation') ? 'seg' : 'other'
const tally = (seen, which) => {
  const mine = seen.filter((one) => storeOf(one.url) === which)
  return { bytes: mine.reduce((total, one) => total + one.bytes, 0), requests: mine.length }
}

/** A page with nothing carried over from the last measurement, and the traffic counter zeroed. */
async function freshPage() {
  await send('Page.navigate', { url })
  await waitFor('Boolean(document.querySelector("#root"))', 'the app')
  since()
}

/** Run a page script, refusing the two ways it can come back saying nothing useful. */
async function ask(script, ms = 900_000) {
  const got = await evaluate(`(async () => {\n  ${script}\n})()`, ms)
  if (!got || got.error) throw new Error(got?.error ?? 'the page returned nothing')
  return got
}

try {
  await send('Network.enable', {})
  await freshPage()

  // ── Which route each bucket resolves to, before anything is timed ────────────────────────
  const routes = await ask(
    `${PRELUDE}
    const transport = await load('/src/data/precomputed/transport.ts')
    transport.resetTransport()
    await scalesOf()
    return transport.transportModes()`,
    120_000,
  )
  const routeOf = (part) =>
    Object.entries(routes).find(([key]) => key.includes(part))?.[1] ?? 'direct'
  const emRoute = routeOf('zetta_lee_mosquito')
  const segRoute = routeOf('fanc-fly_segmentation')
  console.log(JSON.stringify(routes, null, 2))
  report.check(
    emRoute !== 'proxy',
    `the EM reads by \`${emRoute}\`` +
      (emRoute === 'proxy' ? ' — the dev proxy, which a deployed Coda does not have' : ''),
  )
  report.check(segRoute !== 'proxy', `the segmentation reads by \`${segRoute}\``)

  const runs = []
  for (const size of sizes) {
    /*
     * A fresh page per window size. Running all three in one page made the 256³ second read come
     * out *slower* than its cold one — three boxes and their decoded bitmaps are a few hundred
     * megabytes, and the later sizes were timing the pressure left by the earlier ones.
     */
    await freshPage()
    /*
     * Open both volumes before the counter matters. `scalesOf()` fetches two `info` documents,
     * and they were landing inside the cold read's drained window — so the printed request count
     * was the read's requests *plus two*, and those counts are quoted into `MAX_COALESCE_GAP`'s
     * and `DEFAULT_CONCURRENCY`'s doc comments. The module-level `fetchInfo` cache makes every
     * later `scalesOf()` in this page free.
     */
    await ask(`${PRELUDE}\n    await scalesOf()\n    return { ok: true }`, 120_000)
    since()

    // Each read in its own `evaluate`, with the traffic drained between: that separation is the
    // whole of the byte-accounting fix in this file's header.
    const cold = await ask(`${PRELUDE}
    const { emInfo, emScale } = await scalesOf()
    if (!emScale) return { error: 'the EM has no 32_32_45 scale' }
    const box = boxFor(emScale, ${size}, CENTRE)
    const chunks = volume.chunksCovering(emScale, box).length
    let fetched = 0
    const t = performance.now()
    const read = await volume.readScalarBox(EM, emScale, box, {
      info: emInfo, onProgress: (done) => { fetched = done },
    })
    const ms = performance.now() - t
    let total = 0
    for (let i = 0; i < read.values.length; i++) total += read.values[i]
    return {
      ms: Math.round(ms), chunks, fetched, missing: read.missingChunks,
      size: [...read.size],
      mean: Math.round((total / read.values.length) * 10) / 10,
      checksum: read.values[(read.values.length / 2) | 0],
      length: read.values.length,
    }`)
    const emTraffic = tally(since(), 'em')

    const again = await ask(`${PRELUDE}
    const { emInfo, emScale } = await scalesOf()
    const box = boxFor(emScale, ${size}, CENTRE)
    const t = performance.now()
    const read = await volume.readScalarBox(EM, emScale, box, { info: emInfo })
    return {
      ms: Math.round(performance.now() - t),
      checksum: read.values[(read.values.length / 2) | 0],
      length: read.values.length,
    }`)
    since()

    const seg = await ask(`${PRELUDE}
    const { segInfo, segScale } = await scalesOf()
    if (!segScale) return { error: 'the segmentation has no 32 nm scale' }
    const box = boxFor(segScale, ${size}, CENTRE)
    const t = performance.now()
    const read = await volume.readLabelBox(SEG, segScale, box, { info: segInfo })
    return { ms: Math.round(performance.now() - t), size: [...read.size], distinct: read.labels.length }`)
    const segTraffic = tally(since(), 'seg')

    runs.push({ size, cold, again, seg, emTraffic, segTraffic })
  }

  console.log(JSON.stringify(runs, null, 2))

  for (const run of runs) {
    /*
     * The box, not the window: xy is the window's side, z is however many 45 nm sections the
     * window's 32 nm planes span. Asserting a cube here is what the first version got wrong.
     */
    report.check(
      run.cold.size[0] === run.size && run.cold.size[1] === run.size,
      `${run.size}³: the box is ${run.cold.size.join('×')} — ${run.cold.size[2]} sections under ` +
        `${run.size} planes`,
    )
    report.check(
      run.cold.size.join('×') === run.seg.size.join('×'),
      `${run.size}³: the EM and the segmentation cover the same box`,
    )
    report.check(
      run.cold.fetched === run.cold.chunks && run.cold.missing === 0,
      `${run.size}³: ${run.cold.chunks} EM chunks, all present`,
    )
    report.check(
      run.again.checksum === run.cold.checksum && run.again.length === run.cold.length,
      `${run.size}³: the second read is the first`,
    )
    /*
     * A jpeg of flat grey decodes as fast as a jpeg of membrane and is not EM. The Aedes sections
     * sit well inside the range, so a mean at either end means the box is outside the volume and
     * every timing is of nothing.
     */
    report.check(
      run.cold.mean > 20 && run.cold.mean < 235,
      `${run.size}³: mean grey ${run.cold.mean}, so the box holds real sections`,
    )
  }

  console.log(
    `\nOne window at one open end, in Chrome. EM by \`${emRoute}\`, segmentation by ` +
      `\`${segRoute}\`. Each read timed and counted on its own:\n`,
  )
  console.log('| window | box | EM chunks | requests | EM MB | EM read | again | MB/s | seg |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const run of runs) {
    const mb = run.emTraffic.bytes / 1e6
    console.log(
      `| ${run.size}³ | ${run.cold.size.join('×')} | ${run.cold.chunks} | ` +
        `${run.emTraffic.requests} | ${mb.toFixed(1)} | ${run.cold.ms} ms | ${run.again.ms} ms | ` +
        `${(mb / (run.cold.ms / 1000)).toFixed(1)} | ${run.seg.ms} ms |`,
    )
  }
  const window = runs.find((one) => one.size === 256)
  if (window) {
    const mb = window.emTraffic.bytes / 1e6
    console.log(
      `\nArm B's window is the 256³ row: ${mb.toFixed(1)} MB of EM over ` +
        `${window.emTraffic.requests} requests, in ${window.cold.ms} ms — ` +
        `${(mb / (window.cold.ms / 1000)).toFixed(1)} MB/s, against the segmentation half's ` +
        `${(window.segTraffic.bytes / 1e6 / (window.seg.ms / 1000)).toFixed(1)} MB/s on the same ` +
        'link in the same run. An earlier draft read a gap between those two as the cost of the ' +
        'gcs-api route the EM is forced onto. That was wrong: the same object by both endpoints ' +
        'is the same speed, and what the gap measured was one reader asking in small pieces and ' +
        'the other in large ones.',
    )
  }

  // ── Where inside the decode the time goes ────────────────────────────────────────────────
  /*
   * The totals above are not decode-bound, which is a far more useful thing to know than the
   * total — a decode is Coda's own code and a bucket is not. So this takes the jpeg bytes of
   * twelve real chunks and times `decodeImageChunk`'s four steps separately. A chunk here is a
   * 64³ cube stored as one tall 64 × 4096 image.
   */
  await freshPage()
  const stages = await ask(
    `${PRELUDE}
    const sharded = await load('/src/data/precomputed/sharded.ts')
    const { emScale } = await scalesOf()
    const box = boxFor(emScale, 256, CENTRE)
    const chunks = volume.chunksCovering(emScale, box)
    const shape = volume.gridShapeOf(emScale)

    const sums = { fetch: 0, bitmap: 0, draw: 0, pixels: 0, grey: 0 }
    let n = 0
    for (const chunk of chunks.slice(0, 12)) {
      const key = volume.compressedMortonCode(chunk.grid, shape)
      let t = performance.now()
      const got = await sharded.readShardedObject(EM + '/' + emScale.key, key, emScale.sharding)
      // Counted only for a chunk the divisor will also count. Adding the time before the skip
      // divides a longer total by a smaller count -- the inflated-numerator shape this file's
      // header already records getting wrong once. (No backticks in here: they end the page
      // script's template literal. That is a documented trap in this repo, and this is its
      // fourth outing.)
      if (!got) continue
      sums.fetch += performance.now() - t
      const extent = [chunk.hi[0] - chunk.lo[0], chunk.hi[1] - chunk.lo[1], chunk.hi[2] - chunk.lo[2]]

      t = performance.now()
      const bitmap = await createImageBitmap(new Blob([got.buffer], { type: 'image/jpeg' }),
        { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      sums.bitmap += performance.now() - t

      t = performance.now()
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(bitmap, 0, 0)
      sums.draw += performance.now() - t

      t = performance.now()
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      sums.pixels += performance.now() - t

      t = performance.now()
      const out = new Uint8Array(extent[0] * extent[1] * extent[2])
      for (let i = 0; i < out.length; i++) out[i] = data[i * 4]
      sums.grey += performance.now() - t

      bitmap.close()
      n += 1
    }
    const per = {}
    for (const [k, v] of Object.entries(sums)) per[k] = Math.round((v / n) * 10) / 10
    return { chunks: n, per, of: chunks.length }`,
    300_000,
  )
  report.check(stages.chunks >= 10, `${stages.chunks} chunks timed stage by stage`)
  const per = stages.per
  const decode = per.bitmap + per.draw + per.pixels + per.grey
  console.log(`\nOne 64³ EM chunk, averaged over ${stages.chunks} real ones (ms):\n`)
  console.log(
    '| one-at-a-time fetch | createImageBitmap | drawImage | getImageData | RGBA → grey | decode |',
  )
  console.log('|---|---|---|---|---|---|')
  console.log(
    `| ${per.fetch} | ${per.bitmap} | ${per.draw} | ${per.pixels} | ${per.grey} | ` +
      `**${Math.round(decode * 10) / 10}** |`,
  )
  console.log(
    `\nA 256³ window is ${stages.of} such chunks, so its decode is about ` +
      `${Math.round(decode * stages.of)} ms — which is why the read above is not decode-bound. ` +
      'The fetch column is one chunk per request, the cost coalescing exists to remove.',
  )

  // ── What the concurrency setting is still worth, now that it is runs and not chunks ──────
  /*
   * **Read the request count before the times.** Since `overChunks` coalesces, this window is a
   * handful of runs — so every setting at or above that count means "all of them at once", and
   * those rows differ only by noise. An earlier version of this sweep had no such column and its
   * flat tail read as a finding. The curve that set `DEFAULT_CONCURRENCY` was taken on a far
   * larger box, where the request count does exceed the pool.
   */
  const sweep = []
  for (const concurrency of [4, 8, 16, 32]) {
    await freshPage()
    await ask(`${PRELUDE}\n    await scalesOf()\n    return { ok: true }`, 120_000)
    since()
    const one = await ask(`${PRELUDE}
    const { emInfo, emScale } = await scalesOf()
    const box = boxFor(emScale, 256, CENTRE)
    const was = []
    let missing = 0
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      const read = await volume.readScalarBox(EM, emScale, box, { info: emInfo, concurrency: ${concurrency} })
      was.push(performance.now() - t)
      missing += read.missingChunks
    }
    was.sort((a, b) => a - b)
    return { ms: Math.round(was[1]), best: Math.round(was[0]), worst: Math.round(was[2]), missing }`)
    const seen = tally(since(), 'em')
    sweep.push({ concurrency, ...one, requests: Math.round(seen.requests / 3) })
    report.check(one.missing === 0, `at ${concurrency} in flight: every chunk present`)
  }
  console.log('\nThe same 256³ window, three reads each, by requests in flight:\n')
  console.log('| in flight | requests the read makes | median | best | worst |')
  console.log('|---|---|---|---|---|')
  for (const one of sweep) {
    console.log(
      `| ${one.concurrency} | ${one.requests} | **${one.ms} ms** | ${one.best} | ${one.worst} |`,
    )
  }
  console.log(
    `\nThe request column is the point: above about ${sweep.at(-1).requests} the setting cannot ` +
      'bind on a window this size, so those rows differ by noise alone.',
  )
} finally {
  await close()
}

report.finish()
