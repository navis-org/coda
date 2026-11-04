/**
 * Does the shipped model give the same answer on WebGPU as on the CPU?
 *
 * Every fidelity number in `docs/ml.md` was taken through ONNX Runtime in **Python, on the CPU**
 * (`probe:affinity-export`). The only check that has ever run on WebGPU — `probe:affinity-runtime`
 * — asserts that affinities land in [0, 1], which a badly wrong kernel satisfies just as well as a
 * right one. So the accuracy of the build we ship, on the backend it actually runs on, had never
 * been measured.
 *
 * The reason to measure it is that a sibling project measured the same arithmetic going wrong
 * there. SEAM (`~/Github/SEAM`, docs/serving.md) exported the same backbone family and found
 * **fp16 correct on WASM and wrong on WebGPU** — 34% agreement, mean logit error 0.32, from one
 * file — and concluded "use fp32 for now". Our `mixed` variant is an nbits8 encoder and an
 * **fp16 decoder**, and the decoder is ~95% of the runtime.
 *
 * ## What it compares
 *
 * One set of files, two execution providers, identical inputs:
 *
 *  1. **encoder**, WASM against WebGPU. Weight-only nbits8 keeps activations in fp32, so this
 *     should agree; if it does not, the problem is not fp16 and the decoder result below is
 *     reading a difference it did not cause.
 *  2. **decoder**, WASM against WebGPU, both fed the *same* latents (WASM's). This is the
 *     measurement: it changes nothing but the backend.
 *  3. **the whole chain** as the app runs it — WebGPU encoder into WebGPU decoder — against the
 *     all-WASM reference, which is what a reader's answer is actually subject to.
 *
 * WASM is the reference rather than the truth: it is the backend SEAM found sound, and so the
 * right control for SEAM's hypothesis. **Nothing here is a distance from fp32**, and a number
 * from this probe may not be added to one that is.
 *
 * The headline is the share of pair decisions that move across the clustering cut, because that
 * is what changes an answer. The bar, and why it is that number, is at the foot of this file.
 *
 * ## The input is the pack's, not the probe's
 *
 * `scripts/probe-affinity-cloud.ts` builds it with `pointCloud()` over a branching arbour and
 * writes it beside this probe. That half exists because the first version of this one minted
 * uniform noise in a ±1 box, which is ten times the real coordinate magnitude and has no
 * structure — and the crossing rate is decided by where the affinity mass sits relative to the
 * cut, which is a property of the input.
 *
 * Usage: `pnpm probe:affinity-backend -- --exported ~/coda-models/affinity-flywire-mixed`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, readModelManifest, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const exported = args.value('--exported')
const reportTo = args.value('--out')
const cloudFile = args.value('--cloud') ?? '/tmp/coda-affinity-cloud.json'
if (!exported) {
  console.error('pass --exported <a converted model directory holding manifest.json>')
  process.exit(2)
}

const manifest = readModelManifest(exported)
/** Variants carrying every declared part, which is what `completeVariants` means in src/ml. */
const complete = [...new Set(manifest.files.map((f) => f.variant))].filter((v) =>
  manifest.parts.every((p) => manifest.files.some((f) => f.variant === v && f.part === p)),
)
/*
 * Named, never guessed, when the export carries more than one. `preferredVariant` is what decides
 * which build a reader actually gets, and it sorts by bytes among the ones WebGPU can run — a rule
 * this `.mjs` cannot import and should not half-copy. Taking `files[0]` instead would silently
 * measure whichever variant the converter happened to write first while the report says it
 * measured the shipped one.
 */
const asked = args.value('--variant')
if (!asked && complete.length > 1) {
  console.error(
    `this export carries ${complete.join(', ')} — name one with --variant. The shipped build is ` +
      `whichever preferredVariant picks, which this probe deliberately does not reimplement.`,
  )
  process.exit(2)
}
const variant = asked ?? complete[0]
if (!complete.includes(variant)) {
  console.error(`${variant} does not carry every part; this manifest has ${complete.join(', ')}`)
  process.exit(2)
}

const cloud = JSON.parse(readFileSync(cloudFile, 'utf8'))
/*
 * The cloud is built for one checkpoint's `globalScale`. Feeding one built for another is exactly
 * the off-scale input this probe was corrected for, and it would look like a result rather than a
 * mistake, so it is refused rather than warned about.
 */
