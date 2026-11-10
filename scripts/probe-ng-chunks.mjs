/**
 * Does rapid camera movement leave neuroglancer's image layer unloaded?
 *
 * Reported from the review card: clicking through merge candidates, the EM sometimes does not
 * fill in — all of it, or part of it, or only a coarse mip — and only a reload fixes it, at the
 * place it was reloaded. Going quickly makes it likelier. The card moves the camera with
 * `coda:ng-set-view`, so the first question is whether that is doing something wrong or whether
 * the viewer is losing requests on its own.
 *
 * ## What it measures
 *
 * The frame is Coda's own neuroglancer on an EM layer alone — no segmentation, so no CAVE
 * credential and nothing in the picture but the thing that fails. The camera is then moved
 * through real contact points from the Aedes suggestion set, at a chosen interval, while the
 * DevTools network domain counts every request the viewer makes: finished, failed, and **still
 * pending** when the dust has settled.
 *
 * A request that is never finished and never failed is the shape of this symptom: a tile that
 * was asked for and never arrived leaves a hole no later frame fills, because as far as the
 * chunk queue is concerned it is already on its way.
 *
 * The volume is **sharded**, which is why this is worth measuring rather than assuming. A chunk
 * is not one fetch: the shard index comes first, then the minishard index, then the data, and a
 * jump to a new part of the brain needs all three before a single tile can be drawn. Interrupt
 * that often enough and the question is whether the queue recovers.
 *
 * Usage: `pnpm dev --port 5178`, then `pnpm probe:ng-chunks` — or `--interval 2000` to compare
 * a reader working slowly with one working fast (`--interval 250`).
 */

