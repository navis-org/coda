/**
 * The hand-written assessor's GPU-free half: the ONNX reader, the plan, and the weight layout.
 *
 * Whether the shaders compute the right thing is a question only a GPU answers, and
 * `pnpm probe:gpu-assessor` asks it against PyTorch on real patches. What is pinned here is
 * everything that decides *what* the shaders are handed — a wrong pad, a residual wired to the
 * wrong tensor or a transposed weight would compile, run and answer plausibly.
 */

import { describe, expect, it } from 'vitest'

import manifest from '../__fixtures__/assessorManifest.json'
import { PATCH_VOXELS } from '../patchBox'
import type { OnnxGraph, OnnxNode, OnnxTensor } from './onnxProto'
import { readOnnx } from './onnxProto'
import type { ConvStep } from './segclrPlan'
import {
  AssessorPlanError,
  PATCH,
  PATCH_EDGE,
  bufferSlots,
  inputsOf,
  outputOf,
  samePad,
  segclrPlan,
  skippableConvs,
} from './segclrPlan'
import {
  TILE_K,
  convLayout,
  convShader,
  listedTogether,
  convWeightLayout,
  epilogueParams,
  stemFootprint,
  stemGroups,
  stemPacks,
  stemShader,
} from './shaders'

// ── A protobuf writer, just enough to build test files ───────────────────────────────────────

function varint(value: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(value))
  const out: number[] = []
  do {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    out.push(v ? byte | 0x80 : byte)
  } while (v)
  return out
}
const key = (field: number, wire: number) => varint((field << 3) | wire)
const bytesField = (field: number, payload: number[]) => [
  ...key(field, 2),
  ...varint(payload.length),
  ...payload,
]
const text = (field: number, value: string) =>
  bytesField(field, [...new TextEncoder().encode(value)])
const f32 = (value: number) => [...new Uint8Array(Float32Array.of(value).buffer)]

describe('readOnnx', () => {
  /*
   * One node with every attribute form the plan reads, and three initializers: raw data at an
   * offset that is not a multiple of four (so the copy path runs), packed float_data, and an
   * int64 tensor that must be listed as unread rather than refuse the file.
   */
  const node = [
    ...text(1, 'x'),
    ...text(1, 'w'),
    ...text(2, 'y'),
    ...text(4, 'Conv'),
    ...bytesField(5, [
      ...text(1, 'strides'),
      ...bytesField(8, [...varint(2), ...varint(2), ...varint(2)]),
    ]),
    ...bytesField(5, [...text(1, 'epsilon'), ...key(2, 5), ...f32(1e-5)]),
    ...bytesField(5, [...text(1, 'axis'), ...key(3, 0), ...varint(-1)]),
    ...bytesField(5, [...text(1, 'auto_pad'), ...text(4, 'NOTSET')]),
  ]
  const raw = [...f32(1.5), ...f32(-2), ...f32(3.25)]
  const graph = [
    ...bytesField(1, node),
    ...bytesField(5, [
      ...key(1, 0),
      ...varint(3),
      ...key(2, 0),
      ...varint(1),
      ...text(8, 'w'),
      ...bytesField(9, raw),
    ]),
    ...bytesField(5, [
      ...bytesField(1, [...varint(2)]),
      ...key(2, 0),
      ...varint(1),
      ...bytesField(4, [...f32(7), ...f32(8)]),
      ...text(8, 'b'),
    ]),
    ...bytesField(5, [
      ...key(1, 0),
      ...varint(1),
      ...key(2, 0),
      ...varint(7),
      ...text(8, 'shape'),
      ...bytesField(9, [1, 0, 0, 0, 0, 0, 0, 0]),
    ]),
  ]
  // A leading field the reader does not know, so the graph's bytes land at an odd offset.
  const model = new Uint8Array([...key(1, 0), ...varint(8), ...bytesField(7, graph)])

  it('reads nodes, their numeric attributes, and float32 tensors in both encodings', () => {
    const read = readOnnx(model)
    expect(read.nodes).toHaveLength(1)
    const [conv] = read.nodes
    expect(conv).toMatchObject({ opType: 'Conv', inputs: ['x', 'w'], outputs: ['y'] })
    expect(conv!.attributes.get('strides')).toEqual([2, 2, 2])
    expect(conv!.attributes.get('epsilon')).toBeCloseTo(1e-5, 10)
    expect(conv!.attributes.get('axis')).toBe(-1)
    expect(conv!.attributes.get('auto_pad')).toBe('NOTSET')
    expect([...read.initializers.get('w')!.data!()]).toEqual([1.5, -2, 3.25])
    expect([...read.initializers.get('b')!.data!()]).toEqual([7, 8])
  })

  it('lists a tensor it cannot read as float32 rather than refusing the file', () => {
    const shape = readOnnx(model).initializers.get('shape')!
    expect(shape.data).toBeUndefined()
    expect(shape.unread).toMatch(/type 7/)
  })

  it('refuses bytes that hold no graph', () => {
    expect(() => readOnnx(new Uint8Array([...key(1, 0), 1]))).toThrow(/no graph/)
  })
})

