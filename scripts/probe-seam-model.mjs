/**
 * Does a SEAM model answer the same thing in a browser as it did in PyTorch?
 *
 * SEAM's invariant 12 is that a released checkpoint exports to ONNX/WebGPU and matches PyTorch
 * within tolerance. Its own `scripts/export_onnx.py` settles the first half on the CPU — 7.6e-6 on
 * the point logits for `A_d256_e80`. **The half that needs a browser is the backend a reader will
 * actually run on**, and that is this side of the seam: the runtime Coda ships, on a real GPU.
 *
 * The comparison is against **PyTorch's own answer**, carried in `fixture.json` beside the model,
 * not against one ONNX Runtime build's. Comparing two ORT builds would miss an export that is
 * wrong in both, which is the failure the fixture exists to catch.
 *
 * ## Why this model gets a check the affinity one did not need
 *
SEAM found **two** fp16 failures, and they are not the same one. A naive conversion flipped 13%
 * of points on the CPU, traced to the Fourier projection in the point embedding, where the
 * coordinate × frequency `Einsum` loses phase before `sin`/`cos`. The file with that fixed is
 * *still* 34% wrong on WebGPU while being fine on WASM — a second, undiagnosed fault in the
 * WebGPU fp16 kernels. So a SEAM model is exported fp32, and this probe is what holds that
 * decision honest: the phase-sensitive `Einsum` is still in the graph, in fp32, and nothing but
 * a run on a real GPU says it behaves there.
 *
 * Two execution providers, so a disagreement can be placed: WASM is the control SEAM found sound,
 * WebGPU is the one that will serve readers.
 *
 * Usage: `pnpm probe:seam-model -- --exported ~/Github/SEAM/data/onnx/A_d256_e80`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, readModelManifest, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const exported = args.value('--exported')
const reportTo = args.value('--out')
if (!exported) {
  console.error("pass --exported <SEAM's export directory, holding manifest.json and fixture.json>")
  process.exit(2)
}

const manifest = readModelManifest(exported)
if (manifest.parts.length !== 1) {
  console.error(`${manifest.id} is cut into ${manifest.parts.join(', ')}; this probe runs one graph`)
  process.exit(2)
}
const fixture = JSON.parse(readFileSync(join(exported, 'fixture.json'), 'utf8'))
if (fixture.model !== manifest.id) {
  // A fixture from another checkpoint would be compared against happily and report nonsense.
  console.error(`fixture.json holds ${fixture.model}, the manifest holds ${manifest.id}`)
  process.exit(2)
}

const { base, stop } = await serveOrtPage({ title: 'seam model', dirs: { '/': exported } })
const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9342,
  profile: '/tmp/coda-seam-model-profile',
  // Without these the adapter is software; without an http origin there is no adapter at all.
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url: base })
await waitFor(ORT_READY, 'onnxruntime-web')

const part = manifest.parts[0]
/*
 * By variant *and* part, which is what identifies a file (`modelFile` in `src/ml/manifest.ts`).
 * One entry today — but this probe's whole subject is that fp32 is what ships, so the day an
 * fp16 variant is exported beside it, taking `files[0]` would certify the wrong one.
 */
const variant = args.value('--variant') ?? 'fp32'
const file = manifest.files.find((f) => f.part === part && f.variant === variant)
if (!file) {
  const had = manifest.files.map((f) => `${f.variant}/${f.part}`).join(', ')
  console.error(`${manifest.id} has no ${variant}/${part}; it has ${had}`)
  process.exit(2)
}

