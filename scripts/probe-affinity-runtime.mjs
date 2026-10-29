/**
 * Phase 1: can a browser actually run the point affinity transformer, and how fast?
 *
 * Phase 0 produced five quantised variants and measured their *fidelity* on the CPU. It could not
 * answer which of them a browser can execute, because that is a question about ONNX Runtime's
 * WebGPU backend and the ops each variant emits:
 *
 *   fp16   / fp32   plain MatMul      expected native
 *   int8            MatMulInteger     expected NOT implemented on WebGPU -> CPU fallback
 *   nbits4 / nbits8 MatMulNBits       expected accelerated
 *
 * This probe replaces "expected" with a measurement. A variant that silently falls back does not
 * error -- it loads, it answers, and it is unusably slow -- so the test is **time**, not success.
 *
 * ## Why headless Chrome is a real measurement here
 *
 * `docs/canvas.md` warns that headless Chrome is SwiftShader, and for WebGL it is. **WebGPU on
 * macOS is not**: with the page on localhost the adapter comes back `apple/metal-3`, the real GPU.
 * Two things are load-bearing and both were found the hard way: the page must be on an http(s)
 * origin (on `about:blank` `navigator.gpu` is simply absent, which reads as "this Chrome has no
 * WebGPU"), and the adapter is reported so a run on a software adapter can never be mistaken for
 * a run on a GPU.
 *
 * Usage: `pnpm probe:affinity-runtime` with the converter's --out directory served, or
 * `--base <url>` against the hosted copy.
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { launchChrome } from './lib/browserProbe.mjs'

const PORT = 8731
const DEBUG_PORT = 9338
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const serveDir = flag('--serve', null)
const base = flag('--base', serveDir ? `http://localhost:${PORT}` : null)
const out = flag('--out', null)
const variants = flag('--variants', 'nbits8,nbits4,fp16,int8').split(',')
// N values to time the encoder at, and to price the N^2 decode from.
const encoderSizes = flag('--points', '256,1024,2048').split(',').map(Number)
const chunk = Number(flag('--chunk', '16384'))

if (!base) {
  console.error('pass --serve <dir> (served on localhost) or --base <url>')
  process.exit(2)
}

let server
if (serveDir) {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', serveDir], {
    stdio: 'ignore',
  })
  process.on('exit', () => server?.kill())
  await new Promise((r) => setTimeout(r, 800))
}

const { evaluate, send, close } = await launchChrome({
  port: DEBUG_PORT,
  profile: '/tmp/coda-affinity-runtime-profile',
  // Without these the adapter is software; without an http origin there is no adapter at all.
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${PORT}/` })
await new Promise((r) => setTimeout(r, 2500))

const script = `(async () => {
  const ort = window.ort
  if (!ort) throw new Error('onnxruntime-web did not load')
  ort.env.wasm.numThreads = 1
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter: a timing here would be meaningless')
  const report = {
    adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture },
    variants: {},
  }

  const pairBlock = (n, start, count) => {
    const data = new BigInt64Array(count * 2)
    for (let i = 0; i < count; i++) {
      const flat = start + i
      data[i * 2] = BigInt(Math.floor(flat / n))
      data[i * 2 + 1] = BigInt(flat % n)
    }
    return new ort.Tensor('int64', data, [1, count, 2])
  }

  for (const variant of ${JSON.stringify(variants)}) {
    const v = { }
    report.variants[variant] = v
    try {
      const t0 = performance.now()
      const encBytes = new Uint8Array(await (await fetch(\`${base}/\${variant}/encoder.onnx\`)).arrayBuffer())
      const decBytes = new Uint8Array(await (await fetch(\`${base}/\${variant}/decoder.onnx\`)).arrayBuffer())
      v.megabytes = +((encBytes.length + decBytes.length) / 1e6).toFixed(1)
      v.fetchSeconds = +((performance.now() - t0) / 1000).toFixed(2)

      const t1 = performance.now()
      const enc = await ort.InferenceSession.create(encBytes, { executionProviders: ['webgpu'] })
      const dec = await ort.InferenceSession.create(decBytes, { executionProviders: ['webgpu'] })
      v.sessionSeconds = +((performance.now() - t1) / 1000).toFixed(2)

      const encode = async (n) => {
        const points = new ort.Tensor('float32',
          Float32Array.from({ length: n * 3 }, () => Math.random() * 2 - 1), [1, n, 3])
        const mask = new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n])
        const t = performance.now()
        const r = await enc.run({ points, mask })
        return { ms: Math.round(performance.now() - t), out: r }
      }

      await encode(256)  // warm the shader cache; the first run compiles every pipeline
      v.encoderMs = {}
      let encoded = null
      for (const n of ${JSON.stringify(encoderSizes)}) {
        const got = await encode(n)
        v.encoderMs[n] = got.ms
        encoded = { n, out: got.out }
      }

      // Decoder throughput: time one chunk, then price the full N^2 matrix from it. Running the
      // whole matrix at N=2048 would be 4.2M pairs and minutes per variant.
      const { n, out: enc_out } = encoded
      const feeds = { latents: enc_out.latents, point_emb: enc_out.point_emb }
      await dec.run({ ...feeds, pairs: pairBlock(n, 0, 1024) })
      const t2 = performance.now()
      const reps = 4
      for (let i = 0; i < reps; i++) await dec.run({ ...feeds, pairs: pairBlock(n, 0, ${chunk}) })
      const perChunk = (performance.now() - t2) / reps
      v.decoderPairsPerSecond = Math.round(${chunk} / (perChunk / 1000))
      v.decodeSecondsForFullMatrix = {}
      for (const m of ${JSON.stringify(encoderSizes)}) {
        v.decodeSecondsForFullMatrix[m] = +((m * m) / v.decoderPairsPerSecond).toFixed(1)
      }
      await enc.release(); await dec.release()
    } catch (e) {
      v.error = String(e).slice(0, 300)
    }
  }
  return report
})()`

const report = await evaluate(script, 1800000)
console.log(JSON.stringify(report, null, 2))
if (out) {
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  console.log(`\nwrote ${out}`)
}
await close()
server?.kill()