// ── The plan, from a synthetic export with SEAM's names ──────────────────────────────────────

function syntheticExport(): OnnxGraph {
  const initializers = new Map<string, OnnxTensor>()
  const nodes: OnnxNode[] = []
  const put = (name: string, dims: number[], fill = 0) => {
    const values = new Float32Array(dims.reduce((n, d) => n * d, 1)).fill(fill)
    initializers.set(name, { name, dims, data: () => values })
  }
  let folded = 700
  const conv = (
    output: string,
    cout: number,
    cin: number,
    k: number,
    stride: number,
    names?: string,
  ) => {
    const w = names ? `${names}.weight` : `onnx::Conv_${folded++}`
    const b = names ? `${names}.bias` : `onnx::Conv_${folded++}`
    put(w, [cout, cin, k, k, k])
    put(b, [cout])
    nodes.push({
      opType: 'Conv',
      inputs: ['in', w, b],
      outputs: [output],
      attributes: new Map([
        ['strides', [stride, stride, stride]],
        ['pads', [0, 0, 0, 0, 0, 0]],
      ]),
    })
  }
  const bn = (prefix: string, c: number) => {
    put(`${prefix}.weight`, [c], 2)
    put(`${prefix}.bias`, [c], 0.5)
    put(`${prefix}.running_mean`, [c], 1)
    put(`${prefix}.running_var`, [c], 3)
    nodes.push({
      opType: 'BatchNormalization',
      inputs: [
        'in',
        `${prefix}.weight`,
        `${prefix}.bias`,
        `${prefix}.running_mean`,
        `${prefix}.running_var`,
      ],
      outputs: [`${prefix}.out`],
      attributes: new Map([['epsilon', 1]]),
    })
  }
  conv('/net/conv1/Conv_output_0', 64, 2, 7, 2)
  let cin = 64
  ;[64, 128, 256, 512].forEach((cout, s) => {
    for (let b = 0; b < 2; b++) {
      const stride = s > 0 && b === 0 ? 2 : 1
      const where = `/net/stages.${s}/stages.${s}.${b}`
      const params = `net.backbone.stages.${s}.${b}`
      conv(
        `${where}/conv_0/Conv_output_0`,
        cout,
        b === 0 ? cin : cout,
        3,
        stride,
        `${params}.conv_0`,
      )
      bn(`${params}.bn_0`, cout)
      conv(`${where}/conv_1/Conv_output_0`, cout, cout, 3, 1, `${params}.conv_1`)
      bn(`${params}.bn_1`, cout)
      if (b === 0) conv(`${where}/shortcut_conv/Conv_output_0`, cout, cin, 1, stride)
    }
    cin = cout
  })
  put('net.head.weight', [1, 512])
  put('net.head.bias', [1], 0.25)
  return { initializers, nodes }
}

describe('samePad', () => {
  it("is SEAM's _same_pad at every size the network meets", () => {
    expect(samePad(129, 7, 2)).toEqual({ pad: 3, out: 65 })
    expect(samePad(65, 3, 2)).toEqual({ pad: 1, out: 33 })
    expect(samePad(33, 3, 1)).toEqual({ pad: 1, out: 33 })
    expect(samePad(33, 3, 2)).toEqual({ pad: 1, out: 17 })
    expect(samePad(33, 1, 2)).toEqual({ pad: 0, out: 17 })
    expect(samePad(9, 3, 2)).toEqual({ pad: 1, out: 5 })
  })
})

