/**
 * Which quantisation recipe do we ship?
 *
 * Phase 0 produced several variants of one model and measured their *fidelity* on the CPU. It
 * could not say which of them a browser can execute, because that is a question about ONNX
 * Runtime's WebGPU backend and the ops each variant emits — dynamic int8 emits `MatMulInteger`,
 * which that backend does not implement, so the variant loads, answers, and is unusably slow.
 * **The test is therefore time, not success.**
 *
 * This is a one-off conversion decision, which is why it is `probe:affinity-variants` and drives
 * ONNX Runtime directly. The probe that drives `src/ml` end to end — the manifest, the weight
 * cache, the worker — is `probe:affinity-runtime`, and it arrives with the node that uses them.
 *
 * ## Why headless Chrome is a real measurement here
 *
 * `docs/canvas.md` warns that headless Chrome is SwiftShader, and for WebGL it is. **WebGPU on
 * macOS is not**: with the page on localhost the adapter comes back `apple/metal-3`, the real GPU.
 * Two things are load-bearing, both found the hard way: the page must be on an http origin (on
 * `about:blank` `navigator.gpu` is simply absent, which reads as "this Chrome has no WebGPU"), and
 * the adapter is reported every run so a software adapter can never be mistaken for a GPU.
 *
 * ## Reproducibility
 *
 * Everything the page needs is written here from `node_modules` and the converter's output, so a
 * clean checkout can re-derive the numbers. Nothing is read from a directory somebody prepared by
 * hand, and **the variants, the file paths and the tensor names all come from the manifest** —
 * re-typing `latents` here is how a renamed output becomes an error nobody connects to the rename.
 *
 * Usage: `pnpm probe:affinity-variants -- --exported <converter --out dir> [--out report.json]`
 */

import { createServer } from 'node:http'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { launchChrome, probeArgs } from './lib/browserProbe.mjs'

/**
 * ORT's own directory, served whole.
 *
 * Not just the entry module: it fetches `ort-wasm-simd-threaded.jsep.wasm` beside itself at
 * runtime, and serving only the `.mjs` fails as "no available backend found … both async and sync
 * fetching of the wasm failed" — which reads as a WebGPU problem rather than a missing file.
 */
const ORT_DIST = 'node_modules/onnxruntime-web/dist'
const PAGE = `<!doctype html><meta charset=utf-8><title>affinity variants</title><body>ready</body>
<script type="module">
import * as ort from './ort/ort.webgpu.bundle.min.mjs'
window.ort = ort
</script>`

const args = probeArgs()
const exported = args.value('--exported')
const reportTo = args.value('--out')
const chunk = Number(args.value('--chunk') ?? 16384)
const sizes = (args.value('--points') ?? '256,1024,2048').split(',').map(Number)
/** Each timing is the best of this many. See the note beside the encoder loop. */
const repeats = Number(args.value('--repeats') ?? 5)
if (!exported) {
  console.error('pass --exported <the converter\'s --out directory>')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(join(exported, 'manifest.json'), 'utf8'))
/** Variants carrying every declared part, which is what `completeVariants` means in src/ml. */
const variants = [
  ...new Set(manifest.files.map((f) => f.variant)),
].filter((v) => manifest.parts.every((p) => manifest.files.some((f) => f.variant === v && f.part === p)))

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json', '.html': 'text/html' }

/**
 * Serve the page, ORT and the converter's output from one origin.
 *
 * `node:http` rather than shelling out to `python3 -m http.server`, which this repo has no other
 * reason to require, and `listen(0)` rather than a fixed port, which a previous run or another
 * probe can be holding — invisibly, since the spawned server's output went nowhere.
 */
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  if (path === '/' || path === '/index.html') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html' })
    return response.end(PAGE)
  }
  const file = path.startsWith('/ort/')
    ? resolve(join(ORT_DIST, path.slice('/ort/'.length)))
    : resolve(join(exported, path))
  response.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file)
    .on('error', () => response.destroy())
    .pipe(response)
})
await new Promise((ready) => server.listen(0, ready))
const base = `http://localhost:${server.address().port}`

const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9338,
  profile: '/tmp/coda-affinity-variants-profile',
  // Without these the adapter is software; without an http origin there is no adapter at all.
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url: base })
await waitFor('Boolean(window.ort)', 'onnxruntime-web')

