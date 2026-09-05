/**
 * The For Each card: what will be iterated, how far it has got, and the one button that starts it.
 *
 * Like `SelectOneBody`, everything here reads the node's **input** rather than its output — the
 * collection is already on the wire, so the count and the first element's name cost no run and
 * are there while the graph is being wired. The output would answer "which element did the last
 * loop stop on", which is true and useless.
 *
 * ## The button exists because the picker cannot be asked for from inside a run
 *
 * `showDirectoryPicker` needs transient activation. By the time the scheduler reaches this loop
 * the click that pressed Run is long spent, so the folder has to be chosen *before* the run
 * starts — which means a control here, not a prompt that appears at element 1. Pressing it picks
 * a destination, arms it, invalidates this node and runs, in that order.
 *
 * Run in the toolbar still works and still iterates; what it cannot do is write files, and the
 * foot says so rather than letting somebody discover it at the end of a four-minute loop.
 *
 * ## The progress bar is the node's own run state
 *
 * `NodeRunInfo.progress` and `.note`, set by the loop driver — the same pair the hairline ring
 * around every running card reads. A ring is right for a node that is working and wrong for one
 * that is on element 273 of 412: the number is the information, and it is what somebody deciding
 * whether to press Cancel is actually reading.
 */

import { useMemo, useState } from 'react'

import { getNodeDef } from '../../core/registry'
import { elementNoun, isIterableKind, isIterableValue } from '../../nodes/lib/iterables'
import { batchSize, isGroupMode, loopPlanOf } from '../../nodes/flow/plan'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { slugify } from '../export'
import { ParamField } from '../params/ParamField'
import { armSink, bestSinkMode, canWriteFolder, chooseSink } from '../fileSink'
import { DOWNLOAD_TYPE } from '../useDownloads'
import { loopRegion } from '../../core/graph'
import type { NodeBodyProps } from './nodeBodies'

/**
 * Below this many passes, the concurrency a batch would recover is not worth a line on the card.
 *
 * A number for a sentence rather than a guard rail: nothing is refused and nothing is capped, so
 * it is not one of `docs/limits.md`'s tiers. Twenty is about where the round trips start to
 * dominate a loop somebody is watching.
 */
const BATCH_WORTH_MENTIONING = 20

