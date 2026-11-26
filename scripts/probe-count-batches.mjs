#!/usr/bin/env node
/**
 * `leaves_many` batch sizes again, now the server can answer counts (`counts_only=true`).
 *
 *   pnpm exec vite-node scripts/probe-count-batches.mjs
 *
 * `LEAVES_CHUNK` (160) and `LEAVES_STREAMS` (2) were chosen on 2026-11-20 against list replies,
 * when a request cost ~175 ms plus 67 per thousand level-2 ids in it, so a whole end in one
 * request waited on its biggest root (`docs/seam-suggestions-plan.md`, "count batches"). Whether
 * that per-id part survives counts is what decides whether larger batches pay now.
 *
 * **Pools.** The recorded per-end root lists of that day are gone, so each "end" here is a pool
 * built the way `pool_features` builds one: every root within `POOL_MAX_DIST_UM` (0.5 µm) of the
 * query's voxels in a search-sized box (3 µm half-width at 64 nm, `cutout_half_width_um`,
 * `cutout_xy_nm`), around a point on a real Aedes neuron, strided over its level-2 chunks. As in
 * the search, an end asks only roots no earlier end asked.
 *
 * **Warm caches kept out, as before.** Cold: each end is asked once, under one setting, the
 * settings taking turns, so every cold reading is on roots never asked. Warm: a block of ends,
 * already asked, under every setting, the order rotating.
 *
 * Reads only: segmentation chunks, `roots_binary`, `l2/attributes`, `leaves_many`. Nothing here
 * writes to CAVE.
 */

import { boxAround } from '../src/data/precomputed/volume.ts'
import { levelTwoChunks } from '../src/data/cave/rootIds.ts'
import { readL2Positions } from '../src/data/cave/l2.ts'
import { tableUrl } from '../src/data/cave/graphene.ts'
import { parseCaveJson } from '../src/data/cave/json.ts'
import { openSearchVolume } from '../src/packs/seam/searchVolume.ts'
import { labelledBox } from '../src/packs/seam/rootedBox.ts'
import { AEDES_DEPLOYMENT, requireCaveToken } from './lib/browserProbe.mjs'

const DATASTACK = 'wclee_aedes_brain'
const HALF_WIDTH_NM = 3000
const XY_NM = 64
/** `POOL_MAX_DIST_UM`: the pool is every object within this of the query in the box. */
const POOL_NM = 500
/** Large Aedes neurons the ends are placed along (1009, 1637, 564 level-2 chunks, 2026-11-25). */
const NEURONS = ['648518347669157986', '648518347558097460', '648518347622603652']
const ENDS_PER_NEURON = Number(process.env.ENDS_PER_NEURON ?? 14)
const WARM_ENDS = Number(process.env.WARM_ENDS ?? 8)
const END_ROOTS = Number(process.env.END_ROOTS ?? 320)
/** A fixed shuffle key for a root id. */
const hashOf = (text) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** [label, roots a request, requests in flight, counts_only]. `end` = the whole end in one. */
const SETTINGS = [
  ['50x4', 50, 4, true],
  ['160x2', 160, 2, true],
  ['320x1', 320, 1, true],
  ['endx1', Infinity, 1, true],
  ['160x2 lists', 160, 2, false],
]

const token = requireCaveToken()
const options = { deployment: AEDES_DEPLOYMENT, token }

// ---- pools ----------------------------------------------------------------------------------

const volume = await openSearchVolume(DATASTACK, XY_NM, Date.now(), options)
const { graphene, scale } = volume
console.error(`volume open: ${graphene.server} ${graphene.table}, scale ${scale.resolution}`)

const points = []
for (const neuron of NEURONS) {
  const chunks = (await levelTwoChunks(graphene, [neuron], options)).get(neuron) ?? []
  const sorted = [...chunks].sort()
  const picked = Array.from(
    { length: Math.min(ENDS_PER_NEURON, sorted.length) },
    (_, k) => sorted[Math.floor(((k + 0.5) * sorted.length) / ENDS_PER_NEURON)],
  )
  const at = await readL2Positions(graphene, picked, options)
  for (const id of picked) if (at.has(id)) points.push({ neuron, nm: at.get(id) })
}
console.error(`${points.length} points`)

