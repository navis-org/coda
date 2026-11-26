/**
 * One tip's assessor patches, cut here — against SEAM's own published patches, byte for byte.
 *
 *   pnpm probe:assessor-patch                       # end 20 of the parity fixture
 *   pnpm probe:assessor-patch -- --end 1014         # a longer list (66 candidates)
 *   pnpm probe:assessor-patch -- --exported ~/Github/SEAM/data/onnx/sa2_mask
 *
 * **This is the check stage 6 rests on.** A patch is a 129³ window of labels, and every way of
 * getting one wrong produces a *plausible* one: a transposed box, a half-voxel offset, a z
 * resampled from the wrong sections, the two sides swapped. The network answers a confident
 * number about every one of them. SEAM publishes the real patches beside its parity fixture —
 * `patches/<end>.npz`, the exact arrays its own scores were computed from — so the only honest
 * test is a byte comparison against those, which is what this does.
 *
 * It fetches rather than mocks, for the same reason as `probe:candidate-search`: the patch is
 * cut from real supervoxels at a real timestamp, and a synthetic box would check the cutting
 * against itself. Both reads are cached under `CODA_PROBE_DIR`, so a re-run asks nothing — the
 * chunkedgraph call is tens of thousands of supervoxels at a shared public server (SEAM's
 * invariant 8).
 *
 * **TypeScript, not `.mjs`**, so that `patchBoxFor` and `readLabelBox` are the app's own and not
 * a second copy of either. `probe:candidate-search` reads a golden box for exactly this reason
 * and says so; here the box is computed by the code that will compute it in the browser.
 *
 * Printed with `console.error`, the convention `probe-zapbench.ts` and `probe-influence.ts`
 * follow: this is a report rather than data, and the lint rule allows `warn` and `error` only.
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { openVolume, readLabelBox } from '../src/data/precomputed/volume'
import type { Triple, VolumeScale, VoxelIndex } from '../src/data/precomputed/volume'
import { PATCH_NM, boxHoldsPatch, patchBoxFor } from '../src/packs/seam/patchBox'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- a probe helper, JavaScript with no types of its own
import { bootPyodide, installBridge, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- same
import { probeArgs, rootsAt } from './lib/browserProbe.mjs'

/*
 * `probeArgs` rather than a local reader: its `value` also takes the `--flag=value` form, which
 * a hand-rolled `indexOf` drops **in silence** — the probe then runs its default and says
 * nothing. That is why the helper grew the form in the first place.
 */
const args = probeArgs()
const END = Number(args.value('--end') ?? 20)
const EXPORTED = args.value('--exported') ?? join(homedir(), 'Github/SEAM/data/onnx/sa2_mask')

const report = probeReport()
const WORK = join(process.env['CODA_PROBE_DIR'] ?? tmpdir(), 'coda-assessor-patch')
mkdirSync(WORK, { recursive: true })

const fixture = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/fixture.json'))
/** `roots_at: snapshot - 1 ms`, which is the instant the published candidates were found at. */
const AT_MS = Date.parse(String(fixture.snapshot).replace(' ', 'T')) - 1

const BUCKET = 'https://storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain'

// ── SEAM's own patches, and what they were cut around ───────────────────────────────────────
execFileSync(
  process.env['CODA_PYTHON'] ?? 'python3',
  ['-I', 'scripts/lib/seam_assessor.py', 'lists', EXPORTED, WORK, String(END)],
  { stdio: 'inherit' },
)
interface SeamList {
  end_uid: number
  patches: number
  size: number
  cand_root: string[]
  neuron: string
  contact_nm: [number, number, number][]
}
const listed = JSON.parse(readFileSync(join(WORK, 'lists.json'), 'utf8')) as {
  commit: string
  set: string
  lists: SeamList[]
}
const list = listed.lists.find((one) => one.end_uid === END)
if (!list) throw new Error(`no end ${END} in ${WORK}/lists.json`)
const theirs = new Uint8Array(readFileSync(join(WORK, `${END}.u8`)))
console.error(
  `\nEnd ${END} of neuron ${list.neuron}: ${list.patches} candidates, ` +
    `${list.size}³ patches (${(theirs.length / 1e6).toFixed(1)} MB of SEAM's own, ` +
    `set ${listed.set} at SEAM ${listed.commit.slice(0, 7)}).`,
)

