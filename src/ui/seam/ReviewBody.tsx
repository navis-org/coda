/**
 * Review Suggestions' card: a queue of merge suggestions, and a viewer showing the current one.
 *
 * ## The viewer is a fallback, not the plan
 *
 * The intended shape is `Current → out.neuroglancer`'s `Control` port: one wire, and the
 * full-size viewer follows the card — the same scene a reader already has up, rather than a
 * second WebGL context showing two segments.
 *
 * So this frame appears **only when that wire is absent**. A card that drew one anyway would put
 * two viewers of the same pair on screen whenever somebody did wire it up, each with its own
 * context and its own copy of the meshes. Unwired, the card is still usable on its own, which is
 * what it is for.
 *
 * ## The two surfaces show different things
 *
 * On the **card** the list is the whole point: a queue to triage, with no room for a viewer that
 * would be a few hundred pixels of EM. **Expanded**, the viewer takes the width and the list
 * stands beside it as narrow as it can be read in — which is the shape of the work, looking at
 * one site while the next few stay in view.
 *
 * ## What is a param and what is local
 *
 * Everything a reader decides is a param: the cursor, the candidate, the verdicts, the filters.
 * Nothing is component state, because this card is drawn in two places at once and state in one
 * would leave the other showing a different row.
 *
 * The one exception is whether the card's filter fields are folded away. That is a preference
 * about *this surface*, it means nothing in the overlay — where the filters live in the rail and
 * this body draws none — and a param for it would appear in that rail as a control that does
 * nothing. So it is `localStorage`, which is what `NodeHint`'s dismissal already uses for a
 * per-viewer convenience that must never become an edit.
 */

import { useEffect, useMemo, useState } from 'react'

import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import {
  buildQueue,
  arrangeRows,
  currentOfQueue,
  decodeVerdicts,
  encodeVerdicts,
  neuronsOf,
  pickedNeuron,
  scenePieces,
  sizeOf,
  stillToSearch,
  tipsOf,
  verdictFor,
  withVerdict,
  VERDICTS,
} from '../../packs/seam/reviewQueue'
import type {
  Candidate,
  CandidateSize,
  QueueMode,
  QueueNeuron,
  QueueRow,
  QueueTip,
  SortBy,
  Verdict,
} from '../../packs/seam/reviewQueue'
import {
  buildScene,
  sceneUrl,
  sceneVoxelNm,
  selfHostedViewer,
  viewerBaseFor,
} from '../../data/neuroglancer/scene'
import { getSource } from '../../data/source'
import { formatNumber, plural } from '../../style/format'
import { cycleColor } from '../../style/colors'
import { ParamField } from '../params/ParamField'
import { cardParams } from '../params/paramGroups'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { useGraphStore } from '../../store/graphStore'
import { useDatasetInput } from '../useDatasetInput'
import { usePublishedScene } from '../viewers/NeuroglancerProfileFrame'
import { NeuroglancerViewer } from '../viewers/NeuroglancerViewer'
import { useRowWindow } from '../useRowWindow'
import { controlPartColor } from '../../nodes/output/neuroglancer'

/** Where the card remembers whether its filters are folded. Per node, per browser. */
const FILTERS_KEY = 'coda.seam.review.filters'

function foldedInitially(nodeId: string): boolean {
  try {
    return window.localStorage.getItem(`${FILTERS_KEY}.${nodeId}`) === 'folded'
  } catch {
    // Private windows, blocked site data, a thumbnail capture: shown is the safe answer.
    return false
  }
}

