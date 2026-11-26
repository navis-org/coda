/**
 * What the inference worker and its caller say to each other.
 *
 * A separate file because both halves import it and neither may import the other: the worker must
 * not pull the main thread's module graph in behind it, and the main thread must never reach
 * `onnxruntime-web`, which is ~20 MB of wasm and JavaScript that `nodes.html` and the MCP build
 * must not acquire.
 *
 * **Big tensors do not cross.** A graph's output can be *held* in the worker under a name and fed
 * straight back into the next graph. That is not an optimisation bolted on: the encoder/decoder
 * split exists so the latents are computed once and kept, and a protocol that returned them would
 * send 6.3 MB back and forth per decode call — hundreds of megabytes over a run. Worse, what does
 * cross is **transferred**, so a returned tensor is detached on the main thread and a second call
 * with it throws. What crosses is the pair indices in and the affinities out.
 *
 * **One worker may hold several models**, keyed by id, and they share the held tensors. That
 * sharing is the feature, not an accident: the next model this seam is meant to carry is a
 * one-graph type head that runs on the *affinity encoder's* latents, and a worker per model could
 * only reach them by shipping them back across the boundary.
 */

import type { LoadedManifest } from './manifest'
import type { WeightProgress } from './weights'

/** The dtypes this seam carries. ONNX has more; these are the ones the graphs declare. */
export type WireType = 'float32' | 'int64' | 'bool'

export interface WireTensor {
  readonly name: string
  readonly type: WireType
  readonly dims: readonly number[]
  readonly data: ArrayBuffer
}

export type WorkerRequest =
  /** Fetch and verify every part's weights, then create their sessions. Additive: open again
   *  for a second model and both stay open in one worker. */
  | {
      readonly id: number
      readonly type: 'open'
      readonly manifestUrl: string
      /** Absent means `preferredVariant`: the smallest one this browser can actually run. */
      readonly variant?: string
      /** Refused if the manifest's own `task` differs — a wrong URL is caught here, not by a cast. */
      readonly task: string
    }
  /**
   * Run one graph of one model.
   *
   * `use` names tensors already held in the worker to feed in alongside `feeds`; `hold` names
   * outputs to keep there instead of sending back; `outputs` names what to send back, and when
   * absent means the part's declared outputs minus anything held.
   */
  | {
      readonly id: number
      readonly type: 'run'
      readonly model: string
      readonly part: string
      readonly feeds: readonly WireTensor[]
      readonly use?: readonly string[]
      readonly hold?: readonly string[]
      readonly outputs?: readonly string[]
    }
  /** Drop held tensors. `close` clears them too; this is for a caller reusing one open model. */
  | { readonly id: number; readonly type: 'release'; readonly names?: readonly string[] }
  | { readonly id: number; readonly type: 'close' }

export type WorkerResponse =
  | {
      readonly id: number
      readonly type: 'ok'
      readonly tensors?: readonly WireTensor[]
      /** Returned by `open`, so the main thread need not fetch the manifest a second time. */
      readonly loaded?: LoadedManifest
    }
  | { readonly id: number; readonly type: 'error'; readonly message: string }
  /** Download progress for an `open`. Does not settle the request. */
  | { readonly id: number; readonly type: 'progress'; readonly progress: WeightProgress }

/**
 * The buffers to move rather than copy when posting these tensors.
 *
 * Here rather than inline at the two call sites so the rule — what crosses this seam is
 * transferred — sits beside the type it is about. Note `workerJob.ts`' `buffersIn` is *not* the
 * helper for this: it collects the buffers behind typed-array *views*, and a `WireTensor.data` is
 * a bare `ArrayBuffer`, so it would return nothing and silently copy 6.3 MB a call.
 */
export function transfersOf(tensors: readonly WireTensor[]): ArrayBuffer[] {
  return tensors.map((t) => t.data)
}
