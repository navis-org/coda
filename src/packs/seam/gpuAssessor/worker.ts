/// <reference types="@webgpu/types" />
/**
 * The hand-written assessor's worker: `src/ml/infer.worker.ts`' protocol, without ONNX Runtime.
 *
 * It answers the same four messages (`src/ml/protocol.ts`) so that `openModel` in
 * `src/ml/session.ts` drives it unchanged through its `createWorker` option — and so a caller
 * holding the session cannot tell the two apart. `scoreCandidates` (`assessorRun.ts`) takes a
 * `GraphRunner`, which is exactly what comes back.
 *
 * The weights come through the same verified cache as every other model (`loadWeights`), from the
 * manifest's **`conv`** variant: the plain export, whose weights are named by layer. The `matmul`
 * variant ONNX Runtime runs carries the same numbers cut into per-offset pieces, which this does
 * not reassemble (`segclrPlan.ts` refuses it in a sentence).
 *
 * Held tensors (`hold` / `use`) are refused: the assessor is one graph, one input, one output,
 * and nothing in its loop holds anything.
 *
 * **One model per worker.** `openModel` makes a worker per open and terminates it on close or
 * failure, so a second open never reaches this one; it is refused rather than half-supported.
 */

import { errorMessage } from '../../../core/errors'
import { completeVariants, loadManifest, soleGraph } from '../../../ml/manifest'
import type { WireTensor, WorkerRequest, WorkerResponse } from '../../../ml/protocol'
import { transfersOf } from '../../../ml/protocol'
import { loadWeights } from '../../../ml/weights'
import { assessorDevice, buildNetwork } from './network'
import type { AssessorNetwork } from './network'
import { readOnnx } from './onnxProto'
import { segclrPlan } from './segclrPlan'

interface Open {
  readonly id: string
  readonly part: string
  readonly input: string
  readonly output: string
  readonly network: AssessorNetwork
}

let opened: Open | undefined

const post = (message: WorkerResponse, transfer: ArrayBuffer[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

async function open(
  id: number,
  manifestUrl: string,
  variant: string | undefined,
  task: string,
) {
  if (opened) throw new Error('This worker already holds an assessor; open another worker')
  // Asked before the manifest: the adapter does not depend on it.
  const gpu = assessorDevice()
  gpu.catch(() => {}) // Awaited below; a manifest refusal first must not leave this unhandled.
  const loaded = await loadManifest(manifestUrl)
  const { manifest } = loaded
  if (manifest.task !== task) {
    throw new Error(`${manifestUrl} is a ${manifest.task} model; this asked for ${task}`)
  }
  // Named by `open.ts`, never defaulted here: a second answer to "which build" is how the two
  // came to disagree in `preferredVariant`'s case.
  if (!variant) throw new Error('The hand-written assessor was opened without naming its build')
  const { part, signature } = soleGraph(manifest)
  if (signature.inputs.length !== 1 || signature.outputs.length !== 1) {
    throw new Error(`${manifest.id} does not take one input and return one output`)
  }
  if (!manifest.files.some((file) => file.variant === variant && file.part === part)) {
    throw new Error(
      `${manifest.id} has no ${variant} build, which the hand-written assessor reads: it needs ` +
        `the plain Conv export beside the ${completeVariants(manifest).join(', ')} one.`,
    )
  }
  // The GPU and the weights together: neither waits on the other.
  const [ready, weights] = await Promise.all([
    gpu,
    loadWeights(loaded, variant, part, {
      onProgress: (progress) => post({ id, type: 'progress', progress }),
    }),
  ])
  const network = await buildNetwork(ready, segclrPlan(readOnnx(new Uint8Array(weights.bytes))))
  // After the network is built, as `infer.worker.ts` does: the cache write is another copy of
  // the same 133 MB, and firing it alongside the upload raised the peak for nothing.
  weights.remember()
  opened = {
    id: manifest.id,
    part,
    input: signature.inputs[0]!,
    output: signature.outputs[0]!,
    network,
  }
  return loaded
}

/**
 * Checked synchronously and handed to the network, and the answer returned as a promise that
 * closes over nothing of the request: with patches in flight (`GPU_ASSESSOR_IN_FLIGHT`), a
 * request held until its answer would keep twelve 8.4 MB patches alive that the GPU already has.
 */
function run(request: Extract<WorkerRequest, { type: 'run' }>): Promise<WireTensor[]> {
  const model = opened
  if (!model || request.model !== model.id || request.part !== model.part)
    throw new Error(`${request.model}/${request.part} is not open`)
  if (request.use?.length || request.hold?.length) {
    throw new Error('The hand-written assessor holds no tensors between runs')
  }
  const feed = request.feeds.find((one) => one.name === model.input)
  if (!feed || feed.type !== 'float32')
    throw new Error(`${model.part} needs a float32 ${model.input}`)
  // The whole shape, not just the count: a feed whose product matched with other sides would be
  // read as (X, Y, Z) at 129 and scored as a different patch.
  const { edge } = model.network
  const shape = [1, edge, edge, edge]
  if (feed.dims.join() !== shape.join()) {
    throw new Error(
      `${model.part} takes one ${shape.slice(1).join('×')} patch a run, not ${feed.dims.join('×')}`,
    )
  }
  const wanted = request.outputs ?? [model.output]
  if (wanted.some((name) => name !== model.output)) {
    throw new Error(`${model.part} has one output, ${model.output}`)
  }
  const { output } = model
  return model.network
    .score(new Float32Array(feed.data))
    .then((logit) => [
      { name: output, type: 'float32', dims: [1], data: Float32Array.of(logit).buffer },
    ])
}

/** Post a run's answer once it comes, holding only its id. */
async function answer(id: number, tensors: Promise<WireTensor[]>) {
  try {
    const got = await tensors
    post({ id, type: 'ok', tensors: got }, transfersOf(got))
  } catch (error) {
    post({ id, type: 'error', message: errorMessage(error) })
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'run') {
    // Not awaited in this frame, which holds the request and so the patch (`run`).
    let tensors: Promise<WireTensor[]>
    try {
      tensors = run(request)
    } catch (error) {
      tensors = Promise.reject(error)
    }
    void answer(request.id, tensors)
    return
  }
  try {
    if (request.type === 'open') {
      const loaded = await open(request.id, request.manifestUrl, request.variant, request.task)
      post({ id: request.id, type: 'ok', loaded })
    } else if (request.type === 'release') {
      // Nothing is ever held, so there is nothing to drop.
      post({ id: request.id, type: 'ok' })
    } else {
      opened?.network.destroy()
      opened = undefined
      post({ id: request.id, type: 'ok' })
    }
  } catch (error) {
    post({ id: request.id, type: 'error', message: errorMessage(error) })
  }
}
