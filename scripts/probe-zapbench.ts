/**
 * What a fish2 `zapbenchId` actually is — the one thing about this feature that cannot be
 * derived from the released array.
 *
 * `segmentation/dataframe.json` was checked row by row: the segmentation label is
 * `trace column + 1` for all 71,721 rows, no exceptions. So the two readings of a `zapbenchId`
 * differ by exactly one everywhere, and **both are in range for every id but the two at the
 * ends** — which is what makes this a probe rather than an assertion. Choosing wrongly does not
 * fail; it returns the neighbouring cell's trace, which is a real trace of a real neuron.
 *
 * The observed range does not settle it, and that is the finding rather than a limitation:
 * fish2's ids run 5…71,720, which is a valid column under *both* readings. `max === 71721`
 * would have proved a label and `min === 0` a 0-based index; neither happened, and the top
 * label being one of the 13% of cells nobody matched is entirely ordinary.
 *
 * So the answer comes from **geometry**. Every matched fish2 neuron carries a `somaLocation`,
 * and the released `segmentation/dataframe.json` carries a centroid per label — two descriptions
 * of the same cell in two coordinate frames. Fitting a least-squares affine from one to the
 * other and reading the residual picks the offset out sharply, because ZapBench labels run
 * roughly in `z`: the wrong offset names a *different cell at a similar depth*, so its `x`/`y`
 * residual is large while `z` looks fine.
 *
 * The offset sweep is the control, and it is what makes the result mean anything — without it a
 * single good residual could just as easily be a fit insensitive to the offset. Measured over
 * 20,342 neurons within 5 microns of a registration landmark:
 *
 *   row = id-3   median 1670   p90 3742
 *   row = id-2   median 1473   p90 3465
 *   row = id-1   median  522   p90  814   <- a 2.8x sharper minimum, and unique
 *   row = id     median 1453   p90 3465
 *   row = id+1   median 1656   p90 3719
 *
 * So `zapbenchId` is the **1-based segmentation label** and the trace column is `id - 1`, which
 * is what `ZAPBENCH_ID_BASE = 'label'` encodes.
 *
 *   NEUPRINT_TEST_APPLICATION_CREDENTIALS=… node scripts/probe-zapbench.mjs
 *
 * The token is read from the environment and never printed. Nothing about this deployment is
 * written down beyond its public hostname.
 */

import { quantileSorted } from '../src/core/stats'
import { CHUNK_F, CHUNK_T, BYTES_PER_VALUE } from '../src/data/zapbench/readPlan'
import { TRACE_COLUMNS, TRACE_TIMESTEPS, ZAPBENCH_RELEASE } from '../src/data/zapbench/traces'
import { objectStoreUrl } from '../src/data/precomputed/transport'

const SERVER = 'https://neuprint-fish2.janelia.org'
const DATASET = 'fish2'
/*
 * Imported rather than re-typed. This probe exists to certify the id arithmetic, so a copy of
 * the constants and the offset formula here would be certifying a transcription of the thing
 * under test — the one place a wrong offset still returns a plausible trace.
 */
const TRACES = objectStoreUrl(`${ZAPBENCH_RELEASE}/traces`)

/*
 * Either spelling, because the repo holds both: `data/dvid/live.test.ts` gates on
 * `NEUPRINT_APPLICATION_CREDENTIALS` and authenticates with
 * `NEUPRINT_TEST_APPLICATION_CREDENTIALS`, which is why its two fish2 tests run and then 401.
 * Reading both here means this probe works whichever one a machine has set, rather than
 * picking the half of that pair that happens to be empty.
 */
const ENV_KEYS = ['NEUPRINT_APPLICATION_CREDENTIALS', 'NEUPRINT_TEST_APPLICATION_CREDENTIALS']
const token = ENV_KEYS.map((key) => process.env[key]).find(Boolean)
if (!token) {
  console.error(
    `Set one of ${ENV_KEYS.join(' or ')} to a neuPrint token for ` +
      `${SERVER}. This probe reads one property off fish2 and nothing else.`,
  )
  process.exit(2)
}

