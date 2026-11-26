/**
 * WGSL for the hand-written assessor, generated per step with every size a constant.
 *
 * Plain functions of a step's numbers, so they are testable without a GPU and the shapes are
 * checked before anything is compiled. `network.ts` compiles and runs them.
 *
 * ## The convolution: an implicit matrix multiply
 *
 * A convolution is a (Cout × Cin·k³) by (Cin·k³ × voxels) product. The right-hand matrix is never
 * built: each tile of it is read from the input, at the tap's offset, straight into workgroup
 * memory, so nothing like the MatMul rewrite's 27 `Slice` copies exists. `probe:conv3d-kernel`
 * measured the shape on the 64→64 3×3×3 case at 4.1 TFLOP/s against the rewrite's 0.77
 * (docs/seam-assessor-speed.md §13). Tile: 64 output channels × 64 voxels a workgroup, 8 × 4 a
 * thread, 16 reduction steps a tile — the fastest of the five shapes that probe swept, and the
 * spread between them was 8%.
 *
 * The reduction index is tap-major, `k = tap · Cin + ci`. When `Cin` is a multiple of the tile's
 * 16, one tile is one tap, so a thread works out its input address once per tile. A stem with
 * another `Cin` takes the general path, which works the address out per element. Only the dense
 * reference's stem takes it here (`segclrPlan`'s `denseStem`); the network's own stem reads the
 * patch instead (`stemShader`).
 *
 * ## Splitting the reduction
 *
 * The late stages are small in space and long in the reduction — stage 3 is 125 voxels against
 * 13,824 terms — so a tile per (channels, voxels) block is 16 workgroups on a GPU that wants
 * hundreds. Those steps split the reduction across workgroups (`splits`), each writing a partial
 * sum, and a second pass (`reduceShader`) adds them and applies the epilogue. WGSL has no float
 * atomics, so the second pass is the only way to add them.
 *
 * ## The epilogue
 *
 * Everything between one convolution and the next is folded in: bias; then for a block's
 * convolutions ReLU and the batch norm's scale and shift; then the residual add and its ReLU.
 *
 * ## Skipping the background
 *
 * A stage-0 convolution computes only the output voxels an object can reach, and `network.ts`
 * says why that is the same logit to the bit. The parts are here: the stem flags which of its
 * outputs any label reaches (`StemForm.reach`); `reachShader` carries the flags through the pool
 * and each 3³ window; `gatherShader` lists the flagged voxels and sizes the dispatch; `fillShader`
 * sets an output to the empty patch's answer; and `ConvForm.listed` computes the list over it.
 *
 * ## Two forms for two shader translators
 *
 * Firefox's translator guards every loop iteration and clears a workgroup's memory slowly, which
 * Chrome's does not (§18): so there the inner loop is written out (`ConvForm.unrolled`) and the
 * stem holds its labels two bits each (`StemForm.packed`). Both are the same sums in the same
 * order.
 */

import type { ConvStep, HeadStep, MaxPoolStep } from './segclrPlan'

/** Output channels a workgroup computes. Every width in the network is a multiple. */
const TILE_M = 64
/** Voxels a workgroup computes. */
const TILE_N = 64
/** Output channels and voxels a thread computes. */
const PER_M = 8
const PER_N = 4
/** Reduction terms a tile holds. */
export const TILE_K = 16
const THREADS = (TILE_M / PER_M) * (TILE_N / PER_N)

/** Workgroup size of the one-thread-per-element passes. */
export const FLAT = 256

export interface ConvLayout {
  /** Reduction length, `Cin · k³`. */
  readonly k: number
  /** Tiles along the reduction. The weights are padded with zeros to `chunks · TILE_K` rows. */
  readonly chunks: number
  readonly splits: number
  /** Workgroups along voxels, channels and splits. */
  readonly groups: readonly [number, number, number]
}

/**
 * How many ways to split a step's reduction.
 *
 * Enough to put about `SPLIT_TARGET` workgroups on the GPU, but never so many that a split holds
 * fewer than eight tiles: below that the partial sums' traffic is a fair share of the arithmetic.
 * The target was swept from 80 to 2,560 on an M3 Max and every value from 160 to 1,280 timed the
 * whole patch within 0.4 ms of the others (docs/seam-assessor-speed.md §14), so it is not tuned.
 */
// The stem's 7³ x 2 reduction never splits, and `stemShader`'s bit-for-bit match with it depends
// on that: a split sum adds its terms in another order. `gpuAssessor.test.ts` pins it.
const SPLIT_TARGET = 320

