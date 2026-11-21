/// <reference types="@webgpu/types" />
/**
 * The mask assessor on WebGPU, without ONNX Runtime: one compute pass a patch.
 *
 * `segclrPlan.ts` says what to compute and `shaders.ts` how; this owns the GPU side — the buffers,
 * the pipelines, and the one submit per patch. Everything is allocated when the network is built
 * and reused for every patch, so scoring a patch is one 8.5 MB upload, ~50 dispatches and a
 * 4-byte read back.
 *
 * **Stage 0 computes only what an object can reach.** Away from the two objects every layer's
 * output is the network's answer to an empty patch, borders included, so that answer is computed
 * once, when the network is built (`captureBackground`), and a patch computes only the voxels of
 * each stage-0 convolution within reach of a label — 26% of them on average over SEAM's lists —
 * with the rest copied from the empty patch's answer. **The logit is the same to the bit**: a
 * voxel out of reach reads only inputs that are themselves the empty patch's, through the same
 * shader, so what is copied is what would have been computed; and a voxel in reach is computed
 * as it always was, since listing voxels changes which workgroup computes one and not the order
 * of its sum. `pnpm probe:gpu-assessor` holds every fixture patch to the dense reference rather
 * than trusting that (docs/seam-assessor-speed.md §17).
 *
 * **Submitted one at a time, read back together.** The buffers are shared between calls, so
 * `score` submits its callers in turn; but it does not wait for one patch's answer before
 * submitting the next. The GPU runs submitted work in order, so patch *n+1*'s upload cannot land
 * before patch *n* has been computed, and each patch's logit is copied to a read-back buffer of
 * its own. That is what lets a caller keep several patches in flight, which Firefox needs: it
 * answers every wait for the GPU in ~100 ms (`GPU_ASSESSOR_IN_FLIGHT` has the measurement). The
 * answers are the same to the bit either way.
 *
 * **The network keeps nothing of the plan.** The plan's weights are views into the 133 MB file,
 * so a scoring method closing over the build's scope would keep the file alive for the session
 * (CLAUDE.md: a long-lived closure keeps its whole creating scope). The build hands an
 * `AssessorNetwork` only the GPU objects, and the CPU side of the weights is garbage once the
 * build returns.
 */

import { errorMessage } from '../../../core/errors'
import { frugalShaders, gpuSupport } from '../../../ml/support'
import type { AssessorPlan, ConvStep, MaxPoolStep, PlanStep } from './segclrPlan'
import { PATCH, bufferSlots, outputOf, skippableConvs } from './segclrPlan'
import {
  channelTiles,
  convLayout,
  convShader,
  convWeightFloats,
  convWeightLayout,
  encodeShader,
  epilogueParams,
  fillShader,
  FLAT,
  gatherListLength,
  gatherShader,
  headShader,
  listedTogether,
  maxPoolShader,
  reachShader,
  reduceShader,
  stemGroups,
  stemPacks,
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
  /** Where the GPU wrote this dispatch's size (`gatherShader`); `groups` is then its ceiling. */
  readonly indirect?: GPUBuffer
  /** It works out what a patch's labels reach, so `captureBackground` leaves it out. */
  readonly findsReach?: true
  /** A skipping convolution: where its output is copied to, whole, as the empty patch's answer. */
  readonly capture?: { readonly from: GPUBuffer; readonly to: GPUBuffer }
}

/** What a dispatch is besides its shader and buffers. */
type Role = Pick<Dispatch, 'indirect' | 'findsReach' | 'capture'>

/** How a network is built, beyond its plan. Neither option changes a logit. */
export interface NetworkOptions {
  /**
   * `false` computes every voxel of stage 0. The reference the shipped network is held to says so
   * (with `segclrPlan`'s `denseStem`), and alone it measures what the skip is worth
   * (`pnpm probe:gpu-browsers -- --no-skip`).
   */
  readonly skipBackground?: boolean
  /**
   * The forms that spare a shader translator its loops and workgroup memory (`ConvForm.unrolled`,
   * `StemForm.packed`). The browser's own answer when absent (`frugalShaders`); a probe names it
   * to time one form in the other browser, and to hold both to one reference.
   */
  readonly frugal?: boolean
}

const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC

