/**
 * A loop's side effects, kept out of the graph.
 *
 * `useDownloads` already establishes the shape: `src/nodes` is headless, a cache hit means
 * `evaluate` never runs, so a file is written by the UI watching for runs rather than by the
 * node. What a loop adds is that **watching a finished run is not enough**, and there are two
 * separately sufficient reasons:
 *
 *  - `RunSummary.executed` is a set of node ids. A Download that ran four hundred times is in it
 *    once, so a driver reading it after the run writes one file — the last element's — and the
 *    other three hundred and ninety-nine never existed.
 *  - `svg`/`png` are read off a **live** viewer through `exportSourceFor`, not off the wire. The
 *    picture for element 273 only exists while React is drawing element 273, which is a moment
 *    inside the run and is gone by the end of it.
 *
 * So the scheduler awaits `onIteration` after every pass, and this is what it awaits.
 *
 * ## The frame yield is the whole of what makes a picture work
 *
 * `CaptureBridge` renders and calls `toDataURL` in the same task, so nothing here depends on the
 * compositor — but it renders *the scene React has committed*, and at the moment a pass ends the
 * store has only just bumped `runVersion`. One animation frame is what puts this element's
 * geometry into the three.js scene before anything reads pixels. Paid only when a Download in
 * the region actually asks for an image; a loop writing SWC never waits for a frame.
 *
 * ## Files go to a sink, not to `<a download>`
 *
 * Four hundred anchor clicks from one gesture are silently dropped somewhere past fifty. See
 * `fileSink.ts` for the two routes and why neither alone is enough.
 */

import { useEffect, useRef } from 'react'

import { errorMessage } from '../core/errors'
import type { IterationInfo } from '../core/scheduler'
import type { CodaGraph, GraphNode } from '../core/graph'
import type { FileSink } from './fileSink'
import { armedSink, disarmSink, safeFileName } from './fileSink'
import { downloadBaseName, DOWNLOAD_TYPE, planDownload } from './useDownloads'
import type { Value } from '../core/values'
import { setIterationHandler, useGraphStore } from '../store/graphStore'

/** One turn of the event loop plus one paint, which is what a live canvas capture needs. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    requestAnimationFrame(() => resolve())
  })
}

/**
 * What to call this pass's files.
 *
 * The element's name is folded in here rather than in `downloadBaseName`, because it is a fact
 * about the *pass* and that function is shared with the single-shot button. Padded to the width
 * of the total so a folder of four hundred files sorts in loop order rather than `1, 10, 100` —
 * the one thing anybody does with such a folder is look at it in order.
 *
 * This is the whole of what a loop adds to a Download. Everything else — which formats apply,
 * where a picture comes from, what a value can be written as — is `planDownload`, shared with
 * the button so the two cannot come to disagree.
 */
function passBaseName(
  node: GraphNode,
  graph: CodaGraph,
  info: IterationInfo,
  now: Date,
): string {
  const ordinal = String(info.index + 1).padStart(String(info.count).length, '0')
  /*
   * **A pass carrying more than one element contributes only its ordinal.** The exporter already
   * names a file per item — `skeletonFiles` appends each neuron's own id — so adding the pass's
   * label as well produced twenty SWCs all prefixed with the *first* neuron of the batch, which
   * reads as twenty copies of one neuron. One element per pass is the case where the label is
   * the only thing naming the file, and there it is kept.
   */
  const named = info.size <= 1 && info.label
  const stem = named ? `${ordinal}-${safeFileName(info.label)}` : ordinal
  return `${downloadBaseName(node, graph.meta?.name, now)}-${stem}`
}

export interface IterationOutcome {
  /**
   * What went wrong, per Download node, this pass.
   *
   * No count of files beside it: `FileSink.written` already holds one, and two counters for one
   * quantity can disagree — a sink that rejects a file would still have been counted here.
   */
  problems: string[]
}

/**
 * Write one pass's files.
 *
 * Exported and free of React so the loop driver and a test share exactly one path — two routes
 * to the same file that disagreed about the name would be worse than one, which is the reason
 * `runDownload` is exported too.
 */
