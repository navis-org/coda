#!/usr/bin/env node
/**
 * Can a hand-written WebGPU kernel beat our 27-MatMul rewrite of a 3x3x3 convolution?
 *
 *   CODA_PYTHON=<python with onnx> pnpm probe:conv3d-kernel
 *
 * The question behind onnxruntime issue #34087: ORT's `Conv3DNaive` runs at ~0.08 TFLOP/s, our
 * graph rewrite (docs/seam-assessor-speed.md §3) at ~0.64 on the whole model, and ORT's own
 * `MatMul` at 1.05–1.5. Whether forking ORT or writing the assessor's forward pass ourselves is
 * worth it depends on what a kernel we write can reach on this GPU — so this measures one.
 *
 * The kernel is an "implicit matrix multiply": the convolution as a (Cout × Cin·27) by
 * (Cin·27 × voxels) product, where the right-hand matrix is never built — each tile of it is read
 * straight from the input at the right offset into workgroup memory. That removes what the
 * rewrite pays for (`Slice` copying the tensor 27 times) while keeping a standard tiled multiply.
 * Several tile shapes are timed, since the best one is a property of the GPU.
 *
 * All contestants share ORT's GPU device and read the same GPU-resident input, and ORT writes its
 * output to a GPU buffer, so no timing includes the 70 MB upload or download that made earlier
 * micro-benchmarks lie (§5). Rounds are interleaved and both the best and the median are printed:
 * other work on the GPU shows up as a median well above the best, and hits every contestant alike.
 *
 * Checked before any speed is believed: the kernel's whole output against ORT's `Conv`, and 64
 * points against a JavaScript reference computed from the input directly.
 *
 * Reads only; everything is generated locally and served to a local browser.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const PYTHON = args.value('--python') ?? process.env.CODA_PYTHON ?? 'python3'
const ROUNDS = Number(args.value('--rounds') ?? 5)
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-ort-kernels')
mkdirSync(WORK, { recursive: true })
execFileSync(PYTHON, ['scripts/lib/make_kernel_graphs.py', WORK], { stdio: 'inherit' })

const C = 64
const S = 65
const GFLOP = (2 * C * C * 27 * S ** 3) / 1e9

/*
 * Tile shapes: TN voxels a workgroup, RM × RN outputs a thread, KT reduction steps a tile.
 * All 64 output channels are one workgroup's rows (TM = 64), so the input tile is read once for
 * every output channel.
 */
const CONFIGS = [
  { TN: 64, RM: 4, RN: 4, KT: 16 },
  { TN: 64, RM: 8, RN: 4, KT: 16 },
  { TN: 128, RM: 4, RN: 8, KT: 16 },
  { TN: 128, RM: 8, RN: 8, KT: 16 },
  { TN: 256, RM: 8, RN: 8, KT: 8 },
]