import {
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  probeReport,
  readCaveToken,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const interval = Number(args.value('--interval') ?? 400)
const moves = Number(args.value('--moves') ?? 12)
const settle = Number(args.value('--settle') ?? 15000)
if (!Number.isFinite(interval) || !Number.isFinite(moves)) {
  console.error('--interval and --moves are milliseconds and a count')
  process.exit(2)
}

/**
 * The datastack whose published scene is driven.
 *
 * The **published** scene rather than one written here, and that is not fussiness: a scene
 * assembled by hand from the same source URL fetched its `info` and then asked for nothing at
 * all — a layer is more than its address, and a test built on one that never loads a tile
 * measures nothing. This is the scene the card actually opens.
 */
const DATASTACK = args.value('--datastack') ?? 'wclee_aedes_brain'

/**
 * Real shown suggestions from the published set: the neuron, the candidate, and where they touch
 * in scene units.
 *
 * Real rather than random because the distances between them are the thing under test — a queue
 * sorted by confidence walks across the whole brain, so consecutive items rarely share a shard —
 * and because **the meshes matter**. Every click changes which two segments are drawn, so the
 * graphene layer fetches two new meshes into the same hundred-item download queue the EM is
 * using. A probe that moved only the camera was missing half the traffic, and found nothing.
 */
const ITEMS = [
  ['648518347558097460', '648518347649141735', [26564, 22269, 2078.5]],
  ['648518347558097460', '648518347557687653', [26984, 20571, 1952.5]],
  ['648518347558097460', '648518347574035646', [23045, 24102, 2044.5]],
  ['648518347558097460', '648518347517147507', [20413, 18276, 4902.5]],
  ['648518347686959617', '648518347672041697', [16171, 12546, 6498.0]],
  ['648518347669157986', '648518347663416610', [40653, 16064, 2365.5]],
  ['648518347669157986', '648518347502180449', [36356, 16885, 935.5]],
  ['648518347558097460', '648518347493951853', [25086, 19189, 4184.5]],
  ['648518347558097460', '648518347390397583', [24602, 17205, 5138.5]],
  ['648518347669157986', '648518347506551099', [40539, 15718, 3256.5]],
]

const VOXEL = [16, 16, 45]
const WIDTH = 15000 / Math.max(...VOXEL)

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-ng-chunks'
const token = readCaveToken()
if (!token) {
  console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, screenshot, close } = await launchChrome({
  port: 9353,
  profile: PROFILE,
})
deleteProfileOnExit(PROFILE, close)

/*
 * **The picture, not the network.** Neuroglancer fetches its chunks in a *worker*, so the page's
 * own network domain sees none of them — the first attempt at this counted zero requests while
 * the EM was loading perfectly, which is the kind of measurement that reads as a finding. What
 * can be seen from here is what the reader sees: how much of the section panel is black.
 *
 * What that looks like is **not** blackness. Neuroglancer draws the coarsest mip it has while
 * the finer ones are on their way, and at this zoom that is a grid of flat grey blocks — one
 * colour per chunk, boundaries visible, no structure. A darkness measure calls that a perfectly
 * good picture. `scripts/lib/detail.py` measures local variation instead, which separates real
 * EM from flat blocks by an order of magnitude.
 */
/* The app first, only to hand over the token: the frame reads it from this origin's storage. */
await send('Page.navigate', { url: 'http://localhost:5178/' })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')
if (!(await handCaveToken(send, token))) {
  console.error('the page did not take the CAVE token')
  process.exit(2)
}
await send('Page.reload')
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

const scene = await evaluate(
  `(async () => {
    const load = ${APP_MODULE}
    const [builtins, registry, specMod, stackMod] = await Promise.all([
      load('/src/data/builtins.ts'), load('/src/data/source.ts'),
      load('/src/data/cave/spec.ts'), load('/src/data/cave/datastack.ts'),
    ])
    builtins.registerBuiltinSources()
    const name = ${JSON.stringify(DATASTACK)}
    if (!specMod.shippedSpecFor(undefined, name)) {
      specMod.registerDatastackSpec({ datastack: name, label: name, description: 'probe' })
    }
    const versions = await stackMod.materializationsFor(name, {})
    const datasetId = specMod.datasetIdFor(name, Math.max(...versions))
    return await registry.getSource('cave').fetchViewerScene({ datasetId })
  })()`,
  300000,
)

await send('Page.navigate', {
  url: `http://localhost:5178/neuroglancer.html#!${encodeURIComponent(
    JSON.stringify({ ...scene, layout: 'xy-3d' }),
  )}`,
})
await waitFor('Boolean(document.querySelector("canvas"))', 'the viewer')
/** The segmentation layer's name in the published scene — what a set-segments message names. */
const SEGMENT_LAYER = DATASTACK
// The opening load is nobody's measurement, and a look at it is how we know the EM draws at
// all — a probe measuring an empty viewer measures nothing, which is how the first two went.
await evaluate('new Promise((r) => setTimeout(() => r(true), 12000))', 60000)
console.log(`opened: ${await screenshot('ng-chunks-opened')}`)

const items = ITEMS.slice(0, moves)
console.log(`working through ${items.length} suggestions every ${interval} ms…`)
const shots = []
for (const [i, [neuron, candidate, at]] of items.entries()) {
  await evaluate(
    `(async () => {
      // Exactly what the card sends, in the order it sends it: the segments in place, then the
      // camera. Two messages, one click.
      window.postMessage(
        {
          type: 'coda:ng-set-segments',
          layers: [{
            name: ${JSON.stringify(SEGMENT_LAYER)},
            segments: [${JSON.stringify(neuron)}, ${JSON.stringify(candidate)}],
            segmentColors: {},
          }],
          update: ${i + 2},
        },
        location.origin,
      )
      window.postMessage(
        { type: 'coda:ng-set-view', position: ${JSON.stringify(at)}, width: ${WIDTH} },
        location.origin,
      )
      await new Promise((r) => setTimeout(r, ${interval}))
      return true
    })()`,
    interval + 60000,
  )
  shots.push(await screenshot(`ng-chunks-${String(i).padStart(2, '0')}`))
}
/*
 * Then stand still, which is what a reader does when they stop to look — and the state that
 * matters: a hole still there after the queue has had every chance is a hole that will not fill.
 */
await evaluate(`new Promise((r) => setTimeout(() => r(true), ${settle}))`, settle + 60000)
shots.push(await screenshot('ng-chunks-settled'))
console.log(shots.join('\n'))

console.log(
  `\nHow much detail each shot is showing — a coarse mip is flat grey blocks:\n` +
    `  python3 -I scripts/lib/detail.py ${shots.join(' ')}`,
)
report.check(shots.length === items.length + 1, `${shots.length} shots kept`)
await close()
report.finish('is `pnpm dev --port 5178` running?')
