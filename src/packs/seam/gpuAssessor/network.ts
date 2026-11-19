/// <reference types="@webgpu/types" />
/**
 * The mask assessor on WebGPU, without ONNX Runtime: one compute pass a patch.
 *
 * `segclrPlan.ts` says what to compute and `shaders.ts` how; this owns the GPU side — the buffers,
 * the pipelines, and the one submit per patch. Everything is allocated when the network is built
 * and reused for every patch, so scoring a patch is one 8.5 MB upload, ~40 dispatches and a
 * 4-byte read back.
 *
 * **One patch at a time.** The scoring loop (`assessorRun.ts`) already feeds one, and the
 * buffers are shared between calls, so `score` queues its callers rather than interleaving them.
 *
 * **The network keeps nothing of the plan.** The plan's weights are views into the 133 MB file,
 * so a scoring method closing over the build's scope would keep the file alive for the session
 * (CLAUDE.md: a long-lived closure keeps its whole creating scope). The build hands an
 * `AssessorNetwork` only the GPU objects, and the CPU side of the weights is garbage once the
 * build returns.
 */

import { errorMessage } from '../../../core/errors'
import { gpuSupport } from '../../../ml/support'
import type { AssessorPlan, ConvStep, PlanStep } from './segclrPlan'
import { PATCH, bufferSlots, outputOf } from './segclrPlan'
import {
  convLayout,
  convShader,
  convWeightFloats,
  convWeightLayout,
  encodeShader,
  epilogueParams,
  FLAT,
  headShader,
  maxPoolShader,
  reduceShader,
  stemGroups,
  stemShader,
} from './shaders'

export interface StepTiming {
  readonly name: string
  readonly ms: number
}

