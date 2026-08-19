#!/usr/bin/env node
/**
 * Look at what neuPrint's region-mesh endpoint actually returns.
 *
 * The ROIs node needs `DataSource.fetchRoiMeshes`, and three facts about that endpoint decide
 * how it is written. None of them can be checked from a browser here — the endpoint wants a
 * token and neuPrint sends no CORS headers — and none of them should be guessed at:
 *
 *  1. **The format**, and how big it is. OBJ is many times the size of the Draco equivalent the
 *     precomputed buckets publish, and the total per dataset decides whether the widget can
 *     download on mount or needs an explicit control.
 *  2. **Coverage.** Whether every ROI in the dataset's own list resolves to a mesh. Some will
 *     not — mushroombody publishes no region summary at all — and a partial answer is a state
 *     the widget already has to render, so what matters is how partial.
 *  3. **The units, and this is the one that produces a silently wrong picture.** neuPrint
 *     returns skeletons and synapses in dataset *voxels* and `src/data/neuprint/units.ts`
 *     scales them to nanometres; precomputed meshes already arrive in nanometres. If region
 *     meshes come back in voxels and nothing scales them, the shells sit a whole factor away
 *     from any neuron drawn beside them, with nothing failing and both sets internally
 *     consistent. The script reports the bounding box against `Meta.voxelSize` so the answer is
 *     read off rather than inferred.
 *
 * Nothing is written and nothing is cached. Every request is a GET against a published
 * read-only endpoint, and the token is never printed.
 *
 *     NEUPRINT_TOKEN=... node scripts/probe-roimeshes.mjs
 *     NEUPRINT_TOKEN=... node scripts/probe-roimeshes.mjs --dataset hemibrain:v1.2.1 --meshes 6
 *
 * Options:
 *   --dataset <id>   Probe one dataset. Repeatable. Default: every one the server lists.
 *   --meshes <n>     How many region meshes to download in full per dataset (default 3).
 *                    Coverage and sizes come from one-byte ranged GETs, which cost nothing.
 *   --server <url>   A different neuPrint deployment.
 */

import { gzipSync } from 'node:zlib'

const DEFAULT_SERVER = 'https://neuprint.janelia.org'

const args = process.argv.slice(2)
const datasetsWanted = []
let meshBudget = 3
let server = DEFAULT_SERVER

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--dataset') datasetsWanted.push(args[++i])
  else if (arg === '--meshes') meshBudget = Number(args[++i])
  else if (arg === '--server') server = args[++i]
  else if (arg === '--help' || arg === '-h') {
    console.log(readUsage())
    process.exit(0)
  } else {
    console.error(`Unknown option: ${arg}`)
    process.exit(2)
  }
}

const token = process.env.NEUPRINT_TOKEN
if (!token) {
  console.error(
    'No NEUPRINT_TOKEN in the environment.\n' +
      '\n' +
      'Your token is the one Coda stores under `coda.neuprint.token` in localStorage, or the\n' +
      'one on https://neuprint.janelia.org/account. Pass it as an environment variable so it\n' +
      'does not end up in your shell history:\n' +
      '\n' +
      '    NEUPRINT_TOKEN=$(pbpaste) node scripts/probe-roimeshes.mjs\n',
  )
  process.exit(2)
}

const auth = { Authorization: `Bearer ${token}` }

function readUsage() {
  return `NEUPRINT_TOKEN=... node scripts/probe-roimeshes.mjs [--dataset id] [--meshes n] [--server url]`
}

/** neuPrint's router matches the raw segment; every dataset id has a colon and %3A gets a 400. */
function datasetSegment(id) {
  return encodeURIComponent(id).replace(/%3A/gi, ':')
}

async function getJson(path) {
  const response = await fetch(`${server}${path}`, { headers: auth })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}`)
  }
  return response.json()
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${bytes} B`
}

/**
 * Read an OBJ far enough to answer the questions above.
 *
 * Deliberately not a general parser — it counts vertices and faces and takes the bounding box,
 * which is everything needed to tell voxels from nanometres and to size the download.
 */