/**
 * Every root within `POOL_NM` of the query's voxels: the query's surface voxels, each marking the
 * ellipsoid of voxels within reach (anisotropic voxels), then the roots under the marks.
 */
function poolOf(read, query, res) {
  const [sx, sy, sz] = read.size
  const rootAt = (i) => read.roots[read.index[i]]
  const isQ = new Uint8Array(sx * sy * sz)
  for (let i = 0; i < isQ.length; i++) if (rootAt(i) === query) isQ[i] = 1
  const reach = res.map((r) => Math.floor(POOL_NM / r))
  const offsets = []
  for (let dz = -reach[2]; dz <= reach[2]; dz++)
    for (let dy = -reach[1]; dy <= reach[1]; dy++)
      for (let dx = -reach[0]; dx <= reach[0]; dx++)
        if ((dx * res[0]) ** 2 + (dy * res[1]) ** 2 + (dz * res[2]) ** 2 <= POOL_NM ** 2)
          offsets.push([dx, dy, dz])
  const near = new Uint8Array(isQ.length)
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const i = x + sx * (y + sy * z)
        if (!isQ[i]) continue
        const surface =
          x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1 ||
          !isQ[i - 1] || !isQ[i + 1] || !isQ[i - sx] || !isQ[i + sx] ||
          !isQ[i - sx * sy] || !isQ[i + sx * sy]
        if (!surface) continue
        for (const [dx, dy, dz] of offsets) {
          const X = x + dx, Y = y + dy, Z = z + dz
          if (X < 0 || Y < 0 || Z < 0 || X >= sx || Y >= sy || Z >= sz) continue
          near[X + sx * (Y + sy * Z)] = 1
        }
      }
  const pool = new Set()
  for (let i = 0; i < near.length; i++) {
    if (!near[i]) continue
    const root = rootAt(i)
    if (root !== 0n && root !== query) pool.add(String(root))
  }
  return pool
}

const asked = new Set()
const ends = []
for (const [i, point] of points.entries()) {
  const box = boxAround(scale, [...point.nm], HALF_WIDTH_NM)
  const read = await labelledBox(volume, scale, box, options)
  // The end's neuron is whatever root the point is on now: a listed id may have been edited since.
  const [sx, sy] = read.size
  const c = point.nm.map((v, a) => Math.floor(v / scale.resolution[a]) - box.lo[a])
  const query = read.roots[read.index[c[0] + sx * (c[1] + sy * c[2])]]
  if (!query) {
    console.error(`end ${i}: no object under the point, skipped`)
    continue
  }
  const pool = poolOf(read, query, scale.resolution)
  // A real end asks ~320 new roots, neighbouring ends' pools overlapping; these points are spread
  // out, so each pool is cut to that many, by a fixed shuffle so a re-run asks the same roots.
  const fresh = [...pool]
    .filter((root) => !asked.has(root))
    .sort((p, q) => hashOf(p) - hashOf(q))
    .slice(0, END_ROOTS)
  for (const root of fresh) asked.add(root)
  if (fresh.length >= 20) ends.push(fresh)
  console.error(`end ${i}: pool ${pool.size}, new ${fresh.length}`)
}

// ---- requests -------------------------------------------------------------------------------

const requests = []
let retries = 0

