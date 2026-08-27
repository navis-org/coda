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
import { dataUrlToBlob, downloadFiles, exportBaseName, serializeSvg, svgToPngBlob } from './export'
import type { ExportFile, ExportFormat } from './exportValue'
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
 * What a Download node's value amounts to, as named byte blobs.
 *
 * **The whole of "what a Download node produces", in one place.** It was two: this dispatch and a
 * near-copy in the loop's driver that differed only in where the bytes landed — and the two had
 * already parted company, with the copy dropping `planExport`'s truncation report entirely, so a
 * loop silently wrote the first fifty of a set and said nothing. Everything here is about the
 * *value*; nothing here writes a file, which is what lets the button and a folder sink share it.
 *
 * Async because a PNG from a vector viewer is rasterised through a canvas. The alternative was a
 * sentinel — an `SVGSVGElement` smuggled through `ExportFile.parts` under a fake mime — which put
 * an undeclared invalid state into a type three other modules read.
 */
export async function planDownload(
  node: GraphNode,
  value: Value | undefined,
  graph: CodaGraph,
  base: string,
): Promise<{ files: ExportFile[]; error?: string }> {
  const format = String(node.params.format ?? 'auto') as ExportFormat

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
      const dataUrl = source.png()
      if (!dataUrl) return { files: [], error: 'Scene is not rendered yet' }
      return { files: [{ name: `${base}.png`, parts: [dataUrlToBlob(dataUrl)], mime: PNG_MIME }] }
    }

    const svg = source?.svg?.()
    if (!svg) {
      return {
        files: [],
        error: sourceId
          ? `No chart is drawn for the node feeding this one. ${format.toUpperCase()} reads a rendered viewer, so that card has to be on screen and not collapsed.`
          : 'Nothing is connected, so there is no chart to write.',
      }
    }
    if (format === 'svg') {
      return {
        files: [{ name: `${base}.svg`, parts: [serializeSvg(svg)], mime: SVG_MIME }],
      }
    }
    return {
      files: [{ name: `${base}.png`, parts: [await svgToPngBlob(svg)], mime: PNG_MIME }],
    }
  }

  if (value === undefined) return { files: [], error: 'Nothing is connected.' }

  const plan = planExport(value, format, base)
  if (plan.files.length === 0) {
    return {
      files: [],
      error: `${value.kind} cannot be written as ${format.toUpperCase()}. Use auto, or JSON.`,
    }
  }
  return {
    files: plan.files,
    ...(plan.truncated
      ? {
          // Not an error — the files were written. But a set silently shorter than the data is
          // the failure the caption idiom exists to avoid, so it is said out loud.
          error: `Wrote the first ${plan.truncated.kept} of ${plan.truncated.total}; a browser stops honouring downloads past about that many.`,
        }
      : {}),
  }
}

const PNG_MIME = 'image/png'
const SVG_MIME = 'image/svg+xml;charset=utf-8'

/**
 * Perform one Download node's download.
 *
 * Exported and shared with the card's button so the two routes to a file cannot disagree about
 * the name or the format. Since `planDownload` took over the dispatch, this is the thin half:
 * decide the name, and hand the bytes to the browser.
 */
export async function runDownload(
  node: GraphNode,
  value: Value | undefined,
  graph: CodaGraph,
  now: Date = new Date(),
): Promise<DownloadOutcome> {
  const base = downloadBaseName(node, graph.meta?.name, now)
  try {
    const plan = await planDownload(node, value, graph, base)
    if (plan.files.length === 0) return { written: [], error: plan.error }
    downloadFiles(plan.files)
    return {
      written: plan.files.map((f) => f.name),
      ...(plan.error ? { error: plan.error } : {}),
    }
  } catch (error) {
    return { written: [], error: errorMessage(error) }
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
    /*
     * A Download **inside a loop** has already written its files, one per element, through
     * `onIteration` — see `useForEach.ts`. It is in `executed` all the same, because that is a
     * set of node ids and cannot count passes, so writing it again here would add a stray
     * four-hundred-and-first file holding the last element and nothing to explain it.
     */
    const inLoop = new Set(lastRun.loopNodes)
    const nodes = graph.nodes.filter(
      (n) =>
        n.type === DOWNLOAD_TYPE &&
        executed.has(n.id) &&
        !inLoop.has(n.id) &&
        n.params.onRun !== false,
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