/** Tiles of output channels a convolution's dispatch runs along its second side. */
export function channelTiles(step: ConvStep): number {
  return step.cout / TILE_M
}

/**
 * Which of these convolutions can compute one list of voxels between them (`ConvForm.listed`):
 * none that splits its sum, whose second pass adds up every voxel; and only those as wide as the
 * first, since the list's dispatch is written once for all of them (`gatherShader`).
 */
export function listedTogether(steps: readonly ConvStep[]): ConvStep[] {
  const whole = steps.filter((step) => convLayout(step).splits === 1)
  return whole.filter((step) => channelTiles(step) === channelTiles(whole[0]!))
}

export function convLayout(step: ConvStep): ConvLayout {
  if (step.cout % TILE_M)
    throw new Error(`${step.name}: ${step.cout} channels is not a multiple of ${TILE_M}`)
  const k = step.cin * step.kernel ** 3
  const chunks = Math.ceil(k / TILE_K)
  const across = Math.ceil(step.outEdge ** 3 / TILE_N)
  const tiles = across * channelTiles(step)
  const splits = Math.max(1, Math.min(Math.floor(chunks / 8), Math.round(SPLIT_TARGET / tiles)))
  return { k, chunks, splits, groups: [across, channelTiles(step), splits] }
}

/**
 * How a convolution is written, beyond what its step says. Neither changes a sum: the same terms
 * are added in the same order for every output either way.
 */
export interface ConvForm {
  /**
   * Compute only the output voxels listed in an extra binding (`lst`, after the residual's) — 64
   * of the list a workgroup, the dispatch as long as the list (`gatherShader`). The step must not
   * split, since a split's second pass adds every voxel's partial sums.
   */
  readonly listed?: boolean
  /**
   * The inner loop's sixteen steps written out, for a translator that charges for a loop's
   * iterations (`frugalShaders` in `src/ml/support.ts` has the measurement).
   */
  readonly unrolled?: boolean
}

/** Floats in a step's laid-out weights: `[k][Cout]`, zero-padded to whole tiles. */
export function convWeightFloats(step: ConvStep, layout: ConvLayout): number {
  return layout.chunks * TILE_K * step.cout
}

/**
 * The weights rearranged to the shader's `[k][Cout]`, into `out` — which the network passes as a
 * buffer's mapped range, so the 133 MB is written once, where the GPU reads it, rather than into
 * an array and then copied. `out` must start zeroed: the padding rows are not written.
 */
export function convWeightLayout(
  step: ConvStep,
  layout: ConvLayout,
  out = new Float32Array(convWeightFloats(step, layout)),
): Float32Array {
  const taps = step.kernel ** 3
  const weight = step.weight()
  /*
   * Output channels in blocks of 16, innermost. The plain (co, ci, tap) order writes `Cin · Cout`
   * floats apart — a megabyte a write in stage 3 — and measured 130 ms over the network; blocked,
   * 16 consecutive floats land together and it is 70 ms, on the open's critical path.
   */
  const BLOCK = 16
  for (let c0 = 0; c0 < step.cout; c0 += BLOCK) {
    const c1 = Math.min(c0 + BLOCK, step.cout)
    for (let ci = 0; ci < step.cin; ci++) {
      for (let tap = 0; tap < taps; tap++) {
        const row = (tap * step.cin + ci) * step.cout
        for (let co = c0; co < c1; co++) {
          out[row + co] = weight[(co * step.cin + ci) * taps + tap]!
        }
      }
    }
  }
  return out
}

/** Bias, then the batch norm's scale and shift if the step has one, as one array. */
export function epilogueParams(step: ConvStep): Float32Array {
  if (!step.bnAfterRelu) return step.bias
  const c = step.cout
  const out = new Float32Array(3 * c)
  out.set(step.bias, 0)
  out.set(step.bnAfterRelu.scale, c)
  out.set(step.bnAfterRelu.shift, 2 * c)
  return out
}

const u = (n: number) => `${n}u`

/**
 * The input corner (`cx`, `cy`, `cz`) of the window that output voxel `index` reads, for a cube
 * of `so` voxels a side: the output position scaled by the stride, less the 'SAME' padding.
 */
function corner(index: string, so: number, stride: number, pad: number): string {
  return `let cx = i32(${index} / ${u(so * so)}) * ${stride} - ${pad};
  let cy = i32((${index} / ${u(so)}) % ${u(so)}) * ${stride} - ${pad};
  let cz = i32(${index} % ${u(so)}) * ${stride} - ${pad};`
}

