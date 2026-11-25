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
 *
 * ## Submit
 *
 * The foot's Submit opens a session (`mergeSession.ts`) that plans, shows the overlay and runs the
 * merges. The card holds none of it — the session outlives the card's surface — and only reads
 * which state it is in, for the button and to pause its own viewer while the overlay has one.
 * What Submit has merged comes back through the record (`mergedSoFar`): such a row says so, and
 * its verdict can no longer be changed.
 *
 * ## Extend
 *
 * An accepted row has an Extend button (`docs/seam-extend-plan.md`). Pressing it writes the pair
 * into `extend` and runs the Suggest Merges node this card's `Extended` output is wired back to,
 * which searches the piece's own open ends; they arrive in `Tips` like any others and are listed
 * with the neuron's. **Started by hand, unless `Auto-extend` is on** (user, 2026-11-16): then a
 * press that accepts a piece extends it too (`judgedParams`).
 * The button then says how far that search has got, read off the rows the piece has published —
 * there is nothing else to read it from — and pressing it again stops extending the piece.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'

import type { CodaGraph } from '../../core/graph'
import { referrerOf } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { countStrings } from '../../core/collections'
import { isTableValue } from '../../core/values'
import {
  acceptedElsewhere,
  acceptedPieces,
  acceptedByRoot,
  acceptedText,
  arrangeTree,
  buildQueue,
  currentOfQueue,
  AUTO_LISTED_HELP,
  AUTO_REJECT_NOTE,
  autoJudged,
  autoMinQOf,
  autoOffered,
  autoStoppedLarge,
  autoStoppedNote,
  autoUnavailable,
  decodeExtend,
  decodeVerdicts,
  extendBlocked,
  extendMenu,
  extendParams,
  extendPress,
  extendProgress,
  gapLabel,
  IN_NEURON_NOTE,
  judgedParams,
  leavesWith,
  listedAutoPairs,
  listedAutoParams,
  listedKey,
  listedTree,
  liveQueue,
  mergedAs,
  neuronsOf,
  nextToReview,
  pickedNeuron,
  planOfTexts,
  planTexts,
  reviewGrowth,
  rowExtend,
  scenePieces,
  estimateLabel,
  sizeLabel,
  sizeOf,
  START_OVER_HELP,
  START_OVER_WRITE,
  stillToMerge,
  storedWork,
  stillToSearch,
  tipKey,
  tipsOf,
  verdictFor,
  verdictPress,
} from '../../packs/seam/reviewQueue'
import { EXTENDED_PORT, pairsOf, verdictKey } from '../../packs/seam/pieces'
import { KEPT_NEURONS, withRecentWork } from '../../packs/seam/reviewEviction'
import type {
  Candidate,
  CurrentItem,
  ExtendChoice,
  QueueMode,
  QueueNeuron,
  QueueRow,
  QueueTip,
  SortBy,
  TreeRow,
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
import type { FollowEntry, PieceFollow } from '../../packs/seam/mergeRecord'
import {
  appendEntry,
  decodeRecord,
  isFollow,
  mergedSoFar,
  rootNow,
} from '../../packs/seam/mergeRecord'
import { caveScopeOf } from '../../nodes/lib/caveParams'
import { caveServerLabel } from '../../data/cave/deployments'
import { getToken, subscribeTokens } from '../../data/cave/credentials'
import { rootCurrency } from '../../packs/seam/rootCurrency'
import { onEdit } from '../../data/cave/rootEdits'
import { useLatest } from '../useLatest'
import type { SubmitRequest, SubmitState } from './mergeSession'
import {
  STILL_OUT_NOTICE,
  appendHeld,
  closeSubmit,
  openSubmit,
  useSubmitChecked,
  useSubmitState,
} from './mergeSession'
import { formatNumber, plural } from '../../style/format'
import { cycleColor } from '../../style/colors'
import { ParamField } from '../params/ParamField'
import { cardParams } from '../params/paramGroups'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { useGraphStore } from '../../store/graphStore'
import { shortcutKeys } from '../shortcuts'
import { useDatasetInput } from '../useDatasetInput'
import { usePublishedScene } from '../viewers/NeuroglancerProfileFrame'
import { NeuroglancerViewer } from '../viewers/NeuroglancerViewer'
import type { PointedSegment } from '../viewers/segmentHover'
import {
  restedPoint,
  useHoveredSegment,
  useRestedSegment,
  useSegmentPick,
} from '../viewers/segmentHover'
import {
  decodePicks,
  encodePicks,
  listedAt,
  unreachedTips,
  withPicks,
  withoutTips,
} from '../../packs/seam/handPicks'
import { checkPick } from '../../packs/seam/pickCheck'
import {
  anchorsOf,
  cutOffTips,
  followEdit,
  followPieces,
  nearEvenOf,
  pieceAnchorsOf,
} from '../../packs/seam/followEdit'
import { flushVerdicts } from '../../data/verdictLog'
import { queueVerdict, verdictInput } from '../../packs/seam/verdictRecord'
import { ExtendButtons } from './ExtendButtons'
import { useReviewKeys } from './reviewKeys'
import { VerdictButtons } from './VerdictButtons'
import { VerdictSharing } from './VerdictSharing'
import { useRowWindow } from '../useRowWindow'
import {
  NEUROGLANCER_TYPE,
  controlPartColor,
  framesOwnCopy,
} from '../../nodes/output/neuroglancer'

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

/** How old a "current" answer must be before a row click asks about the row's roots again. */
const RECHECK_ROW_MS = 20_000
/** How long a suggested edit waits for the chunkedgraph to call the neuron outdated. */
const SUGGESTED_WAIT_MS = 60_000

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
  const picks = useMemo(() => decodePicks(node.params.picks), [node.params.picks])
  // Every row the tables hold — a piece's joining end and a dropped piece's tips among them. The
  // reader's hand picks go on after the rows to review are chosen (`queue`, as `evaluate` does),
  // so one on a piece accepted and never extended keeps its own row.
  const built = useMemo(
    () =>
      buildQueue(
        isTableValue(tips) ? tips : undefined,
        isTableValue(candidates) ? candidates : undefined,
      ),
    [tips, candidates],
  )
  // The reader's own verdicts. Everything that reads "accepted" reads `verdicts`, below.
  const stored = useMemo(() => decodeVerdicts(node.params.verdicts), [node.params.verdicts])
  /*
   * What is extended, and so which rows there are to review — read from the params, as `evaluate`
   * and Suggest Merges read it, so a piece un-accepted here is off the list on that click. The
   * same calls `reviewStateOf` makes, one memo at a time.
   *
   * As the plan's texts first (`planTexts`), which compare by value: `stored` is a new map on
   * every press, and memoised on it directly a verdict that extends nothing still rebuilt the
   * tree, the queue and the sorted list — 3 ms a click on a neuron of five hundred tips, 100 ms
   * on one of two thousand with two hundred pieces (measured 2026-11-16). The refusals hold only
   * pairs Auto-extend could take, and only while one is live, so a reject of anything else
   * rebuilds nothing either.
   */
  const texts = useMemo(
    () =>
      planTexts(
        {
          extend: node.params.extend,
          autoRoots: node.params.autoRoots,
          autoRefused: node.params.autoRefused,
          autoMinQ: node.params.autoMinQ,
        },
        stored,
      ),
    [
      node.params.extend,
      node.params.autoRoots,
      node.params.autoRefused,
      node.params.autoMinQ,
      stored,
    ],
  )
  const {
    extend: extendedText,
    autoRoots: autoText,
    refused: refusedText,
    taken: takenText,
    minQ: minQText,
  } = texts
  /*
   * The pairs Auto-extend could take: a verdict on one is written down for it (`judgedParams`).
   * By the reader's floor whether or not an Auto-extend is live yet — what a press would take.
   */
  const minQ = autoMinQOf(node.params.autoMinQ)
  const offered = useMemo(() => autoOffered(built, minQ), [built, minQ])
  const plan = useMemo(
    () =>
      planOfTexts({
        extend: extendedText,
        autoRoots: autoText,
        refused: refusedText,
        minQ: minQText,
      }),
    [extendedText, autoText, refusedText, minQText],
  )
  // The pairs the reader extended — which is not the same question as "is this piece in the tree".
  const extended = useMemo(() => decodeExtend(extendedText), [extendedText])
  const autoPressed = useMemo(() => decodeExtend(autoText), [autoText])
  // The presses `Auto-extend listed` made on SEAM's word: accepted by Auto-extend, not the reader.
  const taken = useMemo(() => decodeExtend(takenText), [takenText])
  // The tree, with what Auto-extend took grown on by the rule the search grew it by.
  const growth = useMemo(() => reviewGrowth(built, plan), [built, plan])
  const tree = growth.tree
  // The pieces whose ends are searched, and how many pieces each Auto-extend press has taken.
  const searched = useMemo(() => new Set(growth.searched.map((piece) => piece.id)), [growth])
  const autoTook = useMemo(() => countStrings(growth.accepted.values()), [growth])
  // Where an Auto-extend stopped on a piece too large to take: those rows carry a `!`.
  const stoppedLarge = useMemo(
    () => autoStoppedLarge(built, growth, plan),
    [built, growth, plan],
  )
  /*
   * The verdicts everything reads as accepted or not: the reader's, and Auto-extend's accepts
   * where the reader has said nothing (`unjudged`) — as `evaluate` and Submit read them.
   */
  const { verdicts, unjudged } = useMemo(
    () => autoJudged(stored, growth.accepted, taken),
    [stored, growth, taken],
  )
  /*
   * The rows to review, the hand picks on them (`withLivePicks`) — less one on a piece the neuron
   * no longer reaches, named as text first so a verdict click that drops none keeps this queue
   * and the list built from it.
   */
  const placed = useMemo(() => withPicks(liveQueue(built, tree), picks), [built, tree, picks])
  const unreached = useMemo(
    () => unreachedTips(placed, verdicts, tree),
    [placed, verdicts, tree],
  )
  const record = useMemo(() => decodeRecord(node.params.merges), [node.params.merges])
  /*
   * The wired CAVE dataset's deployment and datastack: the chunkedgraph the record is read for,
   * and the currency check asks.
   */
  const target = useMemo(
    () => caveScopeOf({ sourceId: dataset.sourceId, datasetId: dataset.datasetId }),
    [dataset.sourceId, dataset.datasetId],
  )
  // Before any follow is applied: what a follow places afresh, so an undone split gives tips back.
  const uncut = useMemo(() => withoutTips(placed, unreached), [placed, unreached])
  // Less the tips that went with a part the neuron was split from (`cutOffTips`).
  // As text, so a click that drops no more keeps this queue and the list built from it.
  const cutOff = useMemo(
    () => cutOffTips(uncut, record, target, verdicts),
    [uncut, record, target, verdicts],
  )
  const queue = useMemo(() => withoutTips(uncut, cutOff), [uncut, cutOff])
  /*
   * One neuron at a time. Everything below — the list, the cursor, the counts in the foot — reads
   * `mine`, never `queue`, so no surface of the card can show a second neuron's tips.
   */
  // "Judged" is the reader's own word: an Auto-extend accept is not a judgement.
  const neurons = useMemo(() => neuronsOf(queue, stored), [queue, stored])
  const neuron = pickedNeuron(queue, String(node.params.neuron ?? ''))
  const mine = useMemo(() => tipsOf(queue, neuron), [queue, neuron])
  const accepted = useMemo(() => acceptedPieces(mine, verdicts), [mine, verdicts])
  /*
   * The tree the list walks: the extended pieces, and an accepted one a hand pick sits on — as a
   * text first (`listedKey`), so a verdict that places no such piece does not rebuild the list:
   * `accepted` is new on every click, and `arrangeTree` is most of a click's cost.
   */
  const listKey = useMemo(
    () => listedKey(tree, mine, accepted, neuron),
    [tree, mine, accepted, neuron],
  )
  const listTree = useMemo(() => listedTree(tree, listKey), [tree, listKey])
  // Listed whatever the filters say (`arrangeTree`); as text first for the same reason.
  const acceptedKey = useMemo(() => acceptedText(accepted), [accepted])
  const keptAccepted = useMemo(() => acceptedByRoot(acceptedKey), [acceptedKey])
  const onNeuron = neurons.find((entry) => entry.neuronId === neuron)

  const minConfidence = numberOr(node.params.minConfidence)
  const minSize = numberOr(node.params.minSize)
  // On unless switched off: `absentMeans: true`, and the card reads the stored param as it is.
  const excludeOrganelles = node.params.excludeOrganelles !== false
  const sortBy = String(node.params.sortBy ?? 'confidence') as SortBy
  const mode = String(node.params.mode ?? 'tip') as QueueMode
  /*
   * One filters object for every list the card builds from them, so a filter added later is
   * added once. Its fields listed one by one rather than as a spread: a spread dependency is one
   * React cannot check, and the memos below are over the whole queue, which is thousands of
   * rows — a hundred thousand of them per candidate.
   */
  const filters = useMemo(
    () => ({ minConfidence, minSize, excludeOrganelles, sortBy, mode }),
    [minConfidence, minSize, excludeOrganelles, sortBy, mode],
  )
  // As a tree: a piece's tips beneath the row the piece was accepted on (`arrangeTree`).
  const listed = useMemo(
    () => arrangeTree(mine, neuron, listTree, filters, keptAccepted),
    [mine, neuron, listTree, filters, keptAccepted],
  )
  /*
   * What `Exclude organelles` did to this list, said in the foot since about one flagged piece
   * in a hundred is not an organelle. Per tip it leaves no tip out — a tip whose first candidate
   * is one leads with the next (`QueueRow.passedOver`) — so the count is of those rows. Per
   * candidate it is the same list with the filter off, less this one: counted that way rather
   * than by a second reading of the rows, so it honours every other filter exactly — a separate
   * count once said "left out" of rows another filter had hidden anyway.
   */
  const organellesOut = useMemo(() => {
    if (!excludeOrganelles) return 0
    if (mode === 'tip') return listed.filter((row) => row.passedOver).length
    const all = arrangeTree(
      mine,
      neuron,
      listTree,
      { ...filters, excludeOrganelles: false },
      keptAccepted,
    )
    return all.length - listed.length
  }, [excludeOrganelles, mode, mine, neuron, listTree, filters, listed, keptAccepted])
  /*
   * How many of this neuron's listed tips are still to come. From what the run says of each
   * rather than from the queue's own length: a tip the run will never reach — its box outside
   * the volume — is published as `searched: false`, so this count reaches zero where "rows
   * with nothing on them" would stall above it and read as a run that stopped early.
   */
  const toSearch = stillToSearch(isTableValue(tips) ? tips : undefined, mine)
  const here = currentOfQueue(mine, String(node.params.current), Number(node.params.rank))

  const windowed = useRowWindow(listed.length)
  // A different neuron is a different list: start it at the top, where the switch put the cursor.
  const { toTop, toRow, keepPlace, atTop } = windowed
  useEffect(() => toTop(), [neuron, toTop])

  /*
   * Rows arriving while the search runs (user, 2026-11-19). **The list holds still**: the row at
   * the top of the view keeps its place (`keepPlace`), so a tip sorted in above it no longer
   * pushes everything down, and the note at the top says how many came in above, out of sight.
   * **And a row that arrives is tinted for a moment** (`data-arrived`), so one landing in view
   * is seen. Only for the data changing under the same view: a new neuron, sort, filter or grain
   * is a new list, and nothing in it is "new".
   *
   * **New is what a row shows, not the row**: a neuron's tips are listed before they are scored,
   * so the usual arrival is a tip already listed getting its candidate and sorting into place —
   * the same key, tracked as the same row by the place-holding, but news to the reader
   * (`rowShowsOf`). The note counts those too.
   */
  const rowKeys = useMemo(() => listed.map((row) => rowKeyOf(row, mode)), [listed, mode])
  const rowShows = useMemo(() => listed.map((row) => rowShowsOf(row, mode)), [listed, mode])
  const view = useMemo(() => ({ neuron, filters }), [neuron, filters])
  const shown = useRef<{
    view: typeof view
    keys: readonly string[]
    shows: readonly string[]
  }>(undefined)
  const [newAbove, setNewAbove] = useState(0)
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NONE_ARRIVED)
  useLayoutEffect(() => {
    const last = shown.current
    shown.current = { view, keys: rowKeys, shows: rowShows }
    if (last?.shows === rowShows) return
    if (!last || last.view !== view || last.keys.length === 0) {
      setNewAbove(0)
      setArrived(NONE_ARRIVED)
      return
    }
    const seen = new Set(last.shows)
    const fresh = new Set<string>()
    rowShows.forEach((shows, at) => {
      if (!seen.has(shows)) fresh.add(rowKeys[at]!)
    })
    // Added to what is still fading, so a batch landing mid-fade does not cut the last one short.
    if (fresh.size > 0) setArrived((was) => new Set([...was, ...fresh]))
    const above = keepPlace(last.keys, rowKeys, (key) => fresh.has(key))
    if (above > 0) setNewAbove((n) => n + above)
  }, [rowKeys, rowShows, view, keepPlace])
  useEffect(() => {
    if (arrived.size === 0) return
    const timer = setTimeout(() => setArrived(NONE_ARRIVED), ARRIVED_MS)
    return () => clearTimeout(timer)
  }, [arrived])
  // Seen once the reader is back at the top.
  useEffect(() => {
    if (atTop) setNewAbove(0)
  }, [atTop])

  /*
   * The segment under the pointer in a neuroglancer frame (`segmentHover.ts`, user, 2026-11-19):
   * the rows showing it are lit as the pointer moves, and once it rests the first of them is
   * scrolled into view — the list draws only what is in view, so a row scrolled away could not
   * light up otherwise. Asked only on a rest, never as the list changes under a still pointer.
   */
  const hovered = useHoveredSegment()
  const rested = useRestedSegment()

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
    const theirs = tipsOf(queue, neuronId)
    // The tree its list will walk, hand-picked pieces outside the extended ones included.
    const theirAccepted = acceptedPieces(theirs, verdicts)
    const walked = listedTree(tree, listedKey(tree, theirs, theirAccepted, neuronId))
    const top = arrangeTree(
      theirs,
      neuronId,
      walked,
      filters,
      acceptedByRoot(acceptedText(theirAccepted)),
    )[0]
    setParams(node.id, {
      neuron: neuronId,
      current: top ? tipKey(top.tip.neuronId, top.tip.endUid) : '',
      rank: (top?.hosted ?? top?.candidate)?.rank ?? 1,
    })
  }

  /*
   * Every write of work on the neuron goes through here: `recent` moves on, and the work of a
   * neuron past the last `KEPT_NEURONS` goes in the same edit (`withRecentWork`) — said on the
   * status bar, since nothing on the card shows it went, and the first press in a workflow from
   * before the list can clear many at once.
   */
  const setNotice = useGraphStore((s) => s.setNotice)
  const commitWork = (
    write: Readonly<Record<string, string>>,
    // Written in the same edit, and no work of its own: the cursor moving to what was written.
    also: Readonly<Record<string, string | number>> = {},
    params: Readonly<Record<string, unknown>> = node.params,
  ) => {
    // Auto-extend's accepts are no param's, so the pieces they took are named here (`reviewEviction.ts`).
    const { write: full, evicted } = withRecentWork(
      params,
      neuron,
      write,
      growth.accepted.keys(),
    )
    setParams(node.id, { ...full, ...also })
    if (evicted.length === 0) return
    setNotice(
      `Cleared the verdicts and extended pieces of ${plural(evicted.length, 'neuron')} you had not ` +
        `worked on lately: this card keeps its last ${KEPT_NEURONS}. ` +
        `${shortcutKeys('undo')} brings them back.`,
    )
  }

  const pick = (tip: QueueTip, shows: Candidate | undefined) => {
    setParam('current', tipKey(tip.neuronId, tip.endUid))
    // A click opens on what the row shows: per candidate its own; per tip the suggestion, or the
    // extended piece where the row shows that because its ends hang beneath it.
    setParam('rank', shows?.rank ?? 1)
  }
  const page = (by: number) => {
    if (!here) return
    const next = here.candidate.rank + by
    if (next < 1 || next > here.tip.candidates.length) return
    setParam('rank', next)
  }
  /*
   * What a press on a verdict writes, and whether it starts a search, is `judgedParams`'s to say
   * — `Auto-extend`, a large piece and a piece that cannot be extended are all read there.
   */
  const judge = (
    tip: QueueTip,
    candidate: Candidate,
    verdict: Verdict,
    blocked: string | undefined,
    also?: Readonly<Record<string, string | number>>,
  ) => {
    const { write, search, said } = judgedParams(
      node.params,
      tip.neuronId,
      candidate,
      verdict,
      blocked,
      offered.has(verdictKey(tip.neuronId, candidate.candidateId)),
    )
    // A piece no longer accepted is no longer extended, and a refusal is kept with the verdict:
    // all in one edit, one undo step.
    commitWork(write, also)
    if (search) runSearch()
    /*
     * **And to SEAM, where the reader opted in** (`verdictLog.ts`): the press, never the param,
     * so an undo or a loaded workflow sends nothing (user, 2026-11-18). A second press on the
     * same verdict took it back, which is a record too. A hand pick's carries no source, and is
     * not queued (`verdictInput`).
     */
    if (target) {
      const input = verdictInput(tip, candidate, said ?? 'cleared', __APP_VERSION__)
      if (queueVerdict(target, input) === undefined) void flushVerdicts()
    }
  }

  /*
   * The node this card's `Extended` is wired back to, which is what searches a piece: whoever
   * reads that output by reference (`referrerOf`). A published set has no such reader.
   */
  const searchId = useGraphStore((s) => referrerOf(s.graph, node.id, EXTENDED_PORT))
  // Wired only to viewers that report nothing back: the keys and the hover are off (the foot says).
  const foreignViewer = useGraphStore((s) => onlyForeignViewers(s.graph, node.id))
  const searchState = useGraphStore((s) =>
    searchId === undefined ? undefined : s.nodeInfo(searchId).state,
  )
  // Its own state too: with a node between the two, nothing is filling here until its first end.
  const search = {
    running: filling || searchState === 'running',
    finished: searchState === 'ok',
    failed: searchState === 'error',
  }
  const runNode = useGraphStore((s) => s.runNode)
  /** Run the search — whatever auto-run is set to; with it on, the two are one run. */
  const runSearch = () => {
    if (searchId !== undefined) void runNode(searchId)
  }
  /*
   * One edit, then a run of the search — so it starts whatever auto-run is set to, and with
   * auto-run on the two are one run (a newer walk adopts the evaluation, `docs/core.md`).
   * Stopping runs nothing: the rows leave the list at once (`liveQueue`), and the tables follow
   * whenever the search next runs.
   */
  const extend = (tip: QueueTip, candidate: Candidate, choice: ExtendChoice) => {
    const unjudgedHere = unjudged.has(verdictKey(tip.neuronId, candidate.candidateId))
    commitWork(
      extendParams(
        node.params,
        tip.neuronId,
        candidate.candidateId,
        choice,
        unjudgedHere,
        offered,
      ),
    )
    if (choice !== 'off') runSearch()
  }
  // Auto-extend takes SEAM's cutoff, which a search with no assessor does not publish.
  const noAuto = autoUnavailable(isTableValue(tips) ? tips : undefined)

  /*
   * The same pieces `Current` publishes, in the same colours the Neuroglancer node gives them —
   * one function each, so this fallback and the full-size viewer cannot disagree.
   */
  /*
   * What Submit has done on this neuron (`mergedSoFar`, the one reading of the record): pieces in
   * it, pieces this workflow put in another reviewed neuron, and whether this neuron is itself one.
   */
  const merged = useMemo(
    () => (neuron === undefined ? undefined : mergedSoFar(record, neuron, target)),
    [record, neuron, target],
  )
  // The pieces this neuron is extended with. Counted for the foot, and what keeps Submit off.
  const grown = useMemo(
    () => tree.filter((piece) => piece.seed === neuron).length,
    [tree, neuron],
  )
  // Of those, the ones Auto-extend accepted and the reader has not judged.
  const autoAccepted = useMemo(() => {
    const seedOf = new Map(tree.map((piece) => [piece.id, piece.seed]))
    return pairsOf(unjudged.keys()).filter((pair) => seedOf.get(pair.piece) === neuron).length
  }, [unjudged, tree, neuron])
  const stillToMergeHere = useMemo(() => stillToMerge(accepted, merged), [accepted, merged])
  const toSubmit = stillToMergeHere.length
  const absorbed = merged?.absorbedInto !== undefined
  // This card's Submit, named by document and node: two documents can share a node id.
  const docId = useGraphStore((s) => s.activeTabId)
  const submitting = useSubmitState(docId, node.id)
  const deployment = target?.deployment
  // Followed, so a sign-in in the Sources panel lifts the reason at once.
  const signedIn = useSyncExternalStore(
    subscribeTokens,
    () => deployment !== undefined && getToken(deployment) !== undefined,
  )
  /*
   * Whether the neuron and its candidates are still current (`rootCurrency`, reads only): the
   * neuron at its root now, and every candidate not already merged. Asked as the queue grows — a
   * Suggest Merges run streams its candidates in — and only of roots not yet known.
   */
  const neuronNow = merged?.currentRoot
  /**
   * The listed pieces not merged, by the root each is asked about as (`rootNow`: a followed one's
   * new root) — several where pieces were merged with each other since, all followed together.
   */
  const pieceAt = useMemo(() => {
    const at = new Map<string, Set<string>>()
    for (const tip of mine) {
      for (const { candidateId: id } of tip.candidates) {
        if (mergedAs(merged, id) !== undefined) continue
        const root = rootNow(merged, id)
        at.set(root, (at.get(root) ?? new Set()).add(id))
      }
    }
    return at
  }, [mine, merged])
  /** The segment a listed piece is drawn as: its root now (`rootNow`). */
  const drawnAs = useCallback(
    (id: string | undefined) => (id === undefined ? undefined : rootNow(merged, id)),
    [merged],
  )
  // From the rest there was at mount: a card mounting again must not scroll to an old one.
  const scrolledFor = useRef(rested?.count ?? 0)
  useEffect(() => {
    if (!rested || rested.count === scrolledFor.current) return
    scrolledFor.current = rested.count
    const at = listed.findIndex(
      (row) => drawnAs((row.hosted ?? row.candidate)?.candidateId) === rested.segment,
    )
    if (at >= 0) toRow(at)
  }, [rested, listed, toRow, drawnAs])
  const askAbout = useMemo(
    () => [...new Set([...(neuronNow ? [neuronNow] : []), ...pieceAt.keys()])],
    [pieceAt, neuronNow],
  )
  useEffect(() => {
    // Gated on a sign-in: the read needs the reader's token, and without one it would be refused.
    if (target && signedIn) rootCurrency.ask(target, askAbout)
  }, [target, signedIn, askAbout])
  // A new function when an answer lands, so a memo that reads it is redone then.
  const currency = useSyncExternalStore(rootCurrency.subscribe, rootCurrency.version)
  const edited = useCallback(
    (id: string) => target !== undefined && rootCurrency.current(target, id) === false,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- what it reads is versioned by `currency`.
    [target, currency],
  )
  /*
   * The query neuron edited since its suggestions were made — by somebody else: this workflow's
   * own merges are `currentRoot` already, and a lost reply still unsettled is the plan's to settle,
   * so neither is said here.
   */
  /** A listed piece edited since: asked at the root it is read as now (`rootNow`). */
  const pieceEdited = useCallback((id: string) => edited(rootNow(merged, id)), [edited, merged])
  const neuronEdited =
    neuronNow !== undefined && !absorbed && merged?.unsettled.length === 0 && edited(neuronNow)
  /*
   * **Following the neuron through an edit** (`followEdit.ts`, reads only;
   * `docs/seam-split-review-plan.md`): where its tips are now, the part to follow, and a
   * `FollowEntry` appended to the record through a short hold, as Submit appends — unrecorded,
   * since it describes the server, and refused while a batch holds the card. Placed from the
   * tips before any follow, so following the root an undone split made gives the tips back.
   */
  const [following, setFollowing] = useState(false)
  const followed = merged?.followed
  // The tips a follow would place now, against those the last one placed.
  const anchors = useMemo(
    () =>
      neuron === undefined || !merged
        ? undefined
        : anchorsOf(tipsOf(uncut, neuron), record, neuron, merged),
    [uncut, neuron, record, merged],
  )
  // Tips not asked about by the last follow: searched since, or a piece merged since.
  const unplaced = useMemo(() => {
    if (!followed || !anchors) return 0
    const asked = new Set(followed.placed)
    return anchors.tips.filter((sv) => !asked.has(sv)).length
  }, [followed, anchors])
  // Another part with nearly as many tips: either could be the neuron, so it is offered.
  const nearEven = nearEvenOf(followed)
  /*
   * A ref as well as the state, so a second call in the same frame — a click, or an edit said to the
   * card — finds a follow already under way.
   */
  const followingRef = useRef(false)
  /** The record as the store has it now, not as this render drew it. */
  const recordedSo = () => {
    if (neuron === undefined) return undefined
    const held = useGraphStore.getState().graph.nodes.find((one) => one.id === node.id)
    return mergedSoFar(decodeRecord(held?.params['merges']), neuron, target)
  }
  const recordedRoot = (): string | undefined => recordedSo()?.currentRoot
  /**
   * **One follow at a time**, the neuron's or pieces', held until its record is written, so an edit
   * said meanwhile waits for the new root; and none while a merge's answer is lost — a follow moves
   * a root the plan settles it by.
   */
  const withFollowHold = async (what: string, run: () => Promise<void>) => {
    if (followingRef.current) return
    if (merged !== undefined && merged.unsettled.length > 0) {
      setNotice(
        `A merge sent earlier has not been settled; Submit settles it before ${what} can be followed.`,
      )
      return
    }
    followingRef.current = true
    setFollowing(true)
    try {
      await run()
    } finally {
      followingRef.current = false
      setFollowing(false)
    }
  }
  /**
   * Entries appended through the record's hold, as Submit appends: those whose `from` is still the
   * root the record has, read **as it is at the write** — the same card can be drawn twice (on the
   * canvas and pinned), and both hear an edit said to them. The entries written, or undefined
   * where the hold refused, said.
   */
  const writeFollows = <E extends FollowEntry | PieceFollow>(
    entries: readonly E[],
    what: string,
  ): E[] | undefined => {
    // Read in the document it was pressed in; elsewhere, the hold below refuses and says why.
    const so = useGraphStore.getState().activeTabId === docId ? recordedSo() : undefined
    const kept = entries.filter(
      (entry) =>
        so === undefined ||
        (isFollow(entry)
          ? so.currentRoot === entry.from
          : // Not one a follow already put in the neuron, whose own id is its root then too.
            rootNow(so, entry.piece) === entry.from && !so.pieces.has(entry.piece)),
    )
    if (kept.length === 0) return []
    // Nothing awaited between the read and the write, so the record cannot move in between.
    const refused = appendHeld(
      { docId, nodeId: node.id },
      (now) => kept.reduce<unknown>((text, entry) => appendEntry(text, entry), now) as string,
    )
    if (refused === undefined) return kept
    setNotice(`${what} could not be followed: ${refused}`)
    return undefined
  }
  const follow = async (prefer?: string) => {
    if (!target || neuron === undefined || !merged || !anchors) return
    await withFollowHold('the neuron', async () => {
      setNotice('Reading where the neuron’s tips are now…')
      const answer = await followEdit(
        { scope: target, reviewedRoot: neuron, from: merged.currentRoot, anchors, prefer },
        { deployment: target.deployment },
      )
      if (!answer.ok) {
        setNotice(answer.message)
        return
      }
      const { entry } = answer
      const written = writeFollows([entry], 'The neuron')
      if (!written) return
      if (written.length === 0) {
        setNotice('The neuron has been followed already.')
        return
      }
      const unknown = anchors.unknown ?? 0
      setNotice(
        (entry.away.length === 0
          ? `Followed the neuron to ${entry.to}; every tip is on it.`
          : `Followed the neuron to ${entry.to}, the part holding ${plural(entry.kept, 'tip')}. ${plural(entry.away.length, 'tip')} went with the other part and left the list.`) +
          (unknown > 0
            ? ` ${plural(unknown, 'merged piece')} could not be checked (the record keeps only a summary of merges this old) and ${unknown === 1 ? 'is' : 'are'} still counted in the neuron.`
            : ''),
      )
    })
  }
  /*
   * **Following pieces of the list through an edit** (`followPieces`, phase 4 of
   * `docs/seam-split-review-plan.md`, reads only): each goes to the root its contact with the
   * neuron is under now, and keeps its verdict; one that went into the neuron reads as merged. A
   * `PieceFollow` per piece edited, all in one write.
   */
  const followPiecesNow = async (ids: readonly string[]) => {
    // A neuron merged into another reviewed one is that one's to follow.
    if (!target || neuron === undefined || !merged || absorbed) return
    const own = tipsOf(uncut, neuron)
    const wanted = ids.flatMap((id) => {
      const one = pieceAnchorsOf(mine, own, id, rootNow(merged, id), accepted)
      return one ? [one] : []
    })
    if (wanted.length === 0) {
      setNotice(
        'These suggestions do not say which supervoxel the piece meets the neuron on, so where it ' +
          'went cannot be read. Run Suggest Merges again to follow it.',
      )
      return
    }
    await withFollowHold('a piece', async () => {
      setNotice(
        wanted.length === 1
          ? `Reading where ${wanted[0]!.piece} is now…`
          : `Reading where ${wanted.length} pieces are now…`,
      )
      const answer = await followPieces(
        { scope: target, reviewedRoot: neuron, pieces: wanted },
        { deployment: target.deployment },
      )
      if (!answer.ok) {
        setNotice(answer.message)
        return
      }
      const fresh = writeFollows(answer.entries, 'The piece')
      if (!fresh) return
      if (fresh.length === 0 && answer.entries.length > 0) {
        setNotice('The piece has been followed already.')
        return
      }
      const after = recordedSo()
      const said = [
        ...fresh.map((entry) =>
          mergedAs(after, entry.piece) === 'merged'
            ? `${entry.piece} is part of the neuron now.`
            : `Followed ${entry.piece} to ${entry.to}, the part that meets the neuron` +
              (entry.away.length > 0
                ? `; ${plural(entry.away.length, 'tip')} of it went with the other part and left the list.`
                : '.'),
        ),
        ...answer.refused.map((one) => one.message),
      ]
      setNotice(said.length > 0 ? said.join(' ') : 'The piece has not been edited since.')
    })
  }
  /*
   * An edit the split gallery or a Neuroglancer card says replaced the neuron or a listed piece
   * (`rootEdits.ts`). Certain, it is followed at once — or, where a follow is under way, once that
   * one ends (an Undo pressed straight after the split). Suggested, it is followed once the
   * chunkedgraph says the root is outdated, asked by a question sent from now on, and only for
   * `SUGGESTED_WAIT_MS`. The neuron goes first; its pieces after (phase 4).
   */
  const followLatest = useLatest(follow)
  const followPiecesLatest = useLatest(followPiecesNow)
  const recordedLatest = useLatest(recordedRoot)
  // Read when an edit is said, so a record write does not subscribe the listener again.
  const pieceAtLatest = useLatest(pieceAt)
  const pending = useRef<readonly string[] | undefined>(undefined)
  /** Roots said to be edited, until the currency check calls them outdated: the neuron's, or a piece's. */
  const awaiting = useRef(new Map<string, { pieces?: ReadonlySet<string>; until: number }>())
  /** Pieces to follow once no follow is under way (`followPiecesNow`). */
  const piecesDue = useRef(new Set<string>())
  // Not while a Submit holds the card: its plan was made on the roots as they were.
  const submittingLatest = useLatest(submitting)
  const followDuePieces = useCallback(() => {
    if (followingRef.current || submittingLatest.current !== 'none') return
    if (piecesDue.current.size === 0) return
    const ids = [...piecesDue.current]
    piecesDue.current.clear()
    void followPiecesLatest.current(ids)
  }, [followPiecesLatest, submittingLatest])
  useEffect(
    () =>
      onEdit((edit) => {
        // A neuron merged into another reviewed one is that one's to follow.
        if (!target || neuronNow === undefined || absorbed) return
        if (edit.deployment !== target.deployment || edit.datastack !== target.datastack) return
        const signed = getToken(target.deployment) !== undefined
        const until = Date.now() + SUGGESTED_WAIT_MS
        const ask: string[] = []
        for (const root of edit.roots) {
          const pieces = root === neuronNow ? undefined : pieceAtLatest.current.get(root)
          if (root !== neuronNow && pieces === undefined) continue
          if (edit.certain || rootCurrency.current(target, root) === false) {
            if (pieces !== undefined) for (const id of pieces) piecesDue.current.add(id)
            else if (followingRef.current) pending.current = edit.roots
            else void followLatest.current()
          } else if (signed) {
            awaiting.current.set(root, pieces === undefined ? { until } : { pieces, until })
            ask.push(root)
          }
        }
        if (ask.length > 0) rootCurrency.askAfter(target, ask, 0)
        followDuePieces()
      }),
    [target, neuronNow, absorbed, pieceAtLatest, followLatest, followDuePieces],
  )
  useEffect(() => {
    if (following || neuronNow === undefined) return
    // A follow just written that this render does not show yet: wait for the one that does.
    if (pending.current && recordedLatest.current() !== neuronNow) return
    if (pending.current?.includes(neuronNow)) {
      pending.current = undefined
      void followLatest.current()
      return
    }
    pending.current = undefined
    const waited = awaiting.current.get(neuronNow)
    if (!neuronEdited || !waited || waited.pieces !== undefined) return
    awaiting.current.delete(neuronNow)
    if (Date.now() <= waited.until) void followLatest.current()
  }, [following, neuronEdited, neuronNow, followLatest, recordedLatest])
  // The pieces, once the neuron's follow (above, in the same commit) is not under way.
  useEffect(() => {
    if (following || followingRef.current || absorbed) return
    const now = Date.now()
    for (const [root, waited] of awaiting.current) {
      if (now > waited.until) awaiting.current.delete(root)
      else if (waited.pieces !== undefined && edited(root)) {
        awaiting.current.delete(root)
        for (const id of waited.pieces) piecesDue.current.add(id)
      }
    }
    followDuePieces()
  }, [following, absorbed, edited, submitting, followDuePieces])
  /*
   * The neuron and the candidate in view asked again on each row clicked, where the last answer is
   * more than `RECHECK_ROW_MS` old: an edit made outside Coda shows its tag by the time the reader
   * looks for it, rather than after the currency check's five minutes. A merged candidate's root
   * is retired by the merge, so not asked.
   */
  const shownCandidate = here?.candidate.candidateId
  const shownToAsk =
    shownCandidate !== undefined && mergedAs(merged, shownCandidate) === undefined
      ? rootNow(merged, shownCandidate)
      : undefined
  // Each row moved to, not only each candidate: the cursor is the row.
  const cursor = `${String(node.params.current ?? '')}#${String(node.params.rank ?? '')}`
  useEffect(() => {
    if (!target || !signedIn || neuronNow === undefined) return
    const ids = shownToAsk === undefined ? [neuronNow] : [neuronNow, shownToAsk]
    rootCurrency.ask(target, ids, RECHECK_ROW_MS)
  }, [target, signedIn, neuronNow, shownToAsk, cursor])
  // Why a piece cannot be extended, where it cannot: read by each row and by Auto-extend listed.
  const blockedOf = useCallback(
    (id: string) => {
      const done = mergedAs(merged, id)
      return extendBlocked({
        wired: searchId !== undefined,
        done,
        outdated: !done && pieceEdited(id),
      })
    },
    [merged, searchId, pieceEdited],
  )
  /*
   * `Auto-extend listed` (user, 2026-11-19): Auto-extend on every listed row whose first candidate
   * clears SEAM's cutoff and the reader has not turned down — which rows, `listedAutoPairs`'s to
   * say; what is written, `listedAutoParams`'. Memoised: it reads every listed row, and a scroll
   * re-renders the card.
   */
  const listedAuto = useMemo(
    () =>
      noAuto !== undefined
        ? []
        : listedAutoPairs(listed, {
            extended,
            autoPressed,
            accepted: growth.accepted,
            unjudged,
            searched,
            offered,
            stored,
            verdicts,
            acceptedHere: accepted,
            blocked: blockedOf,
          }),
    [
      noAuto,
      listed,
      extended,
      autoPressed,
      growth,
      unjudged,
      searched,
      offered,
      stored,
      verdicts,
      accepted,
      blockedOf,
    ],
  )
  const autoListed = () => {
    if (listedAuto.length === 0) return
    commitWork(listedAutoParams(node.params, listedAuto, offered))
    runSearch()
  }

  /*
   * A hand pick (`handPicks.ts`, user, 2026-11-19): the segment under the pointer in a
   * neuroglancer frame, added to this neuron's list and accepted, on `J` or the Add button. A
   * piece the list already holds is accepted where it is listed; anything else is checked against
   * the segmentation first (`checkPick`), which takes a moment, so the status bar says so.
   */
  const [checking, setChecking] = useState<string>()
  // Set at once, where `checking` waits for a render: a second press before then is turned away.
  const checkingRef = useRef(false)
  /*
   * What a hand pick may touch besides the neuron: **every piece accepted on it and not merged
   * yet**, extended or not (user, 2026-11-20) — what Submit merges (`toSubmit`), so a pick on one
   * is a second hop like any other, and its row stays on that piece (`withPicks` after
   * `liveQueue`).
   */
  const unmergedPieces = stillToMergeHere
  const pickAbort = useRef<AbortController>(undefined)
  useEffect(() => () => pickAbort.current?.abort(), [])
  const addPick = async ({ segment: pointed, positionNm }: PointedSegment) => {
    if (neuron === undefined || checkingRef.current) return
    // A followed piece is drawn as its new root: a pick on that is a pick on the piece listed.
    const drawnFor = pieceAt.get(pointed)
    if (drawnFor !== undefined && drawnFor.size > 1) {
      setNotice(
        `${pointed} is what ${[...drawnFor].join(' and ')} are all part of now: pick from the list instead.`,
      )
      return
    }
    const segment = drawnFor === undefined ? pointed : [...drawnFor][0]!
    if (mergedAs(merged, segment)) {
      setNotice(`${segment} has been merged already.`)
      return
    }
    const listed = listedAt(mine, segment)
    if (listed) {
      const { tip, candidate } = listed
      const cursor = { current: tipKey(tip.neuronId, tip.endUid), rank: candidate.rank }
      if (verdictFor(stored, tip.neuronId, segment) === 'accept') {
        setParams(node.id, cursor)
        setNotice(`${segment} is listed and accepted already.`)
      } else {
        judge(tip, candidate, 'accept', blockedOf(segment), cursor)
        setNotice(`${segment} was listed already, and is accepted now.`)
      }
      return
    }
    if (!target) {
      setNotice(
        'A hand pick is checked against the segmentation, which needs a CAVE dataset wired into `Dataset`.',
      )
      return
    }
    if (!signedIn) {
      setNotice(
        `Sign in to ${target.deployment} to add a hand pick: it is checked against the segmentation first.`,
      )
      return
    }
    if (!positionNm) {
      setNotice(
        'Neuroglancer did not say where the pointer was. Point at the piece in a panel.',
      )
      return
    }
    const controller = new AbortController()
    pickAbort.current = controller
    checkingRef.current = true
    setChecking(segment)
    setNotice(`Checking ${segment} against the segmentation…`)
    let checked
    try {
      checked = await checkPick(
        {
          datastack: target.datastack,
          segment,
          positionNm: [...positionNm],
          seed: neuron,
          neuronRoot: merged?.currentRoot ?? neuron,
          pieces: unmergedPieces,
          joined: merged?.joined,
          moved: merged?.moved,
        },
        { deployment: target.deployment, signal: controller.signal },
      )
    } catch {
      return // Cancelled: the card went away.
    } finally {
      checkingRef.current = false
      setChecking(undefined)
    }
    if (!checked.ok) {
      setNotice(checked.message)
      return
    }
    // Written into the card as it is now, and only into the document it was picked in.
    const store = useGraphStore.getState()
    const params = store.graph.nodes.find((one) => one.id === node.id)?.params
    if (store.activeTabId !== docId || !params) return
    const { root, contactNm, gapUm, l2Chunks, candSv, tipSv } = checked
    const held = decodePicks(params['picks'])
    if (held.some((one) => one.seed === neuron && one.candidateId === segment)) return
    const n = held.reduce((most, one) => Math.max(most, one.n), 0) + 1
    const pick = {
      n,
      seed: neuron,
      root,
      candidateId: segment,
      contactNm,
      gapUm,
      l2Chunks,
      candSv,
      tipSv,
    }
    // Where it lands is where the queue will list it: placed by `withPicks` itself.
    const placed = listedAt(withPicks(mine, [pick]), segment)!
    // An accept left from before, on a pair no longer listed: judged again, it would be cleared.
    const already = verdictFor(decodeVerdicts(params['verdicts']), root, segment) === 'accept'
    const { write, search } = already
      ? { write: {}, search: false }
      : judgedParams(params, root, placed.candidate, 'accept', blockedOf(segment))
    // The cursor goes to it only where the reader is still on that neuron.
    const stayed = String(params['neuron'] ?? '') === String(node.params.neuron ?? '')
    commitWork(
      { ...write, picks: encodePicks([...held, pick]) },
      stayed ? { current: tipKey(root, placed.tip.endUid), rank: placed.candidate.rank } : {},
      params,
    )
    if (search) runSearch()
    setNotice(`Added ${segment} by hand and accepted it: ${gapLabel(gapUm)} from the neuron.`)
  }
  useSegmentPick(node.id, (pointed) => void addPick(pointed))

  /*
   * The verdict keys (`reviewKeys.ts`, user, 2026-11-22): the row under the cursor judged, and the
   * cursor on to the next row to review (`nextToReview`) in the same edit — one undo step takes
   * both back. A key never takes a verdict back: pressed on a row that already has it, it only
   * moves on, where the button would clear it. A row that cannot be judged says why, as the
   * button's title does, and the cursor stays.
   */
  const rowOf = (at: CurrentItem | undefined) =>
    at
      ? listed.findIndex(
          (row) =>
            row.tip === at.tip &&
            (mode === 'tip' || row.candidate?.candidateId === at.candidate.candidateId),
        )
      : -1
  // The cursor moved by a key is scrolled to once the list has drawn it.
  const followCursor = useRef(false)
  useReviewKeys(node.id, (key) => {
    /*
     * Not under a Submit window, this card's or another's: it covers the buttons, and its own
     * viewer hands the keys back like any frame — a verdict changed under the plan being confirmed
     * or sent would not be the one merged.
     */
    if (submitting === 'open' || submitting === 'running' || submitting === 'other') {
      setNotice('Close the Submit window first: the verdict keys wait until it is gone.')
      return
    }
    const verdict = key === 'skip' ? undefined : key
    if (verdict !== undefined && !here) {
      setNotice('Click a row first: a verdict key judges the row under the cursor.')
      return
    }
    const said = here && verdictFor(verdicts, here.tip.neuronId, here.candidate.candidateId)
    if (verdict !== undefined && here) {
      const id = here.candidate.candidateId
      const can = verdictPress({
        verdict,
        done: mergedAs(merged, id),
        inNeuron: acceptedElsewhere(accepted, said, id),
        goesWith: '',
      })
      if (can.disabled) {
        setNotice(can.title)
        return
      }
    }
    const at = nextToReview(
      listed,
      rowOf(here),
      mode,
      verdicts,
      (id) => mergedAs(merged, id) !== undefined || accepted.has(id),
      // A change to anything but an accept takes the piece's ends off the list, where it has any.
      verdict !== undefined && verdict !== 'accept' && said !== verdict
        ? here?.candidate.candidateId
        : undefined,
    )
    const next = at === undefined ? undefined : listed[at]
    const move = next && {
      current: tipKey(next.tip.neuronId, next.tip.endUid),
      rank: (next.hosted ?? next.candidate)?.rank ?? 1,
    }
    if (verdict !== undefined && here && said !== verdict) {
      judge(here.tip, here.candidate, verdict, blockedOf(here.candidate.candidateId), move)
    } else if (move) {
      setParams(node.id, move)
    }
    if (move) followCursor.current = true
    else if (listed.length === 0) setNotice('No row is listed yet.')
    else setNotice('No other listed row is left to review.')
  })
  useEffect(() => {
    if (!followCursor.current) return
    followCursor.current = false
    const at = rowOf(here)
    if (at >= 0) toRow(at)
  })

  /*
   * Start over: asked in place, as the shelf asks before a delete (no `window.confirm`, which
   * jsdom lacks), then one edit. Nothing runs: the extended pieces' rows leave the list at once
   * (`liveQueue`), as when Extend is stopped.
   */
  const [askingStartOver, setAskingStartOver] = useState(false)
  const work = useMemo(() => storedWork(node.params), [node.params])
  /*
   * And the double-clicks in every Neuroglancer card this one is wired to (user, 2026-11-20):
   * finding a piece to pick by hand means double-clicking it into the viewer, which keeps it on
   * that card, so after a Start over it stayed on screen in neuroglancer's own colours, a piece
   * of nobody's list. One edit with the card's own write, one undo step.
   */
  const setParamsMany = useGraphStore((s) => s.setParamsMany)
  // As text, so the selector hands out a primitive (invariant 7); counted in the prompt.
  const viewerText = useGraphStore((s) => viewersWithEdits(s.graph, node.id).join(','))
  const viewers = viewerText === '' ? [] : viewerText.split(',')
  const startOver = () => {
    setAskingStartOver(false)
    setParamsMany([
      { nodeId: node.id, values: { ...START_OVER_WRITE } },
      ...viewersWithEdits(useGraphStore.getState().graph, node.id).map((nodeId) => ({
        nodeId,
        values: { selectionEdits: [] },
      })),
    ])
  }

  const press = submitPress({
    docId,
    nodeId: node.id,
    sourceId: dataset.sourceId,
    datasetId: dataset.datasetId,
    signedIn,
    queue,
    neuron,
    absorbed,
    neuronEdited,
    accepted: accepted.size,
    count: toSubmit,
    submitting,
  })
  const showAccepted = node.params.showAccepted !== false
  // Memoised on what the scene depends on, not on `here` (a new object each render): a scroll
  // of the list re-renders the card and must not rebuild the pieces.
  const hereTip = here && tipKey(here.tip.neuronId, here.tip.endUid)
  const hereCandidate = here?.candidate.candidateId
  const pieces = useMemo(
    () => scenePieces(mine, neuron, here, verdicts, showAccepted, merged, accepted),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `here` is named by its two ids.
    [mine, neuron, hereTip, hereCandidate, verdicts, showAccepted, merged, accepted],
  )
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
  const contact = here?.candidate.contactNm
  const focus =
    contact && voxel ? ([0, 1, 2] as const).map((i) => contact[i] / voxel[i]!) : undefined

  const fields = cardParams(def, node.params)
  /*
   * Paused while a Submit overlay is up — this card's or another's: the overlay has a viewer of
   * its own and covers this one, and two Neuroglancer frames would compete for one GPU. Not while
   * the check runs, which draws nothing, so a cancelled or refused check costs the view nothing.
   */
  const overlayUp = submitting === 'open' || submitting === 'running' || submitting === 'other'
  const showViewer =
    !compact && !driving && scene !== undefined && !!dataset.datasetId && !overlayUp

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
      data-viewer={showViewer ? 'yes' : 'no'}
    >
      {/*
       * The viewer, expanded only. A frame on the card would be a WebGL application a couple of
       * hundred pixels tall, next to the list it is competing with for the space; the card's job
       * is the queue, and the ⤢ button is one click from the picture.
       */}
      {showViewer && dataset.datasetId && (
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
          <div className="review-list-frame">
            {/*
             * Over the list rather than above it: a note pushing the list down as it appears would
             * be the very jump the list holds still against.
             */}
            {newAbove > 0 && !atTop && (
              <button
                type="button"
                className="review-body__new-above"
                title="Rows the search added above where you are reading. The list held still rather than move under you; this takes you to the top."
                onClick={() => {
                  toTop()
                  setNewAbove(0)
                }}
              >
                {`↑ ${formatNumber(newAbove)} new above`}
              </button>
            )}
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
                // The same objects: `here` and the rows are both read off `mine`.
                const onTip = here?.tip === tip
                // What the row shows of its own accord (`hosted` is per tip only).
                const shows = row.hosted ?? row.candidate
                const candidate: Candidate | undefined =
                  mode === 'tip' && onTip ? here.candidate : shows
                const on =
                  onTip &&
                  (mode === 'tip' || here?.candidate.candidateId === candidate?.candidateId)
                // The pair the row shows, as `parent/piece`.
                const key = candidate && verdictKey(tip.neuronId, candidate.candidateId)
                const said =
                  candidate && verdictFor(verdicts, tip.neuronId, candidate.candidateId)
                // Merged by Submit: a verdict on it changes nothing now, so it cannot be changed.
                const done = candidate && mergedAs(merged, candidate.candidateId)
                // In the neuron already by another road: a second accept would be a second merge.
                const inNeuron =
                  candidate !== undefined &&
                  acceptedElsewhere(accepted, said, candidate.candidateId)
                // At the root it is asked about as: a followed piece's new one (`rootNow`).
                const outdated =
                  !done && candidate !== undefined && pieceEdited(candidate.candidateId)
                const followedTo =
                  candidate && !done ? merged?.moved.get(candidate.candidateId) : undefined
                // Auto-extend stopped at this end on the piece the row shows, too large to take.
                const stop = stoppedLarge.get(tipKey(tip.neuronId, tip.endUid))
                const stopNote =
                  stop && stop.id === candidate?.candidateId
                    ? autoStoppedNote(stop.chunks, tip.q)
                    : ''
                // How the piece is extended: by the reader's press, or by an Auto-extend further up.
                const {
                  choice,
                  autoFrom,
                  heldBy,
                  held,
                  extended: isExtended,
                } = rowExtend(key, {
                  extended,
                  autoPressed,
                  accepted: growth.accepted,
                  unjudged,
                  searched,
                })
                // What goes off the list with this piece, said before the click that does it.
                const goesWith =
                  isExtended && candidate ? leavesWith(tree, candidate.candidateId) : ''
                // Why the piece cannot be extended, where it cannot.
                const blocked = candidate && blockedOf(candidate.candidateId)
                /*
                 * The Extend button, on an accepted row only: what it reads, says and whether it
                 * can be pressed are `extendPress`'s, as Submit's are `submitPress`'s; its menu's
                 * are `extendMenu`'s.
                 */
                const extendButton =
                  candidate && said === 'accept'
                    ? extendPress({
                        candidate,
                        progress: isExtended
                          ? extendProgress(built, tip.seed, candidate.candidateId, search)
                          : undefined,
                        blocked,
                        extendOnAccept: node.params.extendOnAccept === true,
                        goesWith,
                        choice,
                        held,
                        heldBy,
                        took: autoTook.get(candidate.candidateId) ?? 0,
                      })
                    : undefined
                const menu = extendButton && extendMenu({ choice, blocked, held, noAuto })
                return (
                  <li
                    key={rowKeyOf(row, mode)}
                    className="review-row"
                    data-row
                    aria-setsize={listed.length}
                    aria-posinset={windowed.rows.start + offset + 1}
                    data-current={on ? 'yes' : 'no'}
                    data-arrived={arrived.has(rowKeyOf(row, mode)) ? 'yes' : undefined}
                    data-hovered={
                      hovered !== undefined && drawnAs(candidate?.candidateId) === hovered
                        ? 'yes'
                        : undefined
                    }
                    data-verdict={said ?? 'none'}
                    data-merged={done ?? 'no'}
                    /*
                     * A piece's tips sit beneath the row the piece was accepted on, a step in for
                     * every piece between them and the neuron, behind an arrow (`editor.css`).
                     */
                    data-depth={row.depth}
                    style={
                      row.depth > 0
                        ? ({ '--depth': Math.min(row.depth, MAX_INDENT) } as CSSProperties)
                        : undefined
                    }
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
                      onClick={() => pick(tip, shows)}
                      aria-label={`Show ${tipName(tip)} and candidate ${
                        candidate?.candidateId ?? 'none'
                      }`}
                      title={`Show ${tipName(tip)} and candidate ${candidate?.candidateId ?? '—'}`}
                    />
                    <span className="review-row__score" style={{ color: scoreInk(row) }}>
                      <span>{row.score === undefined ? '—' : row.score.toFixed(3)}</span>
                      {row.estimate !== undefined && (
                        <span className="review-row__estimate">
                          {estimateLabel(row.estimate)}
                        </span>
                      )}
                    </span>
                    {/*
                     * Its chips take the pointer back so their titles show (`editor.css`), and a
                     * click on one bubbles here: it picks the row, as a click beside it does. The
                     * line's own text gives the pointer up, so this never runs twice.
                     */}
                    <span className="review-row__id" onClick={() => pick(tip, shows)}>
                      {candidate?.candidateId ?? 'no candidate'}
                      {/*
                       * Auto-extend stopped here on a piece too large to take — often a false
                       * merge, in this piece or in the chain (user, 2026-11-21).
                       */}
                      {stopNote && (
                        <span
                          className="review-row__stopped"
                          role="img"
                          aria-label={stopNote}
                          title={stopNote}
                        >
                          !
                        </span>
                      )}
                      {/*
                       * Its own chip, not one more muted fact: a merged piece must stand apart
                       * from the ones still to merge at a glance (user, 2026-11-16).
                       */}
                      {done && (
                        <span className="review-row__merged">
                          {done === 'merged'
                            ? '✓ merged'
                            : done === 'joined'
                              ? '✓ joined, not in the neuron yet'
                              : done === 'split'
                                ? 'split off with the other part'
                                : '✓ merged into another neuron'}
                        </span>
                      )}
                      {inNeuron && !done && (
                        <span className="review-row__merged" title={IN_NEURON_NOTE}>
                          in this neuron
                        </span>
                      )}
                      {/* Accepted by Auto-extend, and not yet by the reader. */}
                      {autoFrom !== undefined && !done && (
                        <span
                          className="review-row__auto"
                          title={`${
                            key !== undefined && taken.has(key)
                              ? 'Accepted on SEAM’s cutoff by Auto-extend listed.'
                              : `Accepted by the Auto-extend on ${autoFrom}.`
                          } Press Accept to make it your own verdict. ${AUTO_REJECT_NOTE}`}
                        >
                          auto
                        </span>
                      )}
                      {candidate?.hand && (
                        <span
                          className="review-row__hand"
                          title="You added this piece from neuroglancer: the search did not list it here. Undo takes it off the list."
                        >
                          by hand
                        </span>
                      )}
                      {/*
                       * Edited since: Submit would refuse it. Pressed, the piece is followed to
                       * the part that meets the neuron (`followPiecesNow`).
                       */}
                      {outdated && candidate && (
                        <button
                          type="button"
                          className="review-row__outdated"
                          // Not while a Submit holds the card, nor for a neuron another took in.
                          disabled={following || absorbed || submitting !== 'none'}
                          title="This piece has been edited since, so it cannot be merged as it is. Press to follow it to the part that meets the neuron; your verdict carries over."
                          onClick={(event) => {
                            event.stopPropagation()
                            void followPiecesNow([candidate.candidateId])
                          }}
                        >
                          outdated
                        </button>
                      )}
                      {followedTo !== undefined && !outdated && (
                        <span
                          className="review-row__followed"
                          title={`Edited since it was suggested, and followed to ${followedTo}, the part that meets the neuron. It is drawn and merged as that; your verdict carries over.`}
                        >
                          followed
                        </span>
                      )}
                    </span>
                    <span className="review-row__facts">
                      {candidate
                        ? [
                            // Which piece the tip is on is the row it sits beneath; said in
                            // words only where there is no such row.
                            row.adrift ? `on piece ${tip.neuronId}` : '',
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
                            gapLabel(candidate.minDistUm),
                            tip.kind === 'kink' ? 'kink' : '',
                            // The tip's verdict on either grain; per tip, the row's own, which is
                            // re-scored where organelles were taken out of the list.
                            (mode === 'tip' ? row.shown : tip.shown) ? 'shown' : '',
                            row.passedOver ? 'first was an organelle' : '',
                            candidate.organelle ? 'organelle' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : row.passedOver
                          ? 'every candidate here is flagged as an organelle'
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
                        <VerdictButtons
                          said={said}
                          press={(verdict) =>
                            verdictPress({
                              verdict,
                              done,
                              inNeuron,
                              goesWith,
                              auto:
                                autoFrom !== undefined
                                  ? 'unjudged'
                                  : heldBy !== undefined
                                    ? 'judged'
                                    : undefined,
                            })
                          }
                          onJudge={(verdict) => judge(tip, candidate, verdict, blocked)}
                        />
                        {extendButton && menu && (
                          <ExtendButtons
                            face={extendButton}
                            pressed={isExtended}
                            menu={menu}
                            checked={choice === 'off' ? undefined : choice}
                            onPress={(writes) => extend(tip, candidate, writes)}
                          />
                        )}
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
          </div>
        )}

        <div className="list-body__foot">
          <VerdictSharing datastack={target?.datastack} />
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
          {organellesOut > 0 && (
            <span title="Exclude organelles: the search flags these as pieces wrapped inside one cell. Per candidate they are left out; per tip, a tip whose first candidate is one leads with the next instead, without SEAM’s r, which is about the first. About one flagged piece in a hundred is not an organelle — switch the filter off to see them.">
              {mode === 'candidate'
                ? `${plural(organellesOut, 'organelle')} left out`
                : `${plural(organellesOut, 'tip')} passing over an organelle first`}
            </span>
          )}
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
          {grown > 0 && (
            <span title="Accepted pieces of this neuron whose own open ends are searched and listed here.">
              {plural(grown, 'piece')} extended
            </span>
          )}
          {autoAccepted > 0 && (
            <span
              title={`Pieces Auto-extend accepted that you have not judged, marked “auto” in the list. ${AUTO_REJECT_NOTE}`}
            >
              {formatNumber(autoAccepted)} by Auto-extend
            </span>
          )}
          {foreignViewer && (
            <span className="review-body__viewer" title={FOREIGN_VIEWER_NOTE}>
              viewer is not Coda’s own: J, K and F are off
            </span>
          )}
          {neuronEdited && (
            <span className="review-body__edited">
              query neuron edited since these suggestions were generated
              <FollowButton
                disabled={following || anchors === undefined}
                onClick={() => void follow()}
                title="Read where this neuron’s tips are now and carry on with the part holding the most of them. Tips on the other parts leave the list; your verdicts are kept."
              >
                {following ? 'following…' : 'Follow the edit'}
              </FollowButton>
            </span>
          )}
          {followed && !neuronEdited && (
            <span title={`Followed ${followed.from} to ${followed.to} at ${followed.at}.`}>
              {followed.away.length === 0
                ? `followed to ${followed.to}`
                : `${plural(followed.away.length, 'tip')} left with the part split off`}
              {nearEven && (
                <FollowButton
                  disabled={following}
                  onClick={() => void follow(nearEven.root)}
                  title={`The other part, ${nearEven.root}, holds ${plural(nearEven.tips, 'tip')} against this part’s ${formatNumber(followed.kept)}: either could be the neuron. Follow it instead, and these tips come back.`}
                >
                  follow the other part instead
                </FollowButton>
              )}
              {unplaced > 0 && (
                <FollowButton
                  disabled={following}
                  onClick={() => void follow(followed.to)}
                  title="Tips searched since the neuron was followed: read which part each is on."
                >
                  place {plural(unplaced, 'new tip')}
                </FollowButton>
              )}
            </span>
          )}
          {absorbed && (
            <span className="review-body__absorbed">
              merged into another neuron under review
            </span>
          )}
        </div>
        {/*
         * The buttons on a row of their own, under the facts (user, 2026-11-19): sharing one
         * wrapping row, they broke onto a second line anyway, wherever the facts ran out.
         */}
        <div className="review-body__actions">
          {askingStartOver ? (
            <>
              <span className="review-body__ask">
                {`Clear ${plural(work.verdicts, 'verdict')} and ${plural(work.extended, 'extended piece')} on every neuron${viewers.length > 0 ? `, and the double-clicks in ${plural(viewers.length, 'Neuroglancer card')}` : ''}? The merge record stays.`}
              </span>
              <button
                type="button"
                className="btn review-body__clear"
                data-tone="danger"
                onClick={startOver}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn review-body__cancel"
                onClick={() => setAskingStartOver(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn review-body__start-over"
                disabled={!work.any && viewers.length === 0}
                title={
                  work.any || viewers.length > 0
                    ? START_OVER_HELP
                    : 'Nothing to clear: no verdict or extended piece is stored, and no viewer wired to this card holds a double-click.'
                }
                onClick={() => setAskingStartOver(true)}
              >
                Start over…
              </button>
              {/*
               * The pick key's button, for whoever does not know the key: the segment the pointer
               * last rested on, since the pointer has left the frame to press this.
               */}
              <button
                type="button"
                className="btn review-body__add-pick"
                disabled={
                  rested === undefined || checking !== undefined || neuron === undefined
                }
                title={
                  rested === undefined
                    ? `Rest the pointer on a piece in Neuroglancer first. Or press ${shortcutKeys('pick-segment')} with the pointer on it.`
                    : `Add ${rested.segment}, which the pointer last rested on in Neuroglancer, to this neuron’s list and accept it. Or press ${shortcutKeys('pick-segment')} with the pointer on a piece.`
                }
                onClick={() => {
                  const pointed = restedPoint()
                  if (pointed) void addPick(pointed)
                }}
              >
                {checking !== undefined ? 'Checking…' : 'Add from viewer'}
              </button>
              {/*
               * Auto-extend on every listed row that clears SEAM's cutoff, in one edit. Disabled with
               * the reason as its title, as Submit is.
               */}
              <button
                type="button"
                className="btn review-body__auto-listed"
                disabled={listedAuto.length === 0}
                title={
                  noAuto ??
                  (listedAuto.length > 0
                    ? AUTO_LISTED_HELP
                    : searchId === undefined
                      ? // Unwired, every row is blocked: say what to wire, as a row's Extend does.
                        extendBlocked({ wired: false, done: undefined, outdated: false })
                      : `No listed row is left for it: ${AUTO_LISTED_HELP}`)
                }
                onClick={autoListed}
              >
                {`Auto-extend listed (${formatNumber(listedAuto.length)})`}
              </button>
              {/*
               * Submit: the accepted pieces of this neuron not yet merged, checked and listed in an
               * overlay before anything is sent. Disabled with the reason as its title.
               */}
              <button
                type="button"
                className="btn btn--primary review-body__submit"
                // While the check runs, nothing else is drawn for it: the button is its Cancel.
                disabled={submitting !== 'planning' && 'blocked' in press}
                title={
                  submitting === 'planning'
                    ? 'Stop checking, and open nothing.'
                    : 'blocked' in press
                      ? press.blocked
                      : SUBMIT_HELP
                }
                onClick={() => {
                  if (submitting === 'planning') closeSubmit()
                  else if ('request' in press) openSubmit(press.request)
                }}
              >
                <SubmitLabel
                  docId={docId}
                  nodeId={node.id}
                  state={submitting}
                  count={toSubmit}
                />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** How long a row that arrived stays tinted: long enough to catch the eye, gone by the next. */
const ARRIVED_MS = 1600

const NONE_ARRIVED: ReadonlySet<string> = new Set()

/** A row's identity across updates, and React's key: its tip, and per candidate the candidate. */
function rowKeyOf(row: TreeRow, mode: QueueMode): string {
  const candidate = mode === 'candidate' ? (row.candidate?.candidateId ?? '') : ''
  return `${tipKey(row.tip.neuronId, row.tip.endUid)}:${candidate}`
}

/** What a row shows the reader: the row, and the piece it leads with — none until it is scored. */
function rowShowsOf(row: TreeRow, mode: QueueMode): string {
  return `${rowKeyOf(row, mode)}#${(row.hosted ?? row.candidate)?.candidateId ?? ''}`
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

/**
 * How many steps in a row is drawn at most. A chain of pieces can be any length, and a row
 * indented once per piece would end up with no room for the piece's id; past this the rows
 * stay in tree order and stop moving right.
 */
const MAX_INDENT = 6

/** A tip as a row names it: its number, and the piece it is on where that is not the neuron. */
/**
 * The Neuroglancer cards wired directly from `nodeId` that hold double-clicks of their own — what
 * Start over clears with the card's work, so a viewer with nothing to clear is not written.
 */
/**
 * Whether every Neuroglancer card wired from `nodeId` shows a viewer other than Coda's own — one
 * that tells the card nothing (`framesOwnCopy`). False where none is wired: the card's own viewer
 * is Coda's. A boolean, so the store selector reading it allocates nothing (invariant 7).
 */
function onlyForeignViewers(graph: CodaGraph, nodeId: string): boolean {
  const wired = graph.nodes.filter(
    (one) =>
      one.type === NEUROGLANCER_TYPE &&
      graph.edges.some((edge) => edge.source === nodeId && edge.target === one.id),
  )
  return wired.length > 0 && !wired.some((one) => framesOwnCopy(one.params))
}

function viewersWithEdits(graph: CodaGraph, nodeId: string): string[] {
  return graph.nodes
    .filter(
      (one) =>
        one.type === NEUROGLANCER_TYPE &&
        Array.isArray(one.params['selectionEdits']) &&
        one.params['selectionEdits'].length > 0 &&
        graph.edges.some((edge) => edge.source === nodeId && edge.target === one.id),
    )
    .map((one) => one.id)
}

function tipName(tip: QueueTip): string {
  return tip.neuronId !== tip.seed
    ? `tip ${tip.endUid} of piece ${tip.neuronId}`
    : `tip ${tip.endUid}`
}

const FOREIGN_VIEWER_NOTE =
  'The Neuroglancer card wired to this one shows a viewer other than Coda’s own, which cannot ' +
  'tell the card what is under the pointer or which keys were pressed in it. So J, K and F, the ' +
  'rows lighting up as you hover, and following a multicut by itself are off. Reviewing and ' +
  'Submit work as usual, and an edit made there is found on the next row you click: press its ' +
  'outdated tag. Set Viewer type to the embedded viewer on the Neuroglancer card to have them back.'

const SUBMIT_HELP =
  'Merge the accepted pieces of this neuron into it. Everything is checked and listed, with the ' +
  'neuron as the merges will make it, before anything is sent.'

/** The button's text while this card's Submit is under way; otherwise it is the count. */
const SUBMIT_LABEL: Partial<Record<SubmitState, string>> = {
  planning: 'Checking… (cancel)',
  open: 'Submit open',
  running: 'Merging…',
}

/**
 * The button's text: the pieces to submit, or how far a Submit has got — with the pieces checked
 * so far once the check reaches them. Its own component, so a count re-renders the label rather
 * than the card.
 */
function SubmitLabel(props: {
  docId: string
  nodeId: string
  state: SubmitState
  count: number
}) {
  const checked = useSubmitChecked(props.docId, props.nodeId)
  // Only while this card's check runs: the state is `planning` whenever there is one.
  if (checked) {
    return `Checking ${formatNumber(checked.done)} of ${formatNumber(checked.total)}… (cancel)`
  }
  return SUBMIT_LABEL[props.state] ?? `Submit (${formatNumber(props.count)})`
}

/**
 * What pressing Submit would do: open a session with this request, or nothing, for the reason
 * given. This card's own Submit first — it is what the button is showing — then in the order a
 * reader would fix them, and another card's Submit last. One function, so the button's reason and
 * the request it sends cannot disagree.
 */
export function submitPress(at: {
  docId: string
  nodeId: string
  sourceId: string | undefined
  datasetId: string | undefined
  /** Whether a token is held for the dataset's deployment (`getToken`, followed). */
  signedIn: boolean
  queue: readonly QueueTip[]
  neuron: string | undefined
  absorbed: boolean
  /** The query neuron edited since its suggestions were made (`rootCurrency`). */
  neuronEdited: boolean
  /** Pieces accepted on this neuron, and of those the ones not yet merged. */
  accepted: number
  count: number
  submitting: SubmitState
}): { blocked: string } | { request: SubmitRequest } {
  const blocked = (reason: string) => ({ blocked: reason })
  if (at.submitting === 'planning' || at.submitting === 'open') {
    return blocked('Submit is open.')
  }
  if (at.submitting === 'running') return blocked('Merges are being sent.')
  if (at.submitting === 'waiting') return blocked(STILL_OUT_NOTICE)
  if (!at.sourceId || !at.datasetId) {
    return blocked('Wire a CAVE Dataset into `Dataset` to submit merges.')
  }
  // The scope the record is read for, so the card's count and Submit's plan read the same one.
  const target = caveScopeOf({ sourceId: at.sourceId, datasetId: at.datasetId })
  if (!target) return blocked('Only a CAVE dataset’s segmentation can be merged into.')
  if (!at.signedIn) {
    return blocked(
      `Sign in to ${caveServerLabel(target.deployment)} (Sources) to submit merges.`,
    )
  }
  /*
   * **Not held while the search is still running** (user, 2026-11-18). The plan reads only what
   * is accepted, so a tip still to arrive cannot change what one Submit sends — a piece accepted
   * later goes in the next. And the search cannot be thrown by a merge it did not see: every
   * neuron is read at its own moment, fixed before the run reads anything (`Searched at`).
   */
  if (at.absorbed) {
    return blocked(
      'This neuron has been merged into another one under review. Submit from that one.',
    )
  }
  if (at.neuronEdited) {
    return blocked(
      'The query neuron has been edited since these suggestions were generated. Run them ' +
        'again on its new root.',
    )
  }
  if (at.accepted === 0 || at.neuron === undefined)
    return blocked('Accept a piece to submit it.')
  if (at.count === 0) return blocked('Every accepted piece is merged.')
  if (at.submitting === 'other')
    return blocked('Another card’s Submit is open. Close it first.')
  return {
    request: {
      docId: at.docId,
      nodeId: at.nodeId,
      deployment: target.deployment,
      datastack: target.datastack,
      sourceId: at.sourceId,
      datasetId: at.datasetId,
      queue: at.queue,
      reviewedRoot: at.neuron,
    },
  }
}

/**
 * The confidence's ink: one hue for what SEAM shows, another for what it does not.
 *
 * Two values rather than a ramp, because the number beside it already says how much — a ramp
 * would be the same quantity twice. What the colour adds is the one thing the number cannot: on
 * which side of a calibrated cutoff this sits.
 */
function scoreInk(row: QueueRow): string {
  return cycleColor(row.shown ? 1 : 0, 'dark')
}

/** A filter field as a number, or undefined for "no limit". Empty is a decision, not a zero. */
function numberOr(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** One of the foot's small buttons for following the neuron through an edit. */
function FollowButton({
  disabled,
  onClick,
  title,
  children,
}: {
  disabled: boolean
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="review-body__follow"
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}