export function ReviewBody({ node, ctx, inputValues, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const [folded, setFolded] = useState(() => foldedInitially(node.id))
  /*
   * Is something else showing this pair? A primitive, not the edge list: `useSyncExternalStore`
   * compares snapshots by identity, so selecting the array would re-render on every graph change
   * (invariant 7).
   */
  const driving = useGraphStore((s) =>
    s.graph.edges.some((edge) => edge.source === node.id && edge.sourceHandle === 'current'),
  )
  /*
   * Is the queue still filling? What arrives here while Suggest Merges runs is a published
   * partial, which the scheduler recomputes this card's own outputs from (`derivePreviews`), so
   * the list is real and so is every verdict made on it — but it is the ends searched *so far*,
   * and a reader filtering the top of a queue that is a third full is sorting a third of the
   * neuron without being told. One line in the foot is what that costs to say.
   *
   * Asked of the *inputs* rather than of the node two wires up, which is the reading that
   * survives somebody putting a `Filter Table` in between: that node is never itself running,
   * but it does hold a partial derived from one.
   */
  const filling = useGraphStore((s) => s.nodeInputsFilling(node.id))
  const fold = (next: boolean) => {
    setFolded(next)
    try {
      window.localStorage.setItem(`${FILTERS_KEY}.${node.id}`, next ? 'folded' : 'shown')
    } catch {
      // Remembering is the convenience; not remembering is not a failure worth reporting.
    }
  }
  const dataset = useDatasetInput(ctx, inputValues)
  const published = usePublishedScene(dataset.sourceId, dataset.datasetId)

  const tips = inputValues?.['tips']
  const candidates = inputValues?.['candidates']
  const queue = useMemo(
    () =>
      buildQueue(
        isTableValue(tips) ? tips : undefined,
        isTableValue(candidates) ? candidates : undefined,
      ),
    [tips, candidates],
  )
  const verdicts = useMemo(() => decodeVerdicts(node.params.verdicts), [node.params.verdicts])
  /*
   * One neuron at a time. Everything below — the list, the cursor, the counts in the foot — reads
   * `mine`, never `queue`, so no surface of the card can show a second neuron's tips.
   */
  const neurons = useMemo(() => neuronsOf(queue, verdicts), [queue, verdicts])
  const neuron = pickedNeuron(queue, String(node.params.neuron ?? ''))
  const mine = useMemo(() => tipsOf(queue, neuron), [queue, neuron])
  const onNeuron = neurons.find((entry) => entry.neuronId === neuron)

  const minConfidence = numberOr(node.params.minConfidence)
  const minSize = numberOr(node.params.minSize)
  const shownOnly = node.params.shownOnly === true
  const sortBy = String(node.params.sortBy ?? 'confidence') as SortBy
  const mode = String(node.params.mode ?? 'tip') as QueueMode
  // Listed one by one rather than as a spread: a spread dependency is one React cannot check,
  // and this memo is over the whole queue, which is thousands of rows — a hundred thousand of
  // them per candidate.
  const listed = useMemo(
    () => arrangeRows(mine, { minConfidence, minSize, shownOnly, sortBy, mode }),
    [mine, minConfidence, minSize, shownOnly, sortBy, mode],
  )
  /*
   * How many of this neuron's tips are still to come. From the table rather than from the
   * queue's own length: a tip the run will never reach — its box outside the volume — is
   * published as `searched: false`, so this count reaches zero where "rows with nothing on them"
   * would stall above it and read as a run that stopped early.
   */
  const toSearch =
    neuron === undefined
      ? undefined
      : stillToSearch(isTableValue(tips) ? tips : undefined, neuron)
  const here = currentOfQueue(mine, String(node.params.current), Number(node.params.rank))

  const windowed = useRowWindow(listed.length)
  // A different neuron is a different list: start it at the top, where the switch put the cursor.
  const { toTop } = windowed
  useEffect(() => toTop(), [neuron, toTop])

  const unit = mode === 'candidate' ? 'candidate' : 'tip'
  const total =
    mode === 'candidate'
      ? mine.reduce((sum, tip) => sum + tip.candidates.length, 0)
      : mine.length

  /*
   * Switching neuron lands on the new neuron's top row, as the list is sorted and filtered now,
   * so the viewer moves with the switch rather than holding a pair the card no longer lists.
   * One `setParams`, so the switch is one undo step rather than three.
   */
  const setParams = useGraphStore((s) => s.setParams)
  const switchTo = (neuronId: string) => {
    const top = arrangeRows(tipsOf(queue, neuronId), {
      minConfidence,
      minSize,
      shownOnly,
      sortBy,
      mode,
    })[0]
    setParams(node.id, {
      neuron: neuronId,
      current: top ? String(top.tip.endUid) : '',
      rank: mode === 'candidate' ? (top?.candidate?.rank ?? 1) : 1,
    })
  }

  const pick = (tip: QueueTip, candidate: Candidate | undefined) => {
    setParam('current', String(tip.endUid))
    // Per candidate a row names its own rank; per tip, clicking opens on the suggestion.
    setParam('rank', mode === 'candidate' ? (candidate?.rank ?? 1) : 1)
  }
  const page = (by: number) => {
    if (!here) return
    const next = here.candidate.rank + by
    if (next < 1 || next > here.tip.candidates.length) return
    setParam('rank', next)
  }
  const judge = (tip: QueueTip, candidate: Candidate, verdict: Verdict) => {
    setParam(
      'verdicts',
      encodeVerdicts(withVerdict(verdicts, tip.endUid, candidate.candidateId, verdict)),
    )
  }

  /*
   * The same pieces `Current` publishes, in the same colours the Neuroglancer node gives them —
   * one function each, so this fallback and the full-size viewer cannot disagree.
   */
  const pieces = scenePieces(mine, neuron, here, verdicts, node.params.showAccepted !== false)
  const scene =
    published.status === 'ready' && pieces.length > 0
      ? buildScene(published.scene, {
          datasetId: dataset.datasetId ?? '',
          segments: pieces.map((piece) => piece.id),
          segmentColors: Object.fromEntries(
            pieces.map((piece) => [piece.id, controlPartColor(piece.part)]),
          ),
          layout: '3d',
          layers: 'all',
        })
      : undefined
  // Nanometres to the scene's own units, which is the only conversion `focus` does not do.
  const voxel = published.status === 'ready' ? sceneVoxelNm(published.scene) : undefined
  const focus =
    here && voxel
      ? ([0, 1, 2] as const).map((i) => here.candidate.contactNm[i]! / voxel[i]!)
      : undefined

  const fields = cardParams(def, node.params)

  return (
    <div
      className="review-body nodrag"
      data-compact={compact ? 'yes' : 'no'}
      /*
       * Whether anything is standing beside the queue. With a viewer there the queue keeps to a
       * reading width and the rest of the panel is the picture; without one — which is the
       * ordinary case once `Current` drives a Neuroglancer node — the queue *is* the panel, and
       * holding it to 340px leaves a column in an empty room.
       */
      data-viewer={!compact && !driving && scene && dataset.datasetId ? 'yes' : 'no'}
    >
      {/*
       * The viewer, expanded only. A frame on the card would be a WebGL application a couple of
       * hundred pixels tall, next to the list it is competing with for the space; the card's job
       * is the queue, and the ⤢ button is one click from the picture.
       */}
      {!compact && !driving && scene && dataset.datasetId && (
        <div className="review-body__viewer">
          <NeuroglancerViewer
            url={sceneUrl(
              viewerBaseFor(
                '',
                getSource(dataset.sourceId ?? '')?.peekDataset(dataset.datasetId)?.viewerSite,
              ),
              scene,
            )}
            frameViewer={selfHostedViewer()}
            focus={focus}
            color={{ mode: 'constant', column: undefined, constant: '0' }}
            datasetId={dataset.datasetId}
            summary={here ? `tip ${here.tip.endUid} · rank ${here.candidate.rank}` : ''}
            compact
          />
        </div>
      )}

      <div className="review-body__queue">
        {/*
         * The neuron, on both surfaces and never folded: it says which neuron every row below is
         * about. Drawn here rather than as a param field because its choices are rows of `Tips`.
         * With one neuron it stays, disabled, as the label naming it.
         */}
        <label className="list-body__field review-body__neuron">
          <span
            className="param__label"
            title="The neuron being reviewed. The list, the viewer and the counts below are all about this one."
          >
            Neuron
          </span>
          <select
            className="field nodrag"
            aria-label="Neuron"
            value={neuron ?? ''}
            disabled={neurons.length <= 1}
            onChange={(event) => switchTo(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {neurons.length === 0 && <option value="">—</option>}
            {neurons.map((entry) => (
              <option key={entry.neuronId} value={entry.neuronId}>
                {neuronLabel(entry)}
              </option>
            ))}
          </select>
        </label>

        {/*
         * The fields, on the card only. Expanded, these same params are the overlay's rail — drawn
         * a few pixels above this body — and drawing them here too was the same four controls
         * twice.
         */}
        {compact && !folded && (
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
                  onChange={(value) => setParam(param.id, value)}
                />
              </label>
            ))}
          </div>
        )}

        {listed.length === 0 ? (
          <div className="list-body__foot list-body__foot--empty">
            {queue.length === 0
              ? filling
                ? 'Searching — the first tips will appear here as they are scored.'
                : 'Nothing to review yet — wire in Merge Suggestions and run it.'
              : `No tip passes the filters. ${formatNumber(mine.length)} in this neuron’s queue.`}
          </div>
        ) : (
          <ol className="review-list nowheel" ref={windowed.ref} onScroll={windowed.onScroll}>
            {/*
             * Every row is reachable by scrolling, and only those in view are drawn: a neuron is
             * hundreds of tips and, per candidate, tens of thousands of rows of six buttons each.
             * The spacers stand in for the rest so the scrollbar is the whole list's.
             */}
            {windowed.rows.before > 0 && (
              <li
                className="review-list__spacer"
                aria-hidden="true"
                style={{ height: windowed.rows.before }}
              />
            )}
            {listed.slice(windowed.rows.start, windowed.rows.end).map((row, offset) => {
              const tip = row.tip
              /*
               * Per tip, the row follows the cursor: the tip being reviewed shows whichever
               * candidate the arrows are on, so paging is visible where it happened. Per
               * candidate a row *is* one candidate and shows itself, and "current" is the pair.
               */
              const onTip = here?.tip.endUid === tip.endUid
              const candidate =
                mode === 'candidate'
                  ? row.candidate
                  : ((onTip ? here.candidate : row.candidate) as Candidate | undefined)
              const on =
                onTip &&
                (mode === 'tip' || here?.candidate.candidateId === candidate?.candidateId)
              const said = candidate && verdictFor(verdicts, tip.endUid, candidate.candidateId)
              return (
                <li
                  key={`${tip.endUid}:${mode === 'candidate' ? (candidate?.candidateId ?? '') : ''}`}
                  className="review-row"
                  data-row
                  aria-setsize={listed.length}
                  aria-posinset={windowed.rows.start + offset + 1}
                  data-current={on ? 'yes' : 'no'}
                  data-verdict={said ?? 'none'}
                >
                  {/*
                   * An empty button covering the whole row, with the content as its siblings
                   * above it.
                   *
                   * The row's three parts do not nest: the confidence spans both rows, the acts
                   * sit top-right, and the measurements run the full width *under* them. No
                   * single element can hold all three and still be one rectangle, so the click
                   * target is a layer rather than a wrapper. It keeps the keyboard reach a real
                   * button gives — one tab stop per row — and takes its name from `aria-label`,
                   * having no text of its own.
                   */}
                  <button
                    type="button"
                    className="review-row__pick"
                    onClick={() => pick(tip, candidate)}
                    aria-label={`Show tip ${tip.endUid} and candidate ${
                      candidate?.candidateId ?? 'none'
                    }`}
                    title={`Show tip ${tip.endUid} and candidate ${candidate?.candidateId ?? '—'}`}
                  />
                  <span className="review-row__score" style={{ color: scoreInk(row) }}>
                    {row.score === undefined ? '—' : row.score.toFixed(3)}
                  </span>
                  <span className="review-row__id">
                    {candidate?.candidateId ?? 'no candidate'}
                  </span>
                  <span className="review-row__facts">
                    {candidate
                      ? [
                          // The size the queue sorts and filters on, **with its unit**: a
                          // chunk count is of the whole object and a volume is of the part
                          // inside the search box, so a bare number would be two things.
                          sizeLabel(sizeOf(candidate)),
                          `rank ${candidate.rank}/${tip.candidates.length}`,
                          // Its own confidence, p_tip x p_cand — the number `candidate` mode
                          // leads with, carried here so the two modes show the same facts.
                          candidate.conf === undefined
                            ? ''
                            : `conf ${candidate.conf.toFixed(3)}`,
                          candidate.geoRank === undefined ? '' : `geo ${candidate.geoRank}`,
                          candidate.minDistUm === undefined
                            ? ''
                            : `${candidate.minDistUm.toFixed(3)} µm apart`,
                          tip.kind === 'kink' ? 'kink' : '',
                          tip.shown ? 'shown' : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'the search found nothing within reach of this tip'}
                  </span>
                  {candidate && (
                    <div className="review-row__acts">
                      <button
                        type="button"
                        className="review-row__page"
                        disabled={!on || candidate.rank <= 1}
                        onClick={() => page(-1)}
                        aria-label="Previous candidate"
                        title="The candidate ranked above this one"
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="review-row__page"
                        disabled={!on || candidate.rank >= tip.candidates.length}
                        onClick={() => page(1)}
                        aria-label="Next candidate"
                        title="The next candidate down this tip’s list"
                      >
                        ›
                      </button>
                      {VERDICTS.map((verdict) => (
                        <button
                          key={verdict}
                          type="button"
                          className="review-row__verdict"
                          data-verdict={verdict}
                          aria-pressed={said === verdict}
                          onClick={() => judge(tip, candidate, verdict)}
                          title={VERDICT_HELP[verdict]}
                        >
                          {VERDICT_LABEL[verdict]}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
            {windowed.rows.after > 0 && (
              <li
                className="review-list__spacer"
                aria-hidden="true"
                style={{ height: windowed.rows.after }}
              />
            )}
          </ol>
        )}

        <div className="list-body__foot">
          {compact && (
            <button
              type="button"
              className="review-body__fold"
              aria-expanded={!folded}
              onClick={() => fold(!folded)}
              title="Show or hide the filter and sort controls on this card"
            >
              {folded ? 'Filters ▸' : 'Filters ▾'}
            </button>
          )}
          {/*
           * Every row is listed, so the count is the list's, and "of" appears only where a
           * filter has narrowed it. Counted in what a row *is*: per candidate the list is
           * candidates, and "3 of 2 tips" was the old line's answer there.
           */}
          <span title={`${unit}s listed, of this neuron’s queue`}>
            {listed.length === total
              ? plural(total, unit)
              : `${formatNumber(listed.length)} of ${plural(total, unit)}`}
          </span>
          {filling && (
            <span
              className="review-body__filling"
              title="Suggest Merges is still searching. These are this neuron’s tips scored so far, and more are still to come — a filter or a sort reaches only this much of the neuron."
            >
              {/*
               * The count where the table says, the bare caption where it cannot. A
               * `seam:suggestions` set carries no `searched` column, being complete by
               * definition, and "0 to search" on one would be a number nobody can act on.
               */}
              {toSearch === undefined
                ? 'still searching'
                : `still searching — ${formatNumber(toSearch)} to go`}
            </span>
          )}
          <span title="Verdicts recorded on this neuron so far, across every candidate">
            {formatNumber(onNeuron?.judged ?? 0)} judged
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * A candidate's size as a row prints it, unit and all.
 *
 * **Never a bare number.** `seam:suggestMerges` publishes a level-2 chunk count, which is of the
 * whole object; a published set carries only `vol_um3`, which is the part inside the search box.
 * The two differ by orders of magnitude and answer different questions, so a row that printed
 * `14` would be the one place a reader could confuse them — including when typing a number into
 * `Min size`, which reads whichever the table has.
 */
function sizeLabel(size: CandidateSize | undefined): string {
  if (!size) return ''
  return size.of === 'chunks'
    ? plural(size.value, 'L2 chunk')
    : `${formatNumber(size.value)} µm³`
}

/**
 * A neuron as the dropdown lists it: the full root id, then how much there is and how much is
 * done, so a reader choosing the next neuron can see which are finished.
 */
function neuronLabel(entry: QueueNeuron): string {
  return [
    entry.neuronId || 'no root ID',
    plural(entry.tips, 'tip'),
    `${formatNumber(entry.judged)} judged`,
  ].join(' · ')
}

const VERDICT_LABEL: Record<Verdict, string> = {
  accept: 'Accept',
  reject: 'Reject',
  unsure: 'Unsure',
}

const VERDICT_HELP: Record<Verdict, string> = {
  accept: 'This piece belongs to the neuron. Nothing is merged — the edit is yours to make.',
  reject: 'This piece does not belong.',
  unsure: 'Cannot tell. Left out of any calibration, rather than counted as wrong.',
}

/**
 * The confidence's ink: one hue for what SEAM shows, another for what it does not.
 *
 * Two values rather than a ramp, because the number beside it already says how much — a ramp
 * would be the same quantity twice. What the colour adds is the one thing the number cannot: on
 * which side of a calibrated cutoff this sits.
 */
function scoreInk(row: QueueRow): string {
  const shown = row.candidate?.shown ?? row.tip.shown
  return cycleColor(shown ? 1 : 0, 'dark')
}

/** A filter field as a number, or undefined for "no limit". Empty is a decision, not a zero. */
function numberOr(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}