/**
 * A step's window walked around (`cx`, `cy`, `cz`) — `corner`'s names — as WGSL: `visit` at every
 * input voxel inside the volume, given that voxel's index within one channel. One spelling for
 * the pool and for the flags that say what the pool's outputs reach, which are only right while
 * they walk the same window.
 */
function windowWalk(kernel: number, si: number, visit: (index: string) => string): string {
  return `for (var dx = 0; dx < ${kernel}; dx++) {
    let x = cx + dx;
    if (x < 0 || x >= ${si}) { continue; }
    for (var dy = 0; dy < ${kernel}; dy++) {
      let y = cy + dy;
      if (y < 0 || y >= ${si}) { continue; }
      for (var dz = 0; dz < ${kernel}; dz++) {
        let z = cz + dz;
        if (z < 0 || z >= ${si}) { continue; }
        ${visit(`u32(x) * ${u(si * si)} + u32(y) * ${u(si)} + u32(z)`)}
      }
    }
  }`
}

/** The epilogue as WGSL, on `v` for channel `m` at voxel `n`. */
function epilogue(step: ConvStep): string {
  const c = step.cout
  const lines = [`v = v + ep[m];`]
  if (step.bnAfterRelu) lines.push(`v = max(v, 0.0) * ep[${u(c)} + m] + ep[${u(2 * c)} + m];`)
  if (step.residual) lines.push(`v = max(v + res[m * ${u(step.outEdge ** 3)} + n], 0.0);`)
  return lines.join('\n      ')
}

/**
 * The convolution. Bindings: 0 input, 1 weights, 2 output (or partial sums when split),
 * 3 epilogue parameters and 4 the residual, both only when not split; then the list of voxels to
 * compute, where the form is `listed`.
 */
