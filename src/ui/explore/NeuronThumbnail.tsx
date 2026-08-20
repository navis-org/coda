/**
 * One neuron's thumbnail.
 *
 * Fetches the coarsest mesh the dataset publishes (~10 kB for a hemibrain neuron, versus 2.0 MB
 * at full detail), projects it to a silhouette mask and paints that. No token is involved:
 * meshes come from public neuroglancer buckets, so thumbnails work in a static deploy even
 * where the Cypher API cannot reach.
 *
 * Three things keep a page of 25 of these from being a denial-of-service on the user's laptop:
 *
 *  - **A concurrency gate.** Each thumbnail is two range requests plus a Draco decode, so they
 *    are queued a few at a time rather than fired as a burst of fifty.
 *  - **Two layers of cache, and only one of them remembers a refusal.** An in-memory map for
 *    this session and IndexedDB across sessions, keyed by dataset, body id and raster size. The
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
 *  - **A refusal path.** `fetchCoarseGeometry` resolves undefined when a dataset has only
 *    full-resolution meshes, or when one body is pathologically heavy even at its coarsest
 *    level, and that becomes a placeholder rather than megabytes per row.
 */

import { useEffect, useRef, useState } from 'react'

import { getSource } from '../../data/source'
import { CHART_INK, currentMode } from '../colors'
import { cacheGet, cacheSet } from '../../data/cache'
import type { Silhouette } from './thumbnail'
import { coverageFraction, hexToRgb, rasteriseSilhouette, silhouetteToRgba } from './thumbnail'

export interface NeuronThumbnailProps {
  sourceId: string | undefined
  datasetId: string | undefined
  bodyId: number
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
 * Rasterise at twice the displayed size and let the browser downsample.
 *
 * The coarsest published mesh has far more detail than a 76px tile can hold — hemibrain's
 * level 0 is hundreds of triangles — so at 1:1 the limit was the raster, not the geometry, and
 * a thin neurite either landed on a pixel or vanished. At 2× the fill has four times the
 * samples to work with and the downscale turns the surplus into antialiasing, which is also
 * what makes it right on a HiDPI screen, where a 1:1 tile was being upscaled by the display.
 *
 * The cost is 4× the bytes per cached mask — 23 kB at 76px rather than 5.8 kB — which is the
 * reason not to go further. The raster size is part of the cache key, so masks stored at the
 * old resolution are a miss rather than a tile drawn at the wrong scale.
 */
const RASTER_SCALE = 2
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
function keyFor(sourceId: string, datasetId: string, bodyId: number, pixels: number): string {
  return `thumb:${sourceId}:${datasetId}:${bodyId}:${pixels}`
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
  bodyId: number,
  pixels: number,
): Promise<Entry> {
  const key = keyFor(sourceId, datasetId, bodyId, pixels)
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
      const geometry = await source.fetchCoarseGeometry({ datasetId, bodyId })
      if (!geometry) {
        memory.set(key, null)
        return null
      }
      const silhouette = rasteriseSilhouette(geometry.positions, geometry.indices, pixels)
      // A tile with almost nothing painted reads as a broken renderer rather than a neuron.
      const entry: Entry = coverageFraction(silhouette) < 0.002 ? null : silhouette
      memory.set(key, entry)
      if (entry) void cacheSet(key, { size: pixels, coverage: entry.coverage }, MASK_FORMAT)
      return entry
    } catch {
      // A missing mesh is ordinary — not every body id has one. Remember the miss so a page
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

export function NeuronThumbnail({
  sourceId,
  datasetId,
  bodyId,
  size = 76,
}: NeuronThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [entry, setEntry] = useState<Entry | undefined>(undefined)

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setEntry(null)
      return
    }
    let live = true
    setEntry(undefined)
    void loadSilhouette(sourceId, datasetId, bodyId, size * RASTER_SCALE).then((result) => {
      if (live) setEntry(result)
    })
    return () => {
      live = false
    }
  }, [sourceId, datasetId, bodyId, size])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !entry) return
    const context = canvas.getContext('2d')
    // Absent wherever 2D is unavailable. `installJsdomStubs` supplies one in tests, so this
    // path does run there — what it does not have is a way to look at the result.
    if (!context) return
    const ink = hexToRgb(CHART_INK[currentMode()].secondary)
    const rgba = silhouetteToRgba(entry, ink)
    context.clearRect(0, 0, entry.size, entry.size)
    context.putImageData(new ImageData(rgba, entry.size, entry.size), 0, 0)
  }, [entry])

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
