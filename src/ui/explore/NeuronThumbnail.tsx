/**
 * One neuron's thumbnail.
 *
 * Asks the source for the cheapest drawable form of one neuron, projects it to a silhouette mask
 * and paints that. **What comes back is not always a mesh**, and this component does not care
 * which: a published pyramid answers its coarsest level (~10 kB for a hemibrain neuron, against
 * 2.0 MB at full detail), and a CAVE datastack with only a `graphene://` segmentation — where
 * the cheapest mesh is the only mesh, several hundred fragments at full resolution — answers a
 * level-2 skeleton instead. `CoarseGeometry` is the union and `thumbnail.ts` has a rasteriser
 * for each, sharing one fit so the two draw into the same frame.
 *
 * **Whether a token is involved is the source's business, not this file's.** The published
 * buckets are public and CORS-open, so a neuPrint or FlyWire row draws in a static deploy even
 * where the Cypher API cannot reach; CAVE's level-2 endpoints redirect to auth, which costs
 * nothing here because a CAVE list cannot be populated without a token in the first place.
 *
 * Three things keep a page of 25 of these from being a denial-of-service on the user's laptop:
 *
 *  - **A concurrency gate.** Each thumbnail is two round trips and, on the mesh route, a wasm
 *    decode — so they are queued a few at a time rather than fired as a burst of fifty.
 *  - **Two layers of cache, and only one of them remembers a refusal.** An in-memory map for
 *    this session and IndexedDB across sessions, keyed by dataset, neuron id and raster size. The
 *    mask is stored, not pixels, so it survives a theme change — a cached RGBA tile would be
 *    the wrong colour after one.
 *
 *    A *refusal* is deliberately not persisted, and that is load-bearing. A mask is a fact
 *    about the geometry; a refusal is a verdict from a policy — the byte ceiling, the
 *    multi-resolution requirement — and policy changes when the code does. Persisting one
 *    outlived raising `THUMBNAIL_MAX_BYTES` from 128 kB to 2 MB: every neuron the old ceiling
 *    had turned down stayed a placeholder through any number of reloads, because nothing ever
 *    asked again. The session map still keeps a page turn from re-requesting, which is all it
 *    was ever needed for; the cost of forgetting across reloads is one manifest read.
 *  - **A refusal path.** `fetchCoarseGeometry` resolves undefined when a dataset has nothing
 *    cheap in either shape — only full-resolution meshes and no level-2 cache — or when one body
 *    is pathologically heavy even at its coarsest level, and that becomes a placeholder rather
 *    than megabytes per row.
 */

import { useEffect, useRef, useState } from 'react'

import { getSource } from '../../data/source'
import type { Mode } from '../colors'
import { CHART_INK, currentMode } from '../colors'
import { cacheGet, cacheSet } from '../../data/cache'
import type { Silhouette } from './thumbnail'
import {
  coverageFraction,
  hexToRgb,
  rasteriseSilhouette,
  rasteriseSkeleton,
  silhouetteToRgba,
} from './thumbnail'

export interface NeuronThumbnailProps {
  sourceId: string | undefined
  datasetId: string | undefined
  neuronId: string
  /** Rendered size in CSS pixels. The mask is rasterised at `RASTER_SCALE` times this. */
  size?: number
}

/** Rendered mask, or `null` for "this dataset/neuron has nothing cheap to show". */
type Entry = Silhouette | null

const memory = new Map<string, Entry>()

/**
 * Bodies whose fetch is running or queued, so two rows showing the same neuron — or a
 * re-render mid-flight — do not fetch it twice.
 */
const pending = new Map<string, Promise<Entry>>()

/** Modest: each task is two HTTP round trips and a wasm decode. */
const MAX_CONCURRENT = 4

