#!/usr/bin/env node
/**
 * Does onnxruntime-web's WebGPU backend run the assessor's graph — and run it *on the GPU*?
 *
 *   pnpm probe:assessor-ops -- --exported ~/Github/SEAM/data/onnx/sa2_mask
 *
 * **The question Phase 7 rests on.** The assessors are 3D ResNets: 3D convolutions, 3D max
 * pooling and a `Pad`, on a 129³ input. Nothing in this repository has run a 3D convolution in a
 * browser, and SEAM named it as the unknown that could make the whole phase impossible. One
 * patch is 86.8 GFLOP and an average tip is ~114 of them, so the difference between the GPU and
 * a CPU fallback is the difference between a wait and a non-starter.
 *
 * SEAM's `probe.onnx` is what this runs: the same network narrowed to widths 8-64 with random
 * weights — every op, kernel, stride and 'SAME' pad of the real graph on the same 129³ input, at
 * 4 GFLOP instead of 86.8, in a 2.2 MB file instead of 133 MB. So the answer arrives in minutes
 * and a 400 MB download is not spent on a question a 2 MB one settles.
 *
 * ## The trap this is built around
 *
 * **A node the WebGPU backend cannot run falls back to the CPU, answers correctly, and says
 * nothing.** A probe that checked only the logits would pass on a graph running entirely on
 * WASM and report a WebGPU timing that is really a CPU one — and the conclusion drawn from it
 * ("WebGPU runs this") would be exactly wrong. So this asks *where each node ran*, two ways that
 * fail differently:
 *
 * - **ORT's verbose log** prints its node placements at session creation. Captured off the
 *   console, because that is where onnxruntime-web puts it.
 * - **WebGPU kernel profiling** emits one record per kernel that really ran on the GPU. A node
 *   missing from it did not run there, whatever the placement log said it intended.
 *
 * The two together are what makes "it runs on the GPU" a measurement rather than a hope. The
 * logits are still compared — against **PyTorch's**, carried in the fixture, not against WASM's,
 * since an export that is wrong in both backends would agree with itself.
 *
 * Reads only, and nothing leaves the machine: the model and the fixture are served from a local
 * directory to a local browser.
 *
 * **`report.check` here is `(ok, line)`** — `browserProbe.mjs`' order, the opposite of
 * `pyodideProbe.mjs`'. Written down because the first run of this probe had them the wrong way
 * round and every one of its seven checks passed on the truthiness of its own message, printing
 * `✓ true` and `✓ false`; it is the second time that has happened in this pack.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const exported = args.value('--exported')
if (!exported) {
  console.error("pass --exported <SEAM's data/onnx/sa2_mask>")
  process.exit(2)
}

/*
 * The numpy half unpacks the npz and checks both files against `manifest.json`'s sha256 — a
 * model served from a stale export answers plausibly, which is the one failure no comparison
 * below could see.
 */
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-assessor-probe')
execFileSync(process.env.CODA_PYTHON ?? 'python3', ['-I', 'scripts/lib/seam_assessor.py', 'probe', exported, WORK], {
  stdio: 'inherit',
})
const fixture = JSON.parse(readFileSync(join(WORK, 'probe-fixture.json'), 'utf8'))

const report = probeReport()
const { base, stop } = await serveOrtPage({
  title: 'assessor ops',
  dirs: { '/': exported, '/work/': WORK },
})
const { evaluate, waitFor, on, close } = await launchChrome({
  port: 9347,
  profile: '/tmp/coda-assessor-ops-profile',
  args: [
    // Without these the adapter is software; without an http origin there is no adapter at all.
    '--use-angle=metal',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    /*
     * `timestamp-query` is the device feature ORT's per-kernel profiling needs, and Chrome keeps
     * it behind this flag. Without it `ort.env.webgpu.profiling` silently produces nothing — the
     * first run of this probe reported "nothing ran on the GPU" for that reason alone, while the
     * graph was in fact running there entirely.
     */
    '--enable-dawn-features=allow_unsafe_apis',
  ],
})

/*
 * ORT's placement log goes to the console, so it is read off the console. Collected from before
 * the first session is created: the placements are printed during `createSession`, and a
 * listener attached after it would see an empty log and report "nothing fell back".
 */
const lines = []
on('Runtime.consoleAPICalled', ({ args: parts }) => {
  for (const part of parts ?? []) {
    if (typeof part.value === 'string') lines.push(part.value)
  }
})