export function convShader(step: ConvStep, layout: ConvLayout, form: ConvForm = {}): string {
  const { k, chunks, splits } = layout
  if (form.listed && splits !== 1)
    throw new Error(
      `${step.name}: a convolution that splits its sum cannot compute a list of voxels`,
    )
  /**
   * The output voxel at `local` (0 to 63) of this workgroup's tile: the next 64 in index order,
   * or the next 64 of the list — whose last tile is padded with an index past every voxel.
   */
  const voxel = (local: string) => (form.listed ? `lst[n0 + ${local}]` : `n0 + ${local}`)
  const si = step.inEdge
  const so = step.outEdge
  const vi = si ** 3
  const vo = so ** 3
  const cin = step.cin
  const kk = step.kernel
  const perSplit = Math.ceil(chunks / splits)
  const fast = cin % TILE_K === 0
  const MB = TILE_M / PER_M
  const NB = TILE_N / PER_N
  const loadsB = (TILE_K * TILE_N) / THREADS
  const loadsA = (TILE_K * TILE_M) / THREADS
  const rowStep = THREADS / TILE_N
  const rows = (fn: (r: number) => string) =>
    Array.from({ length: PER_M }, (_, r) => fn(r)).join('\n')
  const cols = (fn: (s: number) => string) =>
    Array.from({ length: PER_N }, (_, s) => fn(s)).join('\n')
  const both = (fn: (r: number, s: number) => string) => rows((r) => cols((s) => fn(r, s)))

  /*
   * The input voxel at (offset along each axis from this thread's window corner), or 0 outside
   * the volume: 'SAME' zero padding, done by not reading.
   */
  const address = (tap: string) => `
      let t0 = i32(${tap} / ${u(kk * kk)});
      let t1 = i32((${tap} / ${u(kk)}) % ${u(kk)});
      let t2 = i32(${tap} % ${u(kk)});
      let xi = cx + t0;
      let yi = cy + t1;
      let zi = cz + t2;
      let inb = valid && xi >= 0 && xi < ${si} && yi >= 0 && yi < ${si} && zi >= 0 && zi < ${si};
      let base = select(0u, u32(xi) * ${u(si * si)} + u32(yi) * ${u(si)} + u32(zi), inb);`

  const loadB = fast
    ? `
    {
      let tap = q / ${u(cin / TILE_K)};
      let c0 = (q % ${u(cin / TILE_K)}) * ${u(TILE_K)};${address('tap')}
      for (var i = 0u; i < ${u(loadsB)}; i++) {
        let r = kb + i * ${u(rowStep)};
        Bs[r * ${u(TILE_N)} + nn] = select(0.0, inp[(c0 + r) * ${u(vi)} + base], inb);
      }
    }`
    : `
    for (var i = 0u; i < ${u(loadsB)}; i++) {
      let r = kb + i * ${u(rowStep)};
      let kidx = q * ${u(TILE_K)} + r;
      let ci = kidx % ${u(cin)};
      let tap = kidx / ${u(cin)};${address('tap')}
      Bs[r * ${u(TILE_N)} + nn] = select(0.0, inp[ci * ${u(vi)} + base], inb && kidx < ${u(k)});
    }`

  /**
   * A thread's `PER_N` output voxels. Listed, each is read from the list once, before the
   * writes, rather than at every one of them.
   */
  const threadVoxels = form.listed
    ? cols((s) => `  let vox${s} = ${voxel(`tn + ${u(s * NB)}`)};`)
    : ''
  const reductionStep = (
    r: string,
  ) => `${rows((i) => `      let a${i} = As[${r} * ${u(TILE_M)} + tm + ${u(i * MB)}];`)}
${cols((j) => `      let b${j} = Bs[${r} * ${u(TILE_N)} + tn + ${u(j * NB)}];`)}
${both((i, j) => `      acc${i}_${j} = fma(a${i}, b${j}, acc${i}_${j});`)}`
  const inner = form.unrolled
    ? Array.from({ length: TILE_K }, (_, r) => `    {\n${reductionStep(u(r))}\n    }`).join(
        '\n',
      )
    : `    for (var r = 0u; r < ${u(TILE_K)}; r++) {
${reductionStep('r')}
    }`

  const write = (r: number, s: number) => {
    const m = `(m0 + tm + ${u(r * MB)})`
    const n = form.listed ? `vox${s}` : `(${voxel(`tn + ${u(s * NB)}`)})`
    return splits === 1
      ? `  if (${n} < ${u(vo)}) {
    let m = ${m};
    let n = ${n};
    var v = acc${r}_${s};
    ${epilogue(step)}
    outp[m * ${u(vo)} + n] = v;
  }`
      : `  if (${n} < ${u(vo)}) { outp[(wg.z * ${u(step.cout)} + ${m}) * ${u(vo)} + ${n}] = acc${r}_${s}; }`
  }

  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read> wt: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
${splits === 1 ? '@group(0) @binding(3) var<storage, read> ep: array<f32>;' : ''}
${splits === 1 && step.residual ? '@group(0) @binding(4) var<storage, read> res: array<f32>;' : ''}
${form.listed ? `@group(0) @binding(${step.residual ? 5 : 4}) var<storage, read> lst: array<u32>;` : ''}
var<workgroup> As: array<f32, ${TILE_K * TILE_M}>;
var<workgroup> Bs: array<f32, ${TILE_K * TILE_N}>;

@compute @workgroup_size(${THREADS})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let n0 = wg.x * ${u(TILE_N)};
  let m0 = wg.y * ${u(TILE_M)};
  let tm = li / ${u(NB)};
  let tn = li % ${u(NB)};
${both((r, s) => `  var acc${r}_${s} = 0.0;`)}

  // The output voxel this thread gathers input for, fixed for the whole reduction, and the
  // corner of its window in the input.
  let nn = li % ${u(TILE_N)};
  let kb = li / ${u(TILE_N)};
  let gn = ${voxel('nn')};
  let valid = gn < ${u(vo)};
  ${corner('gn', so, step.stride, step.pad)}

  let q0 = wg.z * ${u(perSplit)};
  let q1 = min(q0 + ${u(perSplit)}, ${u(chunks)});
  for (var q = q0; q < q1; q++) {${loadB}
    let a0 = q * ${u(TILE_K * step.cout)} + m0;
    for (var i = 0u; i < ${u(loadsA)}; i++) {
      let e = li + i * ${u(THREADS)};
      As[e] = wt[a0 + (e / ${u(TILE_M)}) * ${u(step.cout)} + e % ${u(TILE_M)}];
    }
    workgroupBarrier();
${inner}
    workgroupBarrier();
  }
${threadVoxels}
${both(write)}
}`
}

/**
 * Add a split step's partial sums and apply its epilogue. Bindings: 0 partials, 1 output,
 * 2 epilogue parameters, 3 the residual if any. One thread per output element.
 */
export function reduceShader(step: ConvStep, splits: number): string {
  const vo = step.outEdge ** 3
  const total = step.cout * vo
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> part: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@group(0) @binding(2) var<storage, read> ep: array<f32>;
${step.residual ? '@group(0) @binding(3) var<storage, read> res: array<f32>;' : ''}

@compute @workgroup_size(${FLAT})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= ${u(total)}) { return; }
  let m = e / ${u(vo)};
  let n = e % ${u(vo)};
  var v = 0.0;
  for (var s = 0u; s < ${u(splits)}; s++) { v = v + part[s * ${u(total)} + e]; }
  ${epilogue(step)}
  outp[e] = v;
}`
}

