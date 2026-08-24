/**
 * Loading a landmark set: fetch, parse, normalise to nanometres, remember.
 *
 * The CSVs are served rather than bundled — `public/transforms/`, fetched on first use, never
 * in a chunk. Two reasons. They are 20–200 kB each and a session touches at most two of them,
 * so bundling them would put every dataset's landmarks in every visitor's download. And a
 * fetched URL is **the same mechanism a user-supplied transform will use**, which makes custom
 * transforms a URL field rather than a second loading path. Only `manifest.json` is static, and
 * only because edit-time code has to read it (see `spaces.ts`).
 *
 * ## Everything comes out in nanometres
 *
 * A landmark file's two sides can be in different units — JRC2018U is published in micrometres
 * while every dataset Coda reads is in nanometres — and both are converted here, once, so no
 * caller ever sees a µm coordinate and `GeometryUnits` never has to grow a third member.
 *
 * **The conversion is exact, and that was checked rather than assumed.** A 3-D thin-plate
 * spline's kernel is `U(r) = r`, homogeneous of degree one — unlike the 2-D `r² log r` — so
 * scaling either side of the landmark pairs scales the result and changes nothing else.
 * Measured against fastcore: 200 landmarks, 50 points, maximum deviation 1.3e-9 on values of
 * order 1e5, both directions.
 */

import { spaceById } from './spaces'
import type { LandmarkSetSpec, SpaceUnits } from './spaces'

/** A fitted-transform's two sides, xyz interleaved, in nanometres. */
export interface LandmarkPairs {
  /** Stable id — the file's basename. Keys the fitted transform in the Python runtime. */
  readonly id: string
  /** `count * 3` values. */
  readonly source: Float64Array
  readonly target: Float64Array
  readonly count: number
}

export const NM_PER_UM = 1000

export function scaleFor(units: SpaceUnits): number {
  return units === 'um' ? NM_PER_UM : 1
}

/**
 * Read one of our own landmark CSVs.
 *
 * Not `parseDelimited`, deliberately, and the reason is what each is for. That parser exists
 * for a file **somebody else wrote** — it detects the delimiter, sniffs a header, infers dtypes
 * and pads ragged rows, because the shape is unknown and being wrong about it is the failure it
 * guards. These files are written by `scripts/gen-transforms.py` with a header the manifest
 * names, so none of that is a question; what is left is arithmetic. It also produces the wrong
 * *shape*: a `TableValue` of boxed `CellValue`s, 20,000 of them for the largest set, which
 * would then be copied into the typed arrays the bridge actually wants.
 *
 * Throws by name on anything unexpected. A landmark file that has quietly become an HTML error
 * page must not turn into a transform that runs and moves every neuron somewhere plausible.
 */
export function parseLandmarks(text: string, spec: LandmarkSetSpec, id: string): LandmarkPairs {
  const lines = text.trim().split('\n')
  const header = lines[0]?.split(',').map((name) => name.trim()) ?? []

  const indexOf = (name: string): number => {
    const at = header.indexOf(name)
    if (at === -1) {
      // Naming what *did* arrive: the usual cause is a 200 carrying somebody's error page,
      // and "no column x" reads as a broken file rather than as a broken fetch.
      const found = header.slice(0, 8).join(', ') || '(nothing)'
      throw new Error(`Landmark file ${id} has no "${name}" column. Its columns are: ${found}`)
    }
    return at
  }

  const si = spec.sourceColumns.map(indexOf)
  const ti = spec.targetColumns.map(indexOf)
  const sScale = scaleFor(spec.sourceUnits)
  const tScale = scaleFor(spec.targetUnits)

  const count = lines.length - 1
  const source = new Float64Array(count * 3)
  const target = new Float64Array(count * 3)

  for (let row = 0; row < count; row++) {
    const fields = lines[row + 1]!.split(',')
    for (let axis = 0; axis < 3; axis++) {
      const s = Number(fields[si[axis]!])
      const t = Number(fields[ti[axis]!])
      if (!Number.isFinite(s) || !Number.isFinite(t)) {
        throw new Error(`Landmark file ${id} has a non-numeric value on line ${row + 2}`)
      }
      source[row * 3 + axis] = s * sScale
      target[row * 3 + axis] = t * tScale
    }
  }

  /*
   * The manifest and the file are written by the same script in the same run, so a disagreement
   * means one of them was replaced without the other — a stale CSV against a fresh manifest, or
   * a hand-edit. Either way the *transform* would still fit and still run, on the wrong
   * landmarks, which is the silent-wrong-answer this whole module is arranged to avoid.
   */
  if (count !== spec.landmarks) {
    throw new Error(
      `Landmark file ${id} has ${count} landmarks; the manifest says ${spec.landmarks}. ` +
        'Re-run scripts/gen-transforms.py.',
    )
  }

  return { id, source, target, count }
}