/** neuPrint hands back untyped rows; every read here is a number or a string. */
type Row = Array<number | string | null>

async function cypher(query: string): Promise<{ columns: string[]; data: Row[] }> {
  const response = await fetch(`${SERVER}/api/custom/custom`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher: query, dataset: DATASET }),
  })
  if (!response.ok) {
    throw new Error(`${response.status} from neuPrint: ${(await response.text()).slice(0, 300)}`)
  }
  return response.json()
}

/** One value out of the uncompressed zarr chunk, by range request. */
async function traceValue(t: number, f: number): Promise<number> {
  const offset = ((t % CHUNK_T) * CHUNK_F + (f % CHUNK_F)) * BYTES_PER_VALUE
  const url = `${TRACES}/c/${Math.floor(t / CHUNK_T)}/${Math.floor(f / CHUNK_F)}`
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + 3}` } })
  if (response.status !== 206) throw new Error(`${response.status} for ${url}`)
  return new DataView(await response.arrayBuffer()).getFloat32(0, true)
}

/*
 * Printed with `console.error`, the convention `probe-influence.ts` and `zoo-index.ts` follow:
 * this is a report rather than data, and the lint rule allows `warn` and `error` only.
 */
console.error(`# fish2 zapbenchId, against ${SERVER}\n`)

/*
 * Asked as one query rather than four: this walks every neuron, and the point of the probe is
 * one pass over the property rather than four passes to be tidy.
 */
const summary = await cypher(
  `MATCH (n:Neuron) WHERE exists(n.zapbenchId)
   RETURN count(n), min(n.zapbenchId), max(n.zapbenchId), count(DISTINCT n.zapbenchId)`,
)
const head = summary.data[0]!
const [matched, min, max, distinct] = head.map(Number) as [number, number, number, number]
const total = Number((await cypher('MATCH (n:Neuron) RETURN count(n)')).data[0]![0])

console.error(`neurons                : ${total.toLocaleString()}`)
console.error(`carrying a zapbenchId  : ${matched.toLocaleString()}`)
console.error(`distinct ids           : ${distinct.toLocaleString()}`)
console.error(`range                  : ${min} … ${max}`)
console.error(`trace columns published : ${TRACE_COLUMNS.toLocaleString()}\n`)

if (matched === 0) {
  console.error('No neuron carries the property. Check the name against the dataset.')
  process.exit(1)
}

const sample = await cypher(
  `MATCH (n:Neuron) WHERE exists(n.zapbenchId)
   RETURN n.bodyId, n.zapbenchId, n.type ORDER BY n.zapbenchId LIMIT 5`,
)
console.error('sample (bodyId, zapbenchId, type):')
for (const row of sample.data) console.error(`  ${row.join('  ')}`)

const typeOf = typeof min
console.error(`\nJSON type of the property: ${typeOf}`)
if (distinct !== matched) {
  console.error(
    `NOTE: ${(matched - distinct).toLocaleString()} neurons share an id with another. The ` +
      'node reads the column as data and fills every row, so that is legal — but it means ' +
      'one functional cell is claimed by more than one EM body.',
  )
}

console.error('\n# what the range can and cannot settle')
if (max === TRACE_COLUMNS) {
  console.error("RANGE VERDICT: 'label' — an id of 71,721 cannot be a 0-based index.")
  process.exit(0)
} else if (min === 0) {
  console.error("RANGE VERDICT: 'index' — an id of 0 cannot be a 1-based label.")
  process.exit(0)
} else if (min < 0 || max > TRACE_COLUMNS) {
  console.error(
    `NEITHER: ${min}…${max} does not fit ${TRACE_COLUMNS.toLocaleString()} columns under ` +
      'either reading. This is not a ZapBench id column.',
  )
  process.exit(1)
}
console.error(
  `Every id in ${min}…${max} is a valid column under both readings, so the range cannot ` +
    'settle it. Falling through to the geometry test.',
)