const scale = manifest.config?.preprocessing?.globalScale
if (scale && cloud.globalScale !== scale) {
  console.error(
    `${cloudFile} was built at globalScale ${cloud.globalScale}, this model wants ${scale}. ` +
      `Rebuild it: pnpm vite-node scripts/probe-affinity-cloud.ts ${cloudFile} ${cloud.points} ${manifest.id}`,
  )
  process.exit(2)
}
/** The manifest's own cut, never a literal — a retuned threshold must move this probe with it. */
const threshold = Number(
  args.value('--threshold') ?? manifest.config?.clustering?.threshold ?? cloud.threshold,
)
/*
 * Checked, because a NaN here passes every test in this file. `crossing()` asks
 * `(a > cut) !== (b > cut)`, which for a NaN cut is `false !== false` for every pair — so
 * `crossed` and `inPlay` are 0, all three checks report "0% of pairs cross t", and the probe
 * exits 0 having measured nothing. A silent pass is worse than no probe.
 */
if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
  console.error(`the clustering threshold is ${threshold}; it must be between 0 and 1`)
  process.exit(2)
}

const { base, stop } = await serveOrtPage({ title: 'affinity backend', dirs: { '/': exported } })
const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9341,
  profile: '/tmp/coda-affinity-backend-profile',
  // Without these the adapter is software; without an http origin there is no adapter at all.
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url: base })
await waitFor(ORT_READY, 'onnxruntime-web')

const script = `(async () => {
  const CONFIG = ${JSON.stringify({ manifest, variant, threshold, cloud: cloud.cloud, points: cloud.points })}
  const { manifest: m, variant: want, threshold: t, points: n } = CONFIG
  const cloud = Float32Array.from(CONFIG.cloud)
  const ort = window.ort
  ort.env.wasm.numThreads = 1
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter: this probe would be comparing WASM with WASM')

  const fileOf = (part) => m.files.find((f) => f.variant === want && f.part === part)
  const quantLabel = (part) => {
    const q = fileOf(part).quantisation ?? {}
    return q.bits ? q.kind + '/' + q.bits : (q.kind ?? 'unknown')
  }
  const bytesOf = async (part) => new Uint8Array(await (await fetch('/' + fileOf(part).file)).arrayBuffer())
  const build = (body, ep) => ort.InferenceSession.create(body, { executionProviders: [ep] })

  const [pointsName, maskName] = m.signatures.encoder.inputs
  const encOut = m.signatures.encoder.outputs
  const pairInput = m.signatures.decoder.inputs.find((name) => !encOut.includes(name))

  const feeds = () => {
    const f = {}
    f[pointsName] = new ort.Tensor('float32', cloud.slice(), [1, n, 3])
    f[maskName] = new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n])
    return f
  }
  // Chunked exactly as affinityRun.ts chunks: 262,144 pairs in one call is std::bad_alloc on
  // WASM, and the point of the probe is to compare what the app computes, not a bigger call.
  const CHUNK = 16384
  const decode = async (session, latents) => {
    const total = n * n
    const out = new Float32Array(total)
    for (let from = 0; from < total; from += CHUNK) {
      const count = Math.min(CHUNK, total - from)
      const data = new BigInt64Array(count * 2)
      for (let k = 0; k < count; k++) {
        const pair = from + k
        data[k * 2] = BigInt(Math.floor(pair / n)); data[k * 2 + 1] = BigInt(pair % n)
      }
      const f = { [pairInput]: new ort.Tensor('int64', data, [1, count, 2]) }
      for (const name of encOut) f[name] = latents[name]
      const answer = await session.run(f)
      const values = new Float32Array(answer[m.signatures.decoder.outputs[0]].data)
      // affinityRun.ts makes the same check, and here it is load-bearing in a nastier way: a
      // short answer leaves zeros in the tail of *both* arrays being compared, so they agree
      // perfectly over the padding and the trip-wire exits 0 having measured part of a matrix.
      if (values.length !== count) throw new Error('the decoder answered ' + values.length + ' of ' + count + ' pairs')
      out.set(values, from)
    }
    return out
  }

  /** How far apart two tensors are. Meaningful for anything numeric. */
  const compare = (a, b) => {
    let max = 0, total = 0
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i])
      if (d > max) max = d
      total += d
    }
    return { max: +max.toFixed(5), mean: +(total / a.length).toFixed(6) }
  }
  /**
   * How many pair decisions move. Only meaningful on affinities: affinityOps.ts links a pair when
   * 1 - affinity < t, so the cut is at an affinity of 1 - t. 'inPlay' is how many pairs sit near
   * enough to the cut to be moved at all, which is what makes the crossing rate readable - 0.06%
   * of every pair could be most of the pairs that were ever in question.
   */
  const NEAR = 0.05
  const crossing = (a, b, cut) => {
    let crossed = 0, inPlay = 0, crossedNear = 0
    for (let i = 0; i < a.length; i++) {
      const moved = (a[i] > cut) !== (b[i] > cut)
      if (moved) crossed++
      // Near the cut on the *reference* side. A pair can cross without being near it (0.9 -> 0.1),
      // so crossings are not a subset of these — which is why the ratio below counts the ones
      // that are, rather than dividing the whole-matrix total by this. Dividing gave a figure
      // that passes 100% exactly under the large-error failure this probe exists to catch.
      if (Math.abs(a[i] - cut) < NEAR) {
        inPlay++
        if (moved) crossedNear++
      }
    }
    return { crossedPercent: +((100 * crossed) / a.length).toFixed(3), crossed,
             nearCut: inPlay, crossedNear,
             crossedOfNearCutPercent: inPlay ? +((100 * crossedNear) / inPlay).toFixed(2) : 0 }
  }
  const range = (a) => {
    let lo = Infinity, hi = -Infinity
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v }
    return [+lo.toFixed(4), +hi.toFixed(4)]
  }

  const encoderBody = await bytesOf('encoder')
  const decoderBody = await bytesOf('decoder')
  const encWasm = await build(encoderBody, 'wasm')
  const encGpu = await build(encoderBody, 'webgpu')
  const decWasm = await build(decoderBody, 'wasm')
  const decGpu = await build(decoderBody, 'webgpu')

  const latWasm = await encWasm.run(feeds())
  const latGpu = await encGpu.run(feeds())
  // 1. the encoder, backend against backend. No crossing rate: a clustering cut has no meaning
  // on latent activations, and publishing one beside the decoder's would read as the same thing.
  const encoder = {}
  for (const name of encOut) {
    encoder[name] = compare(new Float32Array(latWasm[name].data), new Float32Array(latGpu[name].data))
  }

  // 2. the decoder alone: identical latents, one backend changed. This is the measurement.
  const aWasm = await decode(decWasm, latWasm)
  const aGpuSameInput = await decode(decGpu, latWasm)
  // 3. the chain the app actually runs.
  const aGpuChain = await decode(decGpu, latGpu)
  const cut = 1 - t

  return {
    adapter: (adapter.info?.vendor ?? '?') + '/' + (adapter.info?.architecture ?? '?'),
    model: m.id, variant: want, points: n, pairs: n * n, threshold: t,
    quantisation: Object.fromEntries(m.parts.map((p) => [p, quantLabel(p)])),
    encoderWasmVsGpu: encoder,
    decoderBackendOnly: { ...compare(aWasm, aGpuSameInput), ...crossing(aWasm, aGpuSameInput, cut) },
    wholeChain: { ...compare(aWasm, aGpuChain), ...crossing(aWasm, aGpuChain, cut) },
    wasmRange: range(aWasm), gpuRange: range(aGpuChain),
  }
})()`

