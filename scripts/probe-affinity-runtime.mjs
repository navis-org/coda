/**
 * Does `src/ml` actually work?
 *
 * Everything in `src/ml` — the manifest check, the verified weight cache, the worker protocol —
 * is unreachable from vitest: it needs a real `Worker`, a real IndexedDB and a WebGPU adapter.
 * Without this probe none of it has ever run, and `docs/ml.md` would be a design note written in
 * the past tense. `probe:affinity-variants` does not help: it drives ONNX Runtime directly to
 * answer a conversion question and imports none of this.
 *
 * So this one drives the app's own modules through the dev server (`APP_MODULE`, the house
 * pattern), and measures the two things only a real browser can say: what a cold open costs when
 * the weights come over the network, and what a warm one costs when they come from the cache.
 *
 * It also exercises the part that cannot be unit-tested at all: that the encoder's outputs can be
 * **held** in the worker and fed to the decoder without crossing back, which is what the whole
 * protocol is shaped around.
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then
 *   `pnpm probe:affinity-runtime -- --manifest <url> [--variant mixed] [--points 256]`
 * Pass `--url` if the dev server is somewhere else. A busy port makes vite move silently, so
 * check the port it actually printed.
 */

import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const manifestUrl = args.value('--manifest')
const variant = args.value('--variant')
const points = Number(args.value('--points') ?? 256)
const chunk = Number(args.value('--chunk') ?? 16384)
if (!manifestUrl) {
  console.error('pass --manifest <url of a converted model manifest>')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9339,
  profile: '/tmp/coda-affinity-runtime-profile',
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

/**
 * Run one open-and-infer cycle in the page.
 *
 * `cold` clears the weight cache first, so the download is measured; otherwise the cache answers
 * and the open is the session build alone.
 */
const cycle = (cold) => `(async () => {
  const load = ${APP_MODULE}
  const [session, weights, support] = await Promise.all([
    load('/src/ml/session.ts'),
    load('/src/ml/weights.ts'),
    load('/src/ml/support.ts'),
  ])

  const gpu = await support.gpuSupport()
  if (gpu.refusal) throw new Error(gpu.refusal)
  if (${cold}) await weights.clearWeights()

  // Per part, then summed: progress reports bytes-so-far for the part being fetched, so a max
  // over the stream reports the largest part rather than the transfer.
  const perPart = new Map()
  const t0 = performance.now()
  const open = await session.openModel({
    manifestUrl: ${JSON.stringify(manifestUrl)},
    task: 'point-affinity',
    ${variant ? `variant: ${JSON.stringify(variant)},` : '// no variant: preferredVariant picks'}
    onProgress: (p) => { if (!p.cached) perPart.set(p.part, p.received) },
  })
  const openMs = Math.round(performance.now() - t0)

  const m = open.loaded.manifest
  const [pointsName, maskName] = m.signatures.encoder.inputs
  const n = ${points}
  const cloud = new Float32Array(n * 3)
  for (let i = 0; i < cloud.length; i++) cloud[i] = Math.random() * 2 - 1

  // Hold both encoder outputs: nothing comes back, which is the property under test.
  const t1 = performance.now()
  const returned = await open.run({
    part: 'encoder',
    feeds: [
      { name: pointsName, type: 'float32', dims: [1, n, 3], data: cloud.buffer },
      { name: maskName, type: 'bool', dims: [1, n], data: new Uint8Array(n).fill(1).buffer },
    ],
    hold: m.signatures.encoder.outputs,
  })
  const encodeMs = Math.round(performance.now() - t1)

  // One decode chunk, fed from the held tensors by name.
  const dec = m.signatures.decoder.inputs
  const pairName = dec.find((name) => !m.signatures.encoder.outputs.includes(name))
  const count = Math.min(${chunk}, n * n)
  const idx = new BigInt64Array(count * 2)
  for (let i = 0; i < count; i++) { idx[i * 2] = BigInt((i / n) | 0); idx[i * 2 + 1] = BigInt(i % n) }
  const t2 = performance.now()
  const out = await open.run({
    part: 'decoder',
    use: m.signatures.encoder.outputs,
    feeds: [{ name: pairName, type: 'int64', dims: [1, count, 2], data: idx.buffer }],
  })
  const decodeMs = Math.round(performance.now() - t2)
  const affinity = new Float32Array(out[0].data)

  await open.release()
  await open.close()

  return {
    adapter: gpu.vendor + '/' + gpu.architecture,
    model: m.id,
    openMs, encodeMs, decodeMs,
    downloadedMegabytes: +([...perPart.values()].reduce((a, b) => a + b, 0) / 1e6).toFixed(1),
    heldNothingReturned: returned.length === 0,
    affinityCount: affinity.length,
    affinityInRange: affinity.every((a) => a >= 0 && a <= 1),
    pairsPerSecond: Math.round(count / (decodeMs / 1000)),
  }
})()`

const cold = await evaluate(cycle(true), 1_800_000)
console.log('cold  ', JSON.stringify(cold))
const warm = await evaluate(cycle(false), 1_800_000)
console.log('warm  ', JSON.stringify(warm))

report.check(cold.heldNothingReturned, 'the encoder returned nothing: its outputs stayed held')
report.check(cold.affinityCount > 0, 'the decoder answered from the held tensors')
report.check(cold.affinityInRange, 'every affinity is in [0, 1]')
report.check(cold.downloadedMegabytes > 0, 'the cold open downloaded the weights')
report.check(warm.downloadedMegabytes === 0, 'the warm open downloaded nothing: the cache answered')
report.check(warm.openMs < cold.openMs, `warm open (${warm.openMs}ms) beats cold (${cold.openMs}ms)`)
await close()
report.finish()
