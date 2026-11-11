/**
 * A model open in the inference worker, from the main thread's side.
 *
 * One worker per open model. The main thread never holds an ONNX Runtime session and never
 * imports the runtime, so everything here is messages and small buffers.
 *
 * **This module owns the worker literal**, rather than taking a factory. `workerJob.ts` takes one
 * because it is generic and cannot know which file; every module that owns exactly one worker —
 * `pyodide/engine.ts`, `nodes/lib/arborDaylight.ts`, `data/files/client.ts` — writes the
 * `new Worker(new URL(…))` itself, and that literal is load-bearing twice over: vite needs it to
 * emit the chunk, and `src/test/importGraph.test.ts` finds every worker by scanning for it. With
 * the literal in a comment instead, this worker's import graph was never walked and the
 * "`onnxruntime-web` must not reach the main chunk" rule was a sentence rather than a test.
 *
 * **The caller owns the chunking.** `run` is one graph call. A full affinity matrix at N = 1024 is
 * a million pairs and about twelve seconds, which has to arrive in pieces that can be reported on,
 * and only the caller knows how big a piece should be. What it does *not* have to own is shipping
 * the encoder's output back and forth: `hold` keeps it in the worker.
 */

import { notLoaded, stopped } from '../data/workerJob'
import type { LoadedManifest } from './manifest'
import type { WireTensor, WorkerRequest, WorkerResponse } from './protocol'
import { transfersOf } from './protocol'
import type { WeightProgress } from './weights'

const LABEL = 'model runtime'

export interface OpenOptions {
  /** The manifest's address. Its files resolve against it, so one directory moves hosts freely. */
  readonly manifestUrl: string
  /**
   * Which build of the model to open. **Leave it unset unless you have a reason.**
   *
   * The default is `preferredVariant`: the smallest variant whose graphs this browser can
   * actually execute. Naming one yourself opts out of that check, and the failure it guards is
   * silent — an int8 build loads and answers, 16x slow, on the CPU.
   */
  readonly variant?: string
  /**
   * The task this caller can read the manifest's `config` as.
   *
   * Required, and compared with the manifest's own: `config` is `unknown` here by design — only
   * the owning pack parses it — and without a tag to check, a URL pointing at the wrong model
   * would be cast to a type it is not and answer with garbage rather than a sentence.
   */
  readonly task: string
  readonly onProgress?: (progress: WeightProgress) => void
  readonly signal?: AbortSignal
  /** Overridden only by a probe wanting a worker of its own making. */
  readonly createWorker?: () => Worker
}

export interface RunRequest {
  /** Which open model. Defaults to the one this session opened. */
  readonly model?: string
  readonly part: string
  readonly feeds?: readonly WireTensor[]
  /** Tensors already held in the worker to feed in alongside `feeds`. */
  readonly use?: readonly string[]
  /** Outputs to keep in the worker rather than send back. */
  readonly hold?: readonly string[]
  /** Outputs to send back. Defaults to the part's declared outputs, minus anything held. */
  readonly outputs?: readonly string[]
}

/**
 * The half of a session a scoring loop needs: the manifest to read names from, and `run`.
 *
 * Narrower than `ModelSession` on purpose — a caller that cannot `close` cannot close somebody
 * else's session — and it is what lets a test hand a loop the logits it already knows without
 * standing up a worker. Named here rather than in each pack, because two of them wrote the same
 * `Pick` under two names.
 */
export type GraphRunner = Pick<ModelSession, 'loaded' | 'run'>

export interface ModelSession {
  /** The checked manifest, fetched once by the worker. Read tensor names from its signatures. */
  readonly loaded: LoadedManifest
  run(request: RunRequest): Promise<readonly WireTensor[]>
  /** Drop held tensors. Named ones, or all of them. */
  release(names?: readonly string[]): Promise<void>
  close(): Promise<void>
}

/** The repo's cancellation, which every `AbortError` guard downstream tests for. */
const cancelled = () => new DOMException('Aborted', 'AbortError')

