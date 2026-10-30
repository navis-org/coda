/**
 * The inference worker: the only place `onnxruntime-web` is loaded.
 *
 * Long-lived and multiplexed rather than one-shot, so it is not `data/workerJob.ts`' shape — that
 * file says why Pyodide keeps its own, and this is the same reason. A point affinity run is one
 * encoder pass and then thousands of decoder calls against the latents it produced; recreating a
 * 385 MB session per call is not a thing to do, and neither is shipping the latents back and
 * forth, which is why they can be held here by name.
 *
 * **The import is dynamic and inside the worker.** `onnxruntime-web` is ~20 MB. A static import in
 * a module the main thread can reach would put it in the main chunk, and through `src/packs/**`
 * into the MCP build and the static pages. `src/test/importGraph.test.ts` walks this file's graph
 * because `session.ts` names it in a `new Worker(new URL('./infer.worker.ts', …))` literal, which
 * is what turns that rule from a comment into a test.
 *
 * **WebGPU only.** The CPU path is not a degraded mode, it is a different product: the int8
 * variant, which WebGPU declines and so runs on the CPU, measured 8.4 s against 0.5 s for one
 * encoder pass (docs/ml.md). `support.ts` refuses before anything is downloaded.
 */

// A type-only import, which `verbatimModuleSyntax` erases entirely -- the runtime arrives through
// the dynamic `import()` in `open` and nowhere else.
import type * as OrtModule from 'onnxruntime-web/webgpu'

import { errorMessage } from '../core/errors'
import { loadManifest } from './manifest'
import type { LoadedManifest } from './manifest'
import { preferredVariant } from './support'
import { loadWeights } from './weights'
import type { WireTensor, WireType, WorkerRequest, WorkerResponse } from './protocol'
import { transfersOf } from './protocol'

type Ort = typeof OrtModule
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>
/** ONNX Runtime's tensor, as much of it as this file touches. */
type OrtTensor = { type: string; dims: readonly number[]; data: unknown }

const VIEWS = { float32: Float32Array, int64: BigInt64Array, bool: Uint8Array } as const

let ort: Ort | undefined
/** Every open model's manifest, by id. Several may be open at once. */
const models = new Map<string, LoadedManifest>()
/** Sessions by `${model}/${part}`, so two models' graphs cannot collide on a part name. */
const sessions = new Map<string, Session>()
/**
 * Outputs kept here between calls, so the big ones never cross the boundary.
 *
 * Deliberately **not** scoped per model: the type head this seam is built to carry runs on the
 * affinity encoder's latents, and scoping would put them out of its reach for no benefit.
 */
const held = new Map<string, { tensor: OrtTensor; model: string }>()

