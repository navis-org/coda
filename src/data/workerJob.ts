/**
 * One job in a one-shot worker: post it, relay progress, resolve with the result, and cancel by
 * terminating. Both halves, for the edge importer and the table-file reader.
 *
 * Written twice before it lived here — the importer's `offThread` and the reader's, near line for
 * line — and each copy owns a cancel path and an error path, which is exactly the kind of code a
 * fix reaches one copy of. `pyodide/` keeps its own: its worker is long-lived and multiplexed,
 * which is a different shape rather than a third copy of this one.
 *
 * **The caller makes the worker.** `new Worker(new URL('./worker.ts', import.meta.url))` has to be
 * written out at the call site, where vite can see it — that literal is how it serves the module
 * in dev and emits a chunk in a build — so this takes a function that constructs one rather than
 * a URL.
 *
 * **Cancel terminates rather than asks.** A decode loop has no interrupt point a message could
 * reach — the conclusion `pyodide/` came to for Python — and a half-done job has nothing worth
 * keeping.
 *
 * **Where there is no `Worker`** — jsdom and Node, where every test runs — the job runs on this
 * thread through the same handler the worker serves, which is what makes it testable at all.
 */

import { errorMessage } from '../core/errors'

/** What a job worker posts back. */
type JobMessage<R> =
  /** Sent on receiving the job: the worker's code loaded, so a silent death after it is not a load failure. */
  | { type: 'started' }
  | { type: 'progress'; fraction: number; note?: string }
  | { type: 'done'; result: R }
  | { type: 'error'; message: string }

/** What a job is run with, wherever it runs: where to report progress, and how to be cancelled. */
export interface JobRunOptions {
  readonly onProgress?: ((fraction: number, note?: string) => void) | undefined
  readonly signal?: AbortSignal | undefined
}

/** A job's body, run by the worker — or, with no `Worker` to run it in, on this thread. */
export type JobHandler<J, R> = (job: J, options: JobRunOptions) => Promise<R>

export interface JobOptions<J, R> extends JobRunOptions {
  /** What failed to start, for the one message nobody else can word: "The … could not be loaded". */
  readonly label: string
  /** The handler the worker serves, for running here where there is no `Worker`. */
  readonly here: JobHandler<J, R>
}

/**
 * A worker's error with no message is its code failing to load — a browser says nothing more about
 * a module it could not fetch or link. What does that to a page that loaded fine is the app moving
 * under it: a deploy that removed the old worker's file, or files edited while it was open. The
 * page's own modules are the old ones and keep working; a new worker fetches the new ones. So the
 * remedy is the one thing the sentence can offer.
 */
export function notLoaded(label: string): string {
  return (
    `The ${label} could not be loaded. Coda has probably been updated since this page was opened. ` +
    `Reload the page and run again.`
  )
}

/**
 * A worker's error with no message *after* it said it had started is not a load failure: its code
 * ran. What ends a running worker without a word is nearly always memory.
 */
export function stopped(label: string): string {
  return (
    `The ${label} stopped while it was running, most likely out of memory. ` +
    'Try a smaller run, or close other workflows and run again.'
  )
}

/** The page half: run `job` in the worker `spawn` makes, and settle with its result. */
export function runWorkerJob<J, R>(
  spawn: () => Worker,
  job: J,
  options: JobOptions<J, R>,
): Promise<R> {
  if (typeof Worker === 'undefined') {
    return options.here(job, { onProgress: options.onProgress, signal: options.signal })
  }
  // An abort listener does not fire for a signal already aborted, so that one is asked first —
  // or a job cancelled before it started would run to the end.
  if (options.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const worker = spawn()
    const stop = () => {
      worker.terminate()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    options.signal?.addEventListener('abort', stop, { once: true })
    const finish = () => {
      options.signal?.removeEventListener('abort', stop)
      worker.terminate()
    }
    // Whether the worker has said anything yet — it says `started` on receiving the job: an error
    // with no message means "never loaded" before, and "died running" after.
    let running = false
    worker.onmessage = (event: MessageEvent<JobMessage<R>>) => {
      const message = event.data
      running = true
      if (message.type === 'started') return
      if (message.type === 'progress')
        return options.onProgress?.(message.fraction, message.note)
      finish()
      if (message.type === 'done') resolve(message.result)
      else reject(new Error(message.message))
    }
    worker.onerror = (event) => {
      finish()
      reject(
        new Error(
          event.message || (running ? stopped(options.label) : notLoaded(options.label)),
        ),
      )
    }
    // A result the page cannot deserialise arrives as neither a message nor an error.
    worker.onmessageerror = () => {
      finish()
      reject(new Error(`The ${options.label}'s answer could not be read`))
    }
    worker.postMessage(job)
  })
}

/**
 * Every typed array's buffer in a result, each once: what a worker moves back by default. Walking
 * the result rather than listing fields means a field added to it later is moved too — a list
 * written out by hand copies the one nobody added to it, and nothing says so.
 */
export function buffersIn(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  walkBuffers(value, found)
  return [...found]
}

function walkBuffers(value: unknown, found: Set<ArrayBuffer>): void {
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer)
  } else if (Array.isArray(value)) {
    // In place, and past primitives without a call: a file reader's result holds plain columns of
    // millions of cells, where `Object.values` would copy each one to find nothing in it.
    for (const item of value)
      if (item !== null && typeof item === 'object') walkBuffers(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const key in value) walkBuffers((value as Record<string, unknown>)[key], found)
  }
}

/**
 * The worker half: answer each posted job with `handle`, relaying its progress, and move the
 * buffers `transfer` names rather than copying them — by default, every one in the result.
 *
 * A no-op anywhere but a worker, so a module the page or a test also imports — for its types or its handler —
 * needs no guard of its own: `self.onmessage` in a window would make every page a message target.
 */
export function serveJob<J, R>(
  handle: JobHandler<J, R>,
  transfer: (result: R) => Transferable[] = (result) => buffersIn(result),
): void {
  // Not a worker: the page (which has a document) or Node, where a test imports the module.
  if (typeof self === 'undefined' || typeof document !== 'undefined') return
  self.onmessage = async (event: MessageEvent<J>) => {
    const post = (message: JobMessage<R>, moved: Transferable[] = []) =>
      self.postMessage(message, { transfer: moved })
    post({ type: 'started' })
    try {
      const result = await handle(event.data, {
        onProgress: (fraction, note) =>
          post({ type: 'progress', fraction, ...(note ? { note } : {}) }),
      })
      post({ type: 'done', result }, transfer(result))
    } catch (err) {
      post({ type: 'error', message: errorMessage(err) })
    }
  }
}
