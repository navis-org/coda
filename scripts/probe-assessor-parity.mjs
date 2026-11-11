#!/usr/bin/env node
/**
 * The real assessor, in a browser, against SEAM's own PyTorch logits.
 *
 *   pnpm probe:assessor-parity -- --exported ~/Github/SEAM/data/onnx/sa2_mask
 *   pnpm probe:assessor-parity -- --exported … --ends 20,1475 --seeds 0,1,2
 *   pnpm probe:assessor-parity -- --exported … --model '/sa2_mask_mm_s{seed}.onnx'
 *
 * The third line is the one a caller should use: SEAM publishes the assessors in two forms, and
 * the `mm` one — its convolutions expressed as matrix multiplies — is 8.4x faster on WebGPU for
 * the same answer. `docs/seam-assessor-speed.md` is why. It pins its batch axis to 1, which this
 * probe asks the model about rather than assuming; a list fed whole to it is refused outright.
 *
 * `pnpm probe:assessor-ops` settles whether the *graph* runs on WebGPU, on a 2.2 MB narrowed
 * copy. This runs `sa2_mask_s<k>.onnx` itself — 133 MB, fp32, the weights the suggestions were
 * scored with — on real patches out of SEAM's parity fixture, and that is what the cost and the
 * agreement can honestly be read off. Scaling the op probe's 4 GFLOP by 21.7 is arithmetic, not
 * a measurement: the narrowed graph has the same 129³ spatial extent at a twentieth of the
 * channels, so it moves nearly as much memory per unit of arithmetic and keeps the GPU less busy.
 *
 * **Compared with `torch_s<k>`, never with `candidates.parquet`'s `score_s<k>`.** `torch` is
 * the number SEAM's parity rule is written against, and the comparison stays there even now
 * that the za refit has rescored the cluster in fp32. It used to matter much more: the stored
 * scores were bf16, which SEAM measured moving a logit by a median 0.6-1.8, so an exact browser
 * would have "failed" against them by about a logit while being right. `lists.parquet` carries
 * PyTorch fp32 beside onnxruntime's CPU answer for that reason.
 *
 * **What this does not do yet** is SEAM's parity rule, which is about *decisions* — the shown
 * set, ref's first candidate, q within 0.01 — and needs stages 7-9. What it measures is the
 * layer underneath: do the logits agree, and what does a patch cost. Both are prerequisites,
 * and the second is the one that decides whether the phase is affordable at all.
 *
 * `report.check` here is `(ok, line)` — `browserProbe.mjs`' order, the opposite of
 * `pyodideProbe.mjs`'. See the note in `probe-assessor-ops.mjs`.
 *
 * Reads only; the model and the fixture are served from a local directory to a local browser.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { ORT_READY, serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const exported = args.value('--exported')
if (!exported) {
  console.error("pass --exported <SEAM's data/onnx/sa2_mask>")
  process.exit(2)
}
/* Two short lists by default: 6 patches is 13 MB of labels and answers in under a minute. */
const ends = (args.value('--ends') ?? '20,1475').split(',').map((one) => one.trim())
const seeds = (args.value('--seeds') ?? '0').split(',').map(Number)
/* Both by default: WASM is the fallback, and on this graph it is not obviously the slower one. */
const providers = (args.value('--eps') ?? 'webgpu,wasm').split(',').map((one) => one.trim())
/*
 * Which graph to run. The default is SEAM's own fp32 export; `--model /work/fp16_s{seed}.onnx`
 * points at anything else served from the work directory — which is how an fp16 conversion is
 * measured without putting a derived model next to SEAM's published ones.
 */
const modelPath = args.value('--model') ?? '/sa2_mask_s{seed}.onnx'
/*
 * `--shapes` adds the throughput measurements to the parity run: does feeding the patches in
 * smaller batches cost more, and do two sessions running at once get more through than one?
 * Both ask the same thing — whether the device has capacity a caller could be using — and the
 * answer decides whether "score a tip" is one queue or several.
 */
const shapes = args.all.includes('--shapes')