const script = `(async () => {
  const CONFIG = ${JSON.stringify({ variants, sizes, chunk, manifest, repeats })}
  const ort = window.ort
  ort.env.wasm.numThreads = 1
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter: a timing here would be meaningless')
  const report = { adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture }, variants: {} }
  const { manifest: m, variants: wanted, sizes: ns, chunk: block, repeats: REPEATS } = CONFIG
  const fileOf = (variant, part) => m.files.find((f) => f.variant === variant && f.part === part)
  const sig = (part) => m.signatures[part]

  const pairs = (n, count) => {
    const data = new BigInt64Array(count * 2)
    for (let i = 0; i < count; i++) { data[i * 2] = BigInt(Math.floor(i / n)); data[i * 2 + 1] = BigInt(i % n) }
    return new ort.Tensor('int64', data, [1, count, 2])
  }

  for (const variant of wanted) {
    const v = {}
    report.variants[variant] = v
    let sessions = {}
    try {
      const t0 = performance.now()
      let bytes = 0
      for (const part of m.parts) {
        const entry = fileOf(variant, part)
        const body = new Uint8Array(await (await fetch('/' + entry.file)).arrayBuffer())
        bytes += body.length
        sessions[part] = await ort.InferenceSession.create(body, { executionProviders: ['webgpu'] })
      }
      v.megabytes = +(bytes / 1e6).toFixed(1)
      v.openSeconds = +((performance.now() - t0) / 1000).toFixed(2)

      const [pointsName, maskName] = sig('encoder').inputs
      const encode = async (n) => {
        const feeds = {}
        feeds[pointsName] = new ort.Tensor('float32', Float32Array.from({ length: n * 3 }, () => Math.random() * 2 - 1), [1, n, 3])
        feeds[maskName] = new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n])
        const t = performance.now()
        const out = await sessions.encoder.run(feeds)
        return { ms: Math.round(performance.now() - t), out }
      }
      await encode(256)   // warm the shader cache; the first run compiles every pipeline
      v.encoderMs = {}
      let last = null
      for (const n of ns) {
        // Best of N, not one shot. This machine is shared with endpoint-security scanning that
        // can take 80% of the CPU, and a single run under it read 12x slow -- slow enough to
        // invert the variant ranking, which is the one thing this probe is for. The minimum is
        // the least contaminated sample; spreadMs publishes how noisy the run was, so a
        // contaminated set is visible in the report rather than silently believed.
        const runs = []
        for (let i = 0; i < REPEATS; i++) runs.push(await encode(n))
        const best = runs.reduce((a, b) => (a.ms <= b.ms ? a : b))
        v.encoderMs[n] = best.ms
        v.spreadMs = Math.max(v.spreadMs ?? 0, Math.max(...runs.map((r) => r.ms)) - best.ms)
        last = { n, out: best.out }
      }

      // Decoder throughput from one chunk, then the full N^2 matrix priced from it: running the
      // whole matrix at N=2048 is 4.2M pairs and minutes per variant.
      const held = {}
      for (const name of sig('decoder').inputs) if (last.out[name]) held[name] = last.out[name]
      const pairName = sig('decoder').inputs.find((name) => !last.out[name])
      const warm = { ...held }; warm[pairName] = pairs(last.n, 1024)
      await sessions.decoder.run(warm)
      // Built once, outside the timed region: 32k BigInt boxings inside it inflated the number.
      const tensor = pairs(last.n, Math.min(block, last.n * last.n))
      const feeds = { ...held }; feeds[pairName] = tensor
      // Best of N for the same reason as the encoder: the fastest chunk is the one that ran
      // without competing for the machine.
      let bestChunkMs = Infinity
      let worstChunkMs = 0
      for (let i = 0; i < REPEATS; i++) {
        const t2 = performance.now()
        await sessions.decoder.run(feeds)
        const ms = performance.now() - t2
        bestChunkMs = Math.min(bestChunkMs, ms)
        worstChunkMs = Math.max(worstChunkMs, ms)
      }
      v.decoderPairsPerSecond = Math.round(block / (bestChunkMs / 1000))
      v.decoderSpread = +(worstChunkMs / bestChunkMs).toFixed(2)
      v.decodeSecondsForFullMatrix = {}
      for (const n of ns) v.decodeSecondsForFullMatrix[n] = +((n * n) / v.decoderPairsPerSecond).toFixed(1)
    } catch (e) {
      v.error = String(e).slice(0, 300)
    } finally {
      // In a finally: a variant that throws is exactly what the int8 row probes for, and leaving
      // its sessions resident would charge the next variant's measurement for them.
      for (const s of Object.values(sessions)) { try { await s.release() } catch {} }
    }
  }
  return report
})()`

const report = await evaluate(script, 1_800_000)
console.log(JSON.stringify(report, null, 2))
if (reportTo) {
  writeFileSync(reportTo, JSON.stringify(report, null, 2) + '\n')
  console.log(`\nwrote ${reportTo}`)
}
await close()
server.close()
