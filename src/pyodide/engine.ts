/**
 * Getting Python off the main thread, and back.
 *
 * The seam every caller uses; `runtime.ts` and `worker.ts` are behind it. Same shape as
 * `layout/engine.ts` — a lazily-created instance per lane (`PyLane`), held across runs, torn
 * down only when something goes wrong — and for the same reason: what is expensive is the
 * *boot*, and paying it per run would be paying ten megabytes and a second and a half to answer a
 * question that takes half a second.
 *
 * **There is no fallback for a runtime without `Worker`.** The ELK engine has one, because
 * elkjs also ships a bundled build and running the real algorithm under vitest is what makes
 * its tests worth anything. Nothing equivalent exists here: Pyodide under vitest would mean
 * a 13 MB dependency, a network fetch inside the suite, and a second boot per test file. So
 * the tests mock this module (`nblast.test.ts`) and the Python itself is exercised by
 * `scripts/probe-nblast.mjs`, which runs the real file against the real wheel in Node. That
 * is an admission, and it is the same one the WebGL viewers make.
 *
 * **Cancel terminates the worker rather than interrupting Python.** Pyodide can be
 * interrupted mid-call, but only through `setInterruptBuffer`, which needs a
 * `SharedArrayBuffer`, which needs COOP/COEP headers, which GitHub Pages cannot set and which
 * this app has no service worker to fake. Terminating costs the next run a re-boot — about a
 * second and a half, since the ten megabytes are in the HTTP cache by then — and it is the
 * only thing that actually stops the work.
 */

import { errorMessage } from '../core/errors'
import type { PyArg, PyCall, PyResult, WorkerReply, WorkerRequest } from './types'

export type { PyArg, PyCall, PyResult } from './types'

interface Pending {
  resolve: (result: PyResult) => void
  reject: (error: Error) => void
  onProgress?: CallOptions['onProgress']
  onPartial?: CallOptions['onPartial']
}

/**
 * Which worker a call runs on. **`'main'` for everything but one bridge**, which is the default.
 *
 * `'assessor'` is SEAM's patch cutter (`assessorPatches.ts`), and it is a lane of its own because
 * Find Merge Candidates runs it *alongside* the search, which calls Python too: one worker made them
 * queue, and once the search's lookups were fast the cut waited ~0.7 s an end for the pool measure
 * to finish (`docs/seam-suggestions-plan.md`, 2026-11-18). A second heap is the price — a few tens
 * of megabytes and one boot, the download already cached.
 *
 * **A lane belongs to a Python module, never to a call** (`laneOf`): what a call leaves in Python
 * — the cutter's held box — is in that worker's heap and nowhere else, so every call to the module
 * has to land there, and a call that did not would still answer.
 */
type PyLane = 'main' | 'assessor'

/** The modules with a lane of their own; every other module runs on `'main'`. */
const MODULE_LANES: Readonly<Record<string, PyLane>> = { assessorPatches: 'assessor' }

/**
 * Which runtime a module's lane is on: changed by every teardown (a Cancel, a crash, Stop), so a
 * caller holding something in Python can tell it went with the worker. A close for it then has
 * nothing to close, and sent anyway would boot a fresh runtime only to be told so — or reach a
 * newer run's worker and close what that run holds.
 */
export function pythonGeneration(module: string): number {
  return lanes[laneOf(module)].generation
}

/** Which lane a module's calls run on. Exported for its test alone. */
export function laneOf(module: string): PyLane {
  return MODULE_LANES[module] ?? 'main'
}

/** One worker and the calls waiting on it. Torn down alone: a Cancel on one lane leaves the other. */
interface Lane {
  worker?: Worker
  readonly pending: Map<number, Pending>
  /**
   * The memory readout's questions, apart from `pending` so that asking one never makes the
   * runtime look busy — `pythonBusy` is what decides whether it may be stopped.
   */
  readonly probes: Map<number, (bytes: number | undefined) => void>
  /** One more each time the lane is torn down: which worker's heap a value left in Python is in. */
  generation: number
}

const newLane = (): Lane => ({ pending: new Map(), probes: new Map(), generation: 0 })
/** Every lane, made up front: an unused one is two empty maps, and boots nothing. */
const lanes: Record<PyLane, Lane> = { main: newLane(), assessor: newLane() }
let nextId = 1

function fail(lane: Lane, reason: string): void {
  for (const entry of lane.pending.values()) entry.reject(new Error(reason))
  lane.pending.clear()
  for (const answer of lane.probes.values()) answer(undefined)
  lane.probes.clear()
}

/** Drop one lane's runtime. Its next request boots a new one; the download is cached by then. */
function teardown(lane: Lane, reason: string): void {
  lane.worker?.terminate()
  lane.worker = undefined
  lane.generation += 1
  fail(lane, reason)
}