function shader({ TN, RM, RN, KT }) {
  const TM = C
  const V = S ** 3
  const MB = TM / RM
  const NB = TN / RN
  const THREADS = MB * NB
  const LB = (KT * TN) / THREADS
  const LA = (KT * TM) / THREADS
  if (THREADS > 256 || THREADS % TN || !Number.isInteger(LB) || !Number.isInteger(LA) || C % KT) {
    throw new Error(`tile ${JSON.stringify({ TN, RM, RN, KT })} does not divide evenly`)
  }
  const rows = (fn) => Array.from({ length: RM }, (_, r) => fn(r)).join('\n')
  const cols = (fn) => Array.from({ length: RN }, (_, s) => fn(s)).join('\n')
  const both = (fn) => rows((r) => cols((s) => fn(r, s)))
  return {
    threads: THREADS,
    code: /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read> wt: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
var<workgroup> As: array<f32, ${KT * TM}>;
var<workgroup> Bs: array<f32, ${KT * TN}>;

@compute @workgroup_size(${THREADS})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let n0 = wg.x * ${TN}u;
  let tm = li / ${NB}u;
  let tn = li % ${NB}u;
${both((r, s) => `  var acc${r}_${s} = 0.0;`)}

  // The voxel this thread gathers for the shared tile: fixed for the whole reduction.
  let nn = li % ${TN}u;
  let kb = li / ${TN}u;
  let n = n0 + nn;
  let valid = n < ${V}u;
  let x = i32(n / ${S * S}u);
  let y = i32((n / ${S}u) % ${S}u);
  let z = i32(n % ${S}u);

  for (var tap = 0u; tap < 27u; tap++) {
    let xi = x + i32(tap / 9u) - 1;
    let yi = y + i32((tap / 3u) % 3u) - 1;
    let zi = z + i32(tap % 3u) - 1;
    let inb = valid && xi >= 0 && xi < ${S} && yi >= 0 && yi < ${S} && zi >= 0 && zi < ${S};
    let base = select(0u, u32(xi) * ${S * S}u + u32(yi) * ${S}u + u32(zi), inb);
    for (var c0 = 0u; c0 < ${C}u; c0 += ${KT}u) {
      for (var i = 0u; i < ${LB}u; i++) {
        let kk = kb + i * ${THREADS / TN}u;
        Bs[kk * ${TN}u + nn] = select(0.0, inp[(c0 + kk) * ${V}u + base], inb);
      }
      let a0 = (tap * ${C}u + c0) * ${TM}u;
      for (var i = 0u; i < ${LA}u; i++) {
        let e = li + i * ${THREADS}u;
        As[e] = wt[a0 + e];
      }
      workgroupBarrier();
      for (var kk = 0u; kk < ${KT}u; kk++) {
${rows((r) => `        let a${r} = As[kk * ${TM}u + tm + ${r * MB}u];`)}
${cols((s) => `        let b${s} = Bs[kk * ${TN}u + tn + ${s * NB}u];`)}
${both((r, s) => `        acc${r}_${s} = fma(a${r}, b${s}, acc${r}_${s});`)}
      }
      workgroupBarrier();
    }
  }
${both(
  (r, s) => `  if (n0 + tn + ${s * NB}u < ${V}u) { outp[(tm + ${r * MB}u) * ${V}u + n0 + tn + ${s * NB}u] = acc${r}_${s}; }`,
)}
}`,
  }
}

const KERNELS = CONFIGS.map((config) => ({
  label: `own TN${config.TN} ${config.RM}x${config.RN} KT${config.KT}`,
  config,
  ...shader(config),
}))

const report = probeReport()
const { base, stop } = await serveOrtPage({ title: 'conv3d kernel', dirs: { '/': WORK } })
const { evaluate, waitFor, close } = await launchChrome({
  port: 9356,
  profile: '/tmp/coda-conv3d-kernel-profile',
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await evaluate(`location.href = ${JSON.stringify(base)}`)
await waitFor(ORT_READY, 'onnxruntime-web', { tries: 600 })

// ── Set up: ORT's sessions, its device, the shared input, our pipelines ─────────────────────
const setup = await evaluate(
  `(async () => {
  const C = ${C}, S = ${S}, V = S ** 3
  const options = { executionProviders: ['webgpu'], preferredOutputLocation: 'gpu-buffer' }
  const conv = await ort.InferenceSession.create('/conv3.onnx', options)
  const matmul = await ort.InferenceSession.create('/conv3_matmul.onnx', options)
  const device = await ort.env.webgpu.device
  if (!device) return { error: 'ort.env.webgpu.device is not available' }

  // The same input as probe-ort-kernels, and random for the same reason: zeros agree with anything.
  const x = new Float32Array(C * V)
  let seed = 1
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    x[i] = seed / 0x3fffffff - 1
  }
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  const input = device.createBuffer({ size: x.byteLength, usage })
  device.queue.writeBuffer(input, 0, x)

  // (Cout, Cin, 3, 3, 3) as written by make_kernel_graphs.py, to [tap][Cin][Cout] for the shader.
  const w = new Float32Array(await (await fetch('/conv3_w.bin')).arrayBuffer())
  const wt = new Float32Array(w.length)
  for (let co = 0; co < C; co++)
    for (let ci = 0; ci < C; ci++)
      for (let tap = 0; tap < 27; tap++) wt[(tap * C + ci) * C + co] = w[(co * C + ci) * 27 + tap]
  const weights = device.createBuffer({ size: wt.byteLength, usage })
  device.queue.writeBuffer(weights, 0, wt)
  const output = device.createBuffer({ size: x.byteLength, usage })

  device.pushErrorScope('validation')
  const kernels = []
  for (const k of ${JSON.stringify(KERNELS)}) {
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: k.code }), entryPoint: 'main' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [input, weights, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
    })
    kernels.push({ ...k, pipeline, group, groups: Math.ceil(V / k.config.TN) })
  }
  const invalid = await device.popErrorScope()
  if (invalid) return { error: invalid.message }

  window.__p = { C, S, V, x, w, device, input, output, conv, matmul, kernels,
    xt: ort.Tensor.fromGpuBuffer(input, { dataType: 'float32', dims: [1, C, S, S, S] }) }
  return { adapter: device.adapterInfo ? device.adapterInfo.description || device.adapterInfo.vendor : '?' }
})()`,
  600_000,
)
if (setup.error) {
  console.error(setup.error)
  process.exit(2)
}
console.log(`device: ${setup.adapter}`)

// ── Correctness, before any timing ─────────────────────────────────────────────────────────
const checks = await evaluate(
  `(async () => {
  const { C, S, V, x, w, device, output, conv, kernels, xt } = window.__p
  const run = await conv.run({ x: xt })
  const ref = await run[conv.outputNames[0]].getData(true)

  // 64 points straight from the definition, so ORT is not the only witness.
  const at = (c, i, j, k) => (i < 0 || j < 0 || k < 0 || i >= S || j >= S || k >= S) ? 0 : x[((c * S + i) * S + j) * S + k]
  const points = []
  for (let p = 0; p < 64; p++) {
    const co = (p * 37) % C
    const n = Math.floor(((p * 7919) % 64) * V / 64) + (p % 2 ? 0 : S * S - 1)
    const i = Math.floor(n / (S * S)), j = Math.floor(n / S) % S, k = n % S
    let sum = 0
    for (let ci = 0; ci < C; ci++)
      for (let tap = 0; tap < 27; tap++)
        sum += w[(co * C + ci) * 27 + tap] * at(ci, i + Math.floor(tap / 9) - 1, j + Math.floor(tap / 3) % 3 - 1, k + tap % 3 - 1)
    points.push([co * V + n, sum])
  }
  const scale = Math.max(...points.map(([, v]) => Math.abs(v)))
  const ortVsJs = Math.max(...points.map(([i, v]) => Math.abs(ref[i] - v)))

  const read = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const result = []
  for (const k of kernels) {
    device.queue.writeBuffer(output, 0, new Float32Array(C * V).fill(NaN))
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(k.pipeline)
    pass.setBindGroup(0, k.group)
    pass.dispatchWorkgroups(k.groups)
    pass.end()
    enc.copyBufferToBuffer(output, 0, read, 0, output.size)
    device.queue.submit([enc.finish()])
    await read.mapAsync(GPUMapMode.READ)
    const mine = new Float32Array(read.getMappedRange())
    let worst = 0
    for (let i = 0; i < mine.length; i++) {
      const d = Math.abs(mine[i] - ref[i])
      if (!(d <= worst)) worst = d   // NaN counts as worst: an unwritten cell must fail
    }
    const vsJs = Math.max(...points.map(([i, v]) => Math.abs(mine[i] - v)))
    read.unmap()
    result.push({ label: k.label, worst, vsJs })
  }
  read.destroy()
  return { scale, ortVsJs, result }
})()`,
  600_000,
)
report.check(
  checks.ortVsJs < checks.scale * 1e-4,
  `ORT's Conv agrees with the JavaScript reference (${checks.ortVsJs.toExponential(1)} on ~${checks.scale.toExponential(1)})`,
)
for (const one of checks.result) {
  report.check(
    one.worst < checks.scale * 1e-4 && one.vsJs < checks.scale * 1e-4,
    `${one.label}: whole output vs ORT ${one.worst.toExponential(1)}, vs JavaScript ${one.vsJs.toExponential(1)}`,
  )
}

