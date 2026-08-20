/**
 * The worker the Python runtime lives in.
 *
 * Thin on purpose: everything it knows is in `runtime.ts`, so the only thing that is
 * worker-shaped here is the message plumbing. It exists at all because the work is not
 * something the canvas can sit through — an all-by-all of 400 neurons measures at about ten
 * seconds, and the boot before it is a ten-megabyte download.
 */

import { errorMessage } from '../core/errors'
import { callPython } from './runtime'
import type { WorkerReply, WorkerRequest } from './types'

/*
 * `lib.dom` has no `DedicatedWorkerGlobalScope` — that lives in `lib.webworker`, which cannot
 * be added to a project whose other 200 files are DOM. Naming the two members this file uses
 * is smaller than a second tsconfig, and it fails just as loudly if either changes.
 */
interface WorkerScope {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void
}

const scope = self as unknown as WorkerScope

/**
 * Hand the result's buffers back rather than copying them.
 *
 * Only the arrays: a result is a flat dict of scalars and typed arrays, and a scalar has
 * nothing to transfer. Anything the worker still needed after this would be detached, which is
 * safe here because the result is built for this reply and dropped.
 */
function transferable(result: Record<string, unknown>): Transferable[] {
  const out: Transferable[] = []
  for (const value of Object.values(result)) {
    if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer)
  }
  return out
}

scope.addEventListener('message', (event) => {
  const { id, call } = event.data
  void (async () => {
    try {
      const result = await callPython(call.module, call.fn, call.args, (fraction, note) => {
        scope.postMessage({ id, kind: 'progress', fraction, note })
      })
      scope.postMessage({ id, kind: 'done', result }, transferable(result))
    } catch (error) {
      scope.postMessage({ id, kind: 'error', message: errorMessage(error) })
    }
  })()
})
