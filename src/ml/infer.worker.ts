/**
 * The inference worker: the only place `onnxruntime-web` is loaded.
 *
 * Long-lived and multiplexed rather than one-shot, so it is not `data/workerJob.ts`' shape — that
 * file says why Pyodide keeps its own, and this is the same reason. A point affinity run is one
 * encoder pass and then thousands of decoder calls against the latents it produced; recreating a
 * 385 MB session per call is not a thing to do.
 *
 * **The import is dynamic and inside the worker.** `onnxruntime-web` is ~20 MB of JavaScript and
 * wasm. A static import at the top of a module the main thread can reach would put it in the main
 * chunk, and through `src/packs/**` into the MCP build and the static pages.
 *
 * **WebGPU only.** The CPU path is not a degraded mode, it is a different product: the int8
 * variant, which WebGPU declines and so falls back, measured 8.4 s against 0.5 s for one encoder
 * pass (docs/proofread-plan.md). `support.ts` refuses before anything is downloaded.
 */

// A type-only import, which `verbatimModuleSyntax` erases entirely -- the runtime arrives through
// the dynamic `import()` in `open` and nowhere else. Written this way rather than as a
// `typeof import(...)` annotation so the shape is stated once and the lint rule is satisfied.
import type * as OrtModule from 'onnxruntime-web/webgpu'

import { loadManifest } from './manifest'
import type { ModelPart } from './manifest'
import { loadWeights } from './weights'
import type { WireTensor, WorkerRequest, WorkerResponse } from './protocol'
import { transferable } from './protocol'

type Ort = typeof OrtModule
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>

let ort: Ort | undefined
const sessions = new Map<ModelPart, Session>()

const post = (message: WorkerResponse, transfer: ArrayBuffer[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

/** The ONNX Runtime tensor constructors want a typed array of the right kind. */
function toTensor(ortLib: Ort, wire: WireTensor) {
  const { data, type, dims } = wire
  const view =
    type === 'float32'
      ? new Float32Array(data)
      : type === 'int64'
        ? new BigInt64Array(data)
        : new Uint8Array(data)
  return new ortLib.Tensor(type, view as never, dims as number[])
}

function fromTensor(
  name: string,
  tensor: { type: string; dims: readonly number[]; data: unknown },
) {
  const data = tensor.data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  // `slice` rather than the view's own buffer: ORT may hand back a view into a larger arena, and
  // transferring that would detach everything else sharing it.
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return { name, type: tensor.type as WireTensor['type'], dims: [...tensor.dims], data: bytes }
}

async function open(id: number, manifestUrl: string, variant: string): Promise<void> {
  const loaded = await loadManifest(manifestUrl)
  ort ??= await import('onnxruntime-web/webgpu')
  for (const part of ['encoder', 'decoder'] as const) {
    const bytes = await loadWeights(loaded, variant, part, {
      onProgress: (progress) => post({ id, type: 'progress', progress }),
    })
    sessions.set(
      part,
      await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: ['webgpu'],
      }),
    )
  }
}

async function run(
  part: ModelPart,
  feeds: readonly WireTensor[],
  outputs: readonly string[],
): Promise<WireTensor[]> {
  const session = sessions.get(part)
  if (!session || !ort) throw new Error(`The ${part} is not open`)
  const input: Record<string, unknown> = {}
  for (const feed of feeds) input[feed.name] = toTensor(ort, feed)
  const result = (await session.run(input as never)) as unknown as Record<
    string,
    { type: string; dims: readonly number[]; data: unknown }
  >
  return outputs.map((name) => {
    const tensor = result[name]
    if (!tensor) throw new Error(`The ${part} produced no ${name}`)
    return fromTensor(name, tensor)
  })
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'open') {
      await open(request.id, request.manifestUrl, request.variant)
      post({ id: request.id, type: 'ok' })
      return
    }
    if (request.type === 'run') {
      const tensors = await run(request.part, request.feeds, request.outputs)
      post({ id: request.id, type: 'ok', tensors }, transferable(tensors))
      return
    }
    for (const session of sessions.values()) await session.release()
    sessions.clear()
    post({ id: request.id, type: 'ok' })
  } catch (error) {
    post({ id: request.id, type: 'error', message: String(error) })
  }
}
