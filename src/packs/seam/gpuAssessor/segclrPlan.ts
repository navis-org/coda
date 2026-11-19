/**
 * The mask assessor's network as a list of GPU steps, with its weights, read out of SEAM's ONNX
 * export (the plain `Conv` one, not the MatMul rewrite).
 *
 * The architecture is fixed — SegCLR's 3D ResNet-18 (SEAM `seam/segclr/model.py`) — and is
 * written out here rather than interpreted from the graph. The graph supplies only the numbers,
 * found by name, and every one is checked against the shape this file expects, so an export of a
 * different network is refused with a sentence instead of producing a logit.
 *
 * What the export looks like, and so what is read:
 *
 * - **The stem and the shortcuts have their batch norm folded in already** (there is no ReLU
 *   between, so the exporter merged them), under names like `onnx::Conv_737`. They are found by
 *   the `Conv` node that produces `/net/conv1/Conv_output_0` and so on.
 * - **The blocks' batch norms are not foldable into their convolution**, because SegCLR runs
 *   conv → ReLU → BN. They become a per-channel scale and shift applied after the ReLU, in the
 *   convolution's own epilogue. Their epsilon is read from the node (`1e-5` as a float32).
 * - **Padding is TensorFlow 'SAME'**, computed in-graph by the export (`Pad` nodes fed from
 *   shape arithmetic). It is recomputed here from SEAM's `_same_pad` formula rather than read.
 *
 * The input encoding is SEAM's `Assessor.encode` for `inputs="mask"`: the patch `lab` arrives as
 * (X, Y, Z) with 1 = Q, 2 = C, 0 = neither; the network sees axes (Z, Y, X) and two channels, the
 * union mask (`lab > 0`) and the side (`+1` on C, `−1` on Q).
 */

import type { OnnxGraph, OnnxNode } from './onnxProto'

export class AssessorPlanError extends Error {}

/**
 * The patch edge this network was trained on, in voxels.
 *
 * `patchBox.PATCH_VOXELS` by value, not by import: `patchBox.ts` imports the precomputed volume
 * reader, which would put the whole segmentation-fetching stack in the GPU worker's graph to
 * read one number. The test holds the two equal.
 */
export const PATCH_EDGE = 129

/** One 3D convolution with everything that follows it up to the next convolution's input. */
export interface ConvStep {
  readonly kind: 'conv'
  readonly name: string
  readonly input: string
  readonly output: string
  readonly cin: number
  readonly cout: number
  /** Cube edges, in voxels. */
  readonly inEdge: number
  readonly outEdge: number
  readonly kernel: number
  readonly stride: number
  /** Voxels of zero padding before the first input voxel, per axis ('SAME'). */
  readonly pad: number
  /**
   * (Cout, Cin, k, k, k), as in the file, read when called — possibly a fresh copy each time
   * (`OnnxTensor.data`), so the build calls it once, as it uploads, and lets it go.
   */
  readonly weight: () => Float32Array
  readonly bias: Float32Array
  /** conv → ReLU → BN: the BN's per-channel scale and shift, applied after the ReLU. */
  readonly bnAfterRelu?: { readonly scale: Float32Array; readonly shift: Float32Array }
  /** Added after everything above, then a ReLU: the end of a residual block. */
  readonly residual?: string
}

export interface EncodeStep {
  readonly kind: 'encode'
  readonly output: string
  readonly edge: number
}

export interface MaxPoolStep {
  readonly kind: 'maxpool'
  readonly input: string
  readonly output: string
  readonly channels: number
  readonly inEdge: number
  readonly outEdge: number
  readonly kernel: number
  readonly stride: number
  /** Padding counts as −∞: it never wins. */
  readonly pad: number
}

/** Mean over every voxel, then the one-logit linear head. */
export interface HeadStep {
  readonly kind: 'head'
  readonly input: string
  readonly channels: number
  readonly edge: number
  readonly weight: Float32Array
  readonly bias: number
}

export type PlanStep = EncodeStep | ConvStep | MaxPoolStep | HeadStep

/**
 * The input of a step that reads **the patch of labels itself** — the uploaded `lab`, never an
 * intermediate, so no buffer is planned for it (`inputsOf` leaves it out). The stem reads it by
 * default (`shaders.ts`' `stemShader`); `denseStem` puts `encode` before it instead.
 */