/** Record one dispatch into a pass. */
function record(pass: GPUComputePassEncoder, one: Dispatch): void {
  pass.setPipeline(one.pipeline)
  pass.setBindGroup(0, one.group)
  if (one.indirect) pass.dispatchWorkgroupsIndirect(one.indirect, 0)
  else pass.dispatchWorkgroups(...one.groups)
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
  /** Read-back buffers no patch is using, one per patch once in flight; made as needed. */
  private readonly spare: GPUBuffer[] = []
  /** The patch's edge in voxels: what a caller must feed. */
  readonly edge: number
  /**
   * Multiply-adds × 2 a patch, for a TFLOP/s figure — **of the plan, every voxel counted**. The
   * background a patch skips is still in it, so a figure from it is the dense network's rate at
   * this speed, not the arithmetic done.
   */
  readonly flops: number
  /** The GPU memory held, in bytes: weights and every intermediate. */
  readonly bytes: number

  constructor(parts: {
    device: GPUDevice
    dispatches: readonly Dispatch[]
    owned: readonly GPUBuffer[]
    lab: GPUBuffer
    logit: GPUBuffer
    edge: number
    flops: number
  }) {
    this.device = parts.device
    this.dispatches = parts.dispatches
    this.owned = parts.owned
    this.lab = parts.lab
    this.logit = parts.logit
    this.edge = parts.edge
    this.flops = parts.flops
    this.bytes = parts.owned.reduce((n, one) => n + one.size, 0)
    void this.device.lost.then((info) => {
      this.lost = info.message || info.reason
    })
  }

  /** One patch, (X, Y, Z) float32 labels at the plan's edge, to one logit. */
  score(patch: Float32Array): Promise<number> {
    // In turn up to the submit (behind a `profile` too, which reuses the buffers between its
    // awaits); the wait for the answer is outside the queue, so the next patch need not wait.
    // Nothing that waits for the answer closes over `patch`, so a patch in flight is the
    // browser's staging copy alone once it is submitted.
    return this.serial(async () => this.submit(patch)).then((readback) => this.read(readback))
  }

  private submit(patch: Float32Array): GPUBuffer {
    this.load(patch)
    const readback =
      this.spare.pop() ??
      this.device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    for (const one of this.dispatches) record(pass, one)
    pass.end()
    encoder.copyBufferToBuffer(this.logit, 0, readback, 0, 4)
    this.device.queue.submit([encoder.finish()])
    return readback
  }

  private async read(readback: GPUBuffer): Promise<number> {
    // Unmapped whatever happens: a buffer left mapped refuses every later `mapAsync`, so one
    // failed read would fail the patch that next took it. (Unmapping one never mapped is a no-op.)
    try {
      await readback.mapAsync(GPUMapMode.READ)
      return new Float32Array(readback.getMappedRange())[0]!
    } finally {
      readback.unmap()
      if (this.destroyed) readback.destroy()
      else this.spare.push(readback)
    }
  }

  /**
   * The same pass with a submit and a wait after every step, so each is timed alone. Meant for a
   * probe, not a run: it drains the GPU between steps.
   *
   * `repeats` records each step that many times in its one submit and divides. A step reads only
   * what earlier steps wrote and writes elsewhere, so running it again changes nothing; and every
   * figure carries one round trip — ~0.3 ms in Chrome, ~100 ms in Firefox — divided by `repeats`.
   * So one repeat reads as the round trip for any small step, thirty time a step in Chrome, and
   * three hundred are what it takes in Firefox. GPU timestamp queries would do without, at the
   * cost of an optional device feature.
   */
  profile(patch: Float32Array, repeats = 1): Promise<StepTiming[]> {
    return this.serial(async () => {
      // A whole number of at least one: none would divide by zero, a part of one mis-divide.
      const times = Math.max(1, Math.floor(repeats))
      this.load(patch)
      await this.device.queue.onSubmittedWorkDone()
      const out: StepTiming[] = []
      for (const one of this.dispatches) {
        const encoder = this.device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        for (let r = 0; r < times; r++) record(pass, one)
        pass.end()
        const t = performance.now()
        this.device.queue.submit([encoder.finish()])
        await this.device.queue.onSubmittedWorkDone()
        out.push({ name: one.name, ms: (performance.now() - t) / times })
      }
      return out
    })
  }

  /**
   * Refuse new work now; free the buffers once the GPU has finished what was submitted. A
   * patch still being read back frees its own read-back buffer when its answer arrives.
   */
  destroy(): void {
    this.destroyed = true
    void this.queue
      .then(() => this.device.queue.onSubmittedWorkDone())
      .catch(() => {})
      .then(() => {
        for (const one of this.owned) one.destroy()
        for (const one of this.spare.splice(0)) one.destroy()
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
  options: NetworkOptions = {},
): Promise<AssessorNetwork> {
  const owned: GPUBuffer[] = []
  device.pushErrorScope('out-of-memory')
  device.pushErrorScope('validation')
  let network: AssessorNetwork | undefined
  let failure: unknown
  try {
    network = await assemble(device, plan, owned, options)
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

/** One depth of reach: the pool's outputs within that many 3³ windows of a label. */
interface ReachLevel {
  /** One flag a voxel. */
  readonly flags: GPUBuffer
  /** The flagged voxels in index order (`gatherShader`), and the dispatch as long as the list. */
  readonly list: GPUBuffer
  readonly args: GPUBuffer
}

/**
 * The background skip's buffers, and which level each skipping convolution computes.
 *
 * `depths` is every convolution taking part with how many 3³ windows past the pool its output
 * sits (`skippableConvs`), at least one of them and each at depth one or more.
 */
function backgroundSkip(
  stem: ConvStep,
  pool: MaxPoolStep,
  depths: readonly (readonly [ConvStep, number])[],
  buffer: (size: number, usage?: number) => GPUBuffer,
) {
  const voxels = pool.outEdge ** 3
  const levels: ReachLevel[] = Array.from(
    { length: Math.max(...depths.map(([, depth]) => depth)) },
    () => ({
      flags: buffer(voxels * 4),
      list: buffer(gatherListLength(voxels) * 4),
      args: buffer(12, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT),
    }),
  )
  return {
    pool,
    voxels,
    /** Any one skipping convolution: all read a 3³ window and are one width (`listedTogether`). */
    like: depths[0]![0],
    /** Which of the stem's outputs any label reaches, and which of the pool's. */
    reached: buffer(stem.outEdge ** 3 * 4),
    pooled: buffer(voxels * 4),
    levels,
    levelOf: new Map(depths.map(([step, depth]) => [step, levels[depth - 1]!] as const)),
  }
}
type BackgroundSkip = ReturnType<typeof backgroundSkip>

/**
 * The empty patch's answer at every skipping convolution, computed once as the network is built.
 *
 * The patch buffer is new, so it is all background. The steps run one at a time, in order, with
 * every flag set to "in reach" — so each skipping convolution lists and computes its whole
 * output, through the very shader a real patch's voxels in reach go through, and that output is
 * copied aside (`Dispatch.capture`). That shared shader is what makes a copied voxel equal a
 * computed one to the bit.
 *
 * The steps that work out the flags are left out (`Dispatch.findsReach`), so each level's flags
 * stay set for the step that lists them; a real patch runs them all and overwrites every one. (A
 * convolution's fill runs here too, copying a background not yet captured, and is then
 * overwritten whole.) Nothing past the last skipping convolution is run.
 */
function captureBackground(
  device: GPUDevice,
  dispatches: readonly Dispatch[],
  skip: BackgroundSkip,
): void {
  const ones = new Uint32Array(skip.voxels).fill(1)
  for (const level of skip.levels) device.queue.writeBuffer(level.flags, 0, ones)
  const last = dispatches.reduce((at, one, index) => (one.capture ? index : at), -1)
  for (const one of dispatches.slice(0, last + 1)) {
    if (one.findsReach) continue
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    record(pass, one)
    pass.end()
    const { capture } = one
    if (capture) encoder.copyBufferToBuffer(capture.from, 0, capture.to, 0, capture.to.size)
    device.queue.submit([encoder.finish()])
  }
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
  options: NetworkOptions,
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

  // Intermediates share buffers once dead (`bufferSlots`).
  const { sizes, slotOf } = bufferSlots(plan.steps)
  const slots = sizes.map((floats) => buffer(floats * 4))
  const tensorOf = (name: string): GPUBuffer => slots[slotOf.get(name)!]!
  const floatsOf = (step: PlanStep): number => outputOf(step)?.floats ?? 0

  const convs = plan.steps.filter((step): step is ConvStep => step.kind === 'conv')
  const layouts = new Map(convs.map((step) => [step, convLayout(step)]))
  // One scratch buffer for every split step's partial sums: they run one after another. A step
  // that does not split writes its output directly and needs none.
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
   * The background skip, decided once. It starts from the stem's own flags, so it needs the stem
   * that reads the patch, feeding the pool — the dense reference has no such stem, and computes
   * every voxel. A convolution takes part if it can compute a list alongside the others
   * (`listedTogether`), which every stage-0 one can; one that could not would be computed whole.
   */
  const stem = convs.find((step) => step.input === PATCH)
  const { pool, depthOf } = skippableConvs(plan.steps)
  const taking = new Set(listedTogether([...depthOf.keys()]))
  const depths = [...depthOf].filter(([step]) => taking.has(step))
  const skip =
    stem && pool?.input === stem.output && depths.length > 0 && options.skipBackground !== false
      ? backgroundSkip(stem, pool, depths, buffer)
      : undefined

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
    role: Role = {},
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
    return { name, pipeline, group, groups, ...role }
  }

  /*
   * Every step's compile is asked for before any weights are rearranged: the rearranging is
   * ~70 ms of CPU, most of it in stage 3 at the end of the list, and the GPU compiles meanwhile.
   * (The skip's own four small shaders are asked for as their steps are reached.)
   */
  const frugal = options.frugal ?? frugalShaders()
  const shaders = plan.steps.map((step) => {
    if (step.kind === 'encode') return { main: compile(encodeShader(step.edge)) }
    if (step.kind === 'conv' && step.input === PATCH) {
      const packed = frugal && stemPacks(step)
      return { main: compile(stemShader(step, { reach: Boolean(skip), packed })) }
    }
    if (step.kind === 'maxpool') return { main: compile(maxPoolShader(step)) }
    if (step.kind === 'head') return { main: compile(headShader(step)) }
    const { splits } = layouts.get(step)!
    return {
      main: compile(
        convShader(step, layouts.get(step)!, {
          listed: skip?.levelOf.has(step),
          unrolled: frugal,
        }),
      ),
      sum: splits > 1 ? compile(reduceShader(step, splits)) : undefined,
    }
  })

  /** After the pool: the flags at every depth, and the list and dispatch for each. */
  const reachDispatches = (skip: BackgroundSkip): Promise<Dispatch>[] => {
    const { voxels } = skip
    const findsReach = { findsReach: true } as const
    // One 3³ window further a level: the window of the convolutions themselves.
    const grow = compile(reachShader(skip.like))
    const listing = compile(gatherShader(voxels, channelTiles(skip.like)))
    const made = [
      dispatch(
        'reach 0',
        compile(reachShader(skip.pool)),
        [skip.reached, skip.pooled],
        flat(voxels),
        findsReach,
      ),
    ]
    skip.levels.forEach((level, at) => {
      const from = at === 0 ? skip.pooled : skip.levels[at - 1]!.flags
      made.push(
        dispatch(`reach ${at + 1}`, grow, [from, level.flags], flat(voxels), findsReach),
        dispatch(`list ${at + 1}`, listing, [level.flags, level.list, level.args], [1, 1, 1]),
      )
    })
    return made
  }

  const forStep = (step: PlanStep, at: number): Promise<Dispatch>[] => {
    const { main, sum } = shaders[at]!
    if (step.kind === 'encode') {
      return [dispatch('encode', main, [lab, tensorOf(step.output)], flat(step.edge ** 3))]
    }
    if (step.kind === 'maxpool') {
      const buffers = [tensorOf(step.input), tensorOf(step.output)]
      const pooling = dispatch('pool1', main, buffers, flat(floatsOf(step)))
      return skip && step === skip.pool ? [pooling, ...reachDispatches(skip)] : [pooling]
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
      const bound = [lab, weights, output, params, ...(skip ? [skip.reached] : [])]
      return [dispatch(step.name, main, bound, stemGroups(step))]
    }
    const input = tensorOf(step.input)
    if (!sum) {
      const bound = [input, weights, output, params, ...residual]
      const level = skip?.levelOf.get(step)
      if (!level) return [dispatch(step.name, main, bound, layout.groups)]
      // A skipping convolution: its whole output set to the empty patch's answer, then the
      // voxels in reach computed over it.
      const floats = floatsOf(step)
      const background = buffer(floats * 4)
      return [
        dispatch(
          `${step.name} (background)`,
          compile(fillShader(floats)),
          [background, output],
          flat(floats),
        ),
        dispatch(step.name, main, [...bound, level.list], layout.groups, {
          indirect: level.args,
          capture: { from: output, to: background },
        }),
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
  const dispatches = settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
  if (skip) captureBackground(device, dispatches, skip)
  return new AssessorNetwork({
    device,
    dispatches,
    owned,
    lab,
    logit,
    edge: plan.edge,
    flops: plan.flops,
  })
}
