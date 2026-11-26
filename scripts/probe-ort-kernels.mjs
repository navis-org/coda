#!/usr/bin/env node
/**
 * Which onnxruntime-web kernel is slow, on one GPU, in isolation.
 *
 *   pnpm probe:ort-kernels
 *
 * The assessors run at 0.076 TFLOP/s in the browser while this machine's GPU does 6.47 through
 * PyTorch's Metal backend (`scripts/lib/seam_assessor.py conv`). That gap could be the device,
 * the graph, or one kernel, and a whole-model timing cannot tell them apart. So this times four
 * one-node graphs, built here rather than taken from SEAM, and the answer is not subtle.
 *
 * What it found on an M3 Max, and what each row rules out:
 *
 * | graph | TFLOP/s | |
 * |---|---|---|
 * | `MatMul` 2048³ | ~1.6 | the backend is not broadly slow |
 * | `Conv` 3×3×3, 64→64 on 65³ | ~0.08 | 20x below the same backend's MatMul |
 * | `Conv` 1×1×1, 64→64 on 65³ | ~0.06 | **arithmetically a MatMul**, and just as slow |
 *
 * The third row is the one that matters. A 1×1×1 convolution *is* a matrix multiply, so if the
 * cost were the sliding window or the third dimension it would be fast. It is not: what is slow
 * is ORT's `Conv` path over 5-D tensors, whatever the kernel. The same arithmetic written as a
 * `MatMul` node runs 27 times faster on the same device in the same session.
 *
 * Which is why `onnxsim` and `onnx-optimizer` are the wrong tool here, though they look like the
 * right one: ORT's own optimiser already folds this model from 444 nodes to 90, and a one-node
 * graph with no plumbing left to remove still shows the whole gap.
 *
 * Reads only; everything is generated locally and served to a local browser.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
/*
 * The graphs are tiny and the only Python here builds them; any env with `onnx` will do.
 *
 * `CODA_PYTHON` then `python3`, which is what every other probe in this family reads — a path
 * into one developer's home directory was baked in here, and it made the script unrunnable for
 * anyone else while looking like a considered default. `--python` overrides, for the common
 * case that `onnx` lives in a virtualenv rather than on the system interpreter.
 */
const PYTHON = args.value('--python') ?? process.env.CODA_PYTHON ?? 'python3'
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-ort-kernels')
mkdirSync(WORK, { recursive: true })

execFileSync(PYTHON, ['scripts/lib/make_kernel_graphs.py', WORK], { stdio: 'inherit' })

const CUBE = [1, 64, 65, 65, 65]
const POINT_GFLOP = (2 * 64 * 64 * 65 ** 3) / 1e9
const CASES = [
  { file: 'matmul.onnx', label: 'MatMul 2048^3', gflop: (2 * 2048 ** 3) / 1e9, feed: [2048, 2048] },
  { file: 'conv3.onnx', label: 'Conv 3x3x3 (ORT kernel)', gflop: POINT_GFLOP * 27, feed: CUBE },
  { file: 'conv3_matmul.onnx', label: 'Conv 3x3x3 as 27 MatMuls', gflop: POINT_GFLOP * 27, feed: CUBE, sameAs: 'conv3.onnx' },
  { file: 'conv3_gemm.onnx', label: 'Conv 3x3x3 as 27 Gemms', gflop: POINT_GFLOP * 27, feed: CUBE, sameAs: 'conv3.onnx' },
  { file: 'conv3_group3.onnx', label: 'Conv 3x3x3 as 9 MatMuls (K=192)', gflop: POINT_GFLOP * 27, feed: CUBE, sameAs: 'conv3.onnx' },
  { file: 'conv3_group9.onnx', label: 'Conv 3x3x3 as 3 MatMuls (K=576)', gflop: POINT_GFLOP * 27, feed: CUBE, sameAs: 'conv3.onnx' },
  { file: 'conv1.onnx', label: 'Conv 1x1x1 (ORT kernel)', gflop: POINT_GFLOP, feed: CUBE },
  { file: 'conv1_matmul.onnx', label: 'Conv 1x1x1 as one MatMul', gflop: POINT_GFLOP, feed: CUBE, sameAs: 'conv1.onnx' },
]

