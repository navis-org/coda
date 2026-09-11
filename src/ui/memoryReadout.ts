/**
 * The memory readout's numbers: one reading, retaken on a clock while somebody can see it, and
 * the dialog's three ways of freeing memory.
 *
 * ## Two sources, and why both
 *
 * **Chrome measures; nothing else does.** `performance.memory` is non-standard and Chromium-only,
 * and it is the only number here that is not an estimate: measured on a served page it moves by
 * exactly 400 MB when a 400 MB `Float32Array` is allocated, and `--enable-precise-memory-info`
 * changes nothing (`scripts/probe-memory.mjs`). Its standard successor,
 * `measureUserAgentSpecificMemory`, needs cross-origin isolation, which GitHub Pages cannot grant.
 * (On `about:blank` the old API does not move at all — a probe run there reads a frozen number and
 * concludes the API is useless.)
 *
 * **The estimate says whose bytes they are** — per workflow and per kind of result, which no
 * browser can — and it is the only figure Firefox and Safari get. See `core/valueBytes.ts`.
 *
 * ## The limit binds only half of it
 *
 * `jsHeapSizeLimit` looks like the ceiling and is not the whole of one: typed arrays count towards
 * `usedJSHeapSize` but not against the limit — measured, 6 GiB of them at 147% of a 4 GiB "limit"
 * with no error. What the limit binds is ordinary objects: table columns, strings, records. So the
 * share the readout colours by is `(used − typed arrays we hold) / limit`, and geometry is reported
 * as bounded by the device instead. Typed arrays held by something other than a result (a WebGL
 * staging copy) stay on the objects side, which overstates the share — the safe direction.
 *
 * Python's heap is a third number again: a wasm memory in a worker, in neither of the above.
 */

import { useSyncExternalStore } from 'react'

import { heldResultsVersion } from '../core/scheduler'
import { ByteLedger } from '../core/valueBytes'
import {
  forEachHeldGeometry,
  geometryCacheVersion,
  resetGeometryCache,
} from '../data/geometryCache'
import { pythonBusy, pythonHeapBytes, stopPython } from '../pyodide/engine'
import type { WorkflowMemory, WorkflowTab } from '../store/graphStore'
import { useGraphStore } from '../store/graphStore'

export type MemoryLevel = 'ok' | 'high' | 'critical'

/** Chrome's measurement, and what it means against the limit. */
export interface HeapUse {
  used: number
  limit: number
  /** `used` less the typed arrays counted below — the part the limit binds. */
  objects: number
  /** `objects / limit`, clamped to 1 for drawing. */
  share: number
  level: MemoryLevel
}

export interface MemoryReading {
  /** Undefined outside Chromium. */
  heap: HeapUse | undefined
  workflows: WorkflowMemory[]
  /** Geometry the session cache keeps beyond what any result is holding. */
  geometry: number
  /** Everything counted: every workflow's results plus the geometry above. */
  held: number
  /** Of `held`, the typed-array storage — not held to the heap limit. */
  buffers: number
  /** The wasm heap's high-water mark, or undefined with no runtime up. Asked only for the dialog. */
  python: number | undefined
  pythonBusy: boolean
}

/**
 * Where the readout turns amber and red, as a share of the heap limit. A colour, not a guard rail.
 *
 * **Well short of 1, because the tab does not wait for 1.** Measured with ordinary arrays added
 * 256 MB at a time, the tab was ended at **79%** of `jsHeapSizeLimit` — the next allocation needed
 * room past what was already used. A red that starts at 85% would start after the crash.
 */
const HIGH_SHARE = 0.6
const CRITICAL_SHARE = 0.75

/** How often the reading is retaken while anything is showing it. */
const POLL_MS = 2000

type ChromePerformance = Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
}

function heapUse(buffers: number): HeapUse | undefined {
  const memory = (performance as ChromePerformance).memory
  if (!memory || !(memory.jsHeapSizeLimit > 0)) return undefined
  const used = memory.usedJSHeapSize
  const limit = memory.jsHeapSizeLimit
  const objects = Math.max(0, used - buffers)
  const share = Math.min(1, objects / limit)
  const level = share < HIGH_SHARE ? 'ok' : share < CRITICAL_SHARE ? 'high' : 'critical'
  return { used, limit, objects, share, level }
}

