/**
 * Getting Python off the main thread, and back.
 *
 * The seam every caller uses; `runtime.ts` and `worker.ts` are behind it. Same shape as
 * `layout/engine.ts` — one lazily-created instance, held across runs, torn down only when
 * something goes wrong — and for the same reason: what is expensive is the *boot*, and paying
 * it per run would be paying ten megabytes and a second and a half to answer a question that
 * takes half a second.
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
  onProgress?: (fraction: number, note?: string) => void
}

let worker: Worker | undefined
const pending = new Map<number, Pending>()
/**
 * The memory readout's questions, apart from `pending` so that asking one never makes the runtime
 * look busy — `pythonBusy` is what decides whether it may be stopped.
 */
const probes = new Map<number, (bytes: number | undefined) => void>()
let nextId = 1

function fail(reason: string): void {
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
  for (const answer of probes.values()) answer(undefined)
  probes.clear()
}

/** Drop the runtime. The next request boots a new one; the download is cached by then. */
function teardown(reason: string): void {
  worker?.terminate()
  worker = undefined
  fail(reason)
}

function ensureWorker(): Worker {
  if (worker) return worker
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
      probes.get(reply.id)?.(reply.bytes)
      probes.delete(reply.id)
      return
    }
    const entry = pending.get(reply.id)
    if (!entry) return
    if (reply.kind === 'progress') {
      entry.onProgress?.(reply.fraction, reply.note)
      return
    }
    pending.delete(reply.id)
    if (reply.kind === 'done') entry.resolve(reply.result)
    else entry.reject(new Error(reply.message))
  })
  created.addEventListener('error', (event: ErrorEvent) => {
    // A worker that died takes every in-flight request with it, and leaving them pending is
    // a node that runs for ever with nothing to show.
    teardown(errorMessage(event.error ?? event.message))
  })
  worker = created
  return created
}

export interface CallOptions {
  onProgress?: (fraction: number, note?: string) => void
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
  const { signal, onProgress } = options
  if (signal?.aborted) throw new Error('Aborted')

  const instance = ensureWorker()
  const id = nextId++

  return new Promise<PyResult>((resolve, reject) => {
    const onAbort = (): void => {
      pending.delete(id)
      teardown('Aborted')
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    pending.set(id, {
      onProgress,
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

/** Whether a call is in flight — a runtime that is may not be stopped from the readout. */
export function pythonBusy(): boolean {
  return pending.size > 0
}

/**
 * How far the runtime's wasm heap has grown, or undefined when there is no runtime to ask.
 *
 * Never boots one: with no worker this answers at once, and a worker still booting answers once
 * the boot settles.
 */
export function pythonHeapBytes(): Promise<number | undefined> {
  if (!worker) return Promise.resolve(undefined)
  const instance = worker
  const id = nextId++
  return new Promise((resolve) => {
    probes.set(id, resolve)
    const message: WorkerRequest = { id, memory: true }
    instance.postMessage(message)
  })
}

/**
 * Stop an idle runtime and give its heap back — the readout's one way to do that, since a wasm
 * memory never shrinks. The next Python step boots a new one, which is cancel's cost exactly.
 * Does nothing while a call is in flight, or when there is nothing to stop.
 */
export function stopPython(): void {
  if (!worker || pending.size > 0) return
  teardown('Stopped')
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
