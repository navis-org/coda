/**
 * What this browser can run a model on, asked before anything is offered or downloaded.
 *
 * The point is to refuse early and in a sentence. Without WebGPU a model falls to wasm, which is
 * not a degraded mode but a different product: the int8 variant of the point affinity encoder,
 * which WebGPU declines and so runs on the CPU, measured 8.4 s against 0.5 s for one pass and 13x
 * worse on its decoder (docs/ml.md). A node that quietly started a 385 MB download and then ran
 * for an hour would be worse than one that says it cannot.
 */

/// <reference types="@webgpu/types" />

import { completeVariants, variantBytes } from './manifest'
import type { ModelManifest } from './manifest'

export interface GpuSupport {
  /**
   * Why no model can run here, or undefined when one can.
   *
   * One field rather than a `refusal` beside an `ok` that merely restates it — two fields that
   * cannot disagree are one field, which is how `whyDatasetMissing` and `edgePlanRefusal` are
   * shaped. A sentence for `ctx.warn`, and deliberately about the *browser*: which model wanted
   * it is the node's to say, not this module's.
   */
  readonly refusal: string | undefined
  /** What answered, for a probe's report and for a bug report. Absent when there is no adapter. */
  readonly vendor?: string
  readonly architecture?: string
}

/**
 * Ops the WebGPU backend does not implement, so a graph containing one silently runs on the CPU.
 *
 * Data rather than prose because the finding it encodes is the hardest-won of the phase and the
 * failure is silent: dynamic int8 quantisation emits `MatMulInteger`, WebGPU declines it, and the
 * model **loads and answers** — 16x slower on the encoder and 35x on the decoder (docs/ml.md). A
 * caller choosing the smallest variant gets a working, unusable model and no error at all.
 */
const NOT_ON_WEBGPU = ['MatMulInteger']

/**
 * The variant to open: complete, runnable on WebGPU, and smallest of those.
 *
 * **"Smallest runnable" is only the right rule if the manifest publishes only variants fit to
 * ship**, and that is a hosting rule, not something this function can check. A conversion
 * directory carries every variant it built — including ones measured as worse — and against that
 * set this would pick the smallest, which for the point affinity model is `nbits4`: runnable,
 * 206 MB, and moving 2% of pair decisions against the `mixed` build every measurement in
 * `docs/ml.md` was taken on. Publish one variant, or publish only ones you would be happy to get.
 *
 * **And only variants fit for the same runtime.** SEAM's mask assessor breaks that half: it
 * publishes a plain graph for Coda's own WGSL implementation of the architecture and a rewrite
 * of the same weights for ONNX Runtime, 0.2 MB apart — so this would hand ONNX Runtime the one
 * it is eight times slower on, runnable and wrong. A model whose variants are different *graphs*
 * rather than different *quantisations* names its build at the opening site and never reaches
 * here; `OpenSeamModelOptions.runtime` is how.
 *
 * What it *can* check is the op inventory, which is a measured fact the manifest carries.
 *
 * **It cannot check fidelity per backend**, and that is a second way "runnable" misleads: every
 * fidelity figure a manifest carries was taken on the CPU, so a variant can be complete, fast and
 * accepted here while being measurably less accurate on the backend that will run it. Measured,
 * not supposed — see docs/ml.md, "Fidelity on WebGPU".
 */
export function preferredVariant(manifest: ModelManifest): string | undefined {
  const refused = new Set<string>()
  for (const file of manifest.files) {
    // An absent `emits` refuses: the gate's whole job is to stop a variant that runs on the
    // CPU without saying so, and "the manifest did not say" is not evidence that it is safe.
    // `quantisation` itself is optional too -- `checkManifest` does not validate it, so a file
    // entry without one must reach the refusal rather than a bare TypeError.
    const emits = file.quantisation?.emits
    if (!emits?.length || emits.some((op) => NOT_ON_WEBGPU.includes(op)))
      refused.add(file.variant)
  }
  return completeVariants(manifest)
    .filter((variant) => !refused.has(variant))
    .sort((a, b) => variantBytes(manifest, a) - variantBytes(manifest, b))[0]
}

/**
 * Ask the browser for a WebGPU adapter.
 *
 * Note `navigator.gpu` is absent on an insecure origin — including `about:blank`, which cost a
 * false negative while measuring this — so "no WebGPU" can mean "not served over https" rather
 * than "this browser cannot". The message says so, because the two are fixed differently.
 */
export async function gpuSupport(): Promise<GpuSupport> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu
  if (!gpu) {
    return {
      refusal:
        'This browser has no WebGPU, which running a model here needs. Chrome and Edge have it; ' +
        'Safari and Firefox are adding it. A page served over plain http has it switched off too.',
    }
  }
  let adapter: GPUAdapter | null = null
  try {
    adapter = await gpu.requestAdapter()
  } catch {
    adapter = null
  }
  if (!adapter) {
    return {
      refusal: 'WebGPU is present but offered no adapter, so there is no GPU to run on.',
    }
  }
  const info = adapter.info as { vendor?: string; architecture?: string } | undefined
  return { refusal: undefined, vendor: info?.vendor, architecture: info?.architecture }
}

/**
 * Firefox, by name: what the measurement below was taken in, and all it claims.
 *
 * Firefox also answers every wait for the GPU in ~100 ms whatever the work, which is why SEAM's
 * assessor keeps patches in flight (`docs/seam-assessor-speed.md` §16). That one is a fact about
 * waiting, not about shaders, and nothing asks it by name any more.
 */
function firefox(): boolean {
  const agent = (globalThis.navigator as Navigator | undefined)?.userAgent
  return typeof agent === 'string' && agent.includes('Firefox/')
}

/**
 * Whether to build the forms of a shader that spare the browser's translator its loops and its
 * workgroup memory: Firefox on a Mac, whose translator charges for both where Chrome's does not.
 *
 * **Measured, in both browsers** (2026-11-21, M3 Max, Firefox 160, `pnpm probe:gpu-browsers`,
 * `docs/seam-assessor-speed.md` §18). SEAM's assessor ran the same multiply-adds in the same time
 * in both — about 13.7 ms a patch — and everything around them cost Firefox 15.5 ms against
 * Chrome's 5.6. Two causes were found by changing one thing at a time: 2,048 floats of workgroup
 * memory that nothing used cost Firefox 3.3 ms a patch and Chrome nothing, and a 16-step loop
 * written out saved it 3.4 ms while costing Chrome 2%. So a kernel has a second form for this
 * browser — less workgroup memory, the hot loop written out — and this says when to build it.
 *
 * Asked by name because there is no feature to ask about: the shaders compile and answer the
 * same to the bit; only the clock differs.
 */
export function frugalShaders(): boolean {
  return firefox() && onMac()
}

/**
 * A Mac, by name — where `frugalShaders` was measured. Firefox translates a shader for Metal
 * there and for other targets elsewhere, and what a loop or a workgroup's memory costs through
 * those is not known; the plain forms are what every other browser and platform runs.
 */
function onMac(): boolean {
  const agent = (globalThis.navigator as Navigator | undefined)?.userAgent
  return typeof agent === 'string' && agent.includes('Macintosh')
}