/**
 * The estimate, and what it was computed from.
 *
 * Kept while none of that has moved, which is what makes the clock cheap: an idle tick re-reads
 * Chrome's figure and walks no values at all. A workflow opened, closed or renamed moves `tabs`; a
 * result arriving or dropped in any of them moves `heldResultsVersion`; the geometry cache has
 * its own counter.
 */
interface Estimate {
  results: number
  geometryVersion: number
  tabs: WorkflowTab[]
  workflows: WorkflowMemory[]
  geometry: number
  held: number
  buffers: number
}

let estimate: Estimate | undefined
let reading: MemoryReading | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pythonWatchers = 0
const listeners = new Set<() => void>()

function estimated(): Estimate {
  const { tabs, workflowMemory } = useGraphStore.getState()
  const results = heldResultsVersion()
  const geometryVersion = geometryCacheVersion()
  if (
    estimate?.results === results &&
    estimate.geometryVersion === geometryVersion &&
    estimate.tabs === tabs
  ) {
    return estimate
  }
  // One ledger across results and the geometry cache: they hold the same buffers while a scene is
  // on screen, and two ledgers would count every drawn neuron twice.
  const ledger = new ByteLedger()
  const workflows = workflowMemory(ledger)
  let geometry = 0
  forEachHeldGeometry((item, bytes) => {
    geometry += ledger.addLoose(item, bytes)
  })
  estimate = {
    results,
    geometryVersion,
    tabs,
    workflows,
    geometry,
    held: ledger.total,
    buffers: ledger.buffers,
  }
  return estimate
}

/** The previous reading when nothing on it moved, so a subscriber is not re-rendered for nothing. */
function measure(): MemoryReading {
  const { workflows, geometry, held, buffers } = estimated()
  const heap = heapUse(buffers)
  const busy = pythonBusy()
  if (
    reading &&
    reading.workflows === workflows &&
    reading.geometry === geometry &&
    reading.pythonBusy === busy &&
    reading.heap?.used === heap?.used &&
    reading.heap?.limit === heap?.limit
  ) {
    return reading
  }
  return { heap, workflows, geometry, held, buffers, python: reading?.python, pythonBusy: busy }
}

function publish(): void {
  for (const listener of listeners) listener()
}

/**
 * The Python figure, only while the dialog is open — the chip never shows it, and asking is a
 * round trip to the worker. `pythonHeapBytes` answers undefined at once with no runtime up.
 */
function askPython(): void {
  if (pythonWatchers === 0) return
  void pythonHeapBytes().then((bytes) => {
    if (!reading || bytes === reading.python) return
    reading = { ...reading, python: bytes }
    publish()
  })
}

function refresh(): void {
  const next = measure()
  if (next !== reading) {
    reading = next
    publish()
  }
  askPython()
}

function tick(): void {
  // Nobody can see a hidden tab's footer.
  if (!document.hidden) refresh()
}

function subscriber(watchPython: boolean) {
  return (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (watchPython) pythonWatchers += 1
    if (listeners.size === 1) {
      timer = setInterval(tick, POLL_MS)
      document.addEventListener('visibilitychange', tick)
    }
    // The first reading, and the Python figure for a dialog that has just opened.
    refresh()
    return () => {
      listeners.delete(listener)
      if (watchPython) pythonWatchers -= 1
      if (listeners.size > 0) return
      clearInterval(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', tick)
    }
  }
}

const subscribeChip = subscriber(false)
const subscribeDialog = subscriber(true)

/**
 * The current reading, retaken every `POLL_MS` while anything is subscribed — the status bar is,
 * always. `withPython` is the dialog's: only it shows the Python heap. A module-level store rather
 * than zustand's: it is a clock, not document state, and putting it in the graph store would re-run
 * every selector in the app every two seconds.
 */
export function useMemoryReading(withPython = false): MemoryReading | undefined {
  return useSyncExternalStore(withPython ? subscribeDialog : subscribeChip, () => reading)
}

/*
 * The dialog's three ways of freeing memory. Each takes a reading at once, so the figure that
 * moved is the one on screen rather than the one two seconds from now.
 */

export function dropResults(workflowId: string): void {
  useGraphStore.getState().clearResults(workflowId)
  refresh()
}

export function dropGeometry(): void {
  resetGeometryCache()
  refresh()
}

export function stopPythonRuntime(): void {
  stopPython()
  refresh()
}
