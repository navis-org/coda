#!/usr/bin/env node
/**
 * That nothing in this pack costs the assessor its patch time.
 *
 *   pnpm dev --port 5191            (in another terminal)
 *   pnpm probe:assessor-gap
 *
 * ## What it was built for, and what it found
 *
 * `pnpm probe:gpu-assessor` ran the hand-written WebGPU assessor at **26.3 ms a patch** on a
 * bare page while `seam:findMergeCandidates` measured **98** — same laptop, same GPU, same
 * `openGpuAssessor`, same worker. Five explanations had already been eliminated by measurement
 * (the Pyodide handover, the hardware, the patch copy, the float32 conversion, a 3D viewer on
 * the canvas) and the two pages differed in too many ways at once for a sixth guess to be worth
 * anything.
 *
 * So this takes them apart: the **same loop at every rung**, one ingredient changed between
 * them, all in one browser so the rungs compare against each other rather than against a figure
 * in a document. Every rung came back within a few milliseconds of bare. The answer was the
 * **browser** — 27 ms a patch in Chrome against 98 in Firefox, which `slowGpuDispatch` in
 * `src/ml/support.ts` now records.
 *
 * ## So it is a regression test now, not a hunt
 *
 * The property it asserts is the finding: no ingredient of a run costs the assessor more than
 * `TOLERATED_MS` a patch over bare. A rung that starts costing real time is this pack taking on
 * a cost that was shown not to be there.
 *
 * Two rungs are expected to move and are excluded by name, because they are physics rather than
 * this pack: a GPU idled five seconds between bursts comes back slower (last fifth 37-40 ms
 * against a 26 best), and four minutes of unbroken work sits near 30. Clock ramp and heat.
 *
 * **It can only ever run in Chrome**, which is worth knowing before reading a result as a
 * general claim: `launchChrome` speaks CDP and `scripts/lib/browserProbe.mjs` has no Firefox
 * path, so the browser half of the finding rests on the node's own `runClock` read in both,
 * not on this.
 *
 * ## The ingredients, and the one reading that splits the answer
 *
 * The things a run has and a bare page does not: a Pyodide worker holding a labelled box of the
 * run's own size, that box being cut from one group ahead, `Chunk cache`'s bytes held and
 * touched, a main thread blocked half the time, a page repainting every frame.
 *
 * Beside every rung a second loop pings the worker with `session.release()`, which the
 * hand-written worker answers immediately. The worker's `onmessage` is `async` and parks on
 * `network.score`, so a ping sent during a run is **not** queued behind it: it is answered while
 * the GPU works. That makes the pair decisive. Runs slowing while pings do not puts the cost
 * inside `network.score`; both slowing together puts it on the main thread or in the worker's
 * event loop, where no change to the network would touch it.
 *
 * The box is synthetic and so are the patches: a convolution's cost does not depend on what is
 * in the voxels, and a real box would drag a CAVE token, a bucket read and an hour of waiting
 * into a measurement about scheduling. The box's *size* is real — `PATCH_REACH_NM` around a
 * four-micrometre spread of contacts, which is the 13.5 M voxels a measured run reads.
 *
 * Reads only. The weights are mirrored once into the work directory and served from there, so a
 * re-run neither re-downloads 133 MB nor touches the lab host (SEAM's invariant 8).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'
import { serveOrtPage } from './lib/ortPage.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5191/'
const published =
  args.value('--manifest') ??
  'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-n3-mal-mask-s0/manifest.json'
const patches = Number(args.value('--patches') ?? 60)
const only = args.value('--only')
/** `Chunk cache`'s own default, in megabytes — the bytes a measured run is holding. */
const cacheMb = Number(args.value('--cache-mb') ?? 512)
/** How far apart a tip's contacts are, in micrometres: what sizes the box the run reads. */
const spreadUm = Number(args.value('--spread-um') ?? 4)
/**
 * How long the sustained rung runs, in seconds. `0` leaves it out.
 *
 * Three minutes by default, which is long enough for a laptop to get warm and short enough that
 * the whole ladder is under ten. A measured run of this node lasts eight or nine minutes, so
 * `--sustained 540` is the faithful one when the question is thermal.
 */