describe('segclrPlan', () => {
  const plan = segclrPlan(syntheticExport())
  const convs = plan.steps.filter((step): step is ConvStep => step.kind === 'conv')
  /** Stage 0's four 3³ convolutions: the ones that compute only what an object can reach. */
  const skippable = [...skippableConvs(plan.steps).depthOf.keys()]

  it('cuts the patch the scoring loop does', () => {
    expect(PATCH_EDGE).toBe(PATCH_VOXELS)
  })

  it('costs what the manifest says a patch costs', () => {
    // The manifest's figure is SEAM's own count, hooked on PyTorch's modules; agreeing with it
    // is a check on every edge and stride above, since each one changes the total.
    expect(plan.flops / 1e9).toBeCloseTo(manifest.config.gflopPerPatch, 1)
  })

  it('is 21 convolutions, ending at 512 channels on 5³', () => {
    expect(convs).toHaveLength(21)
    expect(plan.steps.map((step) => step.kind).join()).toMatch(/^conv,maxpool,(conv,)+head$/)
    expect(convs.at(-1)).toMatchObject({ cout: 512, outEdge: 5 })
  })

  it('wires each block to its own shortcut, and the second block to the first', () => {
    const second = (tag: string) => convs.find((step) => step.name === `${tag}.conv_1`)!
    expect(second('s1b0').residual).toBe('s1b0.short')
    expect(second('s1b1').residual).toBe('s1b0.out')
    expect(convs.find((step) => step.name === 's1b0.shortcut')).toMatchObject({
      input: 's0b1.out',
      stride: 2,
      pad: 0,
    })
  })

  it('folds a block batch norm to scale and shift, and leaves the folded ones alone', () => {
    // γ 2, β 0.5, mean 1, var 3, ε 1: scale 2 / √4 = 1, shift 0.5 − 1 × 1 = −0.5.
    const block = convs.find((step) => step.name === 's0b0.conv_0')!
    expect(block.bnAfterRelu!.scale[0]).toBe(1)
    expect(block.bnAfterRelu!.shift[0]).toBe(-0.5)
    expect(convs.find((step) => step.name === 'conv1')!.bnAfterRelu).toBeUndefined()
  })

  it('never puts a step output in the buffer of a tensor it reads', () => {
    const { sizes, slotOf } = bufferSlots(plan.steps)
    for (const step of plan.steps) {
      const output = outputOf(step)
      if (!output) continue
      const mine = slotOf.get(output.name)!
      for (const input of inputsOf(step)) expect(slotOf.get(input)).not.toBe(mine)
      expect(sizes[mine]!).toBeGreaterThanOrEqual(output.floats)
    }
  })

  it('shares buffers: the stem output, plus what the blocks need, and none for the patch', () => {
    // The stem's 70 MB is taken by the stages once the pool has read it, so the slots come to
    // the stem and three for a block (input, first conv, shortcut). The patch is the upload
    // itself (`PATCH`); the dense reference adds the encoded patch's 17 MB.
    const { sizes } = bufferSlots(plan.steps)
    expect(sizes.length).toBeLessThanOrEqual(4)
    const total = (of: number[]) => of.reduce((sum, floats) => sum + floats, 0)
    const dense = bufferSlots(segclrPlan(syntheticExport(), { denseStem: true }).steps).sizes
    expect(total(dense)).toBeGreaterThan(total(sizes))
  })

  /**
   * **The stem, and only the stem, reads the patch of labels** (`stemShader`). Its answer is the
   * dense stem's to the bit — `probe:gpu-assessor` holds that, on a GPU; what is pinned here is
   * which step takes the sparse path, and the shape of the dispatch it gets.
   */
  it('reads the stem from the patch, in cubes of four voxels a side', () => {
    expect(plan.steps[0]).toMatchObject({ kind: 'conv', name: 'conv1', input: PATCH })
    expect(plan.steps.filter((step) => 'input' in step && step.input === PATCH)).toHaveLength(1)
    expect(plan.edge).toBe(PATCH_EDGE)
    expect(stemGroups(convs[0]!)).toEqual([17, 17, 17])
    // A cube of 4 outputs at stride 2 under a 7³ kernel reads 13³ labels: 8.8 KB of workgroup
    // memory, under the 16 KB every WebGPU device offers.
    expect(stemFootprint(convs[0]!)).toBe(13)
    expect(() => stemShader({ ...convs[0]!, cin: 3 })).toThrow(/2 channels/)
  })

  /**
   * **Stage 0 computes only what an object can reach** (`network.ts`). That the logit stays the
   * same to the bit is `probe:gpu-assessor`'s to hold, on a GPU; what is pinned here is which
   * convolutions take part and how far each one's reach has grown — a depth one short computes
   * too few voxels, and every answer would still be a logit.
   */
  it('skips the background in stage 0 alone, a 3³ window further at each convolution', () => {
    const { pool, depthOf } = skippableConvs(plan.steps)
    expect(pool?.output).toBe('pool')
    expect([...depthOf].map(([step, depth]) => [step.name, depth])).toEqual([
      ['s0b0.conv_0', 1],
      ['s0b0.conv_1', 2],
      ['s0b1.conv_0', 3],
      ['s0b1.conv_1', 4],
    ])
    // Every one of them can compute a list alongside the others — none splits its sum and all
    // are one width — so none falls back to computing every voxel (`network.ts`).
    expect(listedTogether(skippable)).toEqual(skippable)
    // One that splits is left out, and so is one of another width.
    const late = convs.find((step) => convLayout(step).splits > 1)!
    expect(listedTogether([...skippable, late, { ...skippable[0]!, cout: 128 }])).toEqual(
      skippable,
    )
  })

  it('stops following a reach it cannot work out', () => {
    // A 5³ window reaches two voxels further, which nothing here follows: the chain ends at
    // that convolution rather than counting it as reaching no further than its input.
    const wider = plan.steps.map((step) =>
      step.kind === 'conv' && step.name === 's0b0.conv_1' ? { ...step, kernel: 5 } : step,
    )
    expect([...skippableConvs(wider).depthOf.keys()].map((step) => step.name)).toEqual([
      's0b0.conv_0',
    ])
  })

  it('binds the list of voxels after whatever else a convolution reads', () => {
    const [first, second] = skippable
    // No residual on a block's first convolution, one on its second.
    expect(convShader(first!, convLayout(first!), { listed: true })).toContain('@binding(4)')
    expect(convShader(second!, convLayout(second!), { listed: true })).toContain('@binding(5)')
    expect(convShader(second!, convLayout(second!))).not.toContain('@binding(5)')
    // A split sum is added up for every voxel by its second pass, so it cannot take a list.
    const late = convs.find((step) => convLayout(step).splits > 1)!
    expect(() => convShader(late, convLayout(late), { listed: true })).toThrow(/splits its sum/)
  })

  it('writes the inner loop out as the same sixteen steps', () => {
    const [first] = skippable
    const steps = (code: string) => code.match(/acc0_0 = fma/g)
    expect(steps(convShader(first!, convLayout(first!)))).toHaveLength(1)
    expect(steps(convShader(first!, convLayout(first!), { unrolled: true }))).toHaveLength(
      TILE_K,
    )
  })

  it('writes the stem in two forms, and flags its reach only when asked', () => {
    const stem = convs[0]!
    const foot = stemFootprint(stem)
    expect(stemShader(stem)).toContain(`array<f32, ${foot ** 3}>`)
    expect(stemShader(stem)).not.toContain('@binding(4)')
    // A row of labels to a word, two bits each, in place of a float a label.
    const packed = stemShader(stem, { reach: true, packed: true })
    expect(packed).toContain(`array<u32, ${foot ** 2}>`)
    expect(packed).not.toContain(`array<f32, ${foot ** 3}>`)
    expect(packed).toContain('@binding(4)')
    // A row wider than sixteen labels does not fit a word: such a stem is written plain
    // (`network.ts` asks `stemPacks`), and asking for it packed anyway is refused.
    expect(stemPacks(stem)).toBe(true)
    expect(stemPacks({ ...stem, kernel: 15 })).toBe(false)
    expect(() => stemShader({ ...stem, kernel: 15 }, { packed: true })).toThrow(
      /pack into a word/,
    )
  })

  /* The reference the sparse stem is checked against, still planned on request. */
  it('plans the dense reference on request: encode, then the dense stem', () => {
    const dense = segclrPlan(syntheticExport(), { denseStem: true })
    expect(dense.steps[0]).toMatchObject({ kind: 'encode', output: 'x' })
    const encode = dense.steps[0]!
    expect(dense.steps[1]).toMatchObject({
      kind: 'conv',
      input: encode.kind === 'encode' ? encode.output : '',
    })
    expect(dense.flops).toBe(plan.flops)
    // The sparse stem matches it to the bit only while its sum is not split (`SPLIT_TARGET`).
    const stem = dense.steps[1]!
    expect(stem.kind === 'conv' && convLayout(stem).splits).toBe(1)
  })

  it('refuses the MatMul rewrite in a sentence', () => {
    const graph = syntheticExport()
    const nodes = graph.nodes.filter(
      (node) => !node.outputs[0]!.includes('stages.2/stages.2.0/conv_0'),
    )
    expect(() => segclrPlan({ ...graph, nodes })).toThrow(AssessorPlanError)
    expect(() => segclrPlan({ ...graph, nodes })).toThrow(/plain Conv export/)
  })

  it.each([
    ['dilations', [2, 2, 2], /dilations 2,2,2/],
    ['group', 2, /grouped/],
    ['auto_pad', 'SAME_UPPER', /pads itself/],
  ] as const)('refuses a convolution with %s the shaders do not compute', (key, value, why) => {
    const graph = syntheticExport()
    const target = '/net/stages.1/stages.1.0/conv_1/Conv_output_0'
    const nodes = graph.nodes.map((node) =>
      node.outputs[0] === target
        ? { ...node, attributes: new Map([...node.attributes, [key, value]]) }
        : node,
    )
    expect(() => segclrPlan({ ...graph, nodes })).toThrow(why)
  })

  it('refuses a weight of the wrong shape', () => {
    const graph = syntheticExport()
    const initializers = new Map(graph.initializers)
    initializers.set('net.head.weight', {
      name: 'net.head.weight',
      dims: [1, 256],
      data: () => new Float32Array(256),
    })
    expect(() => segclrPlan({ ...graph, initializers })).toThrow(/1×256.*1×512/)
  })
})