/**
 * Where a landmark file is served from.
 *
 * Through `BASE_URL` rather than a literal `/transforms/…`, because `base` is `'./'` in the
 * build and an absolute path would 404 on the subpath GitHub Pages serves this from. Same rule
 * as the start page's backdrop.
 */
export function landmarkUrl(file: string): string {
  return `${import.meta.env.BASE_URL}transforms/${file}`
}

/**
 * In flight or already loaded, by file.
 *
 * A promise rather than the value, so two nodes running in the same pass share one fetch
 * instead of racing to make two. A rejection is evicted — a chunk that failed to fetch once
 * would otherwise make every later run fail for the rest of the session, which is the rule the
 * Pyodide and ELK engines both keep.
 */
const loading = new Map<string, Promise<LandmarkPairs>>()

async function fetchLandmarks(spec: LandmarkSetSpec): Promise<LandmarkPairs> {
  const url = landmarkUrl(spec.file)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not load landmarks (${spec.file}): ${response.status} from ${url}`)
  }
  return parseLandmarks(await response.text(), spec, spec.file)
}

/** Load a landmark set, once per session. Safe to call from several nodes at once. */
export function loadLandmarks(spec: LandmarkSetSpec): Promise<LandmarkPairs> {
  const existing = loading.get(spec.file)
  if (existing) return existing
  const started = fetchLandmarks(spec).catch((error: unknown) => {
    loading.delete(spec.file)
    throw error
  })
  loading.set(spec.file, started)
  return started
}

/** Forget everything loaded. Tests only — a landmark file does not change under a session. */
export function resetLandmarks(): void {
  loading.clear()
}

// ---------------------------------------------------------------------------
// What a space offers
// ---------------------------------------------------------------------------

/**
 * The mirror registration for a space, or undefined where there is none.
 *
 * A lookup rather than a search: mirrors are **direct only**. navis can mirror via another
 * template and Coda deliberately does not — the round trip needs the bridging registrations
 * that only exist as CMTK and H5 files, and a two-hop answer compounds two splines' error to
 * reach a result the direct landmarks already give. A space with no entry has no mirror, and
 * the node says so rather than finding a way.
 */
export function mirrorFor(spaceId: string | undefined) {
  return spaceById(spaceId)?.mirror
}

/**
 * The transform from a space into the common frame, or undefined where there is none.
 *
 * The other lookup, and the whole of bridging: a star with `COMMON_SPACE` at the hub, one edge
 * per dataset, no path finding anywhere. An arbitrary space-to-space transform is derivable
 * from two of these — out through the hub and back, since fastcore can refit a spline in the
 * opposite direction — but that is a second fit and a second helping of error, and nothing
 * needs it yet.
 */
export function toCommonFor(spaceId: string | undefined) {
  return spaceById(spaceId)?.toCommon
}

/**
 * The same landmark pairs the other way round.
 *
 * **This is what an "inverse" transform is here, and it is a refit rather than an inversion.**
 * A thin-plate spline has no closed-form inverse — fastcore's own `__neg__` fits target onto
 * source afresh — so swapping the two columns and fitting again *is* the operation, and doing
 * it on this side means the Python module needs to know nothing about direction. It also means
 * the coefficient cache treats an inverse like any other set, since the id differs.
 *
 * The consequence worth stating: an inverse costs a **second fit**, at the same cubic price as
 * the first, and its error is the round trip's rather than one hop's. `neuron.xform` says so on
 * the card whenever it uses one.
 */
export function invertPairs(pairs: LandmarkPairs): LandmarkPairs {
  return {
    // The id is what keys both caches, so it has to say which direction this is or the reverse
    // fit would be handed back for a forward request and be quietly, plausibly wrong.
    id: `${pairs.id}#inverse`,
    source: pairs.target,
    target: pairs.source,
    count: pairs.count,
  }
}
