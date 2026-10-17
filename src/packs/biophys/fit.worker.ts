/**
 * The worker half of a fit's evaluations (`fitPool.ts`): handed the setup once, then a membrane at a
 * time, answering each with its residuals, moved rather than copied.
 */

import { errorMessage } from '../../core/errors'
import type { FitSetup } from './fit'
import { residualsAt } from './fit'
import type { FitRequest, FitReply } from './fitPool'

let setup: FitSetup | undefined

// Not a worker — the page or a test importing the module — and nothing to serve.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<FitRequest>) => {
    const request = event.data
    const post = (reply: FitReply, moved: Transferable[] = []) =>
      self.postMessage(reply, { transfer: moved })
    if (request.type === 'setup') {
      setup = request.setup
      return post({ type: 'ready' })
    }
    try {
      if (!setup) throw new Error('A fit evaluation arrived before its setup.')
      const residuals = residualsAt(setup, request.membrane)
      post({ type: 'residuals', residuals }, [residuals.buffer])
    } catch (err) {
      post({ type: 'error', message: errorMessage(err) })
    }
  }
}
