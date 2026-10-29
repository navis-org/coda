/**
 * What the inference worker and its caller say to each other.
 *
 * A separate file because both halves import it and neither may import the other: the worker must
 * not pull the main thread's module graph in behind it, and the main thread must never reach
 * `onnxruntime-web`, which is ~20 MB of wasm and JavaScript that `nodes.html` and the MCP build
 * must not acquire (docs/packs.md gives the rule, for glyph tables, and it is the same one).
 *
 * **Tensors cross as plain buffers**, not as ONNX Runtime tensors: the type lives only in the
 * worker, and a structured clone of one would copy the weights-sized arrays it wraps. Every
 * buffer is transferred, so a `WireTensor` posted is a `WireTensor` detached — read its length
 * before you post it, the trap `callPython` already documents.
 */

import type { ModelPart } from './manifest'
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
  /** Fetch and verify the weights, then create both sessions. One per worker. */
  | {
      readonly id: number
      readonly type: 'open'
      readonly manifestUrl: string
      readonly variant: string
    }
  /** Run one graph. `outputs` names what to send back, so nothing large is returned unasked. */
  | {
      readonly id: number
      readonly type: 'run'
      readonly part: ModelPart
      readonly feeds: readonly WireTensor[]
      readonly outputs: readonly string[]
    }
  | { readonly id: number; readonly type: 'close' }

export type WorkerResponse =
  | { readonly id: number; readonly type: 'ok'; readonly tensors?: readonly WireTensor[] }
  | { readonly id: number; readonly type: 'error'; readonly message: string }
  /** Download progress for an `open`. Does not settle the request. */
  | { readonly id: number; readonly type: 'progress'; readonly progress: WeightProgress }

/** Every transferable buffer in a message, so a post moves its tensors instead of copying them. */
export function transferable(tensors: readonly WireTensor[] | undefined): ArrayBuffer[] {
  return (tensors ?? []).map((t) => t.data)
}