describe('the convolution layout', () => {
  /** A tiny convolution with every weight distinct, so a transposition cannot hide. */
  const step: ConvStep = {
    kind: 'conv',
    name: 'tiny',
    input: 'a',
    output: 'b',
    cin: 3,
    cout: 64,
    inEdge: 4,
    outEdge: 4,
    kernel: 3,
    stride: 1,
    pad: 1,
    weight: () => Float32Array.from({ length: 64 * 3 * 27 }, (_, i) => i),
    bias: new Float32Array(64).fill(0.5),
  }

  it('puts weight (co, ci, tap) at row tap·Cin + ci, column co, padded to whole tiles', () => {
    const layout = convLayout(step)
    const laid = convWeightLayout(step, layout)
    expect(laid.length).toBe(layout.chunks * TILE_K * 64)
    for (const [co, ci, tap] of [
      [0, 0, 0],
      [5, 2, 13],
      [63, 1, 26],
    ] as const) {
      expect(laid[(tap * 3 + ci) * 64 + co]).toBe((co * 3 + ci) * 27 + tap)
    }
    // The padding rows are zero, so the tail tile adds nothing.
    expect(laid.subarray(3 * 27 * 64).every((v) => v === 0)).toBe(true)
  })

  it('splits a long reduction over small volumes, and not a short one', () => {
    expect(
      convLayout({ ...step, cin: 512, cout: 512, inEdge: 5, outEdge: 5 }).splits,
    ).toBeGreaterThan(8)
    expect(convLayout({ ...step, cin: 64, cout: 64, inEdge: 33, outEdge: 33 }).splits).toBe(1)
  })

  it('lays out bias, scale and shift, and only the bias where there is no batch norm', () => {
    expect(epilogueParams(step)).toHaveLength(64)
    const scale = new Float32Array(64).fill(2)
    const shift = new Float32Array(64).fill(-1)
    const params = epilogueParams({ ...step, bnAfterRelu: { scale, shift } })
    expect([params.length, params[0], params[64], params[128]]).toEqual([192, 0.5, 2, -1])
  })
})
