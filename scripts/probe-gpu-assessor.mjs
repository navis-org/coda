#!/usr/bin/env node
/**
 * The hand-written WebGPU assessor (`src/packs/seam/gpuAssessor/`) against ONNX Runtime and
 * PyTorch, on real patches.
 *
 *   pnpm dev --port 5191            (in another terminal)
 *   CODA_PYTHON=<python with pandas> pnpm probe:gpu-assessor -- --exported <SEAM data/onnx/n3_mal_mask>
 *
 * Three things, each needing a real browser and a GPU:
 *
 * 1. **Parity.** Every patch of the chosen lists through both runtimes, compared with
 *    `lists.parquet`'s `torch_s0` — the number SEAM's parity rule is written against — and with
 *    each other. Same shape of check as `probe:assessor-parity`, which this does not replace.
 * 2. **Speed, the way the app would run it.** Both through `openModel`'s session and worker, the
 *    hand-written one via `openGpuAssessor`, one patch a run as `scoreCandidates` feeds them.
 *    Warm: each list is scored twice and the second pass is the one quoted.
 * 3. **Where the time goes.** The network built on the page's own thread and each step timed on
 *    its own, so the next optimisation is aimed rather than guessed.
 *
 * The models are served from SEAM's export directory with a manifest written here: Coda's
 * fixture manifest (the `matmul` build ONNX Runtime runs), plus the plain `conv` export the
 * hand-written one reads. Both are SEAM's files, checked by sha256 as `src/ml` always does.
 *
 * Other work on the GPU shows as a median well above the best; the timing table prints both.
 * Reads only.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5191/'
const exported = args.value('--exported')
if (!exported) {
  console.error("pass --exported <SEAM's data/onnx/n3_mal_mask>")
  process.exit(2)
}
const ends = (args.value('--ends') ?? '20,1475').split(',').map((one) => one.trim())

const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-gpu-assessor')
execFileSync(
  process.env.CODA_PYTHON ?? 'python3',
  ['-I', 'scripts/lib/seam_assessor.py', 'lists', exported, WORK, ...ends],
  { stdio: 'inherit' },
)
const fixture = JSON.parse(readFileSync(join(WORK, 'lists.json'), 'utf8'))

/* SEAM's directory at `/`, the lists and the manifest at `/work/`. CORS-open, because the page
 * is the dev server's origin. The ORT page `serveOrtPage` also serves goes unused here. */
const { base: models, stop } = await serveOrtPage({
  title: 'gpu assessor',
  dirs: { '/': exported, '/work/': WORK },
})

/*
 * The manifest: Coda's own fixture, so the `matmul` entry is byte for byte what the app opens,
 * with the `conv` export added beside it. Its sha256 is computed here rather than copied from
 * SEAM's manifest, so a file that changed under the same name is caught by `src/ml`'s check.
 * Written beside the lists, so each file carries its absolute `url` (`ModelFile.url`).
 */
const manifest = JSON.parse(readFileSync('src/packs/seam/__fixtures__/assessorManifest.json', 'utf8'))
const matmul = manifest.files.find((file) => file.variant === 'matmul')
const convFile = matmul.file.replace('_mm_', '_')
const convPath = join(exported, convFile)
/* The plain export's name is the MatMul one's without `_mm_`. If SEAM ever names them otherwise,
 * this would list the MatMul file as `conv` and fail as "it may be the MatMul rewrite". */
if (convFile === matmul.file || !existsSync(convPath)) {
  console.error(`No plain Conv export beside ${matmul.file} in ${exported} (looked for ${convFile})`)
  process.exit(2)
}
const sha = createHash('sha256').update(readFileSync(convPath)).digest('hex')
manifest.files = [
  { ...matmul, url: `${models}/${matmul.file}` },
  {
    ...matmul,
    url: `${models}/${convFile}`,
    variant: 'conv',
    file: convFile,
    bytes: statSync(convPath).size,
    sha256: sha,
    quantisation: { ...matmul.quantisation, emits: ['Conv'] },
  },
]
writeFileSync(join(WORK, 'manifest.json'), JSON.stringify(manifest))
const part = manifest.parts[0]
const signature = manifest.signatures[part]
const names = { task: manifest.task, part, input: signature.inputs[0], output: signature.outputs[0] }

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9357,
  // Chrome is killed on any exit, a throw included (`launchChrome`); the server goes with the
  // process.
  profile: join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-gpu-assessor-profile'),
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