function inspectObj(text) {
  let vertices = 0
  let faces = 0
  let normals = 0
  let faceForm = ''
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]

  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      vertices++
      const parts = line.slice(2).trim().split(/\s+/)
      for (let axis = 0; axis < 3; axis++) {
        const value = Number(parts[axis])
        if (!Number.isFinite(value)) continue
        if (value < min[axis]) min[axis] = value
        if (value > max[axis]) max[axis] = value
      }
    } else if (line.startsWith('f ')) {
      faces++
      // `f 1 2 3`, `f 1//1 2//2 3//3` and `f 1/2/3 …` are all legal and a parser that assumes
      // the bare form silently reads a normal index as a vertex index.
      if (!faceForm) faceForm = line.slice(2).trim().split(/\s+/)[0] ?? ''
    }
    else if (line.startsWith('vn ')) normals++
  }
  return { vertices, faces, normals, faceForm, min, max }
}

async function probeDataset(id, info) {
  // The listing spells it `ROIs`; `superLevelROIs` is the subset that tiles the volume, which
  // is what the widget draws.
  const rois = info.ROIs ?? []
  const primary = info.superLevelROIs ?? []
  console.log(`\n─── ${id} ─────────────────────────────────────────────`)
  console.log(`  regions listed   ${rois.length}   (primary: ${primary.length || 'not published'})`)

  const candidates = (primary.length > 0 ? primary : rois).slice()
  if (candidates.length === 0) {
    console.log('  nothing to ask for — this dataset publishes no region list')
    return
  }

  const meshUrl = (roi) =>
    `${server}/api/roimeshes/mesh/${datasetSegment(id)}/${encodeURIComponent(roi)}`

  /*
   * Coverage by ranged GET, not HEAD.
   *
   * The first version of this script asked with HEAD and reported every dataset as having zero
   * meshes — while the GETs immediately below it returned megabytes of perfectly good OBJ. The
   * endpoint 404s on HEAD and 200s on GET, so the whole coverage table was an artefact of the
   * probe. A one-byte Range asks the same question without downloading the answer: a server
   * that honours it replies 206 with the full length in `Content-Range`, and one that does not
   * replies 200 and hands over the body, which still tells us the mesh exists.
   */
  let present = 0
  let absent = 0
  const missing = []
  const sizes = []
  let rangeHonoured = 0
  let wireBytes = 0

  for (const roi of candidates) {
    let response
    try {
      response = await fetch(meshUrl(roi), { headers: { ...auth, Range: 'bytes=0-0' } })
    } catch (error) {
      console.log(`  ! network error on ${roi}: ${error.message}`)
      break
    }
    if (!response.ok) {
      absent++
      if (missing.length < 6) missing.push(`${roi} (${response.status})`)
      continue
    }
    present++
    const contentRange = response.headers.get('content-range')
    const total = contentRange ? Number(contentRange.split('/')[1]) : NaN
    if (Number.isFinite(total) && total > 0) {
      sizes.push(total)
      rangeHonoured++
      continue
    }
    /*
     * The server ignores Range and sends the whole thing. The body has to be drained anyway or
     * the socket sits holding megabytes — so measure it rather than discarding it, which is what
     * the first version did, downloading every mesh and then reporting the sizes as unknown.
     *
     * It arrives gzipped and `fetch` decompresses transparently, so `content-length` is absent
     * on a chunked response and the wire cost cannot be read off a header. Compressing the body
     * locally is the honest way to it: the same algorithm the server used, on the same bytes.
     */
    const body = await response.arrayBuffer().catch(() => undefined)
    if (!body) continue
    const bytes = new Uint8Array(body)
    sizes.push(bytes.byteLength)
    wireBytes += gzipSync(bytes).byteLength
  }

  console.log(`  meshes present   ${present} of ${candidates.length}`)
  if (absent > 0) console.log(`  meshes absent    ${absent} — e.g. ${missing.join(', ')}`)

  if (sizes.length > 0) {
    const total = sizes.reduce((sum, n) => sum + n, 0)
    const sorted = sizes.slice().sort((a, b) => a - b)
    console.log(
      `  DOWNLOAD         ${human(total)} decoded for all ${sizes.length}` +
        (wireBytes > 0
          ? ` · ${human(wireBytes)} gzipped (${(total / wireBytes).toFixed(1)}×)`
          : ''),
    )
    console.log(
      `  per region       median ${human(sorted[Math.floor(sorted.length / 2)])}` +
        ` · p90 ${human(sorted[Math.floor(sorted.length * 0.9)])}` +
        ` · max ${human(sorted[sorted.length - 1])}`,
    )
  } else if (present > 0) {
    console.log(`  DOWNLOAD         unknown — nothing measurable came back`)
  }
  if (rangeHonoured > 0 && rangeHonoured < present) {
    console.log(`  (Range honoured on ${rangeHonoured} of ${present}; totals cover those only)`)
  }

  // --- Format, units, and what it costs on the wire ------------------------
  const sample = candidates.slice(0, Math.max(0, meshBudget))
  for (const roi of sample) {
    const response = await fetch(meshUrl(roi), { headers: { ...auth, 'Accept-Encoding': 'gzip' } })
    if (!response.ok) {
      console.log(`  ${roi}: ${response.status} ${response.statusText}`)
      continue
    }
    const contentType = response.headers.get('content-type') ?? '(none)'
    const encoding = response.headers.get('content-encoding') ?? 'identity'
    const wire = Number(response.headers.get('content-length'))
    const text = await response.text()
    const head = text.slice(0, 60).replace(/\n/g, '\\n')
    const looksObj = /^\s*(#|v |vn |g |o |mtllib)/.test(text)

    console.log(`\n  ${roi}`)
    console.log(`    content-type   ${contentType}`)
    console.log(
      `    bytes          ${human(text.length)} decoded` +
        (Number.isFinite(wire) && wire > 0
          ? ` · ${human(wire)} on the wire (${encoding})`
          : ` · wire size not stated (${encoding})`),
    )
    console.log(`    first line     ${head}…`)

    if (!looksObj) {
      console.log('    ! does not look like OBJ — the parser in the plan needs rewriting')
      continue
    }
    const obj = inspectObj(text)
    console.log(
      `    vertices/faces ${obj.vertices} / ${obj.faces}` +
        `${obj.normals ? ` (+${obj.normals} normals)` : ' (no normals)'}` +
        `${obj.faceForm ? ` · faces written as "${obj.faceForm}"` : ''}`,
    )
    const span = [0, 1, 2].map((a) => obj.max[a] - obj.min[a])
    console.log(`    bbox span      ${span.map((v) => Math.round(v)).join(' × ')}`)
    reportUnits(span, info)
  }
}

/**
 * Say whether the numbers are voxels or nanometres, rather than leaving it to be inferred.
 *
 * A fly brain is a few hundred micrometres across. In nanometres that is a span of order 1e5;
 * at an 8 nm voxel it is order 1e4. The two are an order of magnitude apart, so the reading is
 * unambiguous — but it is exactly the kind of thing that gets skimmed past, hence a sentence
 * rather than a table of numbers.
 */
function reportUnits(span, info) {
  const largest = Math.max(...span)
  const voxel = info.voxelSize?.[0]
  const note = voxel ? ` (Meta.voxelSize x = ${voxel} nm)` : ''
  if (largest > 40000) {
    console.log(`    units          looks like NANOMETRES — ~${Math.round(largest / 1000)} µm across${note}`)
    console.log('                   → no conversion needed; matches the precomputed meshes.')
  } else if (largest > 1000) {
    console.log(`    units          looks like VOXELS — ~${Math.round(largest)} voxels across${note}`)
    console.log('                   → must be scaled by Meta.voxelSize, like skeletons are.')
  } else {
    console.log(`    units          unclear — largest span is ${largest.toFixed(1)}${note}`)
  }
}

async function main() {
  console.log(`neuPrint region meshes — ${server}`)

  let listing
  try {
    listing = await getJson('/api/dbmeta/datasets')
  } catch (error) {
    console.error(`\nCould not list datasets: ${error.message}`)
    console.error('A 401 means the token is wrong or expired.')
    process.exit(1)
  }

  const ids = datasetsWanted.length > 0 ? datasetsWanted : Object.keys(listing)
  for (const id of ids) {
    const info = listing[id]
    if (!info) {
      console.log(`\n─── ${id} ───\n  not listed by this server`)
      continue
    }
    try {
      await probeDataset(id, info)
    } catch (error) {
      console.log(`  ! ${error.message}`)
    }
  }

  console.log('\nDone. Paste this output back into the ROIs thread.')
}

await main()