/*
 * The geometry test. Two descriptions of one cell — fish2's `somaLocation` and the released
 * centroid for a label — related by an unknown affine, so the transform is fitted and the
 * *residual* is the signal. Swept across neighbouring offsets because a fit insensitive to the
 * offset would produce a good residual for the wrong answer too.
 */
console.error('\n# geometry test')
console.error('reading segmentation/dataframe.json (52 MB, cached in /tmp)…')

const CACHE = '/tmp/coda-zapbench-segdf.json'
const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
if (!existsSync(CACHE)) {
  const response = await fetch(
    'https://storage.googleapis.com/zapbench-release/volumes/20240930/segmentation/dataframe.json',
  )
  if (!response.ok) throw new Error(`${response.status} reading the segmentation dataframe`)
  writeFileSync(CACHE, Buffer.from(await response.arrayBuffer()))
}
const seg = JSON.parse(readFileSync(CACHE, 'utf8'))

/*
 * The property the whole mapping rests on, re-checked rather than trusted: the dataframe's row
 * order *is* the trace column order, and the label is one higher. If this ever stops holding,
 * every residual below is meaningless.
 */
const labels = seg.label
let offBy = 0
for (let row = 0; row < TRACE_COLUMNS; row++) if (labels[row] === row + 1) offBy++
console.error(`label === row + 1 for ${offBy.toLocaleString()} of ${TRACE_COLUMNS.toLocaleString()} rows`)
if (offBy !== TRACE_COLUMNS) {
  console.error('The dataframe no longer indexes the way this rests on. Stopping.')
  process.exit(1)
}

/**
 * Least squares for `[cx, cy, cz, 1] · coef = target`, by normal equations.
 *
 * The 4×4 system is a `Float64Array` rather than nested arrays — which is both the natural shape
 * for a dense fixed matrix and the one that reads cleanly under `noUncheckedIndexedAccess`, where
 * every `number[][]` access would otherwise carry a non-null assertion.
 */
function fitAxis(predictors: readonly number[][], target: readonly number[]): Float64Array {
  // Augmented 4×5: the normal matrix beside its right-hand side. Read and written through two
  // accessors, so the index arithmetic is stated once and no call site carries an assertion.
  const M = new Float64Array(4 * 5)
  const at = (r: number, c: number): number => M[r * 5 + c]!
  const put = (r: number, c: number, value: number): void => {
    M[r * 5 + c] = value
  }

  for (let n = 0; n < predictors.length; n++) {
    const p = predictors[n]!
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) put(i, j, at(i, j) + p[i]! * p[j]!)
      put(i, 4, at(i, 4) + p[i]! * target[n]!)
    }
  }

  for (let c = 0; c < 4; c++) {
    let pivot = c
    for (let r = c + 1; r < 4; r++) if (Math.abs(at(r, c)) > Math.abs(at(pivot, c))) pivot = r
    if (pivot !== c) {
      for (let k = 0; k < 5; k++) {
        const swap = at(c, k)
        put(c, k, at(pivot, k))
        put(pivot, k, swap)
      }
    }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue
      const f = at(r, c) / at(c, c)
      for (let k = c; k < 5; k++) put(r, k, at(r, k) - f * at(c, k))
    }
  }

  const coef = new Float64Array(4)
  for (let i = 0; i < 4; i++) coef[i] = at(i, 4) / at(i, i)
  return coef
}

const placed = await cypher(
  `MATCH (n:Neuron) WHERE exists(n.zapbenchId) AND exists(n.somaLocation)
   RETURN n.zapbenchId, n.somaLocation.x, n.somaLocation.y, n.somaLocation.z,
          n.closestLandmarkDistanceMicrons`,
)
/*
 * Only the well-registered ones. A neuron far from any landmark has a loose match of its own,
 * which blurs every offset equally and so adds noise without adding information.
 */
const LANDMARK_MICRONS = 5
const points = placed.data
  .filter((row) => row[4] !== null && Number(row[4]) < LANDMARK_MICRONS)
  .map((row) => ({
    id: Number(row[0]),
    soma: [Number(row[1]), Number(row[2]), Number(row[3])],
  }))