const lists = fixture.lists.map((one) => ({ end: one.end_uid, patches: one.patches, size: one.size }))

// ── 3 first: the network on the page's thread, each step timed ────────────────────────────────
const profiled = await evaluate(
  `(async () => {
  const load = ${APP_MODULE}
  const [onnx, planning, net] = await Promise.all([
    load('/src/packs/seam/gpuAssessor/onnxProto.ts'),
    load('/src/packs/seam/gpuAssessor/segclrPlan.ts'),
    load('/src/packs/seam/gpuAssessor/network.ts'),
  ])
  const bytes = new Uint8Array(await (await fetch(${JSON.stringify(`${models}/${convFile}`)})).arrayBuffer())
  const t0 = performance.now()
  const plan = planning.segclrPlan(onnx.readOnnx(bytes))
  const device = await net.assessorDevice()
  const network = await net.buildNetwork(device, plan)
  const built = performance.now() - t0
  const list = ${JSON.stringify(lists[0])}
  const labels = new Uint8Array(await (await fetch(${JSON.stringify(`${models}/work/`)} + list.end + '.u8')).arrayBuffer())
  const voxels = list.size ** 3
  const patch = Float32Array.from(labels.subarray(0, voxels))
  await network.profile(patch)
  const steps = await network.profile(patch)
  const times = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await network.score(patch)
    times.push(performance.now() - t)
  }
  network.destroy()
  device.destroy()
  return { built, steps, times, flops: network.flops, bytes: network.bytes, adapter: device.adapterInfo?.description || device.adapterInfo?.vendor }
})()`,
  900_000,
)
console.log(`device: ${profiled.adapter}; GPU memory ${(profiled.bytes / 1e6).toFixed(0)} MB; built in ${profiled.built.toFixed(0)} ms`)
console.log(`\nOne patch, each step on its own (${(profiled.flops / 1e9).toFixed(1)} GFLOP a patch):\n`)
const stepTotal = profiled.steps.reduce((ms, one) => ms + one.ms, 0)
for (const one of profiled.steps) {
  console.log(`  ${one.name.padEnd(28)} ${one.ms.toFixed(2).padStart(7)} ms ${((100 * one.ms) / stepTotal).toFixed(0).padStart(3)}%`)
}
console.log(`  ${'sum'.padEnd(28)} ${stepTotal.toFixed(1).padStart(7)} ms`)
const direct = Math.min(...profiled.times)
console.log(
  `\n  one submit, page thread: best ${direct.toFixed(1)} ms = ${(profiled.flops / 1e9 / direct).toFixed(2)} TFLOP/s`,
)

