/**
 * The point cloud `probe:affinity-backend` measures on — built by the pack, not by the probe.
 *
 * The backend probe is a `.mjs` driving ONNX Runtime in a browser, so it cannot import the pack's
 * TypeScript. Its first version minted its own input instead: uniform noise in a ±1 box. Both
 * halves of that were wrong, and in ways that go straight to its headline number.
 *
 *  - **The scale.** A real cloud is divided by `globalScale` (659.88 µm), so a 300 µm neuron
 *    lands at about ±0.23. ±1 is four times that — and the coordinate is what multiplies the
 *    Fourier frequencies, which is the exact quantity the fp16 failure being hunted is about.
 *  - **The shape.** A neuron is a branching arbour; uniform noise in a box is the one thing it
 *    never is. The probe's headline is the share of pairs whose decision crosses the clustering
 *    cut, and that is decided by where the affinity mass sits relative to the cut — a property of
 *    the input, not of the kernel. A cloud with no pairs near the cut reports nothing wrong
 *    however wrong the kernel is.
 *
 * So the cloud comes from `pointCloud()`, the same function the node uses, over a branching
 * skeleton. This is the two-half shape `probe:affinity-parity` already uses, and for the same
 * reason: the measurement has to be of the thing the product computes.
 *
 * Written as JSON with the `globalScale` it was built at, which the `.mjs` half checks against the
 * manifest it is probing — a cloud built for another checkpoint would silently be off-scale again.
 *
 * `pnpm probe:affinity-backend` runs this, then the browser half.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { seededRandom } from '../src/nodes/lib/tableOps'
import { parseAffinityConfig } from '../src/packs/seam/affinityConfig'
import { DEFAULT_SEED, pointCloud } from '../src/packs/seam/pointCloud'

const OUT = process.argv[2] ?? '/tmp/coda-affinity-cloud.json'
const POINTS = Number(process.argv[3] ?? 1024)
// Checked here rather than left to fail in the browser half, where a zero-length cloud surfaces
// as an ONNX Runtime error naming neither this script nor the argument that caused it.
if (!Number.isInteger(POINTS) || POINTS < 1) {
  console.error(`points must be a positive whole number, not ${process.argv[3]}`)
  process.exit(2)
}

const checkpoints = JSON.parse(readFileSync('scripts/affinity-checkpoints.json', 'utf8')) as {
  checkpoints: Record<string, { config: unknown }>
}
/**
 * Which checkpoint's constants to build for. An argument rather than a constant because the
 * backend probe refuses a cloud whose `globalScale` differs from the model it is probing, and
 * tells you to rebuild — advice that goes nowhere if the rebuild cannot be pointed at another
 * checkpoint. Dormant today: all three published checkpoints share 659.88367.
 */
const MODEL = process.argv[4] ?? 'affinity-flywire'
const entry = checkpoints.checkpoints[MODEL]
if (!entry) {
  console.error(
    `${MODEL} is not in scripts/affinity-checkpoints.json; it has ` +
      `${Object.keys(checkpoints.checkpoints).join(', ')}`,
  )
  process.exit(2)
}
const config = parseAffinityConfig(entry.config, MODEL)

/**
 * A branching arbour in nanometres: a random walk that sprouts side branches, over the extent of
 * a fly neuron. Not a real skeleton — the point is a cloud with the connectivity and the local
 * density of one, rather than a box of noise — and `probe:affinity-parity` is where the
 * preprocessing itself is held to the reference.
 */
function arbour(nodes: number): Float32Array {
  const random = seededRandom(0x5eed)
  const positions = new Float32Array(nodes * 3)
  const heading = new Float32Array(nodes * 3)
  /** Node spacing, nm. */
  const STEP = 2_000
  /** How much of its parent's direction a node keeps. Without this the walk never travels: a
   *  pure random walk of 2,000 × 2 µm steps spans ~20 µm, where a fly neuron spans 100–300. */
  const PERSIST = 0.92
  const tips: number[] = [0]
  for (let k = 0; k < 3; k++) heading[k] = random() * 2 - 1
  for (let i = 1; i < nodes; i++) {
    const from = tips[Math.floor(random() * tips.length)]!
    const at = i * 3
    const parent = from * 3
    let length = 0
    for (let k = 0; k < 3; k++) {
      const d = PERSIST * heading[parent + k]! + (1 - PERSIST) * (random() * 2 - 1)
      heading[at + k] = d
      length += d * d
    }
    length = Math.sqrt(length) || 1
    for (let k = 0; k < 3; k++) {
      heading[at + k] = heading[at + k]! / length
      positions[at + k] = positions[parent + k]! + heading[at + k]! * STEP
    }
    // Mostly extend the tip just grown; occasionally keep the old one too, which is what makes a
    // branch rather than one long walk.
    if (random() < 0.9) tips[tips.indexOf(from)] = i
    else tips.push(i)
  }
  return positions
}

const positions = arbour(2_000)
const cloud = pointCloud(
  { positions },
  { globalScale: config.preprocessing.globalScale, points: POINTS, seed: DEFAULT_SEED },
)
let lo = Infinity
let hi = -Infinity
for (const v of cloud.positions) {
  if (v < lo) lo = v
  if (v > hi) hi = v
}
writeFileSync(
  OUT,
  JSON.stringify({
    points: POINTS,
    globalScale: config.preprocessing.globalScale,
    threshold: config.clustering.threshold,
    extent: [+lo.toFixed(4), +hi.toFixed(4)],
    cloud: [...cloud.positions],
  }) + '\n',
)
console.error(`wrote ${OUT}: ${POINTS} points, extent ${lo.toFixed(3)} to ${hi.toFixed(3)}`)