const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-assessor-lists')
execFileSync(
  process.env.CODA_PYTHON ?? 'python3',
  ['-I', 'scripts/lib/seam_assessor.py', 'lists', exported, WORK, ...ends],
  { stdio: 'inherit' },
)
const fixture = JSON.parse(readFileSync(join(WORK, 'lists.json'), 'utf8'))

const report = probeReport()
const { base, stop } = await serveOrtPage({
  title: 'assessor parity',
  dirs: { '/': exported, '/work/': WORK },
  // `ort.all` only where it is needed: it is the bigger build, and WebNN is the one provider
  // the default bundle leaves out.
  bundle: providers.some((one) => one.startsWith('webnn')) ? 'ort.all.bundle.min.mjs' : undefined,
})
const { evaluate, waitFor, close } = await launchChrome({
  port: 9348,
  profile: '/tmp/coda-assessor-parity-profile',
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    // WebNN is behind a flag in Chrome today. Harmless when no probe asks for it.
    '--enable-features=WebMachineLearningNeuralNetwork',
  ],
})

await evaluate(`location.href = ${JSON.stringify(base)}`)
await waitFor(ORT_READY, 'onnxruntime-web', { tries: 600 })

/**
 * One seed's session, then every list through it.
 *
 * The session is made once and reused, which is the shape a caller would use — 133 MB of
 * weights uploaded to the GPU per tip would dominate everything else. Each list is run twice and
 * the second is the one quoted: the first carries shader compilation, which a real run pays once
 * per page rather than once per tip.
 */
async function runSeed(seed, ep) {
  return evaluate(
    `(async () => {
      const made0 = performance.now()
      /*
       * webnn:gpu / webnn:npu pick WebNN's device. Spelled out because the default is the CPU,
       * and a WebNN run that lands there times exactly like WASM -- which is what the first
       * reading of this looked like, and would have been reported as "WebNN is no faster".
       * (No backticks in here: this whole block is inside a template literal.)
       */
      const [name, deviceType] = '${ep}'.split(':')
      const session = await ort.InferenceSession.create(${JSON.stringify(modelPath)}.replace('{seed}', String(${seed})), {
        executionProviders: [deviceType ? { name, deviceType } : name],
      })
      const made = performance.now() - made0
      const out = []
      for (const list of ${JSON.stringify(fixture.lists.map((one) => ({ end_uid: one.end_uid, patches: one.patches, size: one.size })))}) {
        const bytes = new Uint8Array(await (await fetch('/work/' + list.end_uid + '.u8')).arrayBuffer())
        /*
         * Built outside the timed region and measured on its own, so that the graph's cost and
         * the marshalling's are two numbers rather than one. It was first written inside, on the
         * guess that widening 2.1 million uint8 labels a patch was what made the first reading
         * so slow. It is not: the cast is about 1 ms and the graph really does take ~1.2 s a
         * patch. Separating them is still right — a caller pays the cast once per patch however
         * many seeds score it — but it buys clarity, not time.
         */
        const cast0 = performance.now()
        const floats = Float32Array.from(bytes)
        const cast = performance.now() - cast0
        /*
         * How many patches the graph takes at once, asked of the model rather than assumed.
         * The matmul form pins its batch axis to 1 -- flattening (N,C,X,Y,Z) to (C,voxels) is
         * only the same tensor at N=1 -- so a whole list fed in one go is refused outright
         * ("Got: 3 Expected: 1"). A symbolic first dimension comes back as a string, and then
         * the list goes in whole as before.
         */
        const fixed = session.inputMetadata?.[0]?.shape?.[0]
        const step = typeof fixed === 'number' && fixed > 0 ? Math.min(fixed, list.patches) : list.patches
        const voxels = list.size ** 3
        const chunks = []
        for (let at = 0; at < list.patches; at += step) {
          const count = Math.min(step, list.patches - at)
          chunks.push(new ort.Tensor(
            'float32',
            // Copied, not a view: a Float32Array at a non-zero offset is not reliably accepted.
            count === list.patches ? floats : floats.slice(at * voxels, (at + count) * voxels),
            [count, list.size, list.size, list.size],
          ))
        }
        const name = session.outputNames[0]
        /* The whole list, however many runs that takes -- so the timings stay per patch. */
        const pass = async () => {
          const all = []
          for (const chunk of chunks) {
            all.push(...(await session.run({ lab: chunk }))[name].data)
          }
          return all
        }
        const cold0 = performance.now()
        const first = await pass()
        const cold = performance.now() - cold0
        const warm0 = performance.now()
        const again = await pass()
        const warm = performance.now() - warm0
        out.push({
          end_uid: list.end_uid,
          patches: list.patches,
          runs: chunks.length,
          cold,
          warm,
          cast,
          logit: again,
          first,
        })
      }
      await session.release?.()
      return { made, lists: out }
    })()`,
    900_000,
  )
}