// ── 1 and 2: both runtimes through openModel's session, on every patch ────────────────────────
const scored = await evaluate(
  `(async () => {
  const load = ${APP_MODULE}
  const [gpuOpen, session] = await Promise.all([
    load('/src/packs/seam/gpuAssessor/open.ts'),
    load('/src/ml/session.ts'),
  ])
  const manifestUrl = ${JSON.stringify(`${models}/work/manifest.json`)}
  const names = ${JSON.stringify(names)}
  const task = names.task
  const opened = {}
  let t = performance.now()
  const runners = { gpu: await gpuOpen.openGpuAssessor({ manifestUrl, task }) }
  opened.gpu = performance.now() - t
  t = performance.now()
  runners.ort = await session.openModel({ manifestUrl, task, variant: 'matmul' })
  opened.ort = performance.now() - t
  const out = { opened, lists: [] }
  for (const list of ${JSON.stringify(lists)}) {
    const labels = new Uint8Array(await (await fetch(${JSON.stringify(`${models}/work/`)} + list.end + '.u8')).arrayBuffer())
    const voxels = list.size ** 3
    const row = { end: list.end }
    for (const [name, runner] of Object.entries(runners)) {
      const pass = async () => {
        const logits = []
        const ms = []
        for (let i = 0; i < list.patches; i++) {
          const patch = Float32Array.from(labels.subarray(i * voxels, (i + 1) * voxels))
          const t = performance.now()
          const answer = await runner.run({ part: names.part, feeds: [{ name: names.input, type: 'float32', dims: [1, list.size, list.size, list.size], data: patch.buffer }] })
          ms.push(performance.now() - t)
          logits.push(new Float32Array(answer.find((one) => one.name === names.output).data)[0])
        }
        return { logits, ms }
      }
      await pass()
      row[name] = await pass()
    }
    out.lists.push(row)
  }
  for (const runner of Object.values(runners)) await runner.close()
  return out
})()`,
  1_800_000,
)

/*
 * Whether `got` ranks the patches as `torch` does, wherever PyTorch's own gap is wider than twice
 * the tolerance. Two patches nearer than that may swap without either value being wrong, and an
 * exact-order check would then fail a run on noise.
 */
const TOLERANCE = 1e-3
const sameRanking = (got, torch) =>
  torch.every((a, i) =>
    torch.every((b, j) => Math.abs(a - b) <= 2 * TOLERANCE || (a > b) === (got[i] > got[j])),
  )
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
console.log(`\nopen: hand-written ${scored.opened.gpu.toFixed(0)} ms, ONNX Runtime ${scored.opened.ort.toFixed(0)} ms\n`)
for (const row of scored.lists) {
  const torch = fixture.lists.find((one) => one.end_uid === row.end).torch[0]
  for (const [name, label] of [['gpu', 'hand-written'], ['ort', 'ONNX Runtime']]) {
    const worst = Math.max(...row[name].logits.map((v, i) => Math.abs(v - torch[i])))
    const same = sameRanking(row[name].logits, torch)
    /*
     * 1e-3, not `probe:assessor-parity`'s 0.05. That one asks whether a runtime is good enough
     * for SEAM's decisions; this asks whether a new implementation of the network is the same
     * network, so it is held to what ONNX Runtime's CPU backend manages on these lists (8e-4).
     */
    report.check(
      worst < TOLERANCE && same,
      `${label.padEnd(12)} end ${row.end}: ${row[name].logits.length} patches within ${worst.toExponential(1)} of PyTorch, ranking ${same ? 'identical' : 'DIFFERENT'}`,
    )
  }
  const apart = Math.max(...row.gpu.logits.map((v, i) => Math.abs(v - row.ort.logits[i])))
  console.log(`  the two runtimes differ by at most ${apart.toExponential(1)} on end ${row.end}`)
}

const all = (name) => scored.lists.flatMap((row) => row[name].ms)
const gpuMs = all('gpu')
const ortMs = all('ort')
console.log(`\nWarm, one patch a run through openModel's worker, ${gpuMs.length} patches:\n`)
console.log(`  ${''.padEnd(14)} ${'best'.padStart(7)} ${'median'.padStart(7)}  ms a patch`)
console.log(`  ${'hand-written'.padEnd(14)} ${Math.min(...gpuMs).toFixed(1).padStart(7)} ${median(gpuMs).toFixed(1).padStart(7)}`)
console.log(`  ${'ONNX Runtime'.padEnd(14)} ${Math.min(...ortMs).toFixed(1).padStart(7)} ${median(ortMs).toFixed(1).padStart(7)}`)
console.log(`\n  hand-written is ${(median(ortMs) / median(gpuMs)).toFixed(1)}x ONNX Runtime (medians)`)
report.check(median(gpuMs) < median(ortMs), 'the hand-written assessor is the faster of the two')

stop()
await close()
report.finish()
