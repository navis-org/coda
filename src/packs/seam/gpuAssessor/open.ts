/**
 * Open the hand-written WebGPU assessor: the same `ModelSession` as `openModel` gives, so it is a
 * drop-in for the ONNX Runtime one wherever the assessor is opened.
 *
 * `seam:findMergeCandidates` opens the assessor through this (as `ASSESSOR_RUNTIME`), and the
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

/**
 * How many patches a caller should keep in flight with this runtime (`scoreCandidates`'
 * `inFlight`).
 *
 * **Twelve, measured in both browsers** (2026-11-19, `pnpm probe:gpu-browsers`, M3 Max). In
 * Firefox every wait for the GPU costs ~100 ms whatever the work — an empty submit included — so
 * a patch waited on alone costs 100 ms against ~30 of computing; in flight together, 4 cost 50 ms
 * a patch, 12 cost 33, and 24 and 57 no less (33, 32). Chrome's patch is 21 ms alone and 19-20
 * at any depth. Past twelve there is nothing left to buy, and each patch in flight holds an
 * 8.5 MB upload in the browser's staging until the GPU reaches it.
 *
 * **Not six, though six measured the same here.** What a depth must do is keep the GPU busy
 * across one ~100 ms wait, and this laptop computes about three patches in that time; a GPU three
 * times as fast needs about ten. Twelve covers it, at ~100 MB of staging.
 *
 * Here and not in the scoring loop, because it is a fact about this runtime: ONNX Runtime's
 * worker is not known to take overlapping runs, so `scoreCandidates` defaults to one at a time
 * and `ASSESSOR_RUNTIME` carries this beside the opener it belongs to.
 */
export const GPU_ASSESSOR_IN_FLIGHT = 12

export function openGpuAssessor(
  options: Omit<OpenOptions, 'createWorker' | 'variant'>,
): Promise<ModelSession> {
  return openModel({
    ...options,
    variant: GPU_ASSESSOR_VARIANT,
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  })
}