async function ask(roots, countsOnly) {
  const query = countsOnly ? 'stop_layer=2&counts_only=true' : 'stop_layer=2'
  const url = tableUrl(graphene, `node/leaves_many?${query}`)
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: `{"node_ids":[${roots.join(',')}]}`,
    })
  let t0 = performance.now()
  let response
  try {
    response = await send()
  } catch (error) {
    // A connection the server closed (HTTP/2 GOAWAY): asked once more, timed from the retry.
    retries++
    console.error(`retry after: ${error.cause?.message ?? error.message}`)
    t0 = performance.now()
    response = await send()
  }
  const text = await response.text()
  const ms = performance.now() - t0
  if (!response.ok) throw new Error(`leaves_many ${response.status}: ${text.slice(0, 200)}`)
  const answer = parseCaveJson(text)
  let ids = 0
  let shape = 'none'
  for (const value of Object.values(answer)) {
    if (typeof value === 'number') {
      ids += value
      shape = 'count'
    } else if (Array.isArray(value)) {
      ids += value.length
      shape = 'list'
    }
  }
  if (countsOnly && shape === 'list') throw new Error('the server ignored counts_only')
  requests.push({ countsOnly, roots: roots.length, ids, bytes: text.length, ms })
  return { ids, ms }
}

/** One end under one setting: its batches through a pool of `streams`. Wall ms. */
async function runEnd(roots, [, size, streams, countsOnly]) {
  const batches = []
  const step = Number.isFinite(size) ? size : roots.length
  for (let i = 0; i < roots.length; i += step) batches.push(roots.slice(i, i + step))
  const t0 = performance.now()
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(streams, batches.length) }, async () => {
      while (next < batches.length) await ask(batches[next++], countsOnly)
    }),
  )
  return performance.now() - t0
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN
}

// Cold: every end once, the settings taking turns.
const cold = new Map(SETTINGS.map(([label]) => [label, []]))
for (const [i, roots] of ends.entries()) {
  const setting = SETTINGS[i % SETTINGS.length]
  const ms = await runEnd(roots, setting)
  cold.get(setting[0]).push((ms * 100) / roots.length)
}

// Warm: the first WARM_ENDS ends, already asked, under every setting, rotating.
const warm = new Map(SETTINGS.map(([label]) => [label, []]))
for (const [i, roots] of ends.slice(0, WARM_ENDS).entries()) {
  for (let k = 0; k < SETTINGS.length; k++) {
    const setting = SETTINGS[(i + k) % SETTINGS.length]
    const ms = await runEnd(roots, setting)
    warm.get(setting[0]).push((ms * 100) / roots.length)
  }
}

// ---- report ---------------------------------------------------------------------------------

/** Least squares ms = a + b * (ids / 1000), over one kind of request. */
function fit(rows) {
  const n = rows.length
  const xs = rows.map((r) => r.ids / 1000)
  const ys = rows.map((r) => r.ms)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0)
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
  const b = sxy / sxx
  return { n, a: my - b * mx, b }
}

const sizes = ends.map((e) => e.length)
console.log(`\nends: ${ends.length}, new roots per end: median ${median(sizes)}, ` +
  `range ${Math.min(...sizes)}-${Math.max(...sizes)}`)
console.log('\nms per 100 roots (median, n ends):')
console.log('setting        cold            warm')
for (const [label] of SETTINGS) {
  const c = cold.get(label)
  const w = warm.get(label)
  console.log(
    `${label.padEnd(14)} ${median(c).toFixed(0).padStart(5)} (n=${c.length})`.padEnd(31) +
      `${median(w).toFixed(0).padStart(5)} (n=${w.length})`,
  )
}
const counted = fit(requests.filter((r) => r.countsOnly))
const listed = fit(requests.filter((r) => !r.countsOnly))
console.log('\nper request, ms = a + b per thousand level-2 ids:')
console.log(`counts: a ${counted.a.toFixed(0)}, b ${counted.b.toFixed(1)} (n=${counted.n})`)
console.log(`lists:  a ${listed.a.toFixed(0)}, b ${listed.b.toFixed(1)} (n=${listed.n})`)
const reqCount = (label) => {
  const [, size] = SETTINGS.find(([l]) => l === label)
  return ends.reduce((a, e) => a + Math.ceil(e.length / (Number.isFinite(size) ? size : e.length)), 0)
}
console.log(`\nretries: ${retries}`)
console.log('\nrequests for all ends: ' + SETTINGS.map(([l]) => `${l} ${reqCount(l)}`).join(', '))