/** Output voxels along each side of a sparse stem's workgroup: a 4 × 4 × 4 cube. */
const STEM_CUBE = 4
/** Output channels a sparse stem's thread computes. */
const STEM_CHANNELS = 16

/**
 * Where network voxel (`x`, `y`, `z`) sits in the patch `lab` — (X, Y, Z) on disk, the network's
 * axes (Z, Y, X) — as a WGSL index expression. One spelling for the two shaders that read it.
 */
function labIndex(x: string, y: string, z: string, edge: number): string {
  return `${z} * ${u(edge * edge)} + ${y} * ${u(edge)} + ${x}`
}

/**
 * A label's two input channels, as WGSL expressions on the f32 label `l`: channel 0 is the union
 * mask, channel 1 +1 on C (2) and −1 on Q (1). One spelling for `encodeShader`, which writes
 * them, and `stemShader`, which multiplies by them — so the two cannot come to disagree.
 *
 * **Channel 0 is zero only where channel 1 is too** (both need a positive label), so channel 0
 * alone says whether a label contributes anything: the stem's background test.
 */
function labelChannels(l: string): readonly [string, string] {
  return [
    `select(0.0, 1.0, ${l} > 0.0)`,
    `select(0.0, 1.0, ${l} == 2.0) - select(0.0, 1.0, ${l} == 1.0)`,
  ]
}

/** How the stem is written, beyond its step. Neither changes a sum. */
export interface StemForm {
  /**
   * Also write, per output voxel, whether any label is in its window (binding 4, `reach`): where
   * the background skip starts from. An output with no label in reach is the bias alone.
   */
  readonly reach?: boolean
  /**
   * Hold the footprint a row to a word, two bits a label — 169 words where the plain form holds
   * 2,197 floats — for a translator that charges for workgroup memory (`frugalShaders`). Firefox's
   * stem took 4.0 ms against Chrome's 1.0; packed, a patch is 2.7 ms cheaper there and no
   * different in Chrome (docs/seam-assessor-speed.md §18).
   *
   * **Labels are taken as the whole numbers 0 to 3.** A patch is a mask of 0, 1 and 2 — the
   * cutter's bytes, widened to floats by `scoreCandidates` — so the two forms see the same
   * labels; one in between would be truncated here, where the plain form reads the float it is.
   */
  readonly packed?: boolean
}

/**
 * Whether a stem's footprint packs (`StemForm.packed`): a row of it, two bits a label, in one
 * 32-bit word. The packed form is a choice about speed, so a stem that does not pack is written
 * plain rather than refused.
 */
export function stemPacks(step: ConvStep): boolean {
  return stemFootprint(step) <= 16
}

/** The edge of the cube of labels one sparse-stem workgroup reads. */
export function stemFootprint(step: ConvStep): number {
  return (STEM_CUBE - 1) * step.stride + step.kernel
}

/** The sparse stem's workgroups: one per cube of output voxels. */
export function stemGroups(step: ConvStep): [number, number, number] {
  const side = Math.ceil(step.outEdge / STEM_CUBE)
  return [side, side, side]
}

/**
 * **The stem, read from the patch of labels and skipping its background** — exactly the dense
 * convolution's answer, in about a fifth of its time. Bindings: 0 the patch (`lab`, read through
 * `labIndex`), 1 weights (`convWeightLayout`'s), 2 output, 3 epilogue parameters.
 *
 * The stem's two input channels are functions of one label (`encodeShader`): 0 everywhere outside
 * the two objects, and inside them 1 on channel 0 and ±1 on channel 1. A real patch is ~97%
 * background (the fixture lists: Q 2-4% of voxels, C under 1%), so the dense stem spends nearly
 * all of its 24 GFLOP multiplying by zero. This one loads each workgroup's footprint of labels
 * into workgroup memory, writes the bias-only answer for a workgroup whose footprint is all
 * background, and elsewhere walks the taps adding weights only where a label is set.
 *
 * **It is the dense stem's sum, term for term.** It multiplies by the same channel values
 * (`labelChannels`), with the same `fma(w, x, acc)`, in the same order — tap by tap, channel 0
 * before channel 1 — and leaves out only taps where both channels are 0, whose terms add exactly
 * nothing. The answer is the same to the bit — even a zero's sign, since both sums start at +0
 * and adding a zero to +0 gives +0 — unless the GPU flushes a subnormal sum to zero, where the
 * dense stem's zero terms would flush it and the skipped ones do not. `segclrPlan`'s `denseStem`
 * builds the reference, and the probe checks the bits rather than trusting this.
 */