/**
 * Rasterise at four times the displayed size and let the browser downsample.
 *
 * The coarsest published mesh has far more detail than a 76px tile can hold — hemibrain's
 * level 0 is hundreds of triangles — so at 1:1 the limit was the raster, not the geometry, and
 * a thin neurite either landed on a pixel or vanished. The surplus samples become antialiasing
 * on the downscale, which is the whole mechanism, and it is why `image-rendering` must stay
 * `auto`.
 *
 * **Four rather than two, because two is 1:1 on the screens this is used on.** A 76px tile at
 * `devicePixelRatio` 2 is 152 device pixels, which is exactly what a 2× raster produced — so
 * every HiDPI display was getting no supersampling at all, and only a 1× one ever saw the
 * effect the constant was added for. Four restores 2× supersampling there, and gives 4× on a 1×
 * display.
 *
 * Deliberately not `RASTER_SCALE * devicePixelRatio`: the raster size is part of the cache key,
 * so a dpr-derived one fragments the store across displays and re-fetches every neuron when a
 * window is dragged to another monitor. A constant that covers dpr ≤ 2 is worth more than a
 * exact one that thrashes.
 *
 * What it costs, all measured:
 *
 *  - **Bytes, 4× again.** 90 kB per mask at a 76px tile rather than 23 kB, 49 kB rather than
 *    12 kB at Explore's 56px rows. `cache.ts` evicts nothing, so this accumulates until the
 *    Sources panel clears it: order 90 MB per thousand neurons browsed.
 *  - **Rasterisation, not the constraint.** A 2,684-node skeleton goes 0.95 → 5.06 ms and a
 *    600-triangle mesh 0.20 → 0.64 ms, against a synthetic skeleton at 40% coverage where a
 *    real one is 3–12% — so those are ceilings. Behind `MAX_CONCURRENT` and two round trips it
 *    is not visible.
 *  - **One refetch of everything, once.** The raster size is in the key, so every mask stored at
 *    2× is a miss and its geometry is fetched again. That is the real price and it is network,
 *    not compute.
 *
 * It buys no detail, and nothing here should pretend otherwise: the geometry is coarse by
 * construction and `STROKE_FRACTION` is a fraction, so a skeleton's stroke stays 1.5 CSS pixels
 * wide. Antialiasing is the entire product.
 */
const RASTER_SCALE = 4
let active = 0
const queue: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => queue.push(resolve))
}

function release(): void {
  const next = queue.shift()
  if (next) next()
  else active--
}

/** Keyed by the *raster* size, not the displayed one, so a change of scale invalidates. */
function keyFor(sourceId: string, datasetId: string, neuronId: string, pixels: number): string {
  return `thumb:${sourceId}:${datasetId}:${neuronId}:${pixels}`
}

/** Stored shape. A plain object and a `Uint8Array` both survive a structured clone. */
interface StoredMask {
  size: number
  coverage: Uint8Array
}

/**
 * Format tag for a stored mask, checked on read.
 *
 * `cache.ts` treats a fingerprint mismatch as a miss, which is what retires everything written
 * by an earlier encoder — including, on the day this was introduced, every refusal the cache
 * had been holding on to. Bump it if the stored bytes ever mean something different; the raster
 * size does not need a bump, since it is already part of the key.
 */
const MASK_FORMAT = 'coverage-8bit-1'

async function loadSilhouette(
  sourceId: string,
  datasetId: string,
  neuronId: string,
  pixels: number,
): Promise<Entry> {
  const key = keyFor(sourceId, datasetId, neuronId, pixels)
  const held = memory.get(key)
  if (held !== undefined) return held
  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const task = (async (): Promise<Entry> => {
    const stored = await cacheGet<StoredMask>(key, { fingerprint: MASK_FORMAT })
    // A stored mask with nothing in it is treated as a miss rather than as a refusal, so a
    // degenerate write can never become permanent.
    if (stored?.coverage.length) {
      const entry: Entry = { size: stored.size, coverage: stored.coverage }
      memory.set(key, entry)
      return entry
    }

    const source = getSource(sourceId)
    if (!source?.fetchCoarseGeometry) {
      memory.set(key, null)
      return null
    }

    await acquire()
    try {
      const geometry = await source.fetchCoarseGeometry({ datasetId, neuronId })
      if (!geometry) {
        memory.set(key, null)
        return null
      }
      /*
       * Whichever shape the source could answer cheaply — see `CoarseGeometry`. Nothing here
       * prefers one: a datastack whose segmentation is `graphene://` has no cheap mesh at any
       * level and a two-request skeleton, and the tile is the same tile either way because both
       * rasterisers share one fit.
       */
      const silhouette =
        geometry.kind === 'skeleton'
          ? rasteriseSkeleton(geometry.positions, geometry.parents, pixels)
          : rasteriseSilhouette(geometry.positions, geometry.indices, pixels)
      // A tile with almost nothing painted reads as a broken renderer rather than a neuron.
      const entry: Entry = coverageFraction(silhouette) < 0.002 ? null : silhouette
      memory.set(key, entry)
      if (entry) void cacheSet(key, { size: pixels, coverage: entry.coverage }, MASK_FORMAT)
      return entry
    } catch {
      // A missing mesh is ordinary — not every neuron id has one. Remember the miss so a page
      // of un-meshed neurons does not retry on every render.
      memory.set(key, null)
      return null
    } finally {
      release()
    }
  })().finally(() => {
    pending.delete(key)
  })

  pending.set(key, task)
  return task
}