// ── The box, from the app's own arithmetic ──────────────────────────────────────────────────
const info = await openVolume(BUCKET)
const scale: VolumeScale | undefined = info.scales.find((one) => one.resolution[0] === PATCH_NM)
if (!scale) {
  throw new Error(`${BUCKET} has no ${PATCH_NM} nm scale; an assessor patch cannot be cut from it`)
}
const centres: Triple[] = list.contact_nm.map((one) => [one[0], one[1], one[2]])
const box = patchBoxFor(scale, centres)
const extent = [0, 1, 2].map((axis) => box.hi[axis]! - box.lo[axis]!)
console.error(
  `box ${extent.join('×')} voxels at ${scale.key} = ${(extent[0]! * extent[1]! * extent[2]! / 1e6).toFixed(1)} M voxels.`,
)
report.check(
  `the box holds every one of the ${centres.length} patches`,
  centres.every((one) => boxHoldsPatch(box, scale, one)),
)

// ── Read it, with the app's own reader ──────────────────────────────────────────────────────
/*
 * **The cache names its width, and the box and its labels are one unit.**
 *
 * `readLabelBox` chooses a width — sixteen bits where the box's table fits, thirty-two above
 * `NARROW_INDEX_LABELS` — and a 16-bit box read back as 32-bit is not a crash: it is half as
 * many voxels, each naming the wrong supervoxel. So the width is in the name.
 *
 * Both names, not just the box's. With one `labels-<end>.json` beside two possible box files, a
 * 16-bit box left over from an earlier run would pair with a label table written since, and
 * every index would name a different supervoxel — the same failure, arriving through the fix
 * for it. A pair is taken only when both of its halves are there.
 */
let labels: BigUint64Array
let index: VoxelIndex
const pair = (bits: number) => ({
  box: join(WORK, `box-${END}-u${bits}.bin`),
  labels: join(WORK, `labels-${END}-u${bits}.json`),
})
const cached = [pair(16), pair(32)].find((one) => existsSync(one.box) && existsSync(one.labels))
if (cached) {
  const bytes = readFileSync(cached.box).buffer.slice(0)
  index = cached.box.endsWith('u16.bin') ? new Uint16Array(bytes) : new Uint32Array(bytes)
  labels = BigUint64Array.from(
    (JSON.parse(readFileSync(cached.labels, 'utf8')) as string[]).map(BigInt),
  )
  console.error(`box cached in ${WORK}.`)
} else {
  const started = Date.now()
  const got = await readLabelBox(BUCKET, scale, box, { info })
  const took = Date.now() - started
  labels = got.labels
  index = got.index
  const into = pair(index.BYTES_PER_ELEMENT * 8)
  writeFileSync(into.box, Buffer.from(index.buffer, index.byteOffset, index.byteLength))
  writeFileSync(into.labels, JSON.stringify([...labels].map(String)))
  console.error(
    `read ${(index.length / 1e6).toFixed(1)} M voxels in ${(took / 1000).toFixed(1)} s ` +
      `(${labels.length} distinct supervoxels, ${index.BYTES_PER_ELEMENT * 8}-bit index).`,
  )
}
report.check(`${labels.length} distinct supervoxels in the box`, labels.length > 0)

// ── Their roots at the snapshot ─────────────────────────────────────────────────────────────
const roots = await rootsAt(labels, AT_MS, join(WORK, `roots-${END}-${AT_MS}.json`))
report.check(`${roots.length} roots for ${labels.length} supervoxels`, roots.length === labels.length)
report.check('the query neuron is in the box', [...roots].includes(BigInt(list.neuron)))

// ── Cut the patches, through the bridge ─────────────────────────────────────────────────────
const py = await bootPyodide()
await py.loadPackage(['numpy'], { messageCallback: () => {} })
const call = await installBridge(py, {
  bridge: 'src/pyodide/assessorPatches.py',
  vendored: { 'seam.patches': 'src/pyodide/seam/patches.py' },
})

const opened = await call('coda_assessor_open', {
  labels,
  index,
  size: extent,
  roots,
  queryRoot: BigInt(list.neuron),
  candRoots: BigUint64Array.from(list.cand_root.map(BigInt)),
  centresNm: Float64Array.from(centres.flat()),
  resolutionNm: scale.resolution,
  loVoxels: box.lo,
})
const present = opened['present'] as Int32Array
const absent = opened['absent'] as Int32Array
console.error(
  `labelled ${((opened['boxVoxels'] as number) / 1e6).toFixed(1)} M voxels in ` +
    `${Math.round(opened['ms'] as number)} ms; ${present.length} candidates present, ` +
    `${absent.length} with no voxel in the box.`,
)
report.check(
  `every candidate has voxels in the box (${absent.length} absent)`,
  absent.length === 0,
)
report.check(
  `the patch size is SEAM's ${list.size}`,
  (opened['patchSize'] as number) === list.size,
)

