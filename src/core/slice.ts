/**
 * Handing the browser a turn in the middle of a long synchronous walk.
 *
 * Lifted out of `src/umap/run.ts`, which is where both halves were measured and where the
 * comments below come from. It moved the moment a second caller needed it: `Points in Volumes`
 * casts a ray per point, which at its own warning threshold is thirteen seconds of pure
 * arithmetic.
 *
 * **`sliced` is the part worth sharing, and the first version of this module did not share it.**
 * It lifted the constant and the two-line primitive and left every caller to write the loop —
 * and the loop is what had already been re-derived three ways: `runUmap` checks a signal and
 * reports per epoch, `labelPointsByVolume` took a throwing `onTick` because it had no signal to
 * check, and `brandesSweep` (`nodes/lib/networkCentrality.ts`) reports every 64 sources and
 * **never yields at all**, so the Cancel button and the progress bar on a node whose own warning
 * says "minutes" are both ornamental. Nobody was ever going to rewrite `yieldToBrowser`; what
 * people re-derive is *report, check the abort, yield on a clock*. So that is `sliced` below,
 * with `slice.test.ts` pinning it once instead of one node's suite pinning it for everybody.
 *
 * **One client today, and the other two are named rather than converted.** `runUmap`'s loop is
 * step-driven (`umap.step()` decides when it is done) and reports a note per epoch, which this
 * signature has no room for; `brandesSweep` gaining a yield is a behaviour change to a node
 * outside the change that brought this file into being. Both are one-function moves whenever
 * somebody is in there, which is the point of the helper existing before they are.
 *
 * Deliberately **not** a method on `EvalContext`. `warnOverThreshold` is the house shape for
 * this — a helper in `core` taking the narrow ctx-shaped interface it actually uses — and it is
 * the shape that works here: two of the three callers are lib functions with no `ctx` in scope,
 * and `src/umap` may not import node types at all.
 *
 * `src/core` rather than beside any caller because they are headless compute — `src/umap` and
 * `src/nodes/lib` — and none may import the others. It is `limits.ts`' slot: a node-facing
 * policy module the engine itself never calls.
 */

/**
 * How long a slice may run before yielding.
 *
 * Above a frame budget on purpose, and the yield below is why: a chain of `setTimeout(…, 0)`
 * hits Chrome's nested-timer clamp past five levels and costs about 4 ms of dead wall clock per
 * yield whatever the delay asked for. At 24 ms that is a sixth of the run spent waiting; the
 * shorter slices a smoother bar would want make it worse, not better. `scheduler.yield()` has
 * no such clamp and is used where the engine has it.
 */
export const SLICE_MS = 24

/**
 * Hand the browser a turn, without paying the nested-timer clamp where it can be avoided.
 *
 * `scheduler.yield()` resumes on the same task queue with no minimum delay; `setTimeout` is the
 * fallback and is still a *task* rather than a microtask, which is the part that matters — an
 * `await Promise.resolve()` runs before the browser gets to paint, so the progress it reports
 * would be progress nobody sees, and the click that would cancel the run never gets dispatched.
 */
export function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

/** What a sliced loop needs from its caller: somewhere to report, and something to obey. */
export interface Slicer {
  /** Fraction done, 0 to 1. Called on each slice boundary and once at the end. */
  progress?: (fraction: number) => void
  /** Checked on the same boundary. An aborted run rejects rather than resolving short. */
  signal?: AbortSignal
}

/**
 * Walk `total` items, handing the browser a turn whenever a slice has run long enough.
 *
 * **The clock is read on a stride that adapts, and the stride starts at one.** `performance.now()`
 * measured 23.7 ns inside a realistic loop here — 3% on a body that casts a ray, but 16% on one
 * that only sweeps bounding boxes and **52%** on a body that does nothing, which is exactly the
 * shape of the cheap cases. So the stride doubles up to `MAX_STRIDE` while slices come in under
 * budget, which costs a cheap walk about seven reads per slice and then amortises to nothing.
 *
 * **It was a fixed 64 and that made the loop uninterruptible for an expensive body**, which is
 * the failure this shape exists to prevent rather than a tuning question. The assumption was that
 * a body is microseconds — true of a ray or a box sweep, and not of `Distance between`, whose body is one
 * neuron *pair*: twenty thousand nearest-point searches, tens of milliseconds on skeletons and
 * hundreds on meshes. At 64 bodies between clock reads the signal was seen up to twenty-five
 * seconds after Cancel was pressed, and **a walk shorter than 64 items never read the clock at
 * all** — so a five-by-five comparison of meshes could not be stopped, which is how it was
 * reported. Starting at one, a body that has already outrun the slice yields immediately, and the
 * worst-case latency is one body rather than sixty-four.
 *
 * Progress is the items **done** — `i + 1`, not `i`. Reported the other way the bar sits one
 * item behind and every run opens at a flat zero, which is how it was written first.
 */
export async function sliced(
  total: number,
  ctx: Slicer,
  body: (index: number) => void,
): Promise<void> {
  let sliceStart = performance.now()
  let stride = 1
  let sinceRead = 0
  for (let i = 0; i < total; i++) {
    body(i)
    if (++sinceRead < stride) continue
    sinceRead = 0
    if (performance.now() - sliceStart < SLICE_MS) {
      // Under budget, so the clock is the expensive part here: look at it half as often, up to
      // the cap. A body costing a whole slice never gets past a stride of one.
      if (stride < MAX_STRIDE) stride *= 2
      continue
    }
    throwIfAborted(ctx.signal)
    ctx.progress?.((i + 1) / total)
    await yieldToBrowser()
    sliceStart = performance.now()
    // Re-learn per slice rather than keeping the widest stride reached: a walk whose bodies get
    // dearer part way through — a set of neurons sorted by size, which is the ordinary case —
    // would otherwise carry a stride chosen when they were cheap.
    stride = 1
  }
  throwIfAborted(ctx.signal)
  ctx.progress?.(1)
}

/**
 * The widest the clock stride grows: 64 items, which is where the old fixed mask sat.
 *
 * A ceiling rather than a setting — it bounds how stale the elapsed-time reading can be for a
 * *cheap* body, where 64 of them are still far under a frame. Expensive bodies never reach it.
 */
const MAX_STRIDE = 64

/**
 * `AbortError`, not a plain `Error`: an aborted run must **reject**, and the scheduler tells a
 * cancellation from a failure by the name. A local copy for the reason `src/umap/run.ts` keeps
 * one — `src/core` may not import `src/data`, where the original lives.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}
