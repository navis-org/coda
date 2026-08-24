/**
 * The Download node's side effect, kept out of the graph.
 *
 * `out.download` is a pure pass-through: `src/nodes` is headless, and a download performed in
 * `evaluate` would fire on the first Run and silently not on the second, because a cache hit
 * means `evaluate` never runs at all. So the node records *what* to write and this drives *when*.
 *
 * Mounted once, in `Editor`, rather than from the node's own card — a collapsed card unmounts its
 * body, and a Download node that stopped working when you tidied it away would be a bug nobody
 * could reproduce on purpose.
 *
 * **The signal is `lastRun.executed`, not the node's output.** Only a node that actually ran is
 * in that list, so a Run over an unchanged graph writes nothing — which is the whole of what
 * bounds "on every run". Watching the output value instead would fire on a cache *restore* too,
 * writing a file for a graph nobody re-ran.
 */

import { useEffect, useRef } from 'react'

import { errorMessage } from '../core/errors'
import type { CodaGraph, GraphNode } from '../core/graph'
import type { Value } from '../core/values'
import {
  downloadDataUrl,
  downloadFiles,
  downloadPng,
  downloadSvg,
  exportBaseName,
} from './export'
import type { ExportFormat } from './exportValue'
import { planExport } from './exportValue'
import { useGraphStore } from '../store/graphStore'
import { exportSourceFor } from './viewers/exportRegistry'

export const DOWNLOAD_TYPE = 'out.download'

/** `2026-08-19-1432`. Local time, because it is a filename a person reads, not a timestamp. */
export function timestampSuffix(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** The filename stem, before any extension. */
export function downloadBaseName(
  node: GraphNode,
  graphName: string | undefined,
  now: Date,
): string {
  const typed = String(node.params.filename ?? '').trim()
  // Falls back to what every viewer's own export uses, so a node nobody configured still writes
  // something identifiable rather than `download.csv`.
  const base = typed || exportBaseName(graphName, node.title ?? 'download')
  return node.params.timestamp === true ? `${base}-${timestampSuffix(now)}` : base
}

/** The node feeding a Download node, which is the one whose chart `svg`/`png` mean. */
export function upstreamNodeId(graph: CodaGraph, nodeId: string): string | undefined {
  return graph.edges.find((e) => e.target === nodeId && e.targetHandle === 'in')?.source
}

export interface DownloadOutcome {
  /** Files written. Empty when the format did not apply. */
  written: string[]
  error?: string
}

/**
 * Perform one Download node's download.
 *
 * Exported and synchronous-ish so the card's button and the run driver share it exactly — two
 * routes to the same file that disagreed about the name or the format would be worse than one
 * route.
 */
export async function runDownload(
  node: GraphNode,
  value: Value | undefined,
  graph: CodaGraph,
  now: Date = new Date(),
): Promise<DownloadOutcome> {
  const format = String(node.params.format ?? 'auto') as ExportFormat
  const base = downloadBaseName(node, graph.meta?.name, now)

  if (format === 'svg' || format === 'png') {
    /*
     * The picture belongs to the *upstream* viewer, and only exists while that card is drawing.
     * The message says which of the two is wrong — nothing wired, or wired to something that is
     * not currently rendering — because the fixes are different and neither is guessable.
     */
    const sourceId = upstreamNodeId(graph, node.id)
    const source = exportSourceFor(sourceId)

    // A WebGL viewer has no vector form, so PNG reads its drawing buffer back instead. SVG
    // still refuses for that node, and the message below says why in the same words.
    if (format === 'png' && !source?.svg && source?.png) {
      try {
        const dataUrl = source.png()
        if (!dataUrl) throw new Error('Scene is not rendered yet')
        downloadDataUrl(dataUrl, `${base}.png`)
        return { written: [`${base}.png`] }
      } catch (error) {
        return { written: [], error: errorMessage(error) }
      }
    }

    const svg = source?.svg?.()
    if (!svg) {
      return {
        written: [],
        error: sourceId
          ? `No chart is drawn for the node feeding this one. ${format.toUpperCase()} reads a rendered viewer, so that card has to be on screen and not collapsed.`
          : 'Nothing is connected, so there is no chart to write.',
      }
    }
    try {
      if (format === 'svg') {
        downloadSvg(svg, `${base}.svg`)
        return { written: [`${base}.svg`] }
      }
      await downloadPng(svg, `${base}.png`)
      return { written: [`${base}.png`] }
    } catch (error) {
      return { written: [], error: errorMessage(error) }
    }
  }

  if (value === undefined) return { written: [], error: 'Nothing is connected.' }

  const plan = planExport(value, format, base)
  if (plan.files.length === 0) {
    return {
      written: [],
      error: `${value.kind} cannot be written as ${format.toUpperCase()}. Use auto, or JSON.`,
    }
  }
  try {
    downloadFiles(plan.files)
  } catch (error) {
    return { written: [], error: errorMessage(error) }
  }
  return {
    written: plan.files.map((f) => f.name),
    ...(plan.truncated
      ? {
          // Not an error — the files were written. But a set silently shorter than the data is
          // the failure the caption idiom exists to avoid, so it is said out loud.
          error: `Wrote the first ${plan.truncated.kept} of ${plan.truncated.total}; a browser stops honouring downloads past about that many.`,
        }
      : {}),
  }
}

/**
 * Watch for finished runs and write the files.
 *
 * Guarded by a ref seeded at mount, in the same idiom as `paletteRequest`: the store outlives
 * every component, so a remount after an earlier run would otherwise re-fire that run's
 * downloads — a file appearing because a panel was toggled.
 */
export function useDownloads(): void {
  const lastRun = useGraphStore((s) => s.lastRun)
  const handled = useRef<typeof lastRun>(undefined)
  const seeded = useRef(false)

  useEffect(() => {
    if (!seeded.current) {
      seeded.current = true
      handled.current = lastRun
      return
    }
    if (!lastRun || lastRun === handled.current) return
    handled.current = lastRun

    const { graph, nodeInputs, setNotice } = useGraphStore.getState()
    const executed = new Set(lastRun.executed)
    const nodes = graph.nodes.filter(
      (n) => n.type === DOWNLOAD_TYPE && executed.has(n.id) && n.params.onRun !== false,
    )
    if (nodes.length === 0) return

    void (async () => {
      const problems: string[] = []
      for (const node of nodes) {
        const outcome = await runDownload(node, nodeInputs(node.id)['in'], graph)
        if (outcome.error) problems.push(`${node.title ?? 'Download'}: ${outcome.error}`)
      }
      if (problems.length) setNotice(problems.join(' · '))
    })()
  }, [lastRun])
}