/**
 * Open a model, downloading and verifying its weights.
 *
 * Cancelling terminates the worker rather than asking it to stop: a `session.run` inside
 * ONNX Runtime has no interrupt point a message could reach, which is the conclusion
 * `workerJob.ts` came to for Python and holds here for the same reason.
 */
export async function openModel(options: OpenOptions): Promise<ModelSession> {
  const worker =
    options.createWorker?.() ??
    new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' })
  let nextId = 0
  let started = false
  let dead: Error | undefined
  const pending = new Map<
    number,
    {
      resolve: (message: WorkerResponse & { type: 'ok' }) => void
      reject: (error: Error) => void
    }
  >()

  const fail = (error: Error) => {
    dead ??= error
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
    else settle.resolve(message)
  }
  // A messageless error before the worker has answered anything is its code failing to load;
  // after that, its code ran and what ends it silently is nearly always memory — which for a
  // 385 MB WebGPU session is the likelier of the two. Two sentences, told apart the way
  // `workerJob.ts` tells them apart rather than by always blaming a stale deploy.
  worker.onerror = () => fail(new Error(started ? stopped(LABEL) : notLoaded(LABEL)))
  // A result the page cannot deserialise arrives as neither a message nor an error, so without
  // this the request simply never settles.
  worker.onmessageerror = () => fail(new Error(stopped(LABEL)))

  const send = (request: WorkerRequest, transfer: ArrayBuffer[] = []) =>
    new Promise<WorkerResponse & { type: 'ok' }>((resolve, reject) => {
      if (dead) return reject(dead)
      pending.set(request.id, { resolve, reject })
      worker.postMessage(request, transfer)
    })

  const onAbort = () => fail(cancelled())
  // Asked before the listener is attached: an abort listener does not fire for a signal that has
  // already aborted, so without this an open on a spent signal would hang.
  if (options.signal?.aborted) {
    worker.terminate()
    throw cancelled()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  let opened
  try {
    opened = await send({
      id: ++nextId,
      type: 'open',
      manifestUrl: options.manifestUrl,
      variant: options.variant,
      task: options.task,
    })
  } catch (error) {
    // No handle comes back, so nothing else can ever tear this down: a failed open otherwise
    // leaks the worker — possibly holding a 385 MB session — for the life of the tab.
    options.signal?.removeEventListener('abort', onAbort)
    worker.terminate()
    throw error
  }
  started = true
  const loaded = opened.loaded
  if (!loaded) {
    options.signal?.removeEventListener('abort', onAbort)
    worker.terminate()
    throw new Error('The worker opened a model but returned no manifest')
  }

  return {
    loaded,
    run: async ({ model = loaded.manifest.id, part, feeds = [], use, hold, outputs }) => {
      // `async`, so this rejects rather than throwing synchronously out of a method whose own
      // signature promises a Promise. Named here rather than one layer down as "x/y is not
      // open", which describes the symptom instead of the mistake.
      //
      // Only checkable for *this* session's model: a worker may hold several, and the others'
      // manifests live there rather than here, so the worker makes that call.
      if (model === loaded.manifest.id && !loaded.manifest.parts.includes(part)) {
        throw new Error(`${loaded.manifest.id} has no part called ${part}`)
      }
      return send(
        { id: ++nextId, type: 'run', model, part, feeds, use, hold, outputs },
        transfersOf(feeds),
      ).then((answer) => answer.tensors ?? [])
    },
    release: async (names) => {
      await send({ id: ++nextId, type: 'release', names })
    },
    close: async () => {
      options.signal?.removeEventListener('abort', onAbort)
      // Already torn down by an abort or a worker failure: there is nothing to tell it, and
      // posting into a dead worker leaves a promise that never settles.
      if (dead) return
      try {
        await send({ id: ++nextId, type: 'close' })
      } finally {
        worker.terminate()
      }
    },
  }
}
