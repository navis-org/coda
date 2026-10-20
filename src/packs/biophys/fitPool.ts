/**
 * A fit's evaluations spread over workers that live as long as the fit: each is handed the setup
 * once and then one membrane at a time, so an iteration's Jacobian — one evaluation per free
 * parameter, asked for in one batch (`leastSquares`) — costs about one evaluation of wall time.
 *
 * Not `runWorkerJob`: that is a worker per job, and a fit is hundreds of evaluations of one setup,
 * which would be cloned into a fresh worker every time. **Cancel terminates** every worker, as it
 * does there, a simulation having no interrupt point a message could reach.
 *
 * **The caller makes each worker**, for the reason `workerJob.ts` gives: the `new Worker(new URL(…))`
 * literal has to be where vite can see it. Where there is no `Worker` — jsdom, Node — the fit runs
 * on this thread (`evaluatorHere`).
 */

import { notLoaded, stopped } from '../../data/workerJob'
import type { Evaluator, FitSetup } from './fit'
import type { FitMembrane } from './passive'
import { evaluatorHere } from './fit'

export type FitRequest =
  | { readonly type: 'setup'; readonly setup: FitSetup }
  | { readonly type: 'evaluate'; readonly membrane: FitMembrane }

export type FitReply =
  /** Sent on receiving the setup: the worker's code loaded, so a silent death after it is not a load failure. */
  | { readonly type: 'ready' }
  /** One evaluation in flight per worker, so a reply needs no id: it answers the worker's `busy`. */
  | { readonly type: 'residuals'; readonly residuals: Float64Array }
  | { readonly type: 'error'; readonly message: string }

const LABEL = 'fit worker'

export interface FitPool {
  readonly evaluate: Evaluator
  /** Ends every worker; anything still waiting is rejected. */
  close(): void
}

/**
 * `size` workers for one setup, at most; one where a batch never holds more. Rejects every pending
 * evaluation on `signal`, a worker's error, or `close`.
 */
export function fitPool(
  spawn: () => Worker,
  setup: FitSetup,
  size: number,
  signal?: AbortSignal,
): FitPool {
  if (typeof Worker === 'undefined') return { evaluate: evaluatorHere(setup), close: () => {} }

  interface Pending {
    readonly membrane: FitMembrane
    readonly resolve: (r: Float64Array) => void
    readonly reject: (e: unknown) => void
  }
  const workers: { worker: Worker; busy: Pending | undefined; loaded: boolean }[] = []
  const queue: Pending[] = []
  let failure: unknown

  const fail = (err: unknown) => {
    if (failure !== undefined) return
    failure = err
    for (const w of workers) {
      w.worker.terminate()
      w.busy?.reject(err)
      w.busy = undefined
    }
    for (const p of queue.splice(0)) p.reject(err)
  }
  const abort = () => fail(new DOMException('Aborted', 'AbortError'))
  signal?.addEventListener('abort', abort, { once: true })

  const pump = () => {
    for (const w of workers) {
      if (w.busy || queue.length === 0) continue
      const next = queue.shift()!
      w.busy = next
      w.worker.postMessage({
        type: 'evaluate',
        membrane: next.membrane,
      } as FitRequest)
    }
  }

  const grow = () => {
    const slot = { worker: spawn(), busy: undefined as Pending | undefined, loaded: false }
    slot.worker.onmessage = (event: MessageEvent<FitReply>) => {
      const reply = event.data
      slot.loaded = true
      if (reply.type === 'ready') return
      // Still busy while failing, so `fail` rejects the evaluation that failed with the rest.
      if (reply.type === 'error') return fail(new Error(reply.message))
      const done = slot.busy
      slot.busy = undefined
      done?.resolve(reply.residuals)
      pump()
    }
    // A message-less error is the module failing to load before it said `ready`, and the worker
    // dying — memory, nearly always — after it.
    slot.worker.onerror = (event) =>
      fail(new Error(event.message || (slot.loaded ? stopped(LABEL) : notLoaded(LABEL))))
    slot.worker.onmessageerror = () =>
      fail(new Error(`The ${LABEL}'s answer could not be read`))
    slot.worker.postMessage({ type: 'setup', setup } as FitRequest)
    workers.push(slot)
  }

  const evaluate: Evaluator = (membranes) => {
    if (signal?.aborted) abort()
    if (failure !== undefined) return Promise.reject(failure)
    // Started as the batches ask for them, so a one-at-a-time stretch keeps one worker.
    while (workers.length < Math.min(size, membranes.length)) grow()
    const answers = membranes.map(
      (membrane) =>
        new Promise<Float64Array>((resolve, reject) =>
          queue.push({ membrane, resolve, reject }),
        ),
    )
    pump()
    return Promise.all(answers)
  }

  return {
    evaluate,
    close: () => {
      signal?.removeEventListener('abort', abort)
      fail(new DOMException('Closed', 'AbortError'))
    },
  }
}
