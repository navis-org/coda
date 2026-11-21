#!/usr/bin/env node
/**
 * The hand-written assessor in Firefox and in Chrome, run the same ways, on real patches — so a
 * difference between the browsers can be put somewhere rather than called "the browser".
 *
 *   pnpm dev --port 5191 --strictPort      (in another terminal)
 *   CODA_PYTHON=<python with pandas> pnpm probe:gpu-browsers -- --exported <SEAM data/onnx/n3_mal_mask>
 *   pnpm probe:gpu-browsers -- --exported … --browsers firefox
 *
 * ## What it found (2026-11-19, M3 Max, Firefox 160 against Chrome)
 *
 * The node measured 98 ms a patch in Firefox against 27 in Chrome, and `probe:assessor-gap` had
 * cleared everything around the network — but only in Chrome, the one browser the probes could
 * drive. Driven here, Firefox answers **every wait for the GPU in ~100 ms whatever the work**:
 * an empty submit, an upload alone, a read back after no dispatches at all. A patch waited on
 * alone pays all of it. With patches in flight it is shared — 50 ms a patch at four, 33 at
 * twelve — and what is left is Firefox computing a patch in ~30 ms against Chrome's 19-20.
 * `network.score` therefore no longer waits for one answer before submitting the next, and
 * `GPU_ASSESSOR_IN_FLIGHT` says how many to keep out (`docs/seam-assessor-speed.md` §16).
 *
 * **Since (2026-11-21, §17-18):** stage 0 computes only what an object can reach, and Firefox
 * builds forms of the kernels its shader translator is quick with — 13.5 ms a patch in Chrome and
 * 17 in Firefox on the same patches, where the paragraph above says 19-20 and ~30.
 *
 * ## The readings
 *
 * - `score()`, one at a time and with 4, 12 and 24 in flight: the method the node calls, through
 *   its own queue and read-back pool. Every answer in flight must equal the one-at-a-time answer
 *   to the bit — the GPU runs submitted work in order, which is what makes sharing the buffers
 *   safe — and that is checked.
 * - Every one-at-a-time answer against the dense reference's (`segclrPlan`'s `denseStem`, every
 *   voxel computed), to the bit, **in each browser** — the two build different forms of the same
 *   sums (`frugalShaders`, docs/seam-assessor-speed.md §18), so each is held to the plain
 *   reference.
 * - Each step alone, recorded many times in its one submit (`profile`'s `repeats`), which is
 *   the only way to time one in Firefox. `--form frugal|plain` builds that form whatever the
 *   browser, and `--no-skip` computes every voxel of stage 0: what the background skip is worth.
 * - The pieces of one patch's round trip, each waited on alone: the 8.5 MB upload; an empty
 *   submit; a read back after 0 and after 400 trivial dispatches. Equal in Firefox is the
 *   finding: the wait, not the work.
 *
 * Firefox runs with a window (`launchFirefox`'s `headful`): headless, it offers no WebGPU adapter.
 * Its `performance.now()` is coarsened to 1 ms, so its figures are whole milliseconds.
 *
 * Reads only. The model and the patches are SEAM's, served from its export directory as
 * `probe:gpu-assessor` serves them.
 */

import { join } from 'node:path'