const report = probeReport()
const { base, stop } = await serveOrtPage({ title: 'ort kernels', dirs: { '/': WORK } })
const { evaluate, waitFor, close } = await launchChrome({
  port: 9355,
  profile: '/tmp/coda-ort-kernels-profile',
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await evaluate(`location.href = ${JSON.stringify(base)}`)
await waitFor(ORT_READY, 'onnxruntime-web', { tries: 600 })

/*
 * The same input for every graph, so the rewrites' answers can be compared with the kernels'.
 * Random rather than zeros: a convolution of zeros is zero whatever the layout, so a reshape
 * that scrambled the voxel order would agree perfectly and the speed-up would be a fiction.
 */
await evaluate(`(async () => {
  const n = ${CUBE.reduce((a, b) => a * b, 1)}
  const x = new Float32Array(n)
  let seed = 1
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    x[i] = seed / 0x3fffffff - 1
  }
  window.__cube = x
  window.__square = new Float32Array(2048 * 2048)
})()`)

const rates = {}
const answers = {}
for (const one of CASES) {
  const got = await evaluate(
    `(async () => {
      const s = await ort.InferenceSession.create('/${one.file}', { executionProviders: ['webgpu'] })
      const dims = ${JSON.stringify(one.feed)}
      const source = dims.length === 5 ? window.__cube : window.__square
      const x = new ort.Tensor('float32', source.slice(), dims)
      const first = await s.run({ x })
      const name = s.outputNames[0]
      let best = Infinity
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        await s.run({ x })
        best = Math.min(best, performance.now() - t)
      }
      await s.release?.()
      // A sample rather than the whole 17 MB output: enough to catch a scrambled layout.
      const data = first[name].data
      const take = []
      for (let i = 0; i < 64; i++) take.push(data[Math.floor((i * data.length) / 64)])
      return { ms: best, take }
    })()`,
    600_000,
  )
  rates[one.file] = one.gflop / got.ms
  answers[one.file] = got.take
  console.log(`  ${one.label.padEnd(28)} ${got.ms.toFixed(1).padStart(7)} ms = ${rates[one.file].toFixed(2)} TFLOP/s`)
}

/*
 * **The rewrites must agree with the kernels they replace**, and this is asserted before any
 * speed-up is believed. A reshape that treats the voxel axes in the wrong order produces a
 * perfectly plausible tensor at full speed, and nothing downstream of it would notice.
 */
for (const one of CASES.filter((c) => c.sameAs)) {
  const mine = answers[one.file]
  const theirs = answers[one.sameAs]
  const worst = Math.max(...mine.map((v, at) => Math.abs(v - theirs[at])))
  const scale = Math.max(...theirs.map(Math.abs))
  report.check(
    worst < scale * 1e-4,
    `${one.label} answers what ${one.sameAs} does (worst ${worst.toExponential(1)} on values of ~${scale.toExponential(1)})`,
  )
}

for (const one of CASES.filter((c) => c.sameAs)) {
  console.log(
    `  → ${one.label} is ${(rates[one.file] / rates[one.sameAs]).toFixed(1)}x the ORT kernel`,
  )
}

/*
 * The finding, asserted rather than described, so a future onnxruntime-web that fixes it says
 * so by failing this probe. That is the intended failure: the day `Conv` catches up with
 * `MatMul`, Phase 7's cost falls by an order of magnitude and somebody should be told.
 */
const ratio = rates['matmul.onnx'] / rates['conv1.onnx']
report.check(
  ratio > 5,
  ratio > 5
    ? `Conv is ${ratio.toFixed(0)}x slower than MatMul for the same arithmetic — still the known gap`
    : `Conv is now within ${ratio.toFixed(1)}x of MatMul: the kernel has been fixed, and the ` +
      'assessor cost should be re-measured',
)

stop()
await close()
report.finish()
