/**
 * Open the hand-written WebGPU assessor: the same `ModelSession` as `openModel` gives, so it is a
 * drop-in for the ONNX Runtime one wherever the assessor is opened.
 *
 * `seam:suggestMerges` opens the assessor through this (as `ASSESSOR_RUNTIME`), and the
 * published manifest lists both builds. The variant is fixed here rather than taken from the
 * caller: the habit at an `openModel` site is to name `matmul`, which would download 133 MB
 * before `segclrPlan` refused it — the plain export is the only one it can read
 * (`gpuAssessor/worker.ts` says why).
 *
 * **Every opening site names its own build, and none may be left to `preferredVariant`**: it
 * takes the smallest runnable variant and the `conv` file is 0.2 MB smaller, so an ONNX Runtime
 * site left to choose would move to the 8x slower graph in silence. `src/ml/support.ts` records
 * that rule where the rule lives.
 *
 * The `new Worker(new URL(...))` literal is here, in the module that owns the worker, so that
 * vite emits the chunk and `src/test/importGraph.test.ts` walks its imports (`session.ts`
 * explains why the literal is load-bearing).
 */

import { openModel } from '../../../ml/session'
import type { ModelSession, OpenOptions } from '../../../ml/session'

/**
 * The manifest variant the hand-written assessor reads: the plain `Conv` export.
 *
 * Exported as well as pinned below, because the caller has to **price** it before it is opened —
 * `openSeamModel` sums the chosen variant's bytes for the download-consent sentence, and a second
 * spelling of `'conv'` there would ask the reader to approve one file and fetch another.
 */
export const GPU_ASSESSOR_VARIANT = 'conv'

export function openGpuAssessor(
  options: Omit<OpenOptions, 'createWorker' | 'variant'>,
): Promise<ModelSession> {
  return openModel({
    ...options,
    variant: GPU_ASSESSOR_VARIANT,
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  })
}