export function stemShader(step: ConvStep, form: StemForm = {}): string {
  // Two input channels, the two `labelChannels` makes: the weight rows below assume exactly them.
  if (step.cin !== 2)
    throw new Error(`${step.name}: a stem read from the patch has 2 channels, not ${step.cin}`)
  // Each thread holds `STEM_CHANNELS` outputs, and a workgroup is at most 256 threads.
  if (step.cout % STEM_CHANNELS !== 0 || STEM_CUBE ** 3 * (step.cout / STEM_CHANNELS) > 256)
    throw new Error(`${step.name}: ${step.cout} output channels do not fit the sparse stem`)
  const foot = stemFootprint(step)
  if (form.packed && !stemPacks(step))
    throw new Error(`${step.name}: a ${foot}-label row does not pack into a word`)
  // The footprint lives in workgroup memory, guaranteed only to 16 KiB — a float a label, or a
  // word a row when packed; the epilogue binds no residual here.
  if ((form.packed ? foot ** 2 : foot ** 3) * 4 + 4 > 16384 || step.residual)
    throw new Error(
      `${step.name}: a ${foot}³ footprint or a residual does not fit the sparse stem`,
    )
  const si = step.inEdge
  const so = step.outEdge
  const vo = so ** 3
  const kk = step.kernel
  const stride = step.stride
  const cout = step.cout
  const footVoxels = foot ** 3
  const threads = STEM_CUBE ** 3 * (cout / STEM_CHANNELS)
  const channels = labelChannels('l')
  const each = (fn: (j: number) => string) =>
    Array.from({ length: STEM_CHANNELS }, (_, j) => fn(j)).join('\n')
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> lab: array<f32>;
@group(0) @binding(1) var<storage, read> wt: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
@group(0) @binding(3) var<storage, read> ep: array<f32>;
${form.reach ? '@group(0) @binding(4) var<storage, read_write> reach: array<u32>;' : ''}
${
  form.packed
    ? `// The footprint a row (along its last axis) to a word, two bits a label.
var<workgroup> Rw: array<u32, ${foot * foot}>;`
    : `var<workgroup> Ls: array<f32, ${footVoxels}>;`
}
// Zero at the start of every workgroup, as all workgroup memory is.
var<workgroup> anySet: atomic<u32>;

@compute @workgroup_size(${threads})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  // This workgroup's cube of output voxels, and its footprint's corner in the input.
  let fx0 = i32(wg.x) * ${STEM_CUBE * stride} - ${step.pad};
  let fy0 = i32(wg.y) * ${STEM_CUBE * stride} - ${step.pad};
  let fz0 = i32(wg.z) * ${STEM_CUBE * stride} - ${step.pad};
${
  form.packed
    ? `  // The footprint's labels, a row a thread.
  for (var rw = li; rw < ${u(foot * foot)}; rw += ${u(threads)}) {
    let xi = fx0 + i32(rw / ${u(foot)});
    let yi = fy0 + i32(rw % ${u(foot)});
    var bits = 0u;
    if (xi >= 0 && xi < ${si} && yi >= 0 && yi < ${si}) {
      for (var z = 0u; z < ${u(foot)}; z++) {
        let zi = fz0 + i32(z);
        if (zi >= 0 && zi < ${si}) {
          // Masked as well as clamped: a label that is not a number must not reach its neighbour's bits.
          bits = bits | ((u32(clamp(lab[${labIndex('u32(xi)', 'u32(yi)', 'u32(zi)', si)}], 0.0, 3.0)) & 3u) << (2u * z));
        }
      }
    }
    Rw[rw] = bits;
    if (bits != 0u) { atomicOr(&anySet, 1u); }
  }`
    : `  // The footprint's labels.
  for (var e = li; e < ${u(footVoxels)}; e += ${u(threads)}) {
    let xi = fx0 + i32(e / ${u(foot * foot)});
    let yi = fy0 + i32((e / ${u(foot)}) % ${u(foot)});
    let zi = fz0 + i32(e % ${u(foot)});
    var l = 0.0;
    if (xi >= 0 && xi < ${si} && yi >= 0 && yi < ${si} && zi >= 0 && zi < ${si}) {
      l = lab[${labIndex('u32(xi)', 'u32(yi)', 'u32(zi)', si)}];
    }
    Ls[e] = l;
    if (${channels[0]} != 0.0) { atomicOr(&anySet, 1u); }
  }`
}
  workgroupBarrier();
  let anyLabel = atomicLoad(&anySet);

  // This thread: one output voxel of the cube, ${STEM_CHANNELS} channels.
  let cv = li % ${u(STEM_CUBE ** 3)};
  let c0 = (li / ${u(STEM_CUBE ** 3)}) * ${u(STEM_CHANNELS)};
  let vx = cv / ${u(STEM_CUBE * STEM_CUBE)};
  let vy = (cv / ${u(STEM_CUBE)}) % ${u(STEM_CUBE)};
  let vz = cv % ${u(STEM_CUBE)};
  let ox = wg.x * ${u(STEM_CUBE)} + vx;
  let oy = wg.y * ${u(STEM_CUBE)} + vy;
  let oz = wg.z * ${u(STEM_CUBE)} + vz;
  if (ox >= ${u(so)} || oy >= ${u(so)} || oz >= ${u(so)}) { return; }
${each((j) => `  var acc${j} = 0.0;`)}
${form.reach ? '  var hit = 0u;' : ''}
  if (anyLabel != 0u) {
    let lx = vx * ${u(stride)};
    let ly = vy * ${u(stride)};
    let lz = vz * ${u(stride)};
    for (var t0 = 0u; t0 < ${u(kk)}; t0++) {
      for (var t1 = 0u; t1 < ${u(kk)}; t1++) {
${
  form.packed
    ? `        // This tap row's ${kk} labels; a row with none adds nothing.
        let row = (Rw[(lx + t0) * ${u(foot)} + ly + t1] >> (2u * lz)) & ${u(4 ** kk - 1)};
        if (row == 0u) { continue; }`
    : ''
}
        for (var t2 = 0u; t2 < ${u(kk)}; t2++) {
          let l = ${form.packed ? 'f32((row >> (2u * t2)) & 3u)' : `Ls[(lx + t0) * ${u(foot * foot)} + (ly + t1) * ${u(foot)} + lz + t2]`};
          // Channel 0 alone says whether this tap adds anything (\`labelChannels\`).
          let ch0 = ${channels[0]};
          if (ch0 != 0.0) {
${form.reach ? '            hit = 1u;' : ''}
            let ch1 = ${channels[1]};
            // Rows (tap · Cin + ci) · Cout, as \`convWeightLayout\` lays them out.
            let w = ((t0 * ${u(kk * kk)} + t1 * ${u(kk)} + t2) * 2u) * ${u(cout)} + c0;
${each(
  (j) => `            acc${j} = fma(wt[w + ${u(j)}], ch0, acc${j});
            acc${j} = fma(wt[w + ${u(cout + j)}], ch1, acc${j});`,
)}
          }
        }
      }
    }
  }
  let n = (ox * ${u(so)} + oy) * ${u(so)} + oz;
${form.reach ? '  if (c0 == 0u) { reach[n] = hit; }' : ''}
${each(
  (j) => `  {
    let m = c0 + ${u(j)};
    var v = acc${j};
    ${epilogue(step)}
    outp[m * ${u(vo)} + n] = v;
  }`,
)}
}`
}

/**
 * The patch to the network's two channels. `lab` is (X, Y, Z), the network's axes (Z, Y, X):
 * network voxel (a, b, c) is `lab[c][b][a]`. Channel 0 is the union mask, channel 1 +1 on C (2)
 * and −1 on Q (1). Bindings: 0 lab, 1 output.
 */
export function encodeShader(edge: number): string {
  const v = edge ** 3
  const [channel0, channel1] = labelChannels('l')
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> lab: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= ${u(v)}) { return; }
  let a = e / ${u(edge * edge)};
  let b = (e / ${u(edge)}) % ${u(edge)};
  let c = e % ${u(edge)};
  let l = lab[${labIndex('a', 'b', 'c', edge)}];
  outp[e] = ${channel0};
  outp[${u(v)} + e] = ${channel1};
}`
}

