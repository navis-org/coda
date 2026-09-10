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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { CoarseGeometry, CoarseRefusal } from '../../data/source'
import { getSource } from '../../data/source'
import type { Mode } from '../colors'
import { CHART_INK } from '../colors'
import { cacheGet, cacheSet } from '../../data/cache'
import { usePrefersReducedMotion, useThemeMode } from '../useThemeMode'
import { previewPlacement } from './previewPlacement'
import { useHoverPanel } from '../useHoverPanel'
import { buildOrder, createRotation, decimateSkeleton, rockFrame } from './rotation'
import { keyedCache } from '../viewers/keyedCache'
import type { Silhouette } from './thumbnail'
import {
  coverageFraction,
  hexToRgb,
  rasteriseSilhouette,
  rasteriseSkeleton,
  coverageInto,
  inkInto,
} from './thumbnail'

/**
 * The tile's size in CSS pixels, expanded and on a card.
 *
 * Here because this component owns the tile: the row reserves a grid track for it, the row's call
 * site picks between the two, and the placeholders size themselves from whichever was chosen. Four
 * spellings of one number is a track reserving 76 around a canvas drawn at something else — silent,
 * and browser-only.
 */
export const TILE_PX = 76
export const TILE_COMPACT_PX = 56

export interface NeuronThumbnailProps {
  sourceId: string | undefined
  datasetId: string | undefined
  neuronId: string
  /** Rendered size in CSS pixels. The mask is rasterised at `RASTER_SCALE` times this. */
  size?: number
  /**
   * Show an enlarged copy while the pointer is over the tile.
   *
   * On for every Explore row, card included — `NeuronRow` records what the compact tile costs
   * and what it turned out not to. Off by default, which is the answer for the other caller:
   * `ProfileViewer`'s shape tile stands for a *group* by drawing its first member, so an
   * enlargement there would offer a closer look at a neuron the header is not about.
   */
  hoverPreview?: boolean
}

/**
 * Rendered mask, or why there is none.
 *
 * `null` is "this dataset/neuron has nothing cheap to show", which covers every ordinary absence
 * — an unmeshed body, a dataset publishing only full-resolution geometry, a failed request. A
 * named reason is a case the source could name: it *has* a picture and the byte ceiling turned it
 * down. They draw the same glyph and differ in what the tile says when asked, which is the whole
 * of what the split at `readKey` buys.
 *
 * **Taken from `CoarseRefusal['reason']` rather than spelled out here**, and `BLANK_NOTE` below is
 * keyed by it. A hand-typed `'too-large'` compiles unchanged the day the seam grows a second
 * reason, and silently labels it "larger than the preview limit" — which is the failure the `kind`
 * discriminant was added to make impossible one arm up. `GeometryDetail` records what a seam costs
 * once it has three spellings.
 *
 * A string beside an object rather than a second field, so the three states narrow on `===` and
 * `memory`'s `held !== undefined` still tells "not asked" from "asked and there is nothing".
 */
type Entry = Silhouette | Blank
type Blank = null | CoarseRefusal['reason']

/**
 * What each named blank says, keyed by the reason so a second one cannot inherit this sentence.
 *
 * `Record` rather than a conditional: adding a reason to `CoarseRefusal` is then a type error
 * here — at the sentence — instead of a tile quietly claiming a failed request was too large.
 */
const BLANK_NOTE: Record<NonNullable<Blank>, { title: string; label: string }> = {
  'too-large': {
    title: 'No thumbnail: this neuron’s mesh is larger than the preview limit',
    label: 'No thumbnail: mesh too large',
  },
}

/** The unnamed blank, which is every ordinary absence and says the least it can. */
const NO_GEOMETRY_TITLE =
  'No thumbnail: this dataset publishes no cheap geometry for this neuron'

const memory = new Map<string, Entry>()

/**
 * Bodies whose fetch is running or queued, so two rows showing the same neuron — or a
 * re-render mid-flight — do not fetch it twice.
 */
const pending = new Map<string, Promise<Entry>>()

