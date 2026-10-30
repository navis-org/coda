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

import { completeVariants } from './manifest'
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
 * The manifest records each file's quantisation recipe, including the ops it emits, so this is a
 * question the data can answer rather than one each node has to remember.
 */
export function preferredVariant(manifest: ModelManifest): string | undefined {
  const sizes = new Map<string, number>()
  const refused = new Set<string>()
  for (const file of manifest.files) {
    sizes.set(file.variant, (sizes.get(file.variant) ?? 0) + file.bytes)
    // An absent `emits` refuses: the gate's whole job is to stop a variant that runs on the
    // CPU without saying so, and "the manifest did not say" is not evidence that it is safe.
    const emits = file.quantisation.emits
    if (!emits?.length || emits.some((op) => NOT_ON_WEBGPU.includes(op)))
      refused.add(file.variant)
  }
  return completeVariants(manifest)
    .filter((variant) => !refused.has(variant))
    .sort((a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0))[0]
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