console.error(
  `${points.length.toLocaleString()} of ${placed.data.length.toLocaleString()} matched neurons ` +
    `are within ${LANDMARK_MICRONS} microns of a landmark\n`,
)

console.error('offset   row       n        median    p90')
const scores: Array<{ offset: number; median: number }> = []
for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
  const predictors: number[][] = []
  const targets: number[][] = [[], [], []]
  for (const { id, soma } of points) {
    const row = id + offset
    const cx = seg.centroid_x[row]
    const cy = seg.centroid_y[row]
    const cz = seg.centroid_z[row]
    if (cx === undefined || cy === undefined || cz === undefined) continue
    predictors.push([cx, cy, cz, 1])
    for (let axis = 0; axis < 3; axis++) targets[axis]!.push(soma[axis]!)
  }
  const coef = targets.map((target) => fitAxis(predictors, target))
  const residuals: number[] = []
  for (let n = 0; n < predictors.length; n++) {
    const p = predictors[n]!
    let sum = 0
    for (let axis = 0; axis < 3; axis++) {
      const c = coef[axis]!
      let predicted = 0
      for (let i = 0; i < 4; i++) predicted += c[i]! * p[i]!
      sum += (predicted - targets[axis]![n]!) ** 2
    }
    residuals.push(Math.sqrt(sum))
  }
  residuals.sort((a, b) => a - b)
  // `quantileSorted` rather than a second nearest-rank median beside the tree's own.
  const median = quantileSorted(residuals, 0.5)
  const p90 = quantileSorted(residuals, 0.9)
  const note = offset === -1 ? '  <- label' : offset === 0 ? '  <- index' : ''
  console.error(
    `  ${String(offset).padStart(2)}    id${offset >= 0 ? '+' : ''}${offset}   ` +
      `${String(predictors.length).padStart(6)}   ${median.toFixed(0).padStart(6)}  ` +
      `${p90.toFixed(0).padStart(6)}${note}`,
  )
  scores.push({ offset, median })
}

const ranked = [...scores].sort((a, b) => a.median - b.median)
// Seven offsets are always swept, so both ends exist; named rather than asserted at five uses.
const best = ranked[0]!
const runnerUp = ranked[1]!
const ratio = runnerUp.median / best.median
console.error('\n# verdict')
if (ratio < 1.5) {
  console.error(
    `INCONCLUSIVE: the best offset (${best.offset}) is only ${ratio.toFixed(2)}x better than ` +
      'the next. The fit is not sensitive enough to the offset to decide.',
  )
  process.exit(1)
}
if (best.offset === -1) {
  console.error(
    `VERDICT: 'label'. row = id-1 is ${ratio.toFixed(1)}x sharper than the next best offset, ` +
      'so zapbenchId is the 1-based segmentation label and the trace column is id - 1.',
  )
} else if (best.offset === 0) {
  console.error(
    `VERDICT: 'index'. row = id is ${ratio.toFixed(1)}x sharper than the next best offset.`,
  )
} else {
  console.error(
    `UNEXPECTED: the sharpest offset is ${best.offset}, which is neither reading. Something ` +
      'other than an off-by-one is going on.',
  )
  process.exit(1)
}

/*
 * Last, a liveness check on the other half: the verdict is about an index, and an index is only
 * worth having if the array it points into actually reads. Four timesteps of the lowest matched
 * id at the column the verdict chose, through the same range arithmetic the app uses.
 */
console.error('\n# reading the array at that column')
const lowest = Number(sample.data[0]![1])
const resolved = lowest + best.offset
const first = await Promise.all([0, 1, 2, 3].map((step) => traceValue(2423 + step, resolved)))
console.error(
  `zapbenchId ${lowest} -> column ${resolved}, t=2423…2426: ` +
    first.map((value) => value.toFixed(6)).join('  '),
)
if (first.every((value) => value === 0)) {
  console.error('All zero, which is what padding past the real extent reads as. Suspicious.')
  process.exit(1)
}
console.error(`Total timesteps available: ${TRACE_TIMESTEPS.toLocaleString()}.`)