// ── Timing, interleaved rounds ─────────────────────────────────────────────────────────────
const samples = {}
for (let round = 0; round < ROUNDS; round++) {
  const got = await evaluate(
    `(async () => {
    const { device, conv, matmul, kernels, xt } = window.__p
    const out = {}
    const ortTime = async (session, reps) => {
      const times = []
      for (let i = 0; i < reps; i++) {
        const t = performance.now()
        const r = await session.run({ x: xt })
        await device.queue.onSubmittedWorkDone()
        times.push(performance.now() - t)
        for (const v of Object.values(r)) v.dispose()
      }
      return times
    }
    out['ORT Conv (Conv3DNaive)'] = await ortTime(conv, 2)
    out['ORT 27 MatMuls (our rewrite)'] = await ortTime(matmul, 3)
    for (const k of kernels) {
      const times = []
      for (let i = 0; i < 3; i++) {
        const reps = 5
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(k.pipeline)
        pass.setBindGroup(0, k.group)
        for (let r = 0; r < reps; r++) pass.dispatchWorkgroups(k.groups)
        pass.end()
        await device.queue.onSubmittedWorkDone()
        const t = performance.now()
        device.queue.submit([enc.finish()])
        await device.queue.onSubmittedWorkDone()
        times.push((performance.now() - t) / reps)
      }
      out[k.label] = times
    }
    return out
  })()`,
    600_000,
  )
  for (const [label, times] of Object.entries(got)) (samples[label] ??= []).push(...times)
  process.stdout.write(`  round ${round + 1}/${ROUNDS}\r`)
}

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
console.log(`\n3x3x3 Conv, ${C}→${C} on ${S}³, ${GFLOP.toFixed(1)} GFLOP; best and median of ${ROUNDS} rounds\n`)
console.log(`  ${''.padEnd(32)} ${'best ms'.padStart(8)} ${'TFLOP/s'.padStart(8)} ${'median'.padStart(8)}`)
const best = {}
for (const [label, times] of Object.entries(samples)) {
  best[label] = Math.min(...times)
  console.log(
    `  ${label.padEnd(32)} ${best[label].toFixed(1).padStart(8)} ${(GFLOP / best[label]).toFixed(2).padStart(8)} ${median(times).toFixed(1).padStart(8)}`,
  )
}
const rewrite = best['ORT 27 MatMuls (our rewrite)']
const fastest = Object.entries(best)
  .filter(([label]) => label.startsWith('own'))
  .sort((a, b) => a[1] - b[1])[0]