/**
 * The finer bodies, kept so a rotation can be built without a second fetch.
 *
 * **The geometry is what is worth holding, not the frames.** Seventeen frames are 6.6 MB and take
 * ~22 ms to rasterise from a mesh, so they are cheap to rebuild and expensive to keep — they live
 * only while the pointer is on a row. The geometry behind them is ~0.5 MB and cost a network
 * round trip, which inverts both halves of that.
 *
 * Three, because a body is only wanted for the row under the pointer and the two either side of
 * it — and it is the *only* thing here worth capping, since the preview's mask is one
 * rasterisation away from it rather than a stored thing of its own. Memory-only: a preview does
 * not survive a reload and neither does what it is drawn from, expressed by never reaching
 * `cache.ts` at all rather than by a predicate that has to be remembered at each call.
 *
 * `keyedCache` rather than a Map and an eviction loop of its own. That module holds the LRU *and*
 * the in-flight sharing for three fetching widgets already, and its header says why a fourth copy
 * is a bad idea: the two rules it carries are both ones the hand-written version here got wrong —
 * the `finally` must drop the pending entry *only if it is still ours*, and a `clear()` needs a
 * generation guard or a request issued before `resetThumbnailCache` writes its result into the
 * store just after. (The tile cache above predates this change and still has both; converting it
 * is a separate job.)
 */
const MAX_FINE_GEOMETRY = 3
const fineGeometry = keyedCache<CoarseGeometry | null>(MAX_FINE_GEOMETRY)

function geometryKey(sourceId: string, datasetId: string, neuronId: string): string {
  return `${sourceId}:${datasetId}:${neuronId}`
}

/**
 * The finer body for one neuron, fetched once however many callers want it.
 *
 * Both the static preview mask and the rotation come through here, which is the point: written as
 * two fetches they would be two requests for one body, and written as "the rotation reads what
 * the mask left behind" the rotation silently stops working as soon as the geometry is evicted
 * while the mask is still cached.
 */
async function loadFineGeometry(
  sourceId: string,
  datasetId: string,
  neuronId: string,
): Promise<CoarseGeometry | null> {
  const forBatch = currentBatch()
  const key = geometryKey(sourceId, datasetId, neuronId)
  const held = fineGeometry.get(key)
  if (held !== undefined) return held
  return fineGeometry.share(key, async () => {
    const source = getSource(sourceId)
    if (!source?.fetchCoarseGeometry) return null
    await acquire(forBatch)
    try {
      const answer = await source.fetchCoarseGeometry({ datasetId, neuronId, detail: 'fine' })
      /*
       * A refusal is `null` here and nothing more, which is the fallback this path already has:
       * the preview stays on the tile's own mask enlarged. It is reachable even for a body whose
       * *coarsest* level was fine — `detail: 'fine'` raises the triangle budget, `chooseLod`
       * answers with a finer level, and that level can be the one over the ceiling. The tile is
       * where the distinction is worth drawing, because that is where there is no picture at all.
       */
      const geometry = answer?.kind === 'refused' ? null : (answer ?? null)
      /*
       * **Decimated here, once, so the static mask and every rotation frame are one body.**
       *
       * It used to happen inside `createRotation`, which meant a dense skeleton was drawn two
       * ways: the static preview rasterised the whole 16,840-node arbor and the sweep drew a
       * decimated one, a visible change the crossfade had to cover. (The numbers that made this
       * urgent — 76.5 ms against 28.0 — are stale now that `drawSegment` stopped re-stamping;
       * both are ~4.8 ms. The *drawing* still has to be one body, which is the reason that
       * outlived the timing.) `DECIMATE_MAX_NODES` is argued at this very
       * raster, so nothing is lost by applying it to both. `createRotation`'s own call is now a
       * no-op guard, since `decimateSkeleton` returns its input by identity under the cap.
       */
      if (geometry?.kind === 'skeleton') {
        return { ...geometry, ...decimateSkeleton(geometry) }
      }
      return geometry ?? null
    } catch {
      // A missing body is ordinary. Remembered, so a source with nothing finer is asked once.
      return null
    } finally {
      release()
    }
  })
}

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

/**
 * Who is waiting for a slot, and which screenful they belong to.
 *
 * **Newest batch first, and that is the whole of it.** The queue was a plain FIFO, which is the
 * right shape only if every waiter is equally wanted — and while somebody clicks through pages
 * looking for a row, they are not. Five pages is 125 queued bodies with the page actually on
 * screen at the *back* of them, so the one screenful anybody is looking at fills last, behind a
 * hundred requests for rows that scrolled away several clicks ago. It reads as the widget being
 * slow and it is the widget being polite in the wrong order.
 *
 * Within a batch the order is still insertion, so a page fills top-down rather than in whatever
 * order a stack happens to pop. That is why this is not simply `queue.pop()`: LIFO fixes the
 * across-page half and breaks the within-page half.
 */
interface Waiter {
  batch: number
  resolve: () => void
}
const queue: Waiter[] = []