function ensureWorker(lane: Lane): Worker {
  if (lane.worker) return lane.worker
  if (typeof Worker === 'undefined') {
    throw new Error(
      'This needs a browser: the Python runtime is loaded into a module worker. ' +
        'Run scripts/probe-nblast.mjs to exercise it outside one.',
    )
  }
  /*
   * The `new URL(..., import.meta.url)` form rather than a `?worker` import, because this
   * worker is ours: vite emits it as its own chunk with a path that survives `base: './'`.
   * The CDN import inside it is what keeps Pyodide out of that chunk as well.
   */
  const created = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  created.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    if (reply.kind === 'memory') {
      lane.probes.get(reply.id)?.(reply.bytes)
      lane.probes.delete(reply.id)
      return
    }
    const entry = lane.pending.get(reply.id)
    if (!entry) return
    if (reply.kind === 'progress') {
      entry.onProgress?.(reply.fraction, reply.note)
      return
    }
    if (reply.kind === 'partial') {
      entry.onPartial?.(reply.result)
      return
    }
    lane.pending.delete(reply.id)
    if (reply.kind === 'done') entry.resolve(reply.result)
    else entry.reject(new Error(reply.message))
  })
  created.addEventListener('error', (event: ErrorEvent) => {
    // A worker that died takes every in-flight request with it, and leaving them pending is
    // a node that runs for ever with nothing to show.
    teardown(lane, errorMessage(event.error ?? event.message))
  })
  // Before any call, and messages arrive in order. `BASE_URL` against the document, the way
  // every other `public/` asset is addressed.
  const init: WorkerRequest = {
    siteRoot: new URL(import.meta.env.BASE_URL, document.baseURI).href,
  }
  created.postMessage(init)
  lane.worker = created
  return created
}

/**
 * **Neither callback may throw.** Both run in the worker's message handler, where a throw becomes
 * an uncaught error on the page and neither settles nor fails the call.
 */
export interface CallOptions {
  onProgress?: (fraction: number, note?: string) => void
  /**
   * A piece of the answer handed over before the call ends — Python's `report(fraction, note,
   * {...})` — converted exactly as the final result is, so a wrapper reads it with the same
   * `uint64From` and friends. Only a wrapper whose function sends one sets this.
   */
  onPartial?: (partial: PyResult) => void
  signal?: AbortSignal
}

/**
 * Call a Python function off the main thread.
 *
 * Typed arrays anywhere in `args` are **transferred**, not copied — they are built for the
 * call and dropped after it, so detaching them costs nothing and saves cloning a hundred
 * thousand points. Anything that means to keep one has to copy it first, which is why this is
 * said here rather than left for somebody to find.
 *
 * Callers are the typed wrappers (`nblast.ts`), not nodes: a node should not be spelling a
 * Python function name, any more than a viewer spells a Cypher query.
 */
export async function callPython(call: PyCall, options: CallOptions = {}): Promise<PyResult> {
  const { signal, onProgress, onPartial } = options
  if (signal?.aborted) throw new Error('Aborted')

  const lane = lanes[laneOf(call.module)]
  const instance = ensureWorker(lane)
  const id = nextId++

  return new Promise<PyResult>((resolve, reject) => {
    const onAbort = (): void => {
      lane.pending.delete(id)
      teardown(lane, 'Aborted')
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    lane.pending.set(id, {
      onProgress,
      onPartial,
      resolve: (result) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    })

    const message: WorkerRequest = { id, call }
    instance.postMessage(message, transferable(call.args))
  })
}

/** Whether a call is in flight on any lane — a runtime that is may not be stopped from the readout. */
export function pythonBusy(): boolean {
  return Object.values(lanes).some((lane) => lane.pending.size > 0)
}

/**
 * How far the runtimes' wasm heaps have grown, summed over the lanes running, or undefined when
 * there is no runtime to ask.
 *
 * Never boots one: with no worker this answers at once, and a worker still booting answers once
 * the boot settles.
 */
export async function pythonHeapBytes(): Promise<number | undefined> {
  const ask = (lane: Lane, instance: Worker) =>
    new Promise<number | undefined>((resolve) => {
      const id = nextId++
      lane.probes.set(id, resolve)
      const message: WorkerRequest = { id, memory: true }
      instance.postMessage(message)
    })
  const asked = Object.values(lanes).flatMap((lane) =>
    lane.worker ? [ask(lane, lane.worker)] : [],
  )
  const bytes = (await Promise.all(asked)).filter((one) => one !== undefined)
  return bytes.length > 0 ? bytes.reduce((sum, one) => sum + one, 0) : undefined
}

/**
 * Stop the idle runtimes and give their heaps back — the readout's one way to do that, since a
 * wasm memory never shrinks. The next Python step boots a new one, which is cancel's cost exactly.
 * Does nothing while any call is in flight, or when there is nothing to stop.
 */
export function stopPython(): void {
  if (pythonBusy()) return
  for (const lane of Object.values(lanes)) teardown(lane, 'Stopped')
}

/** Every buffer in a call's arguments, however deeply nested. */
function transferable(args: PyArg[]): Transferable[] {
  const out: Transferable[] = []
  const walk = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  args.forEach(walk)
  return out
}