const post = (message: WorkerResponse, transfer: ArrayBuffer[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

function toTensor(ortLib: Ort, wire: WireTensor) {
  // `as never`: ORT's `Tensor` overloads are per-dtype and cannot be satisfied from a union.
  return new ortLib.Tensor(wire.type, new VIEWS[wire.type](wire.data) as never, [...wire.dims])
}

function fromTensor(name: string, tensor: OrtTensor): WireTensor {
  const data = tensor.data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  // `slice` rather than the view's own buffer: ORT may hand back a view into a larger arena, and
  // transferring that would detach everything else sharing it.
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return { name, type: tensor.type as WireType, dims: [...tensor.dims], data: bytes }
}

/** Drop a held tensor, disposing it first. A GPU-located tensor is leaked by a bare delete. */
function drop(name: string): void {
  const tensor = held.get(name)?.tensor as { dispose?: () => void } | undefined
  // A CPU tensor's `dispose` is a no-op today, so this costs nothing — and it is what makes
  // `preferredOutputLocation: 'gpu-buffer'` a one-line change later rather than a silent leak
  // of every held buffer for the worker's life.
  tensor?.dispose?.()
  held.delete(name)
}

/** Release one model's sessions, if it is open. Used before a re-open and by `close`. */
async function closeModel(id: string): Promise<void> {
  for (const [key, session] of [...sessions]) {
    if (key.startsWith(`${id}/`)) {
      await session.release()
      sessions.delete(key)
    }
  }
  // Its held outputs go with it. Leaving them is stale latents today and, once an output can be
  // a GPU buffer owned by the released session, a use-after-free.
  for (const [name, entry] of [...held]) if (entry.model === id) drop(name)
  models.delete(id)
}

async function open(
  id: number,
  manifestUrl: string,
  chosen: string | undefined,
  task: string,
): Promise<LoadedManifest> {
  // Started together: the ~20 MB runtime fetch has no dependency on the manifest, and
  // serialising them paid a whole network round trip on every cold open.
  // Started, not awaited: the ~20 MB runtime fetch has no dependency on the manifest, and
  // awaiting it first serialised two independent cold costs.
  const runtimeReady =
    ort ??
    import('onnxruntime-web/webgpu').then((module) => {
      // Single-threaded. Not a performance choice: ONNX Runtime otherwise spawns wasm worker
      // threads, which needs `SharedArrayBuffer` and so the cross-origin isolation (COOP/COEP)
      // this app does not set. The compute is on the GPU regardless; the wasm side is glue.
      //
      // **Nothing sets `env.wasm.wasmPaths` here, and setting it hangs this worker.** The
      // package's default export is the *bundled* build, with its wasm inlined; pointing
      // `wasmPaths` at an external binary made `InferenceSession.create` never settle — no
      // error, no rejection, a model that opens for ever. The symptom that leads here is a
      // fetch answering `<!doctype`, and the fix for that is `optimizeDeps.exclude` in
      // `vite.config.ts`, not a path override. See docs/ml.md.
      module.env.wasm.numThreads = 1
      return module
    })
  const [loaded, runtime] = await Promise.all([loadManifest(manifestUrl), runtimeReady])
  ort = runtime
  if (loaded.manifest.task !== task) {
    throw new Error(`${manifestUrl} is a ${loaded.manifest.task} model; this asked for ${task}`)
  }
  // Chosen here rather than by the caller: this is where the manifest is, and the op inventory
  // it reads is the one thing standing between a reader and a model that runs on the CPU.
  const variant = chosen ?? preferredVariant(loaded.manifest)
  if (!variant) {
    throw new Error(
      `No build of ${loaded.manifest.id} can run on WebGPU here. ` +
        `Its variants need ops this browser's backend does not implement.`,
    )
  }
  // Built into a staging map and installed only once every part succeeded. A half-open model
  // would otherwise leave a 385 MB session nobody can reach or release, and a re-open would
  // overwrite the live sessions without releasing them.
  const built = new Map<string, Session>()
  try {
    for (const part of loaded.manifest.parts) {
      const weights = await loadWeights(loaded, variant, part, {
        onProgress: (progress) => post({ id, type: 'progress', progress }),
      })
      built.set(
        part,
        await runtime.InferenceSession.create(new Uint8Array(weights.bytes), {
          executionProviders: ['webgpu'],
        }),
      )
      // After the session is built, never before: the cache write is another copy of the same
      // 385 MB, and firing it alongside `create` tripled the peak.
      weights.remember()
    }
  } catch (error) {
    for (const session of built.values()) await session.release()
    throw error
  }
  await closeModel(loaded.manifest.id)
  for (const [part, session] of built) sessions.set(`${loaded.manifest.id}/${part}`, session)
  models.set(loaded.manifest.id, loaded)
  return loaded
}

async function run(request: Extract<WorkerRequest, { type: 'run' }>): Promise<WireTensor[]> {
  const loaded = models.get(request.model)
  const session = sessions.get(`${request.model}/${request.part}`)
  if (!loaded || !session || !ort)
    throw new Error(`${request.model}/${request.part} is not open`)

  const input: Record<string, unknown> = {}
  for (const name of request.use ?? []) {
    const tensor = held.get(name)
    if (!tensor) throw new Error(`No ${name} is held; run the graph that produces it first`)
    input[name] = tensor.tensor
  }
  for (const feed of request.feeds) input[feed.name] = toTensor(ort, feed)

  const keep = new Set(request.hold ?? [])
  const declared = loaded.manifest.signatures[request.part]?.outputs ?? []
  // Defaulted here rather than on the main thread, which would be a second statement of the
  // same rule against a manifest the worker already holds.
  const wanted = request.outputs ?? declared.filter((name) => !keep.has(name))
  // The `fetches` form: ask only for what is kept or wanted, so no future part pays a GPU
  // download for an output nobody reads.
  const asked = [...new Set([...keep, ...wanted])]
  const result = (await session.run(input as never, asked as never)) as unknown as Record<
    string,
    OrtTensor
  >

  const got = (name: string) => {
    const tensor = result[name]
    if (!tensor) throw new Error(`The ${request.part} produced no ${name}`)
    return tensor
  }
  for (const name of keep) {
    // `got` first: dropping before it would destroy the tensor currently held under this name
    // and then throw, leaving the next call to fail with an unrelated "No X is held".
    const tensor = got(name)
    drop(name)
    held.set(name, { tensor, model: request.model })
  }
  return wanted.map((name) => fromTensor(name, got(name)))
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'open') {
      const loaded = await open(request.id, request.manifestUrl, request.variant, request.task)
      post({ id: request.id, type: 'ok', loaded })
      return
    }
    if (request.type === 'run') {
      const tensors = await run(request)
      post({ id: request.id, type: 'ok', tensors }, transfersOf(tensors))
      return
    }
    if (request.type === 'release') {
      for (const name of request.names ?? [...held.keys()]) drop(name)
      post({ id: request.id, type: 'ok' })
      return
    }
    for (const name of [...held.keys()]) drop(name)
    for (const session of sessions.values()) await session.release()
    sessions.clear()
    models.clear()
    post({ id: request.id, type: 'ok' })
  } catch (error) {
    post({ id: request.id, type: 'error', message: errorMessage(error) })
  }
}