export function ForEachBody({ node, ctx, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const [asking, setAsking] = useState(false)

  const input = useGraphStore((s) => {
    // `runVersion` ties this read to scheduler ticks; `nodeInputs` hands back the cached value
    // by reference, so the selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeInputs(node.id)['in']
  })
  const info = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInfo(node.id)
  })
  const busy = useGraphStore((s) => s.busy)

  /**
   * Whether anything in this loop's region writes files.
   *
   * Asked of the *graph* rather than of a param, because it is a fact about how the loop is
   * wired and the answer changes as somebody wires it. Without it the card would offer a folder
   * picker on a loop whose region is a 3D viewer and nothing else — a permission prompt for
   * files nobody is going to write.
   */
  const graph = useGraphStore((s) => s.graph)
  const writesFiles = useMemo(
    () => {
      const region = loopRegion(graph, node.id)
      return graph.nodes.some((n) => region.has(n.id) && n.type === DOWNLOAD_TYPE)
    },
    // Memoised rather than derived inside the selector: a selector runs on *every* store update
    // — every keystroke, every drag, and each of the several hundred `runVersion` bumps a loop
    // makes — and this one walks the edges and the nodes to build three collections.
    [graph, node.id],
  )

  /*
   * Two different questions from two different places, and conflating them printed "Connect a
   * table" on a card that was plainly wired. **Whether something is connected** comes off the
   * inferred type, which exists the moment the link is drawn; **what is on the wire** is a fact
   * about the last run and is absent until there has been one.
   */
  const connected = Boolean(ctx.inputs['in'])
  const kind = ctx.inputs['in']?.kind
  const iterable = isIterableKind(kind)

  const items = isIterableValue(input) ? input : undefined
  const grouping = isGroupMode(node.params)
  const groupBy = ctx.column('groupBy')

  /*
   * The same plan the node itself will make — one function, not a restatement of it. The card,
   * the canvas frame and `loopPlan` had each written the rule out, and the third had already
   * drifted onto the raw `groupBy` param; see `nodes/flow/plan.ts`.
   */
  const plan = useMemo(() => loopPlanOf(node, input, ctx.inputs), [node, input, ctx.inputs])
  const total = plan.count
  const first = total > 0 ? plan.label(0) : ''

  const batch = batchSize(node.params)
  const noun = grouping ? 'group' : batch > 1 ? 'batch' : elementNoun(items)
  const running = info.state === 'running'
  const fraction = running ? (info.progress ?? 0) : 0

  // The generic card renders every non-advanced param; a body replaces that area outright, so it
  // renders the same set rather than a chosen few — a control a body forgets is reachable only
  // from the inspector, which on screen is indistinguishable from one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  /**
   * Pick a destination, then run this loop.
   *
   * The order matters and each step is load-bearing. The picker goes first, from inside the
   * click, because it needs the activation. `invalidateNode` goes next because a settled loop
   * does not re-run — that is `out.download`'s contract and the whole reason pressing Run twice
   * does not write two sets of files — so re-running one is a deliberate gesture, and this is it.
   */
  const start = async () => {
    setAsking(true)
    try {
      const { graph, invalidateNode, runNode } = useGraphStore.getState()
      if (writesFiles) {
        // `slugify`, whose own note records that the graph download and the chart exports had
        // the same two regexes side by side. A fifth spelling here would have the archive escape
        // its name by a different rule than every file inside it.
        const sink = await chooseSink(`${slugify(graph.meta?.name ?? '', 'loop')}-files`)
        // Dismissed. A decision, not an error: running anyway would iterate for minutes and
        // write nothing, which is the outcome somebody just declined.
        if (!sink) return
        armSink(sink)
      }
      invalidateNode(node.id)
      await runNode(node.id)
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="list-body nodrag">
      <div className="loop-body__head">
        <span className="loop-body__count">
          {total > 0 ? `${formatNumber(total)} ${noun}${total === 1 ? '' : 's'}` : '—'}
        </span>
        {first && (
          <span className="step-body__name" title={`First: ${first}`}>
            {first}
          </span>
        )}
        <span className="step-body__spacer" />
        <button
          type="button"
          className="step-body__commit"
          /*
           * Disabled while a run is in flight rather than hidden, on `Use this`'s reasoning: a
           * disabled control says "not now", a missing one says "this node cannot do that".
           */
          disabled={busy || asking || total === 0}
          title={
            total === 0
              ? 'Nothing to iterate yet.'
              : writesFiles
                ? canWriteFolder()
                  ? 'Choose a folder, then run this loop and write one set of files per element.'
                  : 'Run this loop and collect every file into one zip.'
                : 'Run this loop from the first element.'
          }
          onClick={() => void start()}
        >
          {asking ? 'Choosing…' : 'Run loop'}
        </button>
      </div>

      {/*
        A real bar rather than the hairline ring every running card already wears. The ring says
        "working"; on element 273 of 412 the number is the information, and it is what somebody
        deciding whether to press Cancel is reading.
      */}
      {running && (
        <div
          className="loop-body__progress"
          role="progressbar"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="loop-body__bar" style={{ width: `${Math.round(fraction * 100)}%` }} />
          <span className="loop-body__note">{info.note ?? 'starting…'}</span>
        </div>
      )}

      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              variant="inspector"
              onChange={(value) => setParam(param.id, value)}
            />
          </label>
        ))}
      </div>

      <div className="list-body__foot">
        {!connected ? (
          <span className="list-body__foot--empty">Connect a table, skeletons or meshes.</span>
        ) : !iterable ? (
          // Said from the type, so it appears while the graph is being wired rather than after a
          // run. The node's badge carries the same refusal; this is where somebody is looking.
          <span className="list-body__missing">⚠ A {kind} has no elements to iterate.</span>
        ) : grouping && !groupBy ? (
          <span className="list-body__missing">⚠ Pick a column to group by.</span>
        ) : !items ? (
          <span className="list-body__foot--empty">Not run yet.</span>
        ) : total === 0 ? (
          <span className="list-body__foot--empty">Nothing to iterate.</span>
        ) : writesFiles && batch === 1 && total >= BATCH_WORTH_MENTIONING ? (
          /*
           * Said only where it is unambiguously good advice: a loop whose region writes files,
           * long enough for the difference to matter, running one element at a time.
           *
           * Every backend already fetches concurrently — six in flight on neuPrint, eight on
           * CATMAID — and one element per pass reduces that to one, so this loop is several times
           * slower than it needs to be. It is deliberately *not* said when the region renders,
           * because there a batch draws one picture of twenty neurons rather than twenty
           * pictures, and 1 is the right answer.
           */
          <span title="Each pass asks the backend for one element, so it can only fetch one at a time. A larger batch fetches several at once and still holds only a batch.">
            one at a time — raise Batch size to fetch several at once
          </span>
        ) : writesFiles ? (
          /*
           * Which of the two routes this browser will take, said before the loop rather than
           * discovered at the end of it. The trade is real — a folder streams to disk and a zip
           * holds everything in the tab — and neither is guessable from the card otherwise.
           */
          <span
            title={
              bestSinkMode() === 'folder'
                ? 'Files are written straight into a folder you pick, one at a time. No limit.'
                : 'This browser cannot write to a folder, so every file is held until the end and handed over as one zip.'
            }
          >
            {bestSinkMode() === 'folder'
              ? 'writes to a folder you pick'
              : 'collects into one zip'}
            {' · use Run loop, not Run'}
          </span>
        ) : (
          <span title="Everything wired after this node runs once per element.">
            runs the chain below once per {noun}
          </span>
        )}
      </div>
    </div>
  )
}