/**
 * Which screenful a request belongs to, without anything here knowing what a page is.
 *
 * React runs a commit's effects in one synchronous pass, so every row of a page calls
 * `loadSilhouette` before control returns to the event loop — a counter advanced on a microtask
 * therefore gives one id to exactly one screenful, whatever caused it. Captured at the *top* of
 * the loader rather than at `acquire`, because by the time a row reaches the semaphore it has
 * already awaited an IndexedDB read and its neighbours are scattered across several ticks.
 *
 * A hover preview asks later than the page it is over, so it gets a higher batch and is served
 * first — which is right, and falls out rather than being special-cased.
 *
 * The capture point is not pinned by a test and cannot easily be: under jsdom the cache read
 * resolves fast enough that a page's rows stay in one microtask either way, so capturing at
 * `acquire` passes. It is a populated IndexedDB in a real browser that scatters them across
 * ticks, which is exactly when the batching matters.
 */
let batch = 0
let batchScheduled = false

function currentBatch(): number {
  if (!batchScheduled) {
    batchScheduled = true
    queueMicrotask(() => {
      batch++
      batchScheduled = false
    })
  }
  return batch
}

function acquire(forBatch: number): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => queue.push({ batch: forBatch, resolve }))
}

function release(): void {
  if (queue.length === 0) {
    active--
    return
  }
  /*
   * The newest batch, and the *first* waiter in it. Batches only ever increase, so the queue is
   * already sorted by them and the newest sits at the end — walking back to where that batch
   * began is what keeps a page filling in its own order.
   */
  const newest = queue[queue.length - 1]!.batch
  let at = queue.length - 1
  while (at > 0 && queue[at - 1]!.batch === newest) at--
  queue.splice(at, 1)[0]!.resolve()
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

/**
 * Rasterise one body at `pixels`, or `null` for "nothing worth drawing".
 *
 * The one place a `CoarseGeometry` becomes a mask, so the tile and the preview cannot disagree
 * about the coverage floor or about which rasteriser a shape goes to. Pure and synchronous — the
 * caller decides whether the result is cached.
 */
function silhouetteOf(geometry: CoarseGeometry, pixels: number): Silhouette | null {
  /*
   * Whichever shape the source could answer cheaply — see `CoarseGeometry`. Nothing here prefers
   * one: a datastack whose segmentation is `graphene://` has no cheap mesh at any level and a
   * two-request skeleton, and the tile is the same tile either way because both rasterisers share
   * one fit.
   */
  const silhouette =
    geometry.kind === 'skeleton'
      ? rasteriseSkeleton(geometry.positions, geometry.parents, pixels)
      : rasteriseSilhouette(geometry.positions, geometry.indices, pixels)
  /*
   * Only a mask with **nothing** painted is refused, and that is the whole of what a floor here
   * can honestly say. This was `< 0.002`, written to hide "a single stray fragment" behind a
   * placeholder — but `fitToTile` scales every shape to fill the tile, so coverage measures how
   * *thin* a shape is, not how small or how broken. Measured on `neuprint-fish2`: its 12 smallest
   * bodies (8–43 vertices) cover 17–58% of the tile, so the floor never rejected a fragment, while
   * 5 of 49 random real neurons came in under it (0.00083–0.00193) — long axons across a square
   * tile, legible when drawn, and blanked with a tooltip saying the dataset had no geometry. It
   * also disagreed with itself across tile sizes: 100006807 passes at the card's 224 (0.00219) and
   * failed at the overlay's 304 (0.00193). What genuinely has nothing to draw — no geometry, a
   * collapsed triangle, a one-node skeleton — rasterises to exactly zero, and `thumbnail.test.ts`
   * pins each.
   */
  return coverageFraction(silhouette) === 0 ? null : silhouette
}

/**
 * One row's tile mask, cached in memory and in IndexedDB.
 *
 * **Tiles only.** The preview's mask used to come through here under a `detail` argument, which
 * gave this function a second cache namespace, a persistence predicate consulted at four sites, a
 * second eviction policy and its own branch on the concurrency semaphore. All of it was holding a
 * value that is a pure function of state the component already has — the preview's mask is
 * `silhouetteOf(geometry, PREVIEW_RASTER)`, and the geometry is cached one layer down in
 * `fineGeometry`. Deriving it there deleted the lot; see `NeuronThumbnail`.
 */
async function loadSilhouette(
  sourceId: string,
  datasetId: string,
  neuronId: string,
  pixels: number,
): Promise<Entry> {
  // Captured before the first await — see `currentBatch`.
  const forBatch = currentBatch()
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

    await acquire(forBatch)
    try {
      const geometry = await source.fetchCoarseGeometry({
        datasetId,
        neuronId,
        detail: 'coarsest',
      })
      if (!geometry || geometry.kind === 'refused') {
        // Remembered for the session but never written to IndexedDB, for the reason this file's
        // header gives: a refusal is a verdict from a policy, and the policy changes when the
        // code does — persisting one outlived the last two raises of the ceiling.
        const blank: Blank = geometry?.kind === 'refused' ? geometry.reason : null
        memory.set(key, blank)
        return blank
      }
      const entry = silhouetteOf(geometry, pixels)
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
 * How big the hover preview is drawn, in CSS pixels.
 *
 * **This was 176, which was the largest the tile's own 304px mask could reach for free.** That
 * ceiling is gone: the preview asks the source for a finer body (`CoarseGeometryRequest.detail`)
 * and rasterises it at `PREVIEW_RASTER`, so what bounds the size now is what the picture covers,
 * not what a mask could be stretched to.
 *
 * **320 is the largest that still clears the row on a 1920 screen**, and that is measured rather
 * than chosen — driven in a browser at three widths, box edges including the 6px padding and 1px
 * border:
 *
 *     window   tile        row name at   preview box   covers the name
 *     1920     268..344    351           8..342        no
 *     1440      86..162    169           8..342        yes, by 173px
 *     1100      86..162    169           8..342        yes, by 173px
 *
 * The panel is centred with a 1500px cap, so at 1920 the gutter plus the tile's own column is
 * 344px and a 334px box fits inside it with 9px to spare. One step larger starts covering the
 * name there, which is the thing `previewPlacement` exists to avoid.
 *
 * **Below 1440 it covers regardless of size and that is not a reason to stay small.** The panel
 * takes all but 28px of padding there, the name begins 169px in, and no preview wider than
 * ~147px clears it — the 176 this replaced already covered by 21px. So the choice at those widths
 * is between covering 173px and covering 21px, and what is bought is a picture 4.2× the tile
 * against 2.3×. Lower this to 232 to take the other side of that; there is no size that avoids
 * the trade.
 */
const PREVIEW_SIZE = 320

/**
 * The raster behind the preview.
 *
 * **Not `PREVIEW_SIZE * RASTER_SCALE`.** Four times a 320px box is 1280², which is 1.6 MB per
 * mask against the tile's 90 kB — and `cache.ts` evicts nothing. Two is 640², which is *exactly*
 * native on a `devicePixelRatio` 2 display and 2× supersampled on a 1× one, and 410 kB.
 *
 * The tile needs four because its problem is a hairline neurite landing on one pixel or none, at
 * a size where the geometry has far more in it than the raster can hold. At 320px that inversion
 * is over — the mask is native or better, and the detail now comes from `detail: 'fine'` asking
 * for a finer body rather than from sampling the coarse one harder. Supersampling above native is
 * a bonus here, not the mechanism.
 *
 * What it costs, and the comparison is the point: 410 kB per neuron **hovered**, against the
 * tile's 90 kB per neuron **seen**. A page is 25 rows and nobody hovers 25 of them, so this
 * accumulates more slowly than the cache it sits beside — it overtakes it only above one hover
 * per four rows browsed.
 */
const PREVIEW_RASTER = 640

/**
 * How long the pointer must rest on a tile before the preview appears.
 *
 * Not politeness: without it, dragging the pointer down a list of 25 rows opens and closes 25
 * previews, which reads as the list flashing rather than as a feature. It is also what keeps the
 * *fine* fetch off a sweep — that request is started when the preview opens, not when the pointer
 * arrives, so a pass down the list costs nothing at the source.
 */
const PREVIEW_DELAY_MS = 130

interface PaintBuffer {
  rgba: Uint8ClampedArray
  image: ImageData
  /** Which theme's ink is already in the colour channels. */
  mode: Mode | null
}

/**
 * The RGBA scratch every tile paints through, one per raster size for the whole session.
 *
 * **Shared rather than per component, because the components do not live long enough to own it.**
 * `NeuronRow` is keyed by neuron id, so a settled search unmounts and remounts all 25 rows — a
 * `useRef` buffer was therefore reallocated 25 times per keystroke, 369 kB each at the tile
 * raster, ~9 MB of garbage a query, with 25 redundant `inkInto` passes on top. That is the same
 * order as the churn `coverageInto` exists to avoid.
 *
 * Sharing is safe for a reason already written at the paint site: the write and the
 * `putImageData` that copies it out are both synchronous inside one layout effect, and
 * `coverageInto` writes *every* alpha byte unconditionally, so no tile can see another's pixels.
 * Two entries live for a session — 304 for the rows and 640 for the hover preview — against a
 * fresh one per row per search.
 *
 * `ImageData` wraps the array rather than copying it, so writing the buffer is writing the image.
 */
const paintBuffers = new Map<number, PaintBuffer>()

function paintBuffer(size: number): PaintBuffer {
  const held = paintBuffers.get(size)
  if (held) return held
  const rgba = new Uint8ClampedArray(size * size * 4)
  const made: PaintBuffer = { rgba, image: new ImageData(rgba, size, size), mode: null }
  paintBuffers.set(size, made)
  return made
}

/**
 * A mask painted through the current ink.
 *
 * A component rather than a hook because there are two canvases now — the tile and the preview —
 * and the preview's only exists while the pointer is over the tile. Written as a hook taking a
 * ref, the paint effect would not re-run when that ref went from null to an element, so the
 * preview would mount blank; mounting and unmounting a component runs its effect by
 * construction.
 */
function SilhouetteCanvas({
  entry,
  mode,
  size,
  className,
  fading = false,
}: {
  entry: Silhouette
  mode: Mode
  size: number
  className: string
  /** Crossfade the first paint under this flag. See the call site. */
  fading?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /*
   * One RGBA buffer and one `ImageData` over it, kept across frames.
   *
   * `ImageData` wraps the array rather than copying it, so writing the buffer *is* writing the
   * image. Reallocated only when the mask's size changes, which for a given surface it never
   * does — the rocking preview repaints 13 times a second, and a fresh 1.56 MiB buffer each time
   * is 20.8 MiB/s of garbage for as long as a pointer rests on a row.
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
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
    const held = paintBuffer(entry.size)
    // The ink moves only when the theme does; the coverage moves every frame of a rock. Writing
    // all four channels per frame measured 0.695 ms at 640² against 0.303 ms for alpha alone.
    if (held.mode !== mode) {
      held.mode = mode
      inkInto(held.rgba, hexToRgb(CHART_INK[mode].primary))
    }
    coverageInto(held.rgba, entry)
    // No `clearRect`: `putImageData` replaces destination pixels wholesale rather than
    // compositing, and this image is the canvas's whole backing store.
    context.putImageData(held.image, 0, 0)
  }, [entry, mode])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-fading={fading || undefined}
      // Backing store in mask pixels, box in CSS pixels — the gap between the two is the
      // supersampling.
      width={entry.size}
      height={entry.size}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}

/**
 * How long one full rock takes: centre → right → centre → left → centre.
 *
 * Half of it, 1.2 s, is a −45°→+45° traverse, which is slow enough to read as a body turning and
 * fast enough that the far side arrives before the pointer moves on.
 */
const ROCK_MS = 2400

/**
 * How long the frame builder may hold the main thread per tick.
 *
 * A budget rather than a frame count, because the two ends of the range differ by twenty times: a
 * mesh builds the whole sweep in ~22 ms and a skeleton in ~80 ms, and neither should be the thing
 * that decides how long a tick lasts. 8 ms leaves the rest of a 16 ms frame for the browser, so
 * the list still scrolls while a sweep is being built behind it — and since `drawSegment` stopped
 * re-stamping, a single frame is ~4.8 ms and actually fits inside the budget rather than
 * overrunning it, and the 16.7 ms deadline with it, on every tick.
 */
const BUILD_BUDGET_MS = 8

/**
 * Build a sweep's frames across several ticks, then play them.
 *
 * Returns the frame to draw, or `null` while there is nothing to draw yet — the caller keeps
 * showing the static mask until then, which is what makes a slow build invisible rather than a
 * blank box.
 *
 * **Nothing is built under `prefers-reduced-motion`.** Not merely "built and not played": the
 * frames are the whole cost, and a reader who has asked for less motion should not be paying for
 * an animation they will not see.
 */
function useRotation(
  geometry: CoarseGeometry | null | undefined,
  size: number,
  active: boolean,
): Silhouette | null {
  const [frames, setFrames] = useState<Silhouette[] | null>(null)
  const [current, setCurrent] = useState<Silhouette | null>(null)
  // The shared registry in `ui/mediaQuery.ts`, not a `matchMedia` of this component's own: one
  // `MediaQueryList` for every row on the page, read through `useSyncExternalStore` (invariant 7),
  // and `resetMediaForTest` for the suite that swaps `matchMedia` out.
  const reduced = usePrefersReducedMotion()

  // Build. One `createRotation` per geometry, then as many frames per tick as the budget allows.
  useEffect(() => {
    setFrames(null)
    setCurrent(null)
    if (!geometry || !active || reduced) return
    const rotation = createRotation(geometry, size)
    /*
     * **The centre frame first, and it is shown before any of the others exist.**
     *
     * A sweep is framed by `sweptBounds` and the static mask by its own, and a rotating body needs
     * more room than a still one — measured in a browser, the neuron is drawn 1.6× smaller once
     * the rock starts, which is 2.6× the painted area. Cutting from one to the other contradicts
     * the whole idea of a rock that begins on the picture you were already looking at, and a
     * crossfade only softens it.
     *
     * So the first thing built is the frame the rock starts on, and it replaces the static mask
     * immediately. The change of framing then happens *once*, at the same moment the stand-in
     * would have been replaced anyway, and from there to the rock there is no change at all.
     */
    const order = buildOrder(rotation.frames)
    const built = new Array<Silhouette | undefined>(rotation.frames)
    let filled = 0
    let handle = 0
    let live = true
    const step = () => {
      if (!live) return
      const started = performance.now()
      // At least one a tick, or a frame more expensive than the whole budget never finishes.
      do {
        const at = order[filled]!
        built[at] = rotation.render(at)
        filled++
      } while (filled < order.length && performance.now() - started < BUILD_BUDGET_MS)
      // Whatever else is still missing, the one the rock opens on is ready after the first tick.
      if (filled === 1) setCurrent(built[order[0]!] ?? null)
      if (filled < order.length) handle = requestAnimationFrame(step)
      else setFrames(built as Silhouette[])
    }
    handle = requestAnimationFrame(step)
    return () => {
      live = false
      cancelAnimationFrame(handle)
    }
  }, [geometry, size, active, reduced])

  /*
   * Play. Time-based rather than a frame counter, so a cycle takes `ROCK_MS` whatever the display
   * refresh rate is and whatever the tab did while it was in the background.
   *
   * Published only when the index moves. 17 frames over `ROCK_MS` change 13 times a second
   * against 60 rAF ticks (120 on a 120 Hz display), so most calls handed `setCurrent` the object
   * it already held — React bails out on `Object.is`, so this was never 47 wasted renders a
   * second, but it is three lines to make the 13 a property of the loop rather than of React's
   * bailout, and it is what keeps `SilhouetteCanvas`'s repaint to the same 13.
   */
  useEffect(() => {
    if (!frames || frames.length === 0) return
    let handle = 0
    let showing = -1
    const started = performance.now()
    const tick = () => {
      const phase = ((performance.now() - started) / ROCK_MS) % 1
      const at = rockFrame(phase, frames.length)
      if (at !== showing) {
        showing = at
        setCurrent(frames[at] ?? null)
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [frames])

  return current
}

export function NeuronThumbnail({
  sourceId,
  datasetId,
  neuronId,
  size = TILE_PX,
  hoverPreview = false,
}: NeuronThumbnailProps) {
  const tileRef = useRef<HTMLDivElement>(null)
  const [entry, setEntry] = useState<Entry | undefined>(undefined)
  /**
   * Where the preview sits and what it is portalled into, set together when it opens.
   *
   * The host is read here rather than watched by a hook of its own. It is only ever needed at the
   * moment the portal is created, and a hook meant 25 rows of a page each held a
   * `fullscreenchange` listener and each took an extra render on mount to go from `null` to
   * `document.body` — for a value 24 of them would never use.
   *
   * `document.fullscreenElement` and not `document.body` alone: the viewer overlay's ⛶ makes
   * `.overlay__panel` the fullscreen root, and the top layer shows that element's subtree and
   * nothing else, so a preview portalled to the body there would be built, positioned correctly
   * and invisible. Read off the document rather than off the ⛶ click, for the reason
   * `ui/fullscreen.ts` writes out: Escape and F11 both leave fullscreen without passing through
   * this app.
   */

  /**
   * The still picture of the finer body — **only where there is going to be no motion.**
   *
   * It is derived rather than fetched: the mask and the sweep come off the same
   * `loadFineGeometry`, so this is `silhouetteOf(geometry, PREVIEW_RASTER)` and never needed a
   * cache namespace of its own.
   *
   * Skipped whenever the rock will run, and that is a saving rather than a loss. The centre frame
   * arrives one build tick after the body does, so rasterising this first *delays* the sharp
   * picture by exactly its own cost — measured, 28 ms on a decimated arbor — to show something for
   * one frame that the rock then replaces. Under `prefers-reduced-motion` there is no rock, and
   * then it is the whole feature.
   *
   * The gate is not pinned by a test and cannot be: deriving it anyway is invisible from the DOM,
   * because `turning` takes precedence either way. What the suite does hold is the half that *is*
   * observable — that the still picture is there under reduced motion.
   */
  const [fine, setFine] = useState<Silhouette | null | undefined>(undefined)
  /** The finer body, once it is in hand. `useRotation` turns it into a sweep. */
  const [geometry, setGeometry] = useState<CoarseGeometry | null | undefined>(undefined)
  const mode = useThemeMode()
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setEntry(null)
      return
    }
    let live = true
    setEntry(undefined)
    // Or a page turn draws the previous row's neuron the moment the pointer rests on this one.
    // `fine` needs no reset of its own: it is written only by the effect keyed on `geometry`,
    // whose first branch clears it.
    setGeometry(undefined)
    void loadSilhouette(sourceId, datasetId, neuronId, size * RASTER_SCALE).then((result) => {
      if (live) setEntry(result)
    })
    return () => {
      live = false
    }
  }, [sourceId, datasetId, neuronId, size])

  /*
   * Hover state is local, and it has to be.
   *
   * `NeuronRow` is `memo`'d precisely because a per-row callback threaded down from
   * `ExploreBody` re-rendered every row's thumbnail subtree on every tick. Lifting this into the
   * list — a `hoveredId`, say — buys that bug back exactly: one pointer move would re-render
   * twenty-five rows to change one.
   */
  /*
   * The gesture is `useHoverPanel`'s — the delay, the mouse-only guard, the portal host, and the
   * per-frame rect watch that dismisses when the list scrolls or the canvas pans underneath.
   * What stays here is what is this component's: the finer body, asked for when the preview
   * opens and released when it closes.
   */
  const { open, handlers } = useHoverPanel({
    anchorRef: tileRef,
    delayMs: PREVIEW_DELAY_MS,
    canOpen: () => hoverPreview && !!sourceId && !!datasetId,
    onOpen: () => {
      /*
       * The finer body is asked for **here**, when the preview opens, and never on pointer
       * arrival. A sweep down the list is 25 pointerenters and no requests; only a deliberate
       * rest is a fetch. It is not awaited — the preview opens immediately with the tile's own
       * mask enlarged and swaps when this lands, so a slow source shows a soft picture rather
       * than no picture. One fetch, whichever of the still picture and the sweep is drawn from it.
       */
      if (!sourceId || !datasetId) return
      void loadFineGeometry(sourceId, datasetId, neuronId).then(setGeometry)
    },
    onClose: () => {
      /*
       * **The caches are not the ceiling unless the rows let go.** `ExploreBody` renders a whole
       * page at once and these are per-row state, so a hovered row held its 0.5 MB body for as
       * long as the page stayed mounted — evicting from `fineGeometry` frees nothing while the
       * row that fetched it still points at it. Measured against the declared bounds, a page of
       * 25 hovered rows overshoots `MAX_FINE_GEOMETRY` by 8×. Both re-resolve from the cache in
       * one microtask on the next hover, and where they have been evicted that is exactly what
       * the cap was for.
       */
      setGeometry(undefined)
    },
  })

  /*
   * Placed at render rather than at open, which the anchor rect makes free: `previewPlacement`
   * is a pure function over rectangles, and the rect it is given is the one measured when the
   * panel opened — see `useHoverPanel`, which measures then and not on pointer arrival.
   */
  const placement =
    open &&
    previewPlacement(open.anchor, PREVIEW_SIZE, {
      width: window.innerWidth,
      height: window.innerHeight,
    })

  /*
   * Gated on the preview being open, so nothing is rasterised for a row nobody rested on — and
   * torn down when it closes, which frees the 6.3 MB of frames. That is the whole of why the
   * frames are transient: the geometry they are built from is what `loadFineGeometry` keeps.
   */
  const turning = useRotation(geometry, PREVIEW_RASTER, open !== undefined)

  /*
   * Derived, and only where the rock will not run — see `fine`'s own note. Kept in state rather
   * than a `useMemo` so a 28 ms rasterisation of a dense arbor stays off the render path.
   */
  useEffect(() => {
    if (!geometry || !reduced) {
      setFine(undefined)
      return
    }
    setFine(silhouetteOf(geometry, PREVIEW_RASTER))
  }, [geometry, reduced])

  if (entry === undefined) {
    return (
      <div
        className="explore-thumb explore-thumb--loading"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    )
  }
  if (entry === null || typeof entry === 'string') {
    /*
     * A neuron glyph either way, not an error: "no cheap geometry" is a normal state for a
     * dataset that publishes only full-resolution meshes, and so is a body over the ceiling.
     *
     * **The two differ in what the tile says, not in what it draws**, and that is a decision. At
     * 56–76px there is no second glyph a reader could tell apart from this one without being
     * told what it meant — a badge at that size is a smudge — where the sentence fits in a
     * tooltip and reads the same on both tile sizes. It is worth saying at all because the two
     * absences are actionable in opposite directions: nothing will ever make an unmeshed body
     * draw, and a refused one is a picture the ceiling declined.
     *
     * A named reason is also **announced**, and the asymmetry is the point rather than an
     * oversight. An empty tile is decorative — it says what the row already says, that there is
     * no picture — so every row of a dataset with no thumbnails would read out one more time for
     * nothing. A refusal is a fact carried on no other surface.
     */
    const note = entry && BLANK_NOTE[entry]
    return (
      <div
        className="explore-thumb explore-thumb--empty"
        style={{ width: size, height: size }}
        /*
         * A data attribute rather than a modifier class, because there is no rule to hang on one
         * — the two blanks draw the same glyph on purpose. What it is for is a stable hook for a
         * test and a browser probe: the alternative is asserting on the tooltip's prose, which is
         * the sentence most likely to be reworded and the one whose wording proves nothing.
         */
        data-blank={entry ?? undefined}
        title={note ? note.title : NO_GEOMETRY_TITLE}
        role={note ? 'img' : undefined}
        aria-label={note?.label}
        aria-hidden={note ? undefined : true}
      >
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
    <div
      ref={tileRef}
      className="explore-thumb-slot"
      style={{ width: size, height: size }}
      {...handlers}
      aria-hidden="true"
    >
      <SilhouetteCanvas entry={entry} mode={mode} size={size} className="explore-thumb" />
      {open &&
        placement &&
        createPortal(
          /*
           * Portalled out of the list, and both clips it escapes are real: `.explore__list` is
           * `overflow-y: auto`, which clips the *other* axis too, and `.overlay__panel` is
           * `overflow: hidden`. `fixed` is right here for the same reason `.chart-tooltip` says
           * it is wrong there — a portal to the fullscreen root or the body has no transformed
           * ancestor, so viewport coordinates mean what they say. Confirmed in a browser: at
           * 1920 the preview sits outside the panel entirely, on the backdrop.
           */
          <div
            className="explore-thumb-preview"
            style={{ left: placement.left, top: placement.top }}
            aria-hidden="true"
          >
            {/*
             * The finer mask where there is one, the tile's own until then — and **always at
             * `PREVIEW_SIZE`**, never at the mask's natural size.
             *
             * A stand-in drawn at its own 304 and replaced by a 640 drawn at 320 would change
             * size when the fetch lands, which reads as the picture jumping rather than
             * sharpening. So the stand-in is knowingly upscaled by 5% for as long as it is up.
             *
             * Three sources, in order of how much they know: the frame the rock is on, the
             * still picture where there will be no rock, and the tile's own mask enlarged. The
             * last is not a failure state — CATMAID hands back the whole traced arbor already
             * and CAVE's chunk-graph route has no finer level, so on those two the enlargement
             * is the raster alone and the tile's mask is the honest picture.
             */}
            <SilhouetteCanvas
              entry={turning ?? fine ?? entry}
              /*
               * Crossfaded in, and it covers two changes rather than being a flourish. The sweep
               * is framed by `sweptBounds` where the static mask is framed by its own, so the
               * neuron is drawn slightly smaller once it turns; and a dense skeleton is decimated
               * for the sweep and not for the mask. Both are right on their own side and neither
               * survives a hard cut between them.
               */
              fading={turning !== null}
              mode={mode}
              size={PREVIEW_SIZE}
              className="explore-thumb-preview__canvas"
            />
          </div>,
          open.host,
        )}
    </div>
  )
}

/** Test seam: drop cached masks between cases. */
export function resetThumbnailCache(): void {
  /*
   * The semaphore too, and not only the caches. `active` and `queue` are module state that
   * outlives a test: a case that leaves a fetch in flight holds its slot for every case after it,
   * and the next suite's thumbnails queue behind a request nobody can resolve any more. Safe here
   * because this is the test seam — resetting it under live work would over-admit.
   */
  active = 0
  queue.length = 0
  memory.clear()
  pending.clear()
  paintBuffers.clear()
  fineGeometry.clear()
}