/**
 * Which outputs of a windowed step any flagged input reaches: a max pool's window for the first
 * set of flags, a 3³ convolution's for each after it. Bindings: 0 the input's flags, 1 the
 * output's. Outside the volume nothing is flagged.
 */
export function reachShader(window: ReachWindow): string {
  const si = window.inEdge
  const so = window.outEdge
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<u32>;
@group(0) @binding(1) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= ${u(so ** 3)}) { return; }
  ${corner('e', so, window.stride, window.pad)}
  var some = 0u;
  ${windowWalk(window.kernel, si, (index) => `some = some | inp[${index}];`)}
  outp[e] = some;
}`
}

/** The window a step reads its input through: the pool's, or a convolution's. */
export type ReachWindow = Pick<MaxPoolStep, 'inEdge' | 'outEdge' | 'kernel' | 'stride' | 'pad'>

/**
 * The flagged voxels of `act`, listed in index order, and the dispatch that computes them.
 * Bindings: 0 the flags, 1 the list, 2 the dispatch's three sizes.
 *
 * One workgroup. Each thread counts the flags in its own stretch of voxels; after a barrier it
 * knows how many come before it and writes its own from there — so the list is in index order,
 * and neighbours in the volume stay neighbours in a tile. The first thread writes the dispatch
 * (a workgroup per `TILE_N` of the list, `tiles` of them along channels) and pads the last tile
 * with an index past every voxel, which `convShader` reads as "not a voxel".
 */
export function gatherShader(voxels: number, tiles: number): string {
  const per = Math.ceil(voxels / FLAT)
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> act: array<u32>;
@group(0) @binding(1) var<storage, read_write> lst: array<u32>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
var<workgroup> counts: array<u32, ${FLAT}>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(local_invocation_index) li: u32) {
  let first = li * ${u(per)};
  let last = min(first + ${u(per)}, ${u(voxels)});
  var count = 0u;
  for (var e = first; e < last; e++) { if (act[e] != 0u) { count++; } }
  counts[li] = count;
  workgroupBarrier();
  var at = 0u;
  var total = 0u;
  for (var i = 0u; i < ${u(FLAT)}; i++) {
    let c = counts[i];
    if (i < li) { at += c; }
    total += c;
  }
  for (var e = first; e < last; e++) {
    if (act[e] != 0u) { lst[at] = e; at++; }
  }
  if (li == 0u) {
    let groups = (total + ${u(TILE_N - 1)}) / ${u(TILE_N)};
    args[0] = groups;
    args[1] = ${u(tiles)};
    args[2] = 1u;
    for (var i = total; i < groups * ${u(TILE_N)}; i++) { lst[i] = 0xffffffffu; }
  }
}`
}