import { ASSESSOR_WORK, assessorFixture } from './lib/assessorFixture.mjs'
import { APP_MODULE, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { launchBrowser } from './lib/firefoxProbe.mjs'
import { serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5191/'
const exported = args.value('--exported')
if (!exported) {
  console.error("pass --exported <SEAM's data/onnx/n3_mal_mask>")
  process.exit(2)
}
const browsers = (args.value('--browsers') ?? 'firefox,chrome').split(',').map((one) => one.trim())
const ends = (args.value('--ends') ?? '20,1475').split(',').map((one) => one.trim())
/** `frugal` or `plain` to build that form whatever the browser; absent, the browser's own. */
const form = args.value('--form')
if (form !== undefined && form !== 'frugal' && form !== 'plain') {
  console.error(`--form is frugal or plain, not ${form}`)
  process.exit(2)
}
const options = {
  ...(form ? { frugal: form === 'frugal' } : {}),
  ...(args.all.includes('--no-skip') ? { skipBackground: false } : {}),
}
/** Depths for `score()`. Twelve is `GPU_ASSESSOR_IN_FLIGHT`. */
const DEPTHS = [1, 4, 6, 8, 12, 24]
const IN_FLIGHT = 12
const PROBE_DIR = process.env.CODA_PROBE_DIR ?? '/tmp'

const { lists, convFile } = assessorFixture(exported, ends)
const { base, stop } = await serveOrtPage({
  title: 'gpu browsers',
  dirs: { '/': exported, '/work/': ASSESSOR_WORK },
})

/**
 * The page's script for one browser. Firefox answers a wait for the GPU in steps of ~100 ms, so
 * it gets a stream of at least 150 patches a reading and each step 300 times a submit; Chrome
 * needs neither, and takes 40 and 30.
 */
const page = (browser) => {
  const total = lists.reduce((sum, one) => sum + one.patches, 0)
  const laps = Math.max(1, Math.ceil((browser === 'firefox' ? 150 : 40) / total))
  const repeats = browser === 'firefox' ? 300 : 30
  return `(async () => {
  const load = ${APP_MODULE}
  const [onnx, planning, net] = await Promise.all([
    load('/src/packs/seam/gpuAssessor/onnxProto.ts'),
    load('/src/packs/seam/gpuAssessor/segclrPlan.ts'),
    load('/src/packs/seam/gpuAssessor/network.ts'),
  ])
  const graph = onnx.readOnnx(new Uint8Array(await (await fetch(${JSON.stringify(`${base}/${convFile}`)})).arrayBuffer()))
  const device = await net.assessorDevice()
  const network = await net.buildNetwork(device, planning.segclrPlan(graph), ${JSON.stringify(options)})
  const info = device.adapterInfo ?? (await navigator.gpu.requestAdapter())?.info ?? {}
  const voxels = network.edge ** 3
  const patches = []
  for (const one of ${JSON.stringify(lists)}) {
    const all = new Uint8Array(await (await fetch(${JSON.stringify(`${base}/work/`)} + one.end + '.u8')).arrayBuffer())
    for (let i = 0; i < one.patches; i++) patches.push(Float32Array.from(all.subarray(i * voxels, (i + 1) * voxels)))
  }
  const N = 24
  const st = (xs) => { const s = [...xs].sort((a, b) => a - b); return { best: s[0], median: s[Math.floor(s.length / 2)] } }
  const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t }
  const queue = device.queue

  // Warm, and the one-at-a-time answers every depth must equal.
  const serial = []
  for (let r = 0; r < 2; r++) for (let i = 0; i < patches.length; i++) serial[i] = await network.score(patches[i])
  // The reference: the dense stem, every voxel, the plain form — one fixed thing in both browsers.
  const reference = await net.buildNetwork(device, planning.segclrPlan(graph, { denseStem: true }), { skipBackground: false, frugal: false })
  // A dozen in flight, as the node keeps: each one out is an 8.5 MB upload waiting its turn.
  let equalReference = true
  const checking = []
  for (let i = 0; i < patches.length; i++) {
    checking.push(reference.score(patches[i]).then((v) => { equalReference &&= Object.is(v, serial[i]) }))
    if (checking.length >= 12) await checking.shift()
  }
  await Promise.all(checking)
  reference.destroy()

  /*
   * Each depth as one stream: every patch, LAPS times over, with that many kept in flight.
   * A stream and not a batch a reading, because Firefox notices finished work about every
   * 100 ms — a batch of twelve reads 200 ms or 300, never the 210 it took, while a stream of a
   * hundred and fifty patches is out by under a millisecond a patch.
   */
  const LAPS = ${laps}
  const score = {}
  let equal = true
  for (const depth of ${JSON.stringify(DEPTHS)}) {
    const each = []
    for (let r = 0; r < 3; r++) {
      const got = []
      const waiting = []
      const t = performance.now()
      for (let lap = 0; lap < (depth === 1 ? 1 : LAPS); lap++) {
        for (let i = 0; i < patches.length; i++) {
          waiting.push(network.score(patches[i]).then((v) => { got.push([i, v]) }))
          if (waiting.length >= depth) await waiting.shift()
        }
      }
      await Promise.all(waiting)
      each.push((performance.now() - t) / got.length)
      equal &&= got.every(([i, v]) => Object.is(v, serial[i]))
    }
    score[depth] = st(each)
  }

  // A buffer of the probe's own, the size of the network's patch input.
  const lab = device.createBuffer({ size: voxels * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const upload = []
  for (let i = 0; i < N; i++) upload.push(await time(async () => {
    const p = patches[i % patches.length]
    queue.writeBuffer(lab, 0, p.buffer, p.byteOffset, p.byteLength)
    await queue.onSubmittedWorkDone()
  }))
  lab.destroy()
  const empty = []
  for (let i = 0; i < N; i++) empty.push(await time(async () => { queue.submit([device.createCommandEncoder().finish()]); await queue.onSubmittedWorkDone() }))

  const module = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> o: array<f32>; @compute @workgroup_size(1) fn main() { o[0] = o[0] + 1.0; }' })
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
  const o = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const back = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: o } }] })
  const trivial = {}
  for (const k of [0, 400]) {
    const xs = []
    for (let i = 0; i < N; i++) xs.push(await time(async () => {
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      for (let j = 0; j < k; j++) { pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1) }
      pass.end()
      encoder.copyBufferToBuffer(o, 0, back, 0, 4)
      queue.submit([encoder.finish()])
      await back.mapAsync(GPUMapMode.READ)
      back.unmap()
    }))
    trivial[k] = st(xs)
  }
  // Each step alone, many times a submit: Firefox answers a wait in ~100 ms whatever the work.
  const steps = await network.profile(patches[0], ${repeats})
  o.destroy(); back.destroy(); network.destroy()
  return JSON.stringify({
    adapter: [info.vendor, info.architecture].filter(Boolean).join(' '),
    patches: patches.length,
    score, equal, equalReference, steps, upload: st(upload), empty: st(empty), trivial,
  })
})()`
}

const results = {}
const ports = { firefox: 9339, chrome: 9358 }
for (const browser of browsers) {
  console.error(`running ${browser}…`)
  const { evaluate, waitFor, navigate, close } = await launchBrowser(browser, {
    port: ports[browser],
    profile: join(PROBE_DIR, `coda-gpu-browsers-${browser}`),
  })
  await navigate(url)
  await waitFor('Boolean(document.querySelector("#root"))', 'the app')
  results[browser] = JSON.parse(await evaluate(page(browser), 1_800_000))
  close()
}
stop()

const names = Object.keys(results)
const cell = (x) => `${x.best.toFixed(1)} / ${x.median.toFixed(1)}`.padStart(18)
const row = (label, pick) => console.log(`  ${label.padEnd(40)}${names.map((n) => cell(pick(results[n]))).join('')}`)
console.log(`\n  ${'ms, best / median'.padEnd(40)}${names.map((n) => n.padStart(18)).join('')}`)
console.log(`  ${'adapter'.padEnd(40)}${names.map((n) => results[n].adapter.slice(0, 16).padStart(18)).join('')}`)
for (const depth of DEPTHS) {
  row(depth === 1 ? 'score(), one at a time' : `score(), ${depth} in flight, a patch`, (r) => r.score[depth])
}
row('the 8.5 MB upload alone, waited on', (r) => r.upload)
row('an empty submit, waited on', (r) => r.empty)
row('a read back after 0 dispatches', (r) => r.trivial[0])
row('a read back after 400 trivial dispatches', (r) => r.trivial[400])
console.log('')

// Firefox's are whole multiples of 100 ms over its 300 repeats: a step under 0.33 reads as it.
console.log(`  ${'each step alone, ms'.padEnd(40)}${names.map((n) => n.padStart(18)).join('')}`)
for (const step of results[names[0]].steps) {
  const cells = names.map((n) => {
    const found = results[n].steps.find((one) => one.name === step.name)
    return (found ? found.ms.toFixed(2) : '').padStart(18)
  })
  console.log(`  ${step.name.padEnd(40)}${cells.join('')}`)
}
console.log('')

const report = probeReport()
for (const name of names) {
  const r = results[name]
  report.check(
    r.equalReference,
    `${name}: every answer equals the dense reference's to the bit (${r.patches} patches)`,
  )
  report.check(
    r.equal,
    `${name}: every answer in flight equals the one-at-a-time answer to the bit (${r.patches} patches)`,
  )
  report.check(
    r.score[IN_FLIGHT].median <= r.score[1].median * 1.05,
    `${name}: ${IN_FLIGHT} in flight cost no more a patch than one at a time ` +
      `(${r.score[IN_FLIGHT].median.toFixed(1)} against ${r.score[1].median.toFixed(1)} ms)`,
  )
}
report.finish()
process.exit(0)