/**
 * Throughput, two ways, on one list and one seed.
 *
 * **Batches.** One `session.run` over `n` patches against `n` runs of one. If the per-patch cost
 * is flat the graph is compute-bound and there is no launch overhead for a batch to amortise.
 *
 * **Concurrency.** Two sessions of the same model, warmed, then run with `Promise.all`. WebGPU
 * work from one page goes to one device, so this says whether that device had room: near-double
 * throughput means it was idling between submissions, and near-equal means it was full.
 */
async function runShapes(seed) {
  return evaluate(
    `(async () => {
      const list = ${JSON.stringify(fixture.lists[0])}
      const bytes = new Uint8Array(await (await fetch('/work/' + list.end_uid + '.u8')).arrayBuffer())
      const voxels = list.size ** 3
      const make = (from, count) => new ort.Tensor(
        'float32',
        Float32Array.from(bytes.subarray(from * voxels, (from + count) * voxels)),
        [count, list.size, list.size, list.size],
      )
      const open = () => ort.InferenceSession.create(
        ${JSON.stringify(modelPath)}.replace('{seed}', String(${seed})),
        { executionProviders: ['webgpu'] },
      )

      const session = await open()
      const out = { patches: list.patches, batches: [], parallel: [] }
      /*
       * A model with a pinned batch axis has no sweep to run: every size but its own is refused
       * before it is timed. Asked rather than assumed, as in runSeed.
       */
      const fixed = session.inputMetadata?.[0]?.shape?.[0]
      const sizes = typeof fixed === 'number' && fixed > 0 ? [fixed] : [1, 4, list.patches]
      out.pinned = typeof fixed === 'number' && fixed > 0 ? fixed : null
      for (const size of sizes) {
        if (size > list.patches) continue
        const chunks = []
        for (let at = 0; at + size <= list.patches; at += size) chunks.push(make(at, size))
        await session.run({ lab: chunks[0] })          // warm the shape
        const t0 = performance.now()
        for (const chunk of chunks) await session.run({ lab: chunk })
        out.batches.push({ size, done: chunks.length * size, ms: performance.now() - t0 })
      }

      /* As much as the graph takes at once -- the whole list, or one patch where it is pinned. */
      const each = out.pinned ?? list.patches
      const whole = make(0, each)
      for (const ways of [1, 2]) {
        const all = [session]
        try {
          while (all.length < ways) all.push(await open())
          for (const one of all) await one.run({ lab: whole })   // warm every session
          const t0 = performance.now()
          /*
           * Concurrent, then the same work strictly in turn. If the device was full the two
           * take the same time; if concurrency is simply unsupported the first one throws,
           * which is an answer too and must not take the batch numbers down with it.
           */
          await Promise.all(all.map((one) => one.run({ lab: whole })))
          const together = performance.now() - t0
          const t1 = performance.now()
          for (const one of all) await one.run({ lab: whole })
          out.parallel.push({
            ways,
            done: ways * each,
            ms: together,
            inTurn: performance.now() - t1,
          })
        } catch (error) {
          out.parallel.push({ ways, done: ways * each, failed: String(error).slice(0, 180) })
        }
        for (const one of all.slice(1)) {
          try {
            await one.release?.()
          } catch {
            /* a session that threw mid-run may not release cleanly; the probe is ending anyway */
          }
        }
      }
      await session.release?.()
      return out
    })()`,
    1_800_000,
  )
}

