/**
 * A model open in the inference worker, from the main thread's side.
 *
 * One worker per open model. The main thread never holds an ONNX Runtime session and never
 * imports the runtime — `infer.worker.ts` says why — so everything here is messages and buffers.
 *
 * **The caller owns the chunking.** `run` is one graph call. A full affinity matrix at N = 1024 is
 * a million pairs and about twelve seconds, which has to arrive in pieces that can be cancelled
 * and reported on, and only the caller knows how big a piece should be.
 */

import type { ModelPart } from './manifest'
import type { WireTensor, WorkerRequest, WorkerResponse } from './protocol'
import { transferable } from './protocol'
import type { WeightProgress } from './weights'

export interface OpenOptions {
  /** The manifest's address. Its files resolve against it, so one directory moves hosts freely. */
  readonly manifestUrl: string
  readonly variant: string
  readonly onProgress?: (progress: WeightProgress) => void
  readonly signal?: AbortSignal
  /**
   * Makes the worker. Passed in rather than constructed here for the reason `workerJob.ts` gives:
   * `new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' })` has to appear
   * literally at a call site for vite to serve it in dev and emit a chunk in a build.
   */
  readonly createWorker: () => Worker
}

export interface ModelSession {
  run(
    part: ModelPart,
    feeds: readonly WireTensor[],
    outputs: readonly string[],
  ): Promise<WireTensor[]>
  close(): Promise<void>
}

/**
 * Open a model, downloading and verifying its weights.
 *
 * Cancelling terminates the worker rather than asking it to stop: a `session.run` inside
 * ONNX Runtime has no interrupt point a message could reach, which is the conclusion
 * `workerJob.ts` came to for Python and holds here for the same reason.
 */
export async function openModel(options: OpenOptions): Promise<ModelSession> {
  const worker = options.createWorker()
  let nextId = 0
  const pending = new Map<
    number,
    { resolve: (tensors: WireTensor[]) => void; reject: (error: Error) => void }
  >()

  const fail = (error: Error) => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
    worker.terminate()
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    if (message.type === 'progress') {
      options.onProgress?.(message.progress)
      return
    }
    const settle = pending.get(message.id)
    if (!settle) return
    pending.delete(message.id)
    if (message.type === 'error') settle.reject(new Error(message.message))
    else settle.resolve([...(message.tensors ?? [])])
  }
  // A worker error with no message is its code failing to load, which on a page that has been
  // open across a deploy is the likeliest cause. Same sentence as `workerJob.ts`' `notLoaded`.
  worker.onerror = () =>
    fail(
      new Error(
        'The model runtime could not be loaded. Coda has probably been updated since this page ' +
          'was opened. Reload the page and run again.',
      ),
    )

  const send = (request: WorkerRequest, transfer: ArrayBuffer[] = []) =>
    new Promise<WireTensor[]>((resolve, reject) => {
      pending.set(request.id, { resolve, reject })
      worker.postMessage(request, transfer)
    })

  const onAbort = () => fail(new Error('Cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  await send({
    id: ++nextId,
    type: 'open',
    manifestUrl: options.manifestUrl,
    variant: options.variant,
  })

  return {
    run: (part, feeds, outputs) =>
      send({ id: ++nextId, type: 'run', part, feeds, outputs }, transferable(feeds)),
    close: async () => {
      options.signal?.removeEventListener('abort', onAbort)
      try {
        await send({ id: ++nextId, type: 'close' })
      } finally {
        worker.terminate()
      }
    },
  }
}