const sustained = Number(args.value('--sustained') ?? 180)
/**
 * Drop the three GPU flags.
 *
 * One of the differences between the two pages is that the probe's Chrome is launched with
 * `--use-angle=metal --enable-gpu --enable-unsafe-webgpu` and the reader's own browser is not.
 * It is a cheap thing to rule in or out and an expensive thing to argue about.
 */
const plain = args.all.includes('--plain')

/**
 * How much an ingredient may cost the assessor before it is a finding, in milliseconds a patch.
 *
 * Seven. On Chrome the whole ladder sits within that of bare — the costliest, all three
 * ingredients at once, was about six — and the thing this guards against is a real cost
 * appearing, not the two or three milliseconds that separate one run from the next.
 */
const TOLERATED_MS = 7

const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-assessor-gap')
mkdirSync(WORK, { recursive: true })

/*
 * The model, mirrored once.
 *
 * Not fetched from the lab host per run: it is 133 MB, the profile is wiped on every launch so
 * the browser's verified cache never survives, and SEAM's invariant 8 is about exactly this —
 * cache every response, the servers are shared. The manifest's own `bytes` is what says the
 * mirror is complete, so a half-written file from an interrupted run is re-fetched rather than
 * served as a truncated model.
 */
const manifestFile = join(WORK, 'manifest.json')
if (!existsSync(manifestFile)) {
  const answer = await fetch(published)
  if (!answer.ok) {
    console.error(`${published}: ${answer.status}`)
    process.exit(2)
  }
  writeFileSync(manifestFile, JSON.stringify(await answer.json()))
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const conv = manifest.files.find((file) => file.variant === 'conv')
if (!conv) {
  console.error(`${published} has no conv build, which is the one the hand-written assessor reads`)
  process.exit(2)
}
const weights = join(WORK, conv.file)
if (!existsSync(weights) || statSync(weights).size !== conv.bytes) {
  const from = conv.url ?? new URL(conv.file, published).toString()
  process.stdout.write(`mirroring ${(conv.bytes / 1e6).toFixed(0)} MB of weights… `)
  const answer = await fetch(from)
  if (!answer.ok) {
    console.error(`${from}: ${answer.status}`)
    process.exit(2)
  }
  writeFileSync(weights, Buffer.from(await answer.arrayBuffer()))
  console.log('done')
}

const { base: models, stop } = await serveOrtPage({ title: 'assessor gap', dirs: { '/': WORK } })
/*
 * Only the `conv` entry is pointed at the mirror. The others keep the urls they were published
 * with and are never fetched — `openGpuAssessor` pins its variant — and dropping them would
 * change what `loadManifest` checks rather than only where one file comes from.
 */
const served = {
  ...manifest,
  files: manifest.files.map((file) =>
    file.variant === 'conv'
      ? { ...file, url: `${models}/${file.file}` }
      : { ...file, url: file.url ?? new URL(file.file, published).toString() },
  ),
}
writeFileSync(join(WORK, 'served.json'), JSON.stringify(served))

/**
 * The ladder: one line each, changing one thing from the line before where it can.
 *
 * Two halves. The first is the probe's own loop with one ingredient added at a time, which
 * answers "does this ingredient slow the assessor at all". The second is the run's loop —
 * `scoreCandidates` over a held box, cutting one group ahead — with the same ingredients on top,
 * which answers "does it slow *this* loop", since the two differ in how much slack they have.
 */
const LADDER = [
  { name: 'bare', loop: 'simple', with: [] },
  { name: 'bare + memory', loop: 'simple', with: ['memory'] },
  { name: 'bare + busy main thread', loop: 'simple', with: ['busy'] },
  { name: 'bare + painting page', loop: 'simple', with: ['paint'] },
  { name: 'bare + a held box', loop: 'simple', with: ['box'] },
  { name: 'the run’s loop', loop: 'real', with: [] },
  { name: '… + memory', loop: 'real', with: ['memory'] },
  { name: '… + busy main thread', loop: 'real', with: ['busy'] },
  { name: '… + painting page', loop: 'real', with: ['paint'] },
  { name: '… + all three', loop: 'real', with: ['memory', 'busy', 'paint'] },
  /*
   * **The run's rhythm, which is the half of it no software ingredient can stand in for.**
   *
   * An end is about five seconds of reading and five of scoring, so the GPU is idle half the
   * time in bursts of seconds — and a laptop's GPU does not hold its clocks through that. The
   * probe scores back to back and would never see it. These two put the gaps back, on each
   * loop, so a rhythm effect can be told from a loop effect.
   */
  { name: 'bare, in bursts', loop: 'simple', with: [], passes: 8, idleMs: 5000 },
  { name: 'the run’s rhythm', loop: 'real', with: [], passes: 8, idleMs: 5000 },
]
if (sustained > 0) {
  /*
   * **Heat.** Every reading taken so far is a minute of GPU at most; a measured run is eight or
   * nine, on a laptop, with a Pyodide worker and the network going the whole time. A machine
   * that throttles would look exactly like this — every patch slower, no trend inside a run,
   * because by the time anybody measures it is already throttled.
   */
  LADDER.push({ name: `${sustained} s without stopping`, loop: 'real', with: [], seconds: sustained })
}
const ladder = only ? LADDER.filter((rung) => rung.name.includes(only)) : LADDER
if (ladder.length === 0) {
  console.error(`--only ${only} matches no rung. They are:\n  ${LADDER.map((r) => r.name).join('\n  ')}`)
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({
  port: 9361,
  // Chrome is killed on any exit, a throw included (`launchChrome`); the server goes with the
  // process.
  profile: join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-assessor-gap-profile'),
  args: plain ? [] : ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
})
await send('Page.navigate', { url })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

const measured = await evaluate(
  `(${pageSide})(${JSON.stringify({
    manifestUrl: `${models}/served.json`,
    task: manifest.task,
    patches,
    cacheMb,
    spreadUm,
    ladder,
  })}, ${APP_MODULE})`,
  3_600_000,
)

// ── The table ────────────────────────────────────────────────────────────────────────────────
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
console.log(
  `\ndevice: ${measured.adapter}; Chrome ${plain ? 'with no GPU flags' : 'with --use-angle=metal --enable-gpu --enable-unsafe-webgpu'}`,
)
console.log(`box: ${measured.box.size.join('×')} voxels = ${(measured.box.voxels / 1e6).toFixed(1)} M, ${measured.box.present} candidates present\n`)
/*
 * **`runClock`'s own four numbers**, so a rung reads against what the node printed on the
 * reader's machine rather than having to be converted first. Best and median together say
 * whether the slow calls are most of them or a tail; the first and last fifths say whether it
 * gets worse as the rung goes on, which is what heat looks like and nothing else does.
 */
const shape = (ms) => {
  const fifth = Math.max(1, Math.floor(ms.length / 5))
  const mean = (of) => of.reduce((a, b) => a + b, 0) / of.length
  return { first: mean(ms.slice(0, fifth)), last: mean(ms.slice(-fifth)) }
}
/*
 * **The rows built once**, so the table and the verdict below cannot disagree about which rung
 * was worst or by how much. Two passes over the same numbers by two routes is how a printed
 * table and a printed conclusion come to say different things.
 */
/**
 * **`runClock`'s own four numbers**, so a rung reads against what the node printed on the
 * reader's machine rather than having to be converted first. Best and median together say
 * whether the slow calls are most of them or a tail; the first and last fifths say whether it
 * gets worse as the rung goes on, which is what heat looks like and nothing else does.
 */
const rows = measured.rungs.map((rung) => ({
  ...rung,
  mid: median(rung.ms),
  best: Math.min(...rung.ms),
  ping: rung.ping.length ? median(rung.ping) : undefined,
  ...shape(rung.ms),
}))
/*
 * The bare rung **by name**, not the first one measured: `--only` runs a subset, and a ladder
 * whose first line is "… + busy main thread" would print every delta against that and call the
 * costliest rung's excess over it the gap. A missing control prints no deltas rather than wrong
 * ones, and skips the verdict.
 */
const control = rows.find((row) => row.name === 'bare')

console.log(
  `  ${'rung'.padEnd(26)} ${'n'.padStart(5)} ${'best'.padStart(6)} ${'median'.padStart(7)} ` +
    `${'first'.padStart(6)} ${'last'.padStart(6)}   ${'ping'.padStart(5)}   vs bare`,
)
for (const row of rows) {
  const against = control ? `${row.mid - control.mid >= 0 ? '+' : ''}${(row.mid - control.mid).toFixed(1)}` : ''
  console.log(
    `  ${row.name.padEnd(26)} ${String(row.ms.length).padStart(5)} ${row.best.toFixed(1).padStart(6)} ` +
      `${row.mid.toFixed(1).padStart(7)} ${row.first.toFixed(1).padStart(6)} ${row.last.toFixed(1).padStart(6)}   ` +
      `${(row.ping === undefined ? '\u2014' : row.ping.toFixed(1)).padStart(5)}   ${against.padStart(7)}`,
  )
}

/*
 * The reading said in words rather than left to be read off the table — a probe whose
 * conclusion is "look at the numbers" is one whose next reader reaches a different conclusion
 * from the same run.
 */
if (control) {
  /*
   * **The rungs that are physics, not this pack.** A GPU idled between bursts comes back
   * slower and a laptop under sustained load throttles; both were measured here (last fifth
   * 37-40 against a 26 best, and ~30 over four minutes) and neither is something the node can
   * do anything about. Excluded by name so the property below is about the ingredients.
   */
  const PHYSICS = ['in bursts', 'rhythm', 'without stopping']
  const ingredients = rows.filter((row) => !PHYSICS.some((what) => row.name.includes(what)))
  const worst = ingredients.reduce((a, b) => (b.mid > a.mid ? b : a))
  const gap = worst.mid - control.mid
  console.log(
    `\nthe costliest ingredient is \u201c${worst.name}\u201d, ${gap.toFixed(1)} ms a patch above bare` +
      (worst.ping !== undefined && control.ping !== undefined
        ? `, with pings at ${worst.ping.toFixed(1)} ms against bare\u2019s ${control.ping.toFixed(1)}`
        : ''),
  )
  if (gap > TOLERATED_MS && worst.ping !== undefined && control.ping !== undefined) {
    console.log(
      worst.ping - control.ping > gap / 2
        ? '  \u2014 the round trip slowed with the patches, so the cost is the main thread or the\n' +
            '    worker\u2019s event loop, and no change to the network would touch it.'
        : '  \u2014 the round trip did not slow, so the time is inside `network.score`: the GPU\n' +
            '    itself, or whatever is sharing it.',
    )
  }
  /*
   * **The finding, as a property.** Chrome measured every ingredient within a few milliseconds
   * of bare, and the node's own clock then put the run at 27 ms a patch — the probe's own
   * figure. A rung that starts costing real time means this pack has taken on a cost that was
   * shown not to be there.
   */
  report.check(
    gap <= TOLERATED_MS,
    `no ingredient of a run costs the assessor more than ${TOLERATED_MS} ms a patch ` +
      `(worst is ${worst.name} at ${gap.toFixed(1)})`,
  )
}

stop()
await close()
report.finish(
  'An ingredient of a run is now costing the assessor real time, where Chrome measured all of\n' +
    'them within a few milliseconds of bare. Read the ping column first: it says whether the\n' +
    'time is going inside `network.score` or on the main thread. The browser is the one thing\n' +
    'this probe cannot vary — `slowGpuDispatch` in src/ml/support.ts has that measurement.',
)

/*
 * The page's globals, declared because this file is linted with Node's.
 *
 * `pageSide` below is stringified and evaluated in a browser, so it reaches for `document` and
 * the frame callbacks that Node has no business knowing about. Written as a function rather
 * than as a template string — which is what the probes beside it do — so that it is parsed,
 * linted and syntax-highlighted like the rest of the file: a two-hundred-line page-side
 * measurement inside a string is one where a typo is a browser exception at minute nine.
 */
/* global document, requestAnimationFrame, cancelAnimationFrame */

/**
 * Everything that happens in the page.
 *
 * It closes over nothing — `opts` and `load` are its whole world — because it is stringified and
 * evaluated in a browser that has never seen this file.
 */
function pageSide(opts, load) {
  return (async () => {
    const [gpuOpen, modelling, bridge, scoring, geometry, ml] = await Promise.all([
      load('/src/packs/seam/gpuAssessor/open.ts'),
      load('/src/packs/seam/assessorModel.ts'),
      load('/src/pyodide/assessorPatches.ts'),
      load('/src/packs/seam/assessorRun.ts'),
      load('/src/packs/seam/patchBox.ts'),
      load('/src/ml/manifest.ts'),
    ])
    const session = await gpuOpen.openGpuAssessor({
      manifestUrl: opts.manifestUrl,
      task: opts.task,
    })
    const { manifest } = session.loaded
    const config = modelling.parseAssessorConfig(manifest.config, manifest.id)
    const { part, signature } = ml.soleGraph(manifest)
    const input = signature.inputs[0]
    const output = signature.outputs[0]
    const edge = geometry.PATCH_VOXELS
    const voxels = edge ** 3

    const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))

    /*
     * The box the run reads, in size if not in content: `PATCH_REACH_NM` each side of a cluster
     * of contacts `spreadUm` across, at the only scale a patch may be cut from. A measured run
     * of this node reads 13.6 M voxels a tip, which four micrometres of spread reproduces.
     */
    const half = geometry.PATCH_REACH_NM + (opts.spreadUm * 1000) / 2
    const res = [geometry.PATCH_NM, geometry.PATCH_NM, 45]
    const size = res.map((nm) => Math.ceil((2 * half) / nm))
    const boxVoxels = size[0] * size[1] * size[2]
    /*
     * A thousand supervoxels per candidate, blocked eight voxels across so the index has the
     * spatial coherence a real cutout's has — what `label_box` streams and what `lut[small]`
     * gathers both depend on it, and noise per voxel would price the cut differently.
     */
    const supervoxels = 4096
    const candidates = opts.patches
    const queryRoot = 7n
    const candRoots = BigUint64Array.from({ length: candidates }, (_, i) => BigInt(100 + i))
    const roots = new BigUint64Array(supervoxels)
    for (let i = 0; i < supervoxels; i++) {
      const slot = i % (candidates + 1)
      roots[i] = slot === 0 ? queryRoot : candRoots[slot - 1]
    }
    const labels = BigUint64Array.from({ length: supervoxels }, (_, i) => BigInt(i + 1))
    const centresNm = new Float64Array(3 * candidates)
    for (let i = 0; i < candidates; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const middle = (size[axis] * res[axis]) / 2
        centresNm[3 * i + axis] = middle + ((((i * 2654435761) >>> (8 * axis)) % 1000) / 1000 - 0.5) * opts.spreadUm * 1000
      }
    }
    /*
     * Rebuilt per rung, not kept: `callPython` transfers every view it is handed, so the index
     * that opened one box is detached and cannot open the next.
     */
    const buildIndex = () => {
      const [sx, sy, sz] = size
      const bx = Math.ceil(sx / 8)
      const by = Math.ceil(sy / 8)
      const blocks = new Uint16Array(bx * by * Math.ceil(sz / 8))
      let seed = 1
      for (let i = 0; i < blocks.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        blocks[i] = seed % supervoxels
      }
      const index = new Uint16Array(boxVoxels)
      let at = 0
      for (let z = 0; z < sz; z++) {
        for (let y = 0; y < sy; y++) {
          const row = ((z >> 3) * by + (y >> 3)) * bx
          for (let x = 0; x < sx; x++) index[at++] = blocks[row + (x >> 3)]
        }
      }
      return index
    }
    const boxRequest = () => ({
      labels: BigUint64Array.from(labels),
      index: buildIndex(),
      size,
      roots: BigUint64Array.from(roots),
      queryRoot,
      resolutionNm: res,
      loVoxels: [0, 0, 0],
      candRoots: BigUint64Array.from(candRoots),
      centresNm: Float64Array.from(centresNm),
    })

    // ── The ingredients ───────────────────────────────────────────────────────────────────────
    //
    // Each starts something and hands back the way to stop it, so a rung cannot leave one
    // running into the next — which is the failure that would make every later rung agree.

    const ingredients = {
      /** `Chunk cache`'s bytes, in the three-megabyte pieces it actually holds, each touched. */
      memory() {
        const chunks = []
        const piece = 3 * 1024 * 1024
        for (let held = 0; held < opts.cacheMb * 1024 * 1024; held += piece) {
          const buffer = new ArrayBuffer(piece)
          // Touched, or the pages are never committed and the browser is holding an address
          // range rather than any memory.
          new Uint8Array(buffer).fill(1)
          chunks.push(buffer)
        }
        return () => {
          chunks.length = 0
        }
      },
      /**
       * The main thread blocked about half the time, in slices the length of a frame.
       *
       * Where `scoreCandidates` itself runs, and where both ends of every round trip to the
       * worker are handled — so this is the ingredient that would inflate runs and pings alike.
       */
      busy() {
        let stopped = false
        const slice = 8
        const tick = () => {
          if (stopped) return
          const until = performance.now() + slice
          while (performance.now() < until) {
            /* deliberately blocking */
          }
          setTimeout(tick, slice)
        }
        tick()
        return () => {
          stopped = true
        }
      },
      /** A page that lays out, paints and composites every frame, on the same GPU. */
      paint() {
        const host = document.createElement('div')
        host.style.cssText =
          'position:fixed;inset:0;z-index:99999;pointer-events:none;display:flex;flex-wrap:wrap'
        for (let i = 0; i < 400; i++) {
          const cell = document.createElement('div')
          cell.style.cssText = 'width:40px;height:40px;background:#345'
          host.append(cell)
        }
        document.body.append(host)
        let frame = 0
        let raf = 0
        const draw = () => {
          frame++
          for (let i = 0; i < host.children.length; i++) {
            const cell = host.children[i]
            cell.style.background = `hsl(${(frame * 3 + i) % 360} 50% 40%)`
            cell.style.width = `${30 + ((frame + i) % 20)}px`
          }
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        return () => {
          cancelAnimationFrame(raf)
          host.remove()
        }
      },
      /**
       * Pyodide booted, with a labelled box of the run's own size held and nothing cutting it.
       *
       * The resident state of a run between cuts: the worker alive, the vendored code loaded,
       * eleven megabytes of labels in a wasm heap that never shrinks.
       */
      async box() {
        const opened = await bridge.openAssessorBox(boxRequest())
        return () => void bridge.closeAssessorBox(opened.id).catch(() => {})
      },
    }

    // ── The two loops ─────────────────────────────────────────────────────────────────────────

    /** One float32 patch, allocated per call because `session.run` transfers what it is fed. */
    const patchFrom = (group, k) =>
      new Float32Array(group.subarray(k * voxels, (k + 1) * voxels))

    /**
     * The probe's loop: patches out of a group buffer, one `session.run` each.
     *
     * The answer is read rather than dropped, because the loop it is being compared against
     * reads it — a float out of a transferred buffer is nothing, but a rung that differs from
     * its control in two ways answers neither question.
     */
    async function simple(ms) {
      for (let i = 0; i < opts.patches; i++) {
        const patch = patchFrom(group, i % scoring.PATCH_GROUP)
        const at = performance.now()
        const answered = await session.run({
          part,
          feeds: [{ name: input, type: 'float32', dims: [1, edge, edge, edge], data: patch.buffer }],
        })
        ms.push(performance.now() - at)
        const got = answered.find((one) => one.name === output)
        if (!got) throw new Error(`the assessor returned no ${output}`)
        void new Float32Array(got.data)[0]
      }
    }

    /**
     * The run's loop: `scoreCandidates` itself, over a held box, cutting one group ahead.
     *
     * The session is wrapped exactly as `assessSteps` wraps it, so what is timed is what the
     * node's own clock times and the two numbers can be put side by side.
     */
    async function real(ms) {
      const timed = {
        loaded: session.loaded,
        run: async (request) => {
          const at = performance.now()
          try {
            return await session.run(request)
          } finally {
            ms.push(performance.now() - at)
          }
        },
      }
      await bridge.useAssessorBox(boxRequest(), (open) =>
        scoring.scoreCandidates(timed, config, open),
      )
    }

    // ── The ladder ────────────────────────────────────────────────────────────────────────────

    const group = new Uint8Array(scoring.PATCH_GROUP * voxels)
    for (let i = 0; i < group.length; i++) group[i] = i % 3

    const rungs = []
    for (const rung of opts.ladder) {
      const stops = []
      for (const name of rung.with) stops.push(await ingredients[name]())
      // A moment for the ingredients to reach a steady state, and for whatever the last rung
      // left behind to be collected: the first patches of a rung are otherwise measuring the
      // rung before it.
      await sleep(1000)

      const ms = []
      const ping = []
      let pinging = true
      const pings = (async () => {
        while (pinging) {
          const at = performance.now()
          await session.release()
          ping.push(performance.now() - at)
          await sleep(50)
        }
      })()

      // A warm pass first, discarded: the first call of a rung pays whatever the change cost.
      const loop = rung.loop === 'real' ? real : simple
      await loop([])
      /*
       * **Passes, gaps and a floor on the duration, so a rung can have a rhythm.** A rung that
       * only ever scores back to back cannot see what a GPU does between bursts, and one that
       * stops after a minute cannot see what a laptop does after five.
       */
      const until = performance.now() + (rung.seconds ?? 0) * 1000
      for (let pass = 0; pass < (rung.passes ?? 1) || performance.now() < until; pass++) {
        if (pass > 0 && rung.idleMs) await sleep(rung.idleMs)
        await loop(ms)
      }

      pinging = false
      await pings
      for (const stopIt of stops.reverse()) await stopIt()
      rungs.push({ name: rung.name, ms, ping })
    }

    /* The box, measured once at the end rather than claimed: its voxel count and how many
     * candidates it can actually answer for are what say the synthetic box is the run's size. */
    const opened = await bridge.openAssessorBox(boxRequest())
    const box = { size, voxels: opened.boxVoxels, present: opened.present.length }
    await bridge.closeAssessorBox(opened.id)

    await session.close()
    const gpu = await navigator.gpu?.requestAdapter()
    return {
      rungs,
      box,
      adapter: gpu?.info?.description || gpu?.info?.vendor || 'unknown',
    }
  })()
}