await evaluate(`location.href = ${JSON.stringify(base)}`)
await waitFor(ORT_READY, 'onnxruntime-web', { tries: 600 })

const adapter = await evaluate(`(async () => {
  if (!navigator.gpu) return null
  const got = await navigator.gpu.requestAdapter()
  if (!got) return null
  const info = got.info ?? (await got.requestAdapterInfo?.()) ?? {}
  return { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' }
})()`)
report.check(
  Boolean(adapter),
  adapter
    ? `WebGPU adapter: ${[adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(' ') || 'unnamed'}`
    : 'no WebGPU adapter — every number below would be the CPU’s',
)

/** Load the patches once; both backends are measured on the same bytes. */
await evaluate(`(async () => {
  const bytes = new Uint8Array(await (await fetch('/work/lab.u8')).arrayBuffer())
  window.__patches = Float32Array.from(bytes)
  window.__n = ${fixture.patches}
  window.__size = ${fixture.size}
  window.__model = ${JSON.stringify(args.value('--model') ?? null)}
})()`)

/**
 * One backend, run twice: cold for correctness, then warm for the timing.
 *
 * The warm run is the one worth quoting. The first carries shader compilation and buffer
 * allocation, which on WebGPU is most of a small graph's wall clock and none of a real one's.
 */
async function runOn(ep) {
  return evaluate(
    `(async () => {
      const t0 = performance.now()
      if (${ep === 'webgpu'}) ort.env.webgpu.profiling = { mode: 'default' }
      ort.env.logLevel = 'verbose'
      const session = await ort.InferenceSession.create(window.__model ?? '/probe.onnx', {
        executionProviders: ['${ep}'],
        logSeverityLevel: 0,
        logVerbosityLevel: 0,
      })
      const made = performance.now() - t0
      const dims = [window.__n, window.__size, window.__size, window.__size]
      const feed = { lab: new ort.Tensor('float32', window.__patches, dims) }
      const cold0 = performance.now()
      const first = await session.run(feed)
      const cold = performance.now() - cold0
      const warm0 = performance.now()
      const again = await session.run(feed)
      const warm = performance.now() - warm0
      const name = session.outputNames[0]
      await session.release?.()
      return {
        made,
        cold,
        warm,
        logit: Array.from(again[name].data),
        agrees: Array.from(first[name].data),
      }
    })()`,
    240_000,
  )
}

const measured = {}
for (const ep of ['wasm', 'webgpu']) {
  const mark = lines.length
  let got
  try {
    got = await runOn(ep)
  } catch (error) {
    report.check(false, `${ep}: the graph did not run — ${String(error).slice(0, 200)}`)
    continue
  }
  measured[ep] = { ...got, log: lines.slice(mark) }

  const off = got.logit.map((v, at) => Math.abs(v - fixture.logit[at]))
  const worst = Math.max(...off)
  report.check(
    worst < 1e-3,
    `${ep}: both logits match PyTorch to ${worst.toExponential(1)} ` +
      `(${got.logit.map((v) => v.toFixed(6)).join(', ')})`,
  )
  /*
   * Two runs of one session, compared. A WebGPU backend that leaves a buffer dirty between runs
   * answers correctly once and drifts after — invisible to a probe that runs the graph a single
   * time, and fatal to a caller that scores a hundred patches in a loop.
   */
  report.check(
    got.agrees.every((v, at) => v === got.logit[at]),
    `${ep}: the second run of the same session answers the same`,
  )
}

/*
 * **Where the nodes ran**, asked three ways that fail differently. The first run of this probe
 * got all three wrong and is the reason they are spelled out:
 *
 * 1. **ORT's own verdict.** `VerifyEachNodeIsAssignedToAnEp` prints the providers the graph was
 *    placed on and how many nodes went to each. Matched on that line alone — a loose search for
 *    `CPUExecutionProvider` hits `TransposeOptimizer_CPUExecutionProvider`, which is the name of
 *    a *graph transformer* that runs on every session whatever the backend, and reports a
 *    fallback that did not happen.
 * 2. **The shaders.** Only the WebGPU backend compiles WGSL, and it logs each program's source.
 *    A `Conv3D` program in that log is a 3D convolution that really became a GPU kernel — the
 *    fact Phase 7 was waiting on, and one that survives profiling being unavailable.
 * 3. **Per-kernel timings**, when `timestamp-query` is there. Independent of both, and the only
 *    one of the three that measures rather than reports.
 */