export const PATCH = 'patch'

export interface AssessorPlan {
  /** The patch's edge in voxels: what a caller uploads, as (X, Y, Z) labels. */
  readonly edge: number
  readonly steps: readonly PlanStep[]
  /** Multiply-adds × 2 over the convolutions and the head, for a TFLOP/s figure. */
  readonly flops: number
}

/** The tensor a step writes, and its size in floats. The head writes none: its logit is not a tensor. */
export function outputOf(step: PlanStep): { name: string; floats: number } | undefined {
  if (step.kind === 'encode') return { name: step.output, floats: 2 * step.edge ** 3 }
  if (step.kind === 'maxpool')
    return { name: step.output, floats: step.channels * step.outEdge ** 3 }
  if (step.kind === 'conv') return { name: step.output, floats: step.cout * step.outEdge ** 3 }
  return undefined
}

/** The intermediate tensors a step reads — not the patch itself (`PATCH`), which is no tensor. */
export function inputsOf(step: PlanStep): string[] {
  if (step.kind === 'encode') return []
  const read =
    step.kind === 'conv' && step.residual ? [step.input, step.residual] : [step.input]
  return read.filter((name) => name !== PATCH)
}

/**
 * Which buffer each intermediate tensor lives in, reusing a buffer once its tensor is dead.
 *
 * The plan's order is fixed, so each tensor's last reader is known; a buffer freed by one step is
 * taken by a later output that fits (the smallest that does). **An output is placed before the
 * step's inputs are released**, so it never shares a buffer with anything it is computed from —
 * the property that, broken, makes a shader read values it has already overwritten. Pure, so the
 * test holds that property rather than a GPU run.
 *
 * Returns each slot's size in floats (fixed by its first tensor) and each tensor's slot.
 */
export function bufferSlots(steps: readonly PlanStep[]): {
  sizes: number[]
  slotOf: Map<string, number>
} {
  const lastRead = new Map<string, number>()
  steps.forEach((step, at) => {
    for (const name of inputsOf(step)) lastRead.set(name, at)
  })
  const sizes: number[] = []
  const slotOf = new Map<string, number>()
  const free: number[] = []
  steps.forEach((step, at) => {
    const output = outputOf(step)
    if (output) {
      const fits = free
        .filter((slot) => sizes[slot]! >= output.floats)
        .sort((a, b) => sizes[a]! - sizes[b]!)[0]
      if (fits === undefined) sizes.push(output.floats)
      else free.splice(free.indexOf(fits), 1)
      slotOf.set(output.name, fits ?? sizes.length - 1)
    }
    for (const name of inputsOf(step)) {
      const slot = slotOf.get(name)
      if (slot === undefined)
        throw new AssessorPlanError(`The plan reads ${name} before anything writes it.`)
      if (lastRead.get(name) === at) free.push(slot)
    }
  })
  return { sizes, slotOf }
}

/** SEAM's `_same_pad`: the padding before the first voxel, and the output edge. */
export function samePad(
  size: number,
  kernel: number,
  stride: number,
): { pad: number; out: number } {
  const out = Math.floor((size + stride - 1) / stride)
  const total = Math.max((out - 1) * stride + kernel - size, 0)
  return { pad: Math.floor(total / 2), out }
}

const WIDTHS = [64, 128, 256, 512] as const

/** A tensor checked by name and shape, read now. For the small ones: biases, norms, the head. */
function tensor(graph: OnnxGraph, name: string, dims: readonly number[]): Float32Array {
  return reader(graph, name, dims)()
}

/** A tensor checked by name and shape now, its values read later (`OnnxTensor.data`). */
function reader(graph: OnnxGraph, name: string, dims: readonly number[]): () => Float32Array {
  const found = graph.initializers.get(name)
  if (!found) throw new AssessorPlanError(`The export has no ${name}; it is not this network.`)
  if (found.dims.join() !== dims.join()) {
    throw new AssessorPlanError(
      `${name} is ${found.dims.join('×')} and this network needs ${dims.join('×')}.`,
    )
  }
  if (!found.data) throw new AssessorPlanError(`${name} cannot be read: ${found.unread}.`)
  return found.data
}