const timings = []
for (const ep of providers) for (const seed of seeds) {
  let got
  try {
    got = await runSeed(seed, ep)
  } catch (error) {
    report.check(false, `${ep} seed ${seed}: did not run — ${String(error).slice(0, 300)}`)
    continue
  }
  report.check(
    true,
    `${ep} seed ${seed}: session built in ${(got.made / 1000).toFixed(1)} s (133 MB of weights)`,
  )

  for (const list of got.lists) {
    const golden = fixture.lists.find((one) => one.end_uid === list.end_uid)
    const torch = golden.torch[seed]
    const off = list.logit.map((v, at) => Math.abs(v - torch[at]))
    const worst = Math.max(...off)
    /*
     * 0.05 is SEAM's own resolution on this quantity: its parity rule only asks about first
     * place where fp32's top two differ by more than that, so an error under it cannot move a
     * decision the rule looks at. onnxruntime's CPU backend manages 8e-4 on the same lists,
     * which is the number this is really being read against.
     */
    report.check(
      worst < 0.05,
      `${ep} end ${list.end_uid}, seed ${seed}: ${list.patches} patches match PyTorch to ` +
        `${worst.toExponential(2)} (onnxruntime CPU managed 8e-4 on these lists)`,
    )
    /* Order is the thing the pipeline reads; a shift that keeps it is cheaper than one that doesn't. */
    const order = (xs) => [...xs.keys()].sort((a, b) => xs[b] - xs[a]).join(',')
    report.check(
      order(list.logit) === order(torch),
      `${ep} end ${list.end_uid}, seed ${seed}: the candidates rank in PyTorch's order`,
    )
    /* A session reused across lists must not carry state between runs. */
    report.check(
      list.first.every((v, at) => v === list.logit[at]),
      `${ep} end ${list.end_uid}, seed ${seed}: the second run of the same session answers the same`,
    )
    timings.push({ ep, seed, ...list })
  }
}

if (timings.length > 0) {
  console.log('\nThe real graph, 86.8 GFLOP a patch, warm:')
  for (const ep of providers) {
    const mine = timings.filter((one) => one.ep === ep)
    if (mine.length === 0) continue
    const patches = mine.reduce((n, one) => n + one.patches, 0)
    const each = mine.reduce((ms, one) => ms + one.warm, 0) / patches
    console.log(
      `  ${ep.padEnd(7)} ${each.toFixed(0).padStart(5)} ms a patch over ${patches} real patches` +
        `   → ${((each * 114) / 1000).toFixed(0)} s for an average tip (114 patches)`,
    )
  }
  const cast = timings.reduce((ms, one) => ms + one.cast, 0) / timings.reduce((n, one) => n + one.patches, 0)
  console.log(
    `  for scale: onnxruntime native CPU on this machine is 200 ms a patch, ~23 s a tip.\n` +
      `  widening the labels to float32 costs ${cast.toFixed(0)} ms a patch, outside the graph.`,
  )
}

if (shapes) {
  const got = await runShapes(seeds[0])
  console.log(`\nThroughput, one list of ${got.patches} patches on WebGPU:`)
  for (const one of got.batches) {
    console.log(
      `  batch ${String(one.size).padStart(2)}  ${(one.ms / one.done).toFixed(0).padStart(5)} ms a patch` +
        `   (${one.done} patches in ${(one.ms / 1000).toFixed(1)} s)`,
    )
  }
  for (const one of got.parallel) {
    if (one.failed) {
      console.log(`  ${one.ways} sessions at once  REFUSED — ${one.failed}`)
      continue
    }
    console.log(
      `  ${one.ways} session${one.ways > 1 ? 's' : ' '} at once  ` +
        `${(one.ms / one.done).toFixed(0).padStart(5)} ms a patch   ` +
        `(${one.done} patches in ${(one.ms / 1000).toFixed(1)} s; ` +
        `strictly in turn ${(one.inTurn / 1000).toFixed(1)} s)`,
    )
  }
}

stop()
await close()
report.finish()