const gpuLog = measured.webgpu?.log ?? []
/*
 * Every placement line, not the first: `Node placements` is a bare **header** ORT always prints,
 * and the verdict is on the line after it. Reading only the first match reported a split graph
 * on a run where all 90 nodes had gone to the GPU.
 */
const verdict = gpuLog
  .filter((line) => /VerifyEachNodeIsAssignedToAnEp/.test(line))
  .map((line) => line.slice(line.indexOf('VerifyEachNodeIsAssignedToAnEp]') + 31).trim())
  .filter((line) => line && line !== 'Node placements')
  .join('; ')
// `\w+_CPUExecutionProvider` is a graph transformer's name, not a placement. Dropped first,
// because a loose search for the provider matches it on every session whatever the backend.
const named = verdict.replace(/\w+_CPUExecutionProvider/g, '')
const onGpu = /placed on \[WebGpuExecutionProvider\]/.test(named)
report.check(
  onGpu && !/\bCPUExecutionProvider\b/.test(named),
  verdict ? `ORT’s own placement: ${verdict.slice(0, 160)}` : 'ORT printed no placement verdict',
)

/*
 * **The negative control, run rather than described.** The same two detectors, pointed at the
 * WASM session's log, must come back negative — otherwise they are matching something every
 * session prints and the checks above pass on any backend at all. Both of them did exactly that
 * on this probe's first run.
 */
const wasmLog = measured.wasm?.log ?? []
const wasmPlacement = wasmLog
  .filter((line) => /VerifyEachNodeIsAssignedToAnEp/.test(line))
  .join('; ')
report.check(
  wasmPlacement.includes('CPUExecutionProvider') &&
    !/placed on \[WebGpuExecutionProvider\]/.test(wasmPlacement),
  'the same detector reports the CPU provider for the WASM session — it tells the two apart',
)
report.check(
  wasmLog.filter((line) => /Conv3D/.test(line)).length === 0,
  'the WASM session compiled no Conv3D shader — a WGSL program really is a GPU kernel',
)

const shaders = gpuLog.filter((line) => /Conv3D/.test(line)).length
report.check(
  shaders > 0,
  shaders > 0
    ? `${shaders} Conv3D WGSL programs compiled — the 3D convolutions really are GPU kernels`
    : 'no Conv3D shader was compiled: the convolutions did not run on the GPU',
)

/*
 * Reported, not judged. Chrome serves `timestamp-query` only behind a flag, and a build without
 * it would otherwise fail a probe whose question it has already answered twice over.
 */
const kernels = gpuLog.filter((line) => /\[profiling\]/i.test(line))
console.log(
  kernels.length > 0
    ? `\n${kernels.length} per-kernel GPU timings from WebGPU’s own profiler.`
    : '\nNo per-kernel GPU timings — this Chrome has no timestamp-query. Placement and the ' +
      'compiled shaders are what answer the question here.',
)

const perPatch = (ms) => ms / fixture.patches
if (measured.wasm && measured.webgpu) {
  const w = perPatch(measured.wasm.warm)
  const g = perPatch(measured.webgpu.warm)
  console.log(
    `\nop probe, ${fixture.gflop_per_patch} GFLOP a patch (the real graph is 86.8):\n` +
      `  wasm    ${w.toFixed(0)} ms a patch   (session ${measured.wasm.made.toFixed(0)} ms, cold run ${measured.wasm.cold.toFixed(0)} ms)\n` +
      `  webgpu  ${g.toFixed(0)} ms a patch   (session ${measured.webgpu.made.toFixed(0)} ms, cold run ${measured.webgpu.cold.toFixed(0)} ms)\n` +
      `  onnxruntime native CPU, for scale: ${(fixture.cpu_s_per_patch * 1000).toFixed(0)} ms a patch\n` +
      `\n  At ${(86.8 / fixture.gflop_per_patch).toFixed(1)}x the arithmetic, a 114-patch tip scales to ` +
      `~${((Math.min(w, g) * (86.8 / fixture.gflop_per_patch) * 114) / 1000).toFixed(0)} s — an estimate, and a ` +
      `pessimistic one:\n  the probe is the same graph at widths 8-64, so it moves nearly as much memory per ` +
      `FLOP as the real one\n  and keeps the GPU less busy. Only the real model says.`,
  )
}

for (const line of kernels.slice(0, 8)) console.log(`  ${line.slice(0, 160)}`)
if (process.env.CODA_DUMP_LOG) {
  writeFileSync(process.env.CODA_DUMP_LOG, gpuLog.join('\n'))
}

stop()
await close()
report.finish()