export async function runIteration(
  info: IterationInfo,
  graph: CodaGraph,
  inputsOf: (nodeId: string) => Record<string, Value | undefined>,
  sink: FileSink | undefined,
  now: Date = new Date(),
): Promise<IterationOutcome> {
  const inRegion = new Set(info.region)
  const nodes = graph.nodes.filter(
    (n) => n.type === DOWNLOAD_TYPE && inRegion.has(n.id) && n.params.onRun !== false,
  )
  if (nodes.length === 0) return { problems: [] }
  /*
   * Asked before anything is planned or rasterised. Discovering it per node per pass would do the
   * whole expensive path for a case that was knowable at entry, and say so four hundred times.
   */
  if (!sink) return { problems: ['This loop has nowhere to write — start it with “Run loop”.'] }

  /*
   * Only paid when a picture is actually wanted. A loop writing SWC would otherwise wait a frame
   * per element for nothing, which on four hundred elements is several seconds of pure latency.
   */
  if (nodes.some((n) => n.params.format === 'png' || n.params.format === 'svg')) {
    await nextFrame()
  }

  const problems: string[] = []
  for (const node of nodes) {
    const title = node.title ?? 'Download'
    try {
      const base = passBaseName(node, graph, info, now)
      const plan = await planDownload(node, inputsOf(node.id)['in'], graph, base)
      // `error` accompanies a plan that still has files in it — a truncation notice — so it is
      // reported whether or not anything was written.
      if (plan.error) problems.push(`${title}: ${plan.error}`)
      if (plan.files.length > 0) await sink.write(plan.files)
    } catch (error) {
      // One unwritable element is not a reason to abandon the rest — the scheduler records the
      // throw against this pass and carries on, which is `docs/limits.md`'s rule about refusals.
      problems.push(`${title}: ${errorMessage(error)}`)
    }
  }
  return { problems }
}

/**
 * Install the loop's side effects, and close whatever they wrote to when the run ends.
 *
 * Mounted once, in `Editor`, for `useDownloads`' reason: a collapsed card unmounts its body, and
 * a loop that stopped writing files because somebody tidied a node away would be a bug nobody
 * could reproduce on purpose.
 *
 * Two halves, and they are separate because the moments are. The **handler** has to be in place
 * before a run starts and is called from inside it. The **close** happens once, after the run —
 * a zip is one archive sealed at the end, and a notice about seven unwritable elements is one
 * line rather than seven.
 */
export function useForEach(): void {
  const lastRun = useGraphStore((s) => s.lastRun)
  const problems = useRef<string[]>([])
  /*
   * Seeded with the mount-time run, which is what stops a remount after an earlier run from
   * re-closing a sink that is already gone — the store outlives every component. `useRef`'s own
   * initial value does the seeding, so there is no second "have I started yet" flag to keep in
   * step with this one.
   */
  const handled = useRef(lastRun)

  useEffect(() => {
    setIterationHandler(async (info) => {
      const { graph, nodeInputs } = useGraphStore.getState()
      const outcome = await runIteration(info, graph, nodeInputs, armedSink())
      problems.current.push(...outcome.problems)
    })
    return () => setIterationHandler(undefined)
  }, [])

  useEffect(() => {
    if (!lastRun || lastRun === handled.current) return
    handled.current = lastRun

    const sink = disarmSink()
    const said = problems.current
    problems.current = []
    if (!sink && said.length === 0) return

    void (async () => {
      const notes: string[] = []
      if (sink) {
        try {
          await sink.close()
          if (sink.written > 0) {
            notes.push(
              `Wrote ${count(sink.written)} file${sink.written === 1 ? '' : 's'} from ${count(lastRun.iterations)} pass${lastRun.iterations === 1 ? '' : 'es'} to ${sink.label}`,
            )
          }
        } catch (error) {
          notes.push(errorMessage(error))
        }
      }
      /*
       * Deduped and capped at three, with the total said. A loop where every element failed for
       * the same reason produces four hundred identical lines, and a notice nobody can read is a
       * notice that reports nothing — the same call the scheduler makes about failed passes.
       */
      if (said.length > 0) {
        const distinct = [...new Set(said)]
        notes.push(
          `${count(said.length)} problem${said.length === 1 ? '' : 's'}: ${distinct.slice(0, 3).join(' · ')}${distinct.length > 3 ? ' …' : ''}`,
        )
      }
      if (notes.length > 0) useGraphStore.getState().setNotice(notes.join(' · '))
    })()
  }, [lastRun])
}

const count = (n: number) => n.toLocaleString('en-US')