function nodeProducing(graph: OnnxGraph, output: string, opType: string): OnnxNode {
  const node = graph.nodes.find((one) => one.outputs[0] === output)
  if (!node || node.opType !== opType) {
    throw new AssessorPlanError(
      `The export has no ${opType} producing ${output}. It may be the MatMul rewrite, which ` +
        'this reads nothing from: it needs the plain Conv export.',
    )
  }
  return node
}

/**
 * Every Conv attribute that changes what is computed, held to what the shaders do.
 *
 * The weights' shape cannot tell a dilated, grouped or self-padding convolution from this one,
 * so without these a different network would pass and answer a plausible, wrong logit. Absent
 * attributes take ONNX's defaults: stride 1, no padding, dilation 1, one group.
 */
function checkConv(node: OnnxNode, stride: number, kernel: number): void {
  const at = node.outputs[0]
  const ints = (key: string, absent: readonly number[]): readonly number[] => {
    const value = node.attributes.get(key)
    return Array.isArray(value) ? value : absent
  }
  const expect = (what: string, got: readonly number[], want: readonly number[]) => {
    if (got.join() !== want.join()) {
      throw new AssessorPlanError(`${at} has ${what} ${got.join(',')}, not ${want.join(',')}.`)
    }
  }
  expect('strides', ints('strides', [1, 1, 1]), [stride, stride, stride])
  expect('dilations', ints('dilations', [1, 1, 1]), [1, 1, 1])
  expect('kernel_shape', ints('kernel_shape', [kernel, kernel, kernel]), [
    kernel,
    kernel,
    kernel,
  ])
  // The export pads with separate `Pad` nodes; padding inside the Conv as well would be a
  // different network, wrong by a voxel's worth of border.
  expect('pads', ints('pads', [0, 0, 0, 0, 0, 0]), [0, 0, 0, 0, 0, 0])
  const group = node.attributes.get('group') ?? 1
  if (group !== 1)
    throw new AssessorPlanError(`${at} is a grouped convolution (${String(group)}).`)
  const autoPad = node.attributes.get('auto_pad') ?? 'NOTSET'
  if (autoPad !== 'NOTSET') {
    throw new AssessorPlanError(
      `${at} pads itself (auto_pad ${String(autoPad)}), which this does not expect.`,
    )
  }
}

/** A Conv node's weight and bias, by the output it writes. */
function convWeights(
  graph: OnnxGraph,
  output: string,
  cout: number,
  cin: number,
  kernel: number,
  stride: number,
): { weight: () => Float32Array; bias: Float32Array } {
  const node = nodeProducing(graph, output, 'Conv')
  checkConv(node, stride, kernel)
  const [, weightName, biasName] = node.inputs
  if (!weightName || !biasName) throw new AssessorPlanError(`${output} has no weight or bias.`)
  return {
    weight: reader(graph, weightName, [cout, cin, kernel, kernel, kernel]),
    bias: tensor(graph, biasName, [cout]),
  }
}

/** A BatchNormalization's eval-mode affine, from its four named tensors and its own epsilon. */
function batchNorm(
  graph: OnnxGraph,
  prefix: string,
  channels: number,
): { scale: Float32Array; shift: Float32Array } {
  const gamma = tensor(graph, `${prefix}.weight`, [channels])
  const beta = tensor(graph, `${prefix}.bias`, [channels])
  const mean = tensor(graph, `${prefix}.running_mean`, [channels])
  const variance = tensor(graph, `${prefix}.running_var`, [channels])
  const node = graph.nodes.find(
    (one) => one.opType === 'BatchNormalization' && one.inputs[1] === `${prefix}.weight`,
  )
  const epsilon = node?.attributes.get('epsilon')
  if (typeof epsilon !== 'number') {
    throw new AssessorPlanError(
      `No BatchNormalization reads ${prefix}, so its epsilon is unknown.`,
    )
  }
  const scale = new Float32Array(channels)
  const shift = new Float32Array(channels)
  for (let c = 0; c < channels; c++) {
    // In double, then rounded once: ONNX Runtime computes (x − mean) / sqrt(var + eps) × γ + β
    // in float32, and the two agree to rounding.
    const s = gamma[c]! / Math.sqrt(variance[c]! + epsilon)
    scale[c] = s
    shift[c] = beta[c]! - mean[c]! * s
  }
  return { scale, shift }
}