const script = `(async () => {
  const CONFIG = ${JSON.stringify({ file: file.file, sha256: file.sha256, bytes: file.bytes, variant, signature: manifest.signatures[part], fixture })}
  const { file: path, signature: sig, fixture: fx } = CONFIG
  const ort = window.ort
  ort.env.wasm.numThreads = 1
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter: this probe would be comparing WASM with WASM')

  const body = new Uint8Array(await (await fetch('/' + path)).arrayBuffer())
  // The manifest's own hash, checked before anything is run. A verification-rejected export can be
  // left on disk beside the previous run's manifest and fixture, and without this the probe would
  // green-light a graph the exporter threw out -- and be weaker than the app, since weights.ts
  // checks the sha before it caches.
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  if (digest !== CONFIG.sha256) {
    throw new Error('the file on disk is not the one the manifest describes: sha256 ' +
      digest.slice(0, 12) + ' against ' + CONFIG.sha256.slice(0, 12))
  }
  if (body.length !== CONFIG.bytes) {
    throw new Error('the file is ' + body.length + ' bytes, the manifest says ' + CONFIG.bytes)
  }
  const n = fx.nPoints
  const feeds = () => {
    const f = {}
    f[sig.inputs[0]] = new ort.Tensor('float32', Float32Array.from(fx.points), [1, n, 3])
    f[sig.inputs[1]] = new ort.Tensor('float32', Float32Array.from(fx.feats), [1, n, 3])
    return f
  }
  const want = { point: Float32Array.from(fx.pointLogits), window: fx.windowLogit }

  /**
   * How far a run is from PyTorch, in the terms the two heads are read in. A logit's sign is the
   * decision — which piece a point was put in, and whether the window is called a merge — so the
   * share of points whose sign differs is what a wrong kernel costs, and the mean error is what
   * says whether it was close.
   */
  const against = (point, windowLogit) => {
    // Length first. The loop below walks the fixture, so a short output would read 'undefined'
    // past its end -- NaN, and invisible to every comparison in it.
    if (point.length !== want.point.length) {
      return { lengthMismatch: point.length + ' against ' + want.point.length }
    }
    let max = 0, total = 0, flipped = 0, nearZero = 0, flippedNearZero = 0, finite = 0
    for (let i = 0; i < want.point.length; i++) {
      const d = Math.abs(point[i] - want.point[i])
      // Counted rather than assumed: 'NaN > max' is false, so a NaN output would leave max at 0
      // and report a perfect match. Same hole the exporter's verify() had.
      if (Number.isFinite(d)) finite++
      if (d > max) max = d
      total += d
      const moved = (point[i] > 0) !== (want.point[i] > 0)
      if (moved) flipped++
      // Near the decision boundary on PyTorch's side, with the share of *those* that moved --
      // the denominator is what makes a flip count readable, and a bare count says nothing.
      if (Math.abs(want.point[i]) < 0.1) {
        nearZero++
        if (moved) flippedNearZero++
      }
    }
    return {
      pointMax: +max.toFixed(6),
      pointMean: +(total / want.point.length).toFixed(7),
      pointsFlipped: flipped,
      pointsNearZero: nearZero,
      flippedNearZero,
      nonFinite: want.point.length - finite,
      windowAbs: +Math.abs(windowLogit - want.window).toFixed(6),
      windowAgrees: (windowLogit > 0) === (want.window > 0),
    }
  }

  const out = {}
  for (const ep of ['wasm', 'webgpu']) {
    const session = await ort.InferenceSession.create(body, { executionProviders: [ep] })
    // Twice: the first run compiles every WebGPU pipeline, so only the second is a latency.
    // That matters beyond tidiness -- onnxruntime-web's WebGPU backend falls back to the CPU
    // kernel **per node, silently**, for any op it has no GPU implementation of, and session
    // creation succeeds either way. A warm time no better than WASM's is the only signal
    // available here that the graph did not really run on the GPU. It catches a wholesale
    // fallback, not a single node's, which is the honest limit of it.
    const answer = await session.run(feeds())
    const t0 = performance.now()
    await session.run(feeds())
    const warmMs = Math.round(performance.now() - t0)
    const point = new Float32Array(answer[sig.outputs[0]].data)
    const windowLogit = new Float32Array(answer[sig.outputs[1]].data)[0]
    out[ep] = { ...against(point, windowLogit), warmMs }
    await session.release()
  }
  return {
    adapter: (adapter.info?.vendor ?? '?') + '/' + (adapter.info?.architecture ?? '?'),
    model: fx.model, variant: CONFIG.variant, points: n, torch: fx.torch,
    megabytes: +(body.length / 1e6).toFixed(1),
    cpu: fx.cpuAgreement ?? null,
    ...out,
  }
})()`

const got = await evaluate(script, 900_000)
console.log(JSON.stringify(got, null, 2))
if (reportTo) {
  writeFileSync(reportTo, JSON.stringify(got, null, 2) + '\n')
  console.log(`wrote ${reportTo}`)
}

/*
 * The bar comes from the export, not from a constant here: `fixture.json` carries the tolerance
 * the exporter verified at, so a run at a different `--tolerance` cannot leave this probe
 * checking against a number nobody chose. SEAM's spike reported fp32 matching PyTorch to 6.7e-6
 * on WebGPU and 1.6e-5 on WASM with every point keeping its class, so the real statement is the
 * second one: **no point may change the side PyTorch put it on**. That is what fp16 broke there
 * (66% of points), and what a logit tolerance alone would not catch.
 */
const TOLERANCE = fixture.tolerance ?? 1e-4
for (const ep of ['wasm', 'webgpu']) {
  const d = got[ep]
  report.check(!d.lengthMismatch, `${ep}: the graph answered as many points as PyTorch did${d.lengthMismatch ? ` (${d.lengthMismatch})` : ''}`)
  if (d.lengthMismatch) continue
  report.check(d.nonFinite === 0, `${ep}: every logit is a finite number (${d.nonFinite} were not)`)
  report.check(
    d.pointMax < TOLERANCE,
    `${ep}: point logits within ${TOLERANCE} of PyTorch (max ${d.pointMax}, mean ${d.pointMean})`,
  )
  // The raw count, never a rounded share: at 4,096 points one flip is 0.024%, but past ~200,000
  // a single flip rounds to 0.000 and a `=== 0` on the percentage would pass.
  report.check(
    d.pointsFlipped === 0,
    `${ep}: every point keeps the side PyTorch put it on (${d.pointsNearZero} sit within 0.1 of the boundary)`,
  )
  report.check(d.windowAgrees && d.windowAbs < TOLERANCE, `${ep}: the window logit agrees (${d.windowAbs})`)
}
/*
 * Not parity, but the one check that says the GPU was used at all. See the note beside the warm
 * run: a per-node fallback is invisible here, a wholesale one is not.
 */
report.check(
  got.webgpu.warmMs <= got.wasm.warmMs,
  `webgpu (${got.webgpu.warmMs} ms warm) is not slower than wasm (${got.wasm.warmMs} ms): the graph ran on the GPU`,
)
await close()
stop()
report.finish()