/**
 * The mode the document is actually rendering in, re-read when it changes.
 *
 * A thumbnail is the one surface where a stale theme does not heal. The mask carries no colour
 * (see `thumbnail.ts`), so a theme flip changes only which ink is painted through it — but the
 * paint is an effect keyed on the mask, and nothing re-renders a row: Explore fetches for itself
 * and its rows subscribe to no graph state. The chart viewers have the same read-during-render
 * of `currentMode()` and go stale on a flip too, and there the next edit repaints them
 * (docs/viewers.md records that as pre-existing); here there is no next edit, so a list rendered
 * in dark mode kept `#c3c2b7` on a light card for as long as it stayed open. Light grey on
 * white — which is the "too faint" this fixes, rather than anything about the ramp.
 *
 * Both halves are load-bearing, because the preference has three values and only two of them are
 * stamped: `data-theme` carries an explicit light or dark, and is *absent* for `system`, where
 * the OS media query is the whole answer. `currentMode()` already knows that rule; this only has
 * to notice when either input moves.
 *
 * Local to this file on the second-consumer rule. Lift it when a second surface wants it — the
 * viewers all would, and that is one change rather than eleven.
 */
function useThemeMode(): Mode {
  const [mode, setMode] = useState<Mode>(currentMode)
  useEffect(() => {
    const update = () => setMode(currentMode())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    // The document may have been stamped between the first render and this effect.
    update()
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])
  return mode
}

export function NeuronThumbnail({
  sourceId,
  datasetId,
  neuronId,
  size = 76,
}: NeuronThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [entry, setEntry] = useState<Entry | undefined>(undefined)
  const mode = useThemeMode()

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setEntry(null)
      return
    }
    let live = true
    setEntry(undefined)
    void loadSilhouette(sourceId, datasetId, neuronId, size * RASTER_SCALE).then((result) => {
      if (live) setEntry(result)
    })
    return () => {
      live = false
    }
  }, [sourceId, datasetId, neuronId, size])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !entry) return
    const context = canvas.getContext('2d')
    // Absent wherever 2D is unavailable. `installJsdomStubs` supplies one in tests, so this
    // path does run there — what it does not have is a way to look at the result.
    if (!context) return
    /*
     * `primary`, not `secondary`, and the reason is the ramp rather than the near end.
     *
     * A silhouette is mostly *not* full coverage: `DEPTH_FLOOR` shades the far surfaces down to
     * 70/255, so most of a neuron is painted through an alpha well under one and the contrast a
     * hex reaches on its own is not the contrast on screen. Composited over each mode's tile
     * (`--surface-3`), `secondary` was worse in light at every step — 6.90:1 against 9.72:1 at
     * full coverage, 1.52:1 against 1.90:1 at the floor — which is a fifth of the contrast where
     * the picture is faintest, on the mode that had less to give.
     *
     * `primary` closes it: 17.1:1 against 17.4:1 near, and 1.88:1 at the floor against dark's
     * *current* 1.90:1 — so the far end of a light thumbnail now reads exactly as the dark one
     * already did, which is the half that was said to look right. That it also darkens dark mode
     * is fine; the ink is inverted between the two either way, since the mask holds no colour.
     *
     * Doing it here rather than by lifting `DEPTH_FLOOR` is what keeps every stored mask valid:
     * the floor is baked into the coverage bytes and would need `MASK_FORMAT` bumped, refetching
     * geometry for every neuron anyone has ever looked at. The ink is applied at paint.
     */
    const ink = hexToRgb(CHART_INK[mode].primary)
    const rgba = silhouetteToRgba(entry, ink)
    context.clearRect(0, 0, entry.size, entry.size)
    context.putImageData(new ImageData(rgba, entry.size, entry.size), 0, 0)
  }, [entry, mode])

  if (entry === undefined) {
    return <div className="explore-thumb explore-thumb--loading" aria-hidden="true" />
  }
  if (entry === null) {
    // A neuron glyph, not an error: "no cheap geometry" is a normal state for a dataset that
    // publishes only full-resolution meshes.
    return (
      <div className="explore-thumb explore-thumb--empty" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
          <path
            d="M12 4v7M12 11l-5 6M12 11l5 6M7 17l-3 3M17 17l3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="12" cy="4" r="2.2" fill="currentColor" />
        </svg>
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className="explore-thumb"
      // Backing store in mask pixels, box in CSS pixels — the gap between the two is the
      // supersampling.
      width={entry.size}
      height={entry.size}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}

/** Test seam: drop cached masks between cases. */
export function resetThumbnailCache(): void {
  memory.clear()
  pending.clear()
}