/**
 * Build the plan from a parsed export. Throws `AssessorPlanError` for any other network.
 *
 * **The stem reads the patch itself** (`PATCH`, `stemShader`): its two channels are functions of
 * one label and a real patch is ~97% background (docs/seam-assessor-speed.md §15). `denseStem`
 * plans the reference instead — `encode` to two channels, then the dense convolution — whose
 * answer is the same to the bit, for checking that it still is.
 */
export function segclrPlan(
  graph: OnnxGraph,
  options: { readonly denseStem?: boolean } = {},
): AssessorPlan {
  const steps: PlanStep[] = options.denseStem
    ? [{ kind: 'encode', output: 'x', edge: PATCH_EDGE }]
    : []
  let flops = 0

  const conv = (
    spec: Omit<ConvStep, 'kind' | 'outEdge' | 'pad' | 'weight' | 'bias' | 'bnAfterRelu'> & {
      readonly from: string
      readonly bn?: string
    },
  ): ConvStep => {
    const { from, bn, ...rest } = spec
    const { pad, out } = samePad(rest.inEdge, rest.kernel, rest.stride)
    const step: ConvStep = {
      kind: 'conv',
      ...rest,
      outEdge: out,
      pad,
      ...convWeights(graph, from, rest.cout, rest.cin, rest.kernel, rest.stride),
      bnAfterRelu: bn ? batchNorm(graph, bn, rest.cout) : undefined,
    }
    steps.push(step)
    flops += 2 * step.cout * step.cin * step.kernel ** 3 * out ** 3
    return step
  }

  // Stem: 7³, stride 2, its BN folded in by the export. No ReLU (SegCLR's quirk).
  const stem = conv({
    name: 'conv1',
    from: '/net/conv1/Conv_output_0',
    input: options.denseStem ? 'x' : PATCH,
    output: 'stem',
    cin: 2,
    cout: WIDTHS[0],
    inEdge: PATCH_EDGE,
    kernel: 7,
    stride: 2,
  })
  const pool = samePad(stem.outEdge, 3, 2)
  steps.push({
    kind: 'maxpool',
    input: 'stem',
    output: 'pool',
    channels: WIDTHS[0],
    inEdge: stem.outEdge,
    outEdge: pool.out,
    kernel: 3,
    stride: 2,
    pad: pool.pad,
  })

  let current = 'pool'
  let cin: number = WIDTHS[0]
  let edge = pool.out
  WIDTHS.forEach((cout, s) => {
    for (let b = 0; b < 2; b++) {
      const stride = s > 0 && b === 0 ? 2 : 1
      const where = `/net/stages.${s}/stages.${s}.${b}`
      const params = `net.backbone.stages.${s}.${b}`
      const tag = `s${s}b${b}`
      const first = conv({
        name: `${tag}.conv_0`,
        from: `${where}/conv_0/Conv_output_0`,
        bn: `${params}.bn_0`,
        input: current,
        output: `${tag}.a`,
        cin: b === 0 ? cin : cout,
        cout,
        inEdge: edge,
        kernel: 3,
        stride,
      })
      // Block a of every stage has a 1×1 shortcut (stage 0's at stride 1: resnet18_stack),
      // with its BN folded in by the export. Block b adds its input back unchanged.
      let shortcut = current
      if (b === 0) {
        shortcut = conv({
          name: `${tag}.shortcut`,
          from: `${where}/shortcut_conv/Conv_output_0`,
          input: current,
          output: `${tag}.short`,
          cin,
          cout,
          inEdge: edge,
          kernel: 1,
          stride,
        }).output
      }
      const second = conv({
        name: `${tag}.conv_1`,
        from: `${where}/conv_1/Conv_output_0`,
        bn: `${params}.bn_1`,
        input: first.output,
        output: `${tag}.out`,
        cin: cout,
        cout,
        inEdge: first.outEdge,
        kernel: 3,
        stride: 1,
        residual: shortcut,
      })
      current = second.output
      edge = second.outEdge
    }
    cin = cout
  })

  const width = WIDTHS[3]
  steps.push({
    kind: 'head',
    input: current,
    channels: width,
    edge,
    weight: tensor(graph, 'net.head.weight', [1, width]),
    bias: tensor(graph, 'net.head.bias', [1])[0]!,
  })
  flops += 2 * width

  return { edge: PATCH_EDGE, steps, flops }
}