const got = await evaluate(script, 1_800_000)
console.log(JSON.stringify(got, null, 2))
if (reportTo) {
  writeFileSync(reportTo, JSON.stringify(got, null, 2) + '\n')
  console.log(`wrote ${reportTo}`)
}

/*
 * What counts as agreement, and why this number rather than a round one.
 *
 * `probe:affinity-export` measured each variant against fp32 on the CPU by this same formula.
 * fp16 — the decoder's own quantisation — moved **0.793%** of pair decisions; nbits8 moved 0.071%.
 * So the bar is fp16's own figure: the backend must not move more decisions than the quantisation
 * already does. Past that, which GPU somebody has would matter more than the recipe we chose.
 *
 * **It is a trip-wire, not a tolerance**, and the two numbers have different anchors — 0.793% is
 * against fp32, this is against WASM — so passing it does not say the shipped build is within
 * 0.793% of full precision, and nothing here measures that. What it does catch is the failure
 * this probe was written to look for: SEAM's flipped 66% of points, missing the bar by three
 * orders of magnitude.
 */
const CROSS_LIMIT = 0.793
const ENCODER_LIMIT = 0.05
const encoderDiffs = Object.values(got.encoderWasmVsGpu ?? {})
const label = (part) => `${got.quantisation[part]} ${part}`
report.check(
  encoderDiffs.length > 0 && encoderDiffs.every((d) => d.max < ENCODER_LIMIT),
  `the ${label('encoder')} agrees across backends (max ${encoderDiffs.map((d) => d.max).join(', ')})`,
)
report.check(
  got.decoderBackendOnly.crossedPercent < CROSS_LIMIT,
  `the ${label('decoder')} on WebGPU agrees with the CPU on the same latents: ` +
    `${got.decoderBackendOnly.crossedPercent}% of pairs cross t ` +
    `(${got.decoderBackendOnly.crossedOfNearCutPercent}% of the ${got.decoderBackendOnly.nearCut} near it), ` +
    `against fp16's own ${CROSS_LIMIT}% against fp32`,
)
report.check(
  got.wholeChain.crossedPercent < CROSS_LIMIT,
  `the whole chain agrees with the CPU: ${got.wholeChain.crossedPercent}% of pairs cross t (limit ${CROSS_LIMIT}%)`,
)
await close()
stop()
report.finish()