/*
 * Every patch in one call, asked for by number. The bridge has no "all of them" default on
 * purpose — a list is up to a hundred 2.1 MB patches — and this probe is the one caller that
 * really does want the lot, because it compares every one against SEAM's.
 */
const cut = await call('coda_assessor_patches', {
  box: opened['box'] as number,
  count: present.length,
})
const given = cut['given'] as Int32Array
const outside = cut['outside'] as Int32Array
const mine = cut['patches'] as Uint8Array
const voxels = list.size ** 3
console.error(
  `cut ${given.length} patches in ${Math.round(cut['ms'] as number)} ms ` +
    `(${Math.round((cut['ms'] as number) / Math.max(1, given.length))} ms each), ` +
    `${outside.length} outside the box.`,
)
report.check(`every candidate got a patch (${outside.length} outside)`, outside.length === 0)

// ── The comparison this probe exists for ────────────────────────────────────────────────────
/*
 * Byte for byte, per candidate, and the first difference is *located* rather than counted: a
 * patch that differs everywhere is a transpose or a swapped pair, one that differs in a plane
 * is a z offset, and one that differs in a corner is a box edge. A bare "they differ" sends a
 * reader to the wrong half of the pipeline.
 *
 * **Byte for byte everywhere, with nothing allowed.** This probe carried one allowance until
 * 2026-11-11. SEAM's published patches were cut before `label_sections` (`dbfef4c`), when a
 * label plane landing exactly on a section boundary was placed by the parity of the box's
 * corner — so the planes the resample ties on could differ from a patch cut here, and the probe
 * named those planes instead of failing on them. SEAM has since recut the fixture (set
 * `rv2-0d62bc912a89`, the `za` refit) and asked for the allowance to go, so a tied plane is now
 * a fault like any other: a patch cut here must be SEAM's from any box that holds it. If one
 * differs, send the end and the candidate upstream rather than tolerating it again.
 */
let wrong = 0
for (let at = 0; at < given.length; at++) {
  const candidate = given[at]!
  const ours = mine.subarray(at * voxels, (at + 1) * voxels)
  const them = theirs.subarray(candidate * voxels, (candidate + 1) * voxels)
  let first = -1
  let off = 0
  for (let i = 0; i < voxels; i++) {
    if (ours[i] !== them[i]) {
      if (first < 0) first = i
      off += 1
    }
  }
  if (off === 0) continue
  wrong += 1
  const size = list.size
  /* z is the fastest axis within a patch: `(x, y, z)` C-ordered, z last. */
  const z = first % size
  const y = Math.floor(first / size) % size
  const x = Math.floor(first / (size * size))
  report.check(
    `candidate ${candidate} (${list.cand_root[candidate]}): ${off} of ${voxels} voxels differ; ` +
      `the first is at (${x}, ${y}, ${z}) — ours ${ours[first]}, SEAM's ${them[first]}`,
    false,
  )
}
report.check(
  `all ${given.length} patches are SEAM's own, byte for byte`,
  wrong === 0 && given.length === list.patches,
)

/*
 * And what is in them, which a byte comparison already covers but a reader of the output
 * should see: the two sides are the thing the network reads, and "every patch matched" is worth
 * one line saying how much of a patch is not background.
 */
if (wrong === 0 && given.length > 0) {
  let q = 0
  let c = 0
  for (let i = 0; i < voxels; i++) {
    if (mine[i] === 1) q += 1
    else if (mine[i] === 2) c += 1
  }
  console.error(
    `\nthe first patch holds ${q} voxels of query and ${c} of candidate out of ${voxels} — ` +
      'the rest is background. A candidate is often a fragment of a few dozen voxels.',
  )
}

/*
 * **The box has an identity, and a stale caller is refused.** The bridge holds one box, so two
 * overlapping tips would have the second `open` replace the first's labels and the first's next
 * cut would answer from it — patches of the right shape, for the wrong neuron. Driven here
 * because the refusal is Python's and nothing in a TypeScript test runs it.
 */
let refused = ''
try {
  await call('coda_assessor_patches', { box: (opened['box'] as number) + 1, count: 1 })
} catch (error) {
  refused = String(error)
}
report.check(
  'a cut against a box that is no longer open is refused by name',
  /the wrong neuron/.test(refused),
)

await call('coda_assessor_close', { box: opened['box'] as number })
report.finish(py)