/** Entries a `gatherShader` list needs: every voxel, and the last tile's padding. */
export function gatherListLength(voxels: number): number {
  return voxels + TILE_N
}

/**
 * One tensor copied over another, element for element: the empty patch's answer over a whole
 * output, before its convolution computes the voxels an object can reach. Bindings: 0 from, 1 to.
 *
 * A shader and not `copyBufferToBuffer`, which cannot be recorded inside a compute pass: a patch
 * is one pass, and four copies would cut it into five. It measured 0.1 ms.
 */
export function fillShader(floats: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> bg: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= ${u(floats)}) { return; }
  outp[e] = bg[e];
}`
}

/** Max over a window, padding never winning. Bindings: 0 input, 1 output. */
export function maxPoolShader(step: MaxPoolStep): string {
  const si = step.inEdge
  const so = step.outEdge
  const total = step.channels * so ** 3
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= ${u(total)}) { return; }
  let ch = e / ${u(so ** 3)};
  let n = e % ${u(so ** 3)};
  ${corner('n', so, step.stride, step.pad)}
  var best = -0x1.fffffep+127f;
  ${windowWalk(step.kernel, si, (index) => `best = max(best, inp[ch * ${u(si ** 3)} + ${index}]);`)}
  outp[e] = best;
}`
}

/**
 * Mean over the volume per channel, then the linear head, in one workgroup. Bindings: 0 input,
 * 1 head weights, 2 the one-float output. The bias is a constant in the shader.
 */
export function headShader(step: HeadStep): string {
  const v = step.edge ** 3
  const per = Math.ceil(step.channels / FLAT)
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<f32>;
var<workgroup> partial: array<f32, ${FLAT}>;

@compute @workgroup_size(${FLAT})
fn main(@builtin(local_invocation_index) li: u32) {
  var sum = 0.0;
  for (var i = 0u; i < ${u(per)}; i++) {
    let ch = li + i * ${u(FLAT)};
    if (ch < ${u(step.channels)}) {
      var total = 0.0;
      for (var n = 0u; n < ${u(v)}; n++) { total = total + inp[ch * ${u(v)} + n]; }
      sum = sum + w[ch] * (total / ${v}.0);
    }
  }
  partial[li] = sum;
  workgroupBarrier();
  for (var width = ${u(FLAT / 2)}; width > 0u; width = width / 2u) {
    if (li < width) { partial[li] = partial[li] + partial[li + width]; }
    workgroupBarrier();
  }
  if (li == 0u) { outp[0] = partial[0] + (${f32Literal(step.bias)}); }
}`
}

/** A float as a WGSL literal that round-trips: never `1e-7` without a decimal point. */
function f32Literal(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`${value} cannot be a shader constant`)
  const text = Math.fround(value).toPrecision(9)
  return /[.e]/.test(text) ? text : `${text}.0`
}
