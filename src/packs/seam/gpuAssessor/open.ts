/**
 * Open the hand-written WebGPU assessor: the same `ModelSession` as `openModel` gives, so it is a
 * drop-in for the ONNX Runtime one wherever the assessor is opened.
 *
 * To swap, the opening site changes from `openModel({ manifestUrl, task })` to
 * `openGpuAssessor({ manifestUrl, task })`, and the manifest must list a `conv` variant — the
 * plain export (`gpuAssessor/worker.ts` says why the `matmul` one will not do). The variant is
 * fixed here rather than taken from the caller: the habit at an `openModel` site is to name
 * `matmul`, which would download 133 MB before `segclrPlan` refused it. Note that adding
 * that variant changes what the ONNX Runtime path picks: `preferredVariant` takes the smallest
 * runnable variant, and the `conv` file is 0.2 MB smaller, so that path must then name
 * `variant: 'matmul'` or it silently moves to the 8x slower graph.
 *
 * The `new Worker(new URL(...))` literal is here, in the module that owns the worker, so that
 * vite emits the chunk and `src/test/importGraph.test.ts` walks its imports (`session.ts`
 * explains why the literal is load-bearing).
 */

import { openModel } from '../../../ml/session'
import type { ModelSession, OpenOptions } from '../../../ml/session'

/** The manifest variant the hand-written assessor reads: the plain `Conv` export. */
const GPU_ASSESSOR_VARIANT = 'conv'

export function openGpuAssessor(
  options: Omit<OpenOptions, 'createWorker' | 'variant'>,
): Promise<ModelSession> {
  return openModel({
    ...options,
    variant: GPU_ASSESSOR_VARIANT,
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  })
}
