/**
 * Opening a SEAM window model: the gate, the download consent and the progress bar.
 *
 * Three cards in this pack run a checkpoint over a neuron's surface — Find Merges, Find Open Ends
 * and Affinity Clusters — and the forty lines in front of each run were the same forty lines,
 * three times. They had already drifted: the refusal sentences were worded two ways and the share
 * of the bar given to the download was two different numbers, which is what a third copy does.
 *
 * Nothing about the three nodes' differences lives in this sequence. What differs is the task,
 * the model list and what to do with the session afterwards, so those are arguments.
 *
 * ## The four refusals, in the order a reader meets them
 *
 * 1. **No usable GPU.** Asked before a byte is fetched: a browser that cannot run the model
 *    should say so in one sentence rather than after seventy megabytes.
 * 2. **The wrong task.** A manifest is checked against the task the caller can read it as.
 *    Model A and Model E are the same network on the same inputs and differ only in what they
 *    were trained to answer, so a URL pointing at the other one would load, run and return
 *    perfectly shaped numbers about a different question.
 * 3. **No runnable build.** A property of the published model, not of the neurons, and worth
 *    saying that way round.
 * 4. **Consent.** The weights are tens of megabytes. They are fetched once and kept, but never
 *    without being asked for — a graph that opens on its own must not reach for them.
 */

import { formatBytes } from '../../core/limits'
import { loadManifest, variantBytes } from '../../ml/manifest'
import type { ModelSession } from '../../ml/session'
import { openModel } from '../../ml/session'
import { gpuSupport, preferredVariant } from '../../ml/support'
import { weightsCached } from '../../ml/weights'
import type { AffinityModel } from './models'
import { parseWindowConfig } from './windowConfig'
import type { WindowConfig } from './windowConfig'

export interface OpenWindowModelOptions {
  /** The chosen entry of the caller's own model list. */
  readonly model: AffinityModel
  /** The task this caller can read the manifest's `config` as. */
  readonly task: string
  /** `ctx.params.download` — whether the reader has agreed to the fetch. */
  readonly download: boolean
  /** How much of the progress bar the download gets before the node's own work starts. */
  readonly downloadShare: number
  readonly signal?: AbortSignal
  readonly progress: (fraction: number, note?: string) => void
  /**
   * The caller's own question about the config, asked **before** the weights are fetched.
   *
   * Return a sentence to refuse with, or undefined to go on. Here rather than after the call
   * because a checkpoint this node cannot use should cost nothing: asking afterwards means tens
   * of megabytes downloaded and a GPU session opened for a model that is about to be refused —
   * and a throw between `openModel` and the caller's own `try` leaks that session.
   */
  readonly check?: (config: WindowConfig) => string | undefined
}

export interface OpenedWindowModel {
  readonly session: ModelSession
  readonly config: WindowConfig
}

export async function openWindowModel(
  options: OpenWindowModelOptions,
): Promise<OpenedWindowModel> {
  const { model, task, downloadShare } = options
  const gpu = await gpuSupport()
  if (gpu.refusal) throw new Error(gpu.refusal)

  options.progress(0, 'reading the model')
  const loaded = await loadManifest(model.manifestUrl, options.signal)
  if (loaded.manifest.task !== task) {
    throw new Error(`${model.label} is a ${loaded.manifest.task} model, not a ${task} one.`)
  }
  const config = parseWindowConfig(loaded.manifest.config, loaded.manifest.id)
  const refusal = options.check?.(config)
  if (refusal) throw new Error(refusal)

  const variant = preferredVariant(loaded.manifest)
  if (!variant) {
    throw new Error(
      `None of ${model.label}'s builds can run on this browser's GPU. This is a property of ` +
        `the published model, not of the neurons.`,
    )
  }
  const bytes = variantBytes(loaded.manifest, variant)
  if (!options.download && !(await weightsCached(loaded, variant))) {
    throw new Error(
      `${model.label} is a ${formatBytes(bytes)} download and \`Download the model\` is off. ` +
        `Tick it to allow the download; it is fetched once and kept in this browser.`,
    )
  }

  /*
   * **Summed over the parts**, not taken from the latest one. A model with more than one graph
   * reports progress per part, and reading only the newest number makes the bar jump backwards
   * every time a part starts — which reads as a stalled download.
   */
  const received = new Map<string, number>()
  const session = await openModel({
    manifestUrl: model.manifestUrl,
    variant,
    task,
    signal: options.signal,
    onProgress: (progress) => {
      received.set(progress.part, progress.received)
      let held = 0
      for (const part of received.values()) held += part
      options.progress(
        bytes > 0 ? (downloadShare * held) / bytes : 0,
        progress.cached ? 'opening the model' : `fetching ${model.label}`,
      )
    },
  })
  return { session, config }
}