console.log(`\n  fastest own kernel: ${fastest[0]}, ${(rewrite / fastest[1]).toFixed(1)}x our rewrite`)

/*
 * The timing is a wall clock around a submit, so it is believed only if it scales with the work:
 * 20 dispatches must take about four times as long as 5. A driver that overlapped or dropped
 * repeated dispatches would show a speed that is not there.
 */
const scaling = await evaluate(
  `(async () => {
  const { device, kernels } = window.__p
  const k = kernels.find((one) => one.label === ${JSON.stringify(fastest[0])})
  const time = async (reps) => {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(k.pipeline)
      pass.setBindGroup(0, k.group)
      for (let r = 0; r < reps; r++) pass.dispatchWorkgroups(k.groups)
      pass.end()
      await device.queue.onSubmittedWorkDone()
      const t = performance.now()
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      best = Math.min(best, performance.now() - t)
    }
    return best
  }
  return { five: await time(5), twenty: await time(20) }
})()`,
  600_000,
)
const ratio = scaling.twenty / scaling.five
report.check(
  ratio > 3.5 && ratio < 4.5,
  `20 dispatches take ${ratio.toFixed(2)}x as long as 5 (${scaling.twenty.toFixed(0)} vs ${scaling.five.toFixed(0)} ms): the clock measures the work`,
)

stop()
await close()
report.finish()