/** A GPU, with the WebGPU refusal `src/ml` words for every model. */
export async function assessorDevice(): Promise<GPUDevice> {
  const { refusal } = await gpuSupport()
  if (refusal) throw new Error(refusal)
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU offered no high-performance adapter.')
  return adapter.requestDevice({
    requiredLimits: {
      // The stem's output is 70 MB; the defaults (128 MB a binding, 256 MB a buffer) hold it, but
      // asking for what the adapter has costs nothing and leaves room for a wider patch.
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  })
}

interface Dispatch {
  readonly name: string
  readonly pipeline: GPUComputePipeline
  readonly group: GPUBindGroup
  readonly groups: readonly [number, number, number]
}

const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC

/** Record one dispatch into a pass. */
function record(pass: GPUComputePassEncoder, one: Dispatch): void {
  pass.setPipeline(one.pipeline)
  pass.setBindGroup(0, one.group)
  pass.dispatchWorkgroups(...one.groups)
}

/** A built network: GPU objects only, so nothing of the plan or the file stays reachable. */
export class AssessorNetwork {
  private queue: Promise<unknown> = Promise.resolve()
  private destroyed = false
  /** Why the device went away, once it has: a driver reset, a sleep, memory pressure. */
  private lost: string | undefined
  private readonly device: GPUDevice
  private readonly dispatches: readonly Dispatch[]
  private readonly owned: readonly GPUBuffer[]
  private readonly lab: GPUBuffer
  private readonly logit: GPUBuffer
  private readonly readback: GPUBuffer
  /** The patch's edge in voxels: what a caller must feed. */
  readonly edge: number
  /** Multiply-adds × 2 a patch, for a TFLOP/s figure. */
  readonly flops: number
  /** The GPU memory held, in bytes: weights and every intermediate. */
  readonly bytes: number

  constructor(parts: {
    device: GPUDevice
    dispatches: readonly Dispatch[]
    owned: readonly GPUBuffer[]
    lab: GPUBuffer
    logit: GPUBuffer
    readback: GPUBuffer
    edge: number
    flops: number
  }) {
    this.device = parts.device
    this.dispatches = parts.dispatches
    this.owned = parts.owned
    this.lab = parts.lab
    this.logit = parts.logit
    this.readback = parts.readback
    this.edge = parts.edge
    this.flops = parts.flops
    this.bytes = parts.owned.reduce((n, one) => n + one.size, 0)
    void this.device.lost.then((info) => {
      this.lost = info.message || info.reason
    })
  }

  /** One patch, (X, Y, Z) float32 labels at the plan's edge, to one logit. */
  score(patch: Float32Array): Promise<number> {
    return this.serial(async () => {
      this.load(patch)
      const encoder = this.device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      for (const one of this.dispatches) record(pass, one)
      pass.end()
      encoder.copyBufferToBuffer(this.logit, 0, this.readback, 0, 4)
      this.device.queue.submit([encoder.finish()])
      await this.readback.mapAsync(GPUMapMode.READ)
      // Unmapped whatever happens: a buffer left mapped refuses every later `mapAsync`, so one
      // failed read would fail every patch after it.
      try {
        return new Float32Array(this.readback.getMappedRange())[0]!
      } finally {
        this.readback.unmap()
      }
    })
  }

  /**
   * The same pass with a submit and a wait after every step, so each is timed alone. Slower in
   * total than `score` — it drains the GPU between steps — and meant for a probe, not a run.
   * Every figure includes one submit-and-wait round trip (~0.2 ms here), so a step that takes
   * microseconds on the GPU reads as that floor: read the big steps' share, not the small ones'.
   * GPU timestamp queries would remove it, at the cost of an optional device feature.
   */
  profile(patch: Float32Array): Promise<StepTiming[]> {
    return this.serial(async () => {
      this.load(patch)
      await this.device.queue.onSubmittedWorkDone()
      const out: StepTiming[] = []
      for (const one of this.dispatches) {
        const encoder = this.device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        record(pass, one)
        pass.end()
        const t = performance.now()
        this.device.queue.submit([encoder.finish()])
        await this.device.queue.onSubmittedWorkDone()
        out.push({ name: one.name, ms: performance.now() - t })
      }
      return out
    })
  }

  /** Refuse new work now; free the buffers once the run in flight, if any, has finished. */
  destroy(): void {
    this.destroyed = true
    void this.queue.then(() => {
      for (const one of this.owned) one.destroy()
    })
  }

  private load(patch: Float32Array): void {
    if (this.destroyed) throw new Error('The assessor network has been closed')
    if (this.lost) {
      throw new Error(
        `The GPU went away (${this.lost}), so the assessor has to be opened again`,
      )
    }
    if (patch.length !== this.edge ** 3) {
      throw new Error(`A patch is ${this.edge}³ voxels; this one is ${patch.length}`)
    }
    this.device.queue.writeBuffer(this.lab, 0, patch.buffer, patch.byteOffset, patch.byteLength)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }
}

/**
 * Upload the plan's weights, compile its shaders, and allocate the intermediates.
 *
 * Everything happens inside one validation scope and one out-of-memory scope, and any failure —
 * a shader that does not compile, a binding the GPU refuses, a size past its limits, memory it
 * does not have — destroys every buffer made so far before the error is thrown, so a failed open
 * leaves nothing on the device. Out of memory is reported first: a buffer that could not be
 * allocated makes every bind group that uses it invalid too, and that later error names nothing.
 */
export async function buildNetwork(
  device: GPUDevice,
  plan: AssessorPlan,
): Promise<AssessorNetwork> {
  const owned: GPUBuffer[] = []
  device.pushErrorScope('out-of-memory')
  device.pushErrorScope('validation')
  let network: AssessorNetwork | undefined
  let failure: unknown
  try {
    network = await assemble(device, plan, owned)
  } catch (error) {
    failure = error
  }
  const invalid = await device.popErrorScope()
  const memory = await device.popErrorScope()
  if (!network || invalid || memory) {
    for (const one of owned) one.destroy()
    const why = memory
      ? `the GPU ran out of memory (${memory.message})`
      : (invalid?.message ?? errorMessage(failure))
    throw new Error(`The assessor network did not build: ${why}`)
  }
  return network
}

/**
 * The build itself. Its own function, so the network it returns closes over none of this scope.
 *
 * Intermediates share buffers once they are dead: the plan's order is fixed, so each tensor's
 * last reader is known, and a buffer freed by one step is taken by a later one that fits. The
 * patch itself is no intermediate: the stem reads the uploaded labels (`PATCH`, `stemShader`)
 * unless the plan is the dense reference (`segclrPlan`'s `denseStem`), whose `encode` step
 * writes the two channels first.
 */
async function assemble(
  device: GPUDevice,
  plan: AssessorPlan,
  owned: GPUBuffer[],
): Promise<AssessorNetwork> {
  const limits = device.limits
  const buffer = (size: number, usage = STORAGE, mapped = false): GPUBuffer => {
    // Every buffer is bound whole, so every one is held to the binding limit, here.
    if (size > limits.maxStorageBufferBindingSize) {
      throw new Error(
        `A ${size}-byte buffer is past this GPU's ${limits.maxStorageBufferBindingSize}-byte binding limit`,
      )
    }
    // Storage bindings must be a multiple of 4 bytes and not empty.
    const made = device.createBuffer({
      size: Math.max(4, Math.ceil(size / 4) * 4),
      usage,
      mappedAtCreation: mapped,
    })
    owned.push(made)
    return made
  }
  /** Fill a new buffer through its mapped range: no staging copy, no array beside it. */
  const filled = (floats: number, fill: (into: Float32Array) => void): GPUBuffer => {
    const made = buffer(floats * 4, STORAGE, true)
    fill(new Float32Array(made.getMappedRange(), 0, floats))
    made.unmap()
    return made
  }
  const upload = (data: Float32Array) => filled(data.length, (into) => into.set(data))

  // The patch buffer is sized by the plan and read by the steps that take the patch, each at its
  // own edge: `encode` in the dense reference, the stem otherwise.
  const patchEdges = plan.steps.flatMap((step) =>
    step.kind === 'encode'
      ? [step.edge]
      : step.kind === 'conv' && step.input === PATCH
        ? [step.inEdge]
        : [],
  )
  if (patchEdges.length === 0 || patchEdges.some((edge) => edge !== plan.edge))
    throw new Error(`The plan does not read its ${plan.edge}³ patch at that edge`)
  const lab = buffer(plan.edge ** 3 * 4)
  const logit = buffer(4)
  const readback = buffer(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)

  // Intermediates share buffers once dead (`bufferSlots`).
  const { sizes, slotOf } = bufferSlots(plan.steps)
  const slots = sizes.map((floats) => buffer(floats * 4))
  const tensorOf = (name: string): GPUBuffer => slots[slotOf.get(name)!]!
  const floatsOf = (step: PlanStep): number => outputOf(step)?.floats ?? 0

  // One scratch buffer for every split step's partial sums: they run one after another. A step
  // that does not split writes its output directly and needs none.
  const convs = plan.steps.filter((step): step is ConvStep => step.kind === 'conv')
  const layouts = new Map(convs.map((step) => [step, convLayout(step)]))
  const scratch = buffer(
    4 *
      Math.max(
        1,
        ...convs.map((step) =>
          layouts.get(step)!.splits > 1 ? layouts.get(step)!.splits * floatsOf(step) : 0,
        ),
      ),
  )

  /*
   * Compiled once per distinct shader — every size is a constant in the code, so two steps of
   * the same shape (a block's second convolution and the next block's) share a pipeline — and
   * all at once rather than one after another, which was most of a second on open.
   */
  const pipelines = new Map<string, Promise<GPUComputePipeline>>()
  const compile = (code: string): Promise<GPUComputePipeline> => {
    let pipeline = pipelines.get(code)
    if (!pipeline) {
      pipeline = device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      })
      pipelines.set(code, pipeline)
      // Awaited by its dispatch, which sees any rejection; this only keeps a build that throws
      // before reaching that dispatch from leaving the rejection unhandled.
      pipeline.catch(() => {})
    }
    return pipeline
  }
  const flat = (count: number): [number, number, number] => [Math.ceil(count / FLAT), 1, 1]
  /** The one place a dispatch is made, so the one place its size is checked. */
  const dispatch = async (
    name: string,
    compiling: Promise<GPUComputePipeline>,
    buffers: readonly GPUBuffer[],
    groups: readonly [number, number, number],
  ): Promise<Dispatch> => {
    const most = limits.maxComputeWorkgroupsPerDimension
    if (groups.some((n) => n > most)) {
      throw new Error(
        `${name} needs ${groups.join('×')} workgroups and this GPU allows ${most} a side`,
      )
    }
    const pipeline = await compiling
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((one, binding) => ({ binding, resource: { buffer: one } })),
    })
    return { name, pipeline, group, groups }
  }

  /*
   * Every compile is asked for before any weights are rearranged: the rearranging is ~70 ms of
   * CPU, most of it in stage 3 at the end of the list, and the GPU compiles meanwhile.
   */
  const shaders = plan.steps.map((step) => {
    if (step.kind === 'encode') return { main: compile(encodeShader(step.edge)) }
    if (step.kind === 'conv' && step.input === PATCH) return { main: compile(stemShader(step)) }
    if (step.kind === 'maxpool') return { main: compile(maxPoolShader(step)) }
    if (step.kind === 'head') return { main: compile(headShader(step)) }
    const { splits } = layouts.get(step)!
    return {
      main: compile(convShader(step, layouts.get(step)!)),
      sum: splits > 1 ? compile(reduceShader(step, splits)) : undefined,
    }
  })

  const forStep = (step: PlanStep, at: number): Promise<Dispatch>[] => {
    const { main, sum } = shaders[at]!
    if (step.kind === 'encode') {
      return [dispatch('encode', main, [lab, tensorOf(step.output)], flat(step.edge ** 3))]
    }
    if (step.kind === 'maxpool') {
      const buffers = [tensorOf(step.input), tensorOf(step.output)]
      return [dispatch('pool1', main, buffers, flat(floatsOf(step)))]
    }
    if (step.kind === 'head') {
      return [
        dispatch('head', main, [tensorOf(step.input), upload(step.weight), logit], [1, 1, 1]),
      ]
    }
    const layout = layouts.get(step)!
    const weights = filled(convWeightFloats(step, layout), (into) =>
      convWeightLayout(step, layout, into),
    )
    const params = upload(epilogueParams(step))
    const residual = step.residual ? [tensorOf(step.residual)] : []
    const output = tensorOf(step.output)
    if (step.input === PATCH) {
      return [dispatch(step.name, main, [lab, weights, output, params], stemGroups(step))]
    }
    const input = tensorOf(step.input)
    if (!sum) {
      return [
        dispatch(step.name, main, [input, weights, output, params, ...residual], layout.groups),
      ]
    }
    return [
      dispatch(step.name, main, [input, weights, scratch], layout.groups),
      dispatch(
        `${step.name} (sum of ${layout.splits})`,
        sum,
        [scratch, output, params, ...residual],
        flat(floatsOf(step)),
      ),
    ]
  }

  /*
   * Settled, not `Promise.all`, and settled even when making them threw partway: every dispatch
   * already started has finished with the buffers before the caller destroys them, inside the
   * error scopes, and none is left to reject unhandled.
   */
  const pending: Promise<Dispatch>[] = []
  let thrown: { error: unknown } | undefined
  try {
    plan.steps.forEach((step, at) => pending.push(...forStep(step, at)))
  } catch (error) {
    thrown = { error }
  }
  const settled = await Promise.allSettled(pending)
  if (thrown) throw thrown.error
  const failed = settled.find((one): one is PromiseRejectedResult => one.status === 'rejected')
  if (failed) throw failed.reason
  return new AssessorNetwork({
    device,
    dispatches: settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : [])),
    owned,
    lab,
    logit,
    readback,
    edge: plan.edge,
    flops: plan.flops,
  })
}
