/**
 * What this browser can run a model on, asked before anything is offered or downloaded.
 *
 * The point is to refuse early and in a sentence. Without WebGPU the affinity encoder falls to
 * wasm, where it is not slow but unusable: the int8 variant, which WebGPU declines and so runs on
 * the CPU, measured **8.4 seconds against 0.5** for one encoder pass and 13x worse on the decoder
 * (docs/proofread-plan.md). A node that quietly started a 385 MB download and then ran for an
 * hour would be worse than one that says it cannot.
 */

/** Why a model cannot run here, or undefined when it can. One sentence, for `ctx.warn`. */
export type GpuRefusal = string | undefined

export interface GpuSupport {
  readonly ok: boolean
  readonly refusal: GpuRefusal
  /** What answered, for a probe's report and for a bug report. Absent when there is no adapter. */
  readonly vendor?: string
  readonly architecture?: string
}

/**
 * Ask the browser for a WebGPU adapter.
 *
 * Note `navigator.gpu` is absent on an insecure origin — including `about:blank`, which cost a
 * false negative while measuring Phase 1 — so "no WebGPU" here can mean "not served over https"
 * rather than "this browser cannot". The message says so, because the two are fixed differently.
 */
export async function gpuSupport(): Promise<GpuSupport> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu
  if (!gpu) {
    return {
      ok: false,
      refusal:
        'This browser has no WebGPU, which this model needs. Chrome and Edge have it; Safari ' +
        'and Firefox are adding it. A page served over plain http has it switched off too.',
    }
  }
  let adapter
  try {
    adapter = await gpu.requestAdapter()
  } catch {
    adapter = null
  }
  if (!adapter) {
    return {
      ok: false,
      refusal: 'WebGPU is present but offered no adapter, so there is no GPU here to run on.',
    }
  }
  const info = adapter.info as { vendor?: string; architecture?: string } | undefined
  return {
    ok: true,
    refusal: undefined,
    vendor: info?.vendor,
    architecture: info?.architecture,
  }
}
