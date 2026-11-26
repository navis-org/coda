/**
 * Proofread Merges: work through SEAM's merge candidates, one tip at a time.
 *
 * ## A tap, and the writing is the card's
 *
 * `annotation:editor`'s shape. The tips pass through unchanged so the node can sit mid-chain,
 * and every verdict is written by a gesture on the card rather than from `evaluate` — a write
 * reached from `evaluate` would be made again by auto-run on every edit anywhere upstream.
 *
 * ## Which params are in the key, and why that is not the usual answer
 *
 * `Current tip`, `Candidate` and `Verdicts` are **data**: they change what this node publishes,
 * so a presentational one would serve a stale answer (invariant 4). That is affordable here and
 * is not elsewhere — the node fetches nothing and copies a few hundred rows, so a click re-runs
 * it in about a millisecond, and the Neuroglancer card downstream patches its frame in place.
 * `seam:loadMergeCandidates` is the expensive half and nothing here re-runs it.
 *
 * The filters and the sort are **presentational**: they narrow what the card lists and change no
 * output at all. A reader hunting for the right threshold should not be re-keying anything.
 *
 * ## A neuron is extended from here, and searched somewhere else
 *
 * `docs/seam-extend-plan.md`. Which accepted pieces are to be extended is a param, `extend`, and
 * it leaves by `Extended` — a table of `parent`/`piece` pairs that Find Merge Candidates reads through a
 * **reference** wire. A reference to this node is answered from its params (`asReference`), so
 * the search knows what to extend before this node has run, and the wire closes no loop: this
 * node still takes its tips from that one. The card's Extend button writes the param and runs
 * the search; `evaluate` starts nothing.
 *
 * ## Nothing here writes to a chunkedgraph
 *
 * A verdict is a note in the workflow. The merges are made by the card's Submit, through
 * `mergeBatch.ts`, which this module does not import (`importGraph.test.ts`). What this node
 * reads of them is the record the batch keeps in `merges` (`mergeRecord.ts`): the `Merges` table,
 * and the neuron's root now for `Current`.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { packNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { CellValue, LayersValue, TableValue } from '../../core/values'
import { isDatasetValue, isTableValue, layersFrom, makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'
import { KEPT_NEURONS } from './reviewEviction'
import { decodeRecord, mergedSoFar, mergesSchema, mergesTable } from './mergeRecord'
import { caveScopeOf } from '../../nodes/lib/caveParams'
import {
  EXTENDED_PORT,
  LARGE_PIECE_CHUNKS,
  extendedSchema,
  extendedTable,
  verdictKey,
} from './pieces'
import { cutOffTips } from './followEdit'
import { decodePicks, withLivePicks, withoutTips } from './handPicks'
import { suggestionLayer } from './scene'
import type { CurrentItem, QueueTip, ScenePiece, Verdict } from './reviewQueue'
import {
  buildQueue,
  currentOfQueue,
  decodeVerdicts,
  extendPlanFrom,
  liveQueue,
  pickedNeuron,
  reviewStateOf,
  scenePieces,
  tipKey,
  tipsOf,
  verdictFor,
} from './reviewQueue'

/** The column the verdicts are folded onto the tips under. */
const VERDICT_COLUMN = 'verdict'

/** The verdict table's own columns. */
export function verdictsSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('candidateId', 'str'),
    column('rank', 'i64'),
    column(VERDICT_COLUMN, 'str'),
    // Picked in neuroglancer by the reader (`handPicks.ts`), not suggested: SEAM missed it.
    column('by_hand', 'bool'),
  )
}

/**
 * The pair being looked at, and where to look.
 *
 * Shaped for `out.neuroglancer`'s `Control` port: ids to show, `part` to colour them apart, and
 * the contact in nanometres on **every** row, since the camera reads the first and a reader
 * sorting or filtering this table should not be able to change where it points.
 */
export function currentSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('part', 'str'),
    column('x', 'f64', 'nm'),
    column('y', 'f64', 'nm'),
    column('z', 'f64', 'nm'),
  )
}

/** The tips, with the reader's verdict on each one's **shown** candidate folded on. */
export function reviewedSchema(tips: TableSchema | undefined): TableSchema {
  return foldColumns(tips ?? tableSchema(), [column(VERDICT_COLUMN, 'str')])
}

export const reviewNode = packNode({
  type: 'seam:proofreadMerges',
  formerTypes: ['seam:review'],
  label: 'Proofread Merges',
  category: 'utility',
  cardWidth: 560,
  description:
    'Works through SEAM’s merge suggestions for one neuron, one tip at a time, showing each tip’s candidate in neuroglancer and recording whether it belongs.',
  guide:
    'A queue of merge suggestions for one neuron, picked at the top of the card. Each row is a ' +
    'tip and one of its candidates; clicking a row shows that candidate beside its neuron. ' +
    'Give each a verdict, and page through a tip’s other candidates with the arrows. ' +
    'The verdicts are saved with the workflow. Submit checks the accepted pieces and, once you ' +
    'confirm, merges them into the neuron.',
  cost: 'cheap',

  inputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    { id: 'candidates', label: 'Candidates', type: T.table() },
    // For the card's own viewer: a scene needs a dataset to be a scene.
    { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false },
    { id: 'layers', label: 'Layers', type: T.layers(), required: false },
  ],
  outputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    { id: 'verdicts', label: 'Verdicts', type: T.table() },
    /*
     * The pair being looked at, for `out.neuroglancer`'s `Control` port: the two ids, which is
     * which, and where they touch. One wire, and the big viewer follows the card.
     */
    { id: 'current', label: 'Current', type: T.neurons() },
    { id: 'layers', label: 'Layers', type: T.layers() },
    // Every merge Submit has made or tried from this card, one row each.
    { id: 'merges', label: 'Merges', type: T.table() },
    /*
     * The accepted pieces to extend, as `parent`/`piece` pairs. Made for Find Merge Candidates' `Review`
     * port, which reads it by reference — from the params, through `asReference` below.
     */
    { id: EXTENDED_PORT, label: 'Extended', type: T.table() },
  ],
  params: [
    /*
     * One neuron at a time, set by the dropdown at the top of the card — which the card draws
     * itself, because the choices are root ids in the rows of `Tips` and an enum's options can
     * only be asked of a schema. Hence `advanced` and `internal`, like the cursor below.
     *
     * **Data, not presentational**, because it narrows `Layers`: the annotation layer is the map
     * of the work on *this* neuron, and points on the others would be a second neuron in the
     * viewer. `Tips` and `Verdicts` stay whole, so switching neuron loses no verdict downstream.
     */
    {
      id: 'neuron',
      advanced: true,
      kind: 'string',
      label: 'Neuron',
      default: '',
      internal: true,
      help: 'The root ID being reviewed. Empty, or an ID no longer in `Tips`, means the first neuron in `Tips`. Set by the dropdown at the top of the card.',
    },
    /*
     * The cursor, the candidate and the verdicts are **`advanced` and `internal`**, which are
     * not the same flag and both apply. `advanced` keeps them off the card, where the body sets
     * them by gesture and a text field saying `11` would be a control nobody can use.
     * `internal` keeps them out of the card's "n changed" count, which would otherwise report a
     * parameter changed every time somebody clicked a row. They stay real params — saved,
     * undoable, in the provenance key, and reachable in the inspector when something has to be
     * read or cleared by hand.
     */
    {
      id: 'current',
      advanced: true,
      kind: 'string',
      label: 'Current tip',
      default: '',
      internal: true,
      help: 'The tip being reviewed, as `root|end_uid` — the root the tip is on, since a neuron and each piece it was extended with number their tips from the same start. Set by clicking a row.',
    },
    {
      id: 'rank',
      advanced: true,
      kind: 'int',
      label: 'Candidate',
      default: 1,
      min: 1,
      internal: true,
      help: 'Which of the current tip’s candidates is shown — 1 is the suggestion. Set by the arrows.',
    },
    {
      id: 'verdicts',
      advanced: true,
      kind: 'string',
      label: 'Verdicts',
      default: '',
      internal: true,
      help: 'The verdicts recorded so far, saved with the workflow.',
    },
    /*
     * Which accepted pieces are extended: verdict keys, `parent/piece`. Written by the card's
     * Extend button, read with the verdicts by `extendedKeys` — a pair counts only while its
     * verdict is `accept`. **Data** (it decides which rows there are to review, and what
     * `Extended` says) and an ordinary undo step.
     */
    {
      id: 'extend',
      advanced: true,
      kind: 'string',
      label: 'Extended pieces',
      default: '',
      internal: true,
      help: 'The accepted pieces whose own open ends are searched, as `parent/piece` pairs. Set by the Extend button on an accepted row.',
    },
    /*
     * What Submit did (`mergeRecord.ts`). Written only by the batch, never by `evaluate` or a
     * gesture. **Unrecorded**, so no Ctrl+Z can erase the note of a merge the server still holds;
     * **data**, since `Merges` and `Current` read it.
     */
    {
      id: 'merges',
      advanced: true,
      kind: 'string',
      label: 'Merge record',
      default: '',
      internal: true,
      unrecorded: true,
      help: 'Every merge Submit has made or tried from this card, saved with the workflow. Written only by Submit, and not an undo step: undoing cannot erase a merge the server still holds.',
    },
    /*
     * The candidates the reader picked in neuroglancer (`handPicks.ts`), each accepted as it was
     * added. **Data**: they are rows of the queue, so of `Verdicts`, `Current` and the merges.
     * Written by the pick key and the card's Add button only, with the accept, in one edit.
     */
    {
      id: 'picks',
      advanced: true,
      kind: 'string',
      label: 'Hand picks',
      default: '',
      internal: true,
      help: 'The candidates you added from neuroglancer, with where each meets the neuron. Set by pressing J with the pointer on a segment, or by Add from viewer.',
    },
    /*
     * **Data, not presentational**: it adds rows to `Current`, which is what the Neuroglancer
     * node draws. On by default — until something is accepted it adds nothing but the neuron.
     */
    {
      id: 'showAccepted',
      kind: 'boolean',
      label: 'Show accepted',
      default: true,
      help: 'Also show every candidate you accepted on this neuron in the viewer, in green, wherever the cursor is — the neuron as it will look once you make the merges. With no row selected, the neuron and its accepted pieces are shown and the camera stays where it is.',
    },
    /*
     * The pieces Auto-extend was pressed on: verdict keys, `parent/piece`, each also in `extend`
     * (`extendParams`). **Data**: it is what the search is told to grow, and what the card counts
     * as accepted follows from it (`docs/seam-auto-extend-plan.md`).
     */
    {
      id: 'autoRoots',
      advanced: true,
      kind: 'string',
      label: 'Auto-extended pieces',
      default: '',
      internal: true,
      help: 'The pieces Auto-extend was chosen on, as `parent/piece` pairs. Set by the menu of the Extend button on an accepted row.',
    },
    /*
     * The pairs Auto-extend could take that the reader turned down, written by the press
     * (`judgedParams`). **Data**: the search is told them while an Auto-extend is live, and a
     * reject of anything else is in no key (`planTexts`).
     */
    {
      id: 'autoRefused',
      advanced: true,
      kind: 'string',
      label: 'Turned down for Auto-extend',
      default: '',
      internal: true,
      help: 'Pairs, as `parent/piece`, that Auto-extend could accept and you gave another verdict, so it does not take them. Set by the verdict buttons.',
    },
    /*
     * The neurons last worked on, oldest first (`reviewEviction.ts`): the card keeps the full
     * work of these and no others. **Presentational**: `evaluate` never reads it; what it decides
     * is written into the params that are data, in the same edit.
     */
    {
      id: 'recent',
      advanced: true,
      kind: 'string',
      label: 'Recent neurons',
      default: '',
      internal: true,
      presentational: true,
      help: `The neurons you last gave a verdict or extended a piece on, oldest first. The card keeps its work for the last ${KEPT_NEURONS}; an older neuron's verdicts and extended pieces are cleared as you start on another. Undo brings them back.`,
    },
    /*
     * **Presentational**: `evaluate` never reads it. It changes what a press on Accept writes,
     * and what is written — `extend` — is the data. Off by default: the search is started by
     * hand unless the reader asks otherwise (user, 2026-11-16). Called `Auto-extend` until that
     * name went to the menu item that accepts and extends on its own (user, 2026-11-18).
     */
    {
      id: 'extendOnAccept',
      formerId: 'autoExtend',
      kind: 'boolean',
      label: 'Extend on accept',
      default: false,
      presentational: true,
      help: `Extend each piece as you accept it, without pressing Extend: its own open ends are searched and listed beneath it. A large piece — ${LARGE_PIECE_CHUNKS} level-2 chunks or more — is left to its Extend button, since searching one can take minutes. Switching this on starts nothing: pieces accepted earlier keep their Extend button.`,
    },
    /*
     * The reader's floor for Auto-extend (user, 2026-11-19): a first candidate is taken only where
     * SEAM's cutoff passes it **and** its `q` is at least this, so it can only raise the bar. Text,
     * as `Min confidence` is, so empty means the default — SEAM's cutoff alone. **Data**: it goes
     * to the search in `Extended` (`ExtendPlan.autoMinQ`), but only while an Auto-extend is live,
     * so setting it with none pressed re-runs nothing.
     */
    {
      id: 'autoMinQ',
      kind: 'string',
      label: 'Auto-extend min q',
      default: '',
      placeholder: 'SEAM’s cutoff',
      help: 'The least `q` Auto-extend accepts a candidate at. Empty is SEAM’s own cutoff (0.159 for the runs Find Merge Candidates makes, 0.118 for SEAM’s published sets); a higher number makes Auto-extend take fewer, surer pieces. A number below the cutoff changes nothing, since the cutoff still applies. Changing it while an Auto-extend is running grows the tree again by the new rule; pieces it no longer takes are no longer accepted.',
    },
    {
      id: 'minConfidence',
      kind: 'string',
      label: 'Min confidence',
      default: '',
      presentational: true,
      placeholder: '(any)',
      help: 'List only rows whose number is at least this: per tip SEAM’s `q` for the first candidate, the score its cutoff is a value of (0.159 single seed, 0.118 production); per candidate that candidate’s `conf`. A reading aid: it changes nothing this node publishes.',
    },
    {
      /*
       * **A new id rather than `formerId` on the old one**, which is the opposite of the usual
       * rule and for the usual rule's reason. `formerId` exists so a rename keeps a reader's
       * saved value; here the value's *units* changed — `Min size` was µm³ inside the search
       * box and is now the candidate's level-2 chunk count — so carrying `0.25` across would
       * turn "a quarter of a cubic micrometre" into "a quarter of a chunk", which filters
       * nothing and says nothing about having changed. Dropped, it returns to its default.
       */
      id: 'minSize',
      kind: 'string',
      label: 'Min size',
      default: '',
      presentational: true,
      placeholder: '(any)',
      help: 'List only tips whose first candidate is at least this big. Size is the candidate’s **level-2 chunk count** — the chunkedgraph’s own decomposition of the whole object, wherever it reaches — which is the best proxy there is for whether a piece is a fragment or part of a neuron. It is coarse: anything small is one chunk, and the number only separates pieces further up. Where the candidates carry no chunk count (`n_l2`; published sets before rv4), this falls back to µm³ of the candidate *inside the search box*; every row says which of the two it is showing.',
    },
    /*
     * `shownOnly` ("Only SEAM's shown set") was removed (user, 2026-11-18). Per tip `shown` is `q`
     * at or above the set's cutoff, and the list now leads with `q`, so `Min confidence` at the
     * cutoff is the same list. A saved value is an undeclared param, which nothing reads.
     */
    {
      /*
       * **On by default, and a reading aid like the filters above**: it changes nothing this node
       * publishes. SEAM's flag (`organelle`, `searchTips.ts`) is a piece wrapped inside one cell —
       * a mitochondrion, a vesicle — which is never a neurite's continuation; about one flagged
       * piece in a hundred is not one, which is why it is a choice and the card counts what it
       * left out. `absentMeans`, so a graph saved before it reads as on, as a new one does.
       */
      id: 'excludeOrganelles',
      kind: 'boolean',
      label: 'Exclude organelles',
      default: true,
      absentMeans: true,
      presentational: true,
      help: 'Leave out candidates the search flags as organelles — mitochondria, vesicles and other pieces wrapped inside one cell, which are never a neurite’s continuation. Per candidate, those candidates are not listed. Per tip, a tip whose first candidate is one stays listed but leads with its next candidate, marked “first was an organelle”, with no `q` or `r` and never counted as shown: SEAM’s numbers all describe the first candidate, and the next one has only its own `conf`. An organelle further down a tip’s list changes nothing. The flag is SEAM’s: about one flagged piece in a hundred is not an organelle, so the card counts what the filter did, and switching it off lists everything as it was. A set that carries no flag is unchanged.',
    },
    {
      /*
       * The grain of a row. `tip` is the default because it is the unit SEAM calibrated: the
       * cutoff, `p_tip` and `r` were all fitted on *first* candidates, so a row there is a
       * suggestion somebody made. `candidate` is the same data one level down, which is how a
       * reader works when the first is clearly wrong and something further down is clearly
       * right — and nothing at that grain is calibrated, which the card says.
       */
      id: 'mode',
      kind: 'enum',
      label: 'One row per',
      default: 'tip',
      presentational: true,
      options: [
        { value: 'tip', label: 'tip' },
        { value: 'candidate', label: 'candidate' },
      ],
      help: 'Whether a row is a tip with its suggestion, or every candidate of every tip. Per tip the number is SEAM’s `q` for the first candidate, with `r` beneath it as a rounded estimate of how often such a first is right; per candidate it is that candidate’s own confidence, which is not calibrated.',
    },
    {
      id: 'sortBy',
      kind: 'enum',
      label: 'Sort by',
      default: 'confidence',
      presentational: true,
      options: [
        { value: 'confidence', label: 'confidence' },
        { value: 'size', label: 'size' },
        { value: 'tip', label: 'tip order' },
      ],
    },
    {
      id: 'layerName',
      kind: 'string',
      label: 'Layer name',
      default: '',
      advanced: true,
      placeholder: 'merge suggestions',
      help: 'The annotation layer’s name in neuroglancer. The layer holds every shown suggestion, so it stays put while you work through them.',
    },
  ],

  inferOutputs: (ctx) => ({
    tips: T.table(reviewedSchema(ctx.schema('tips'))),
    verdicts: T.table(verdictsSchema()),
    current: T.neurons(currentSchema()),
    layers: T.layers(),
    merges: T.table(mergesSchema()),
    [EXTENDED_PORT]: T.table(extendedSchema()),
  }),

  /*
   * What a reference wire from `Extended` is handed, and keyed on: the pairs, from the params
   * alone. One function with `evaluate`'s own answer for that output, so the search and anything
   * wired to the output by an ordinary wire read the same table.
   */
  asReference: (params, output) =>
    output === EXTENDED_PORT
      ? extendedTable(extendPlanFrom(params, decodeVerdicts(params['verdicts'])))
      : undefined,

  validate: (ctx) => {
    const issues: string[] = []
    for (const [id, what] of [
      ['minConfidence', '`Min confidence` is a chance, so it is between 0 and 1'],
      /*
       * **No unit in the sentence**, because the unit is the table's and not this param's.
       * Where the candidates carry `n_l2` the size is a count of level-2 chunks; where they do
       * not (a published set from before rv4) it is `vol_um3`, a volume. Naming either
       * here is a sentence that is wrong half the time, and the check does not need it — what
       * is being refused is a negative size, which is impossible in both units.
       */
      ['minSize', '`Min size` is a size, so it is not negative'],
      ['autoMinQ', '`Auto-extend min q` is a chance, so it is between 0 and 1'],
    ] as const) {
      const text = String(ctx.params[id]).trim()
      if (!text) continue
      const value = Number(text)
      const ok = id === 'minSize' ? value >= 0 : value >= 0 && value <= 1
      if (!Number.isFinite(value) || !ok) issues.push(`${what} — not “${text}”.`)
    }
    return issues
  },

  evaluate: (ctx) => {
    const tips = ctx.input('tips')
    if (!isTableValue(tips)) {
      throw new Error(
        'Nothing is wired into `Tips`. Wire in the Load Merge Candidates node’s Tips.',
      )
    }
    const candidates = ctx.input('candidates')
    if (!isTableValue(candidates)) {
      throw new Error(
        'Nothing is wired into `Candidates`. The candidate lists are what the arrows page ' +
          'through, so the node needs both of Load Merge Candidates’ tables.',
      )
    }
    const built = buildQueue(tips, candidates)
    // What there is to review: each neuron's tips and those of the pieces in its tree — as the
    // params say the tree is now, whatever rows the search has yet to drop — with what
    // Auto-extend took grown on, by the rule the search grew it by. Its accepts count wherever an
    // accept is read, and are never a reader's verdict: `Tips` and `Verdicts` carry `stored`.
    // The hand picks go on last (`withPicks`), so one on a piece accepted and never extended
    // keeps its own row: placed before, it was dropped with that piece's tips.
    const { stored, plan, growth, verdicts } = reviewStateOf(ctx.params, built)
    const record = decodeRecord(ctx.params.merges)
    // Read for the wired dataset's chunkedgraph only, as the card and the plan read it.
    const dataset = ctx.input('dataset')
    const scope = caveScopeOf(isDatasetValue(dataset) ? dataset : undefined)
    // Less the tips that went with a part the neuron was split from (`cutOffTips`).
    const live = withLivePicks(
      liveQueue(built, growth.tree),
      decodePicks(ctx.params.picks),
      verdicts,
      growth.tree,
    )
    const queue = withoutTips(live, cutOffTips(live, record, scope, verdicts))
    // The cursor resolves within the picked neuron only, so a cursor left on another neuron's
    // tip — after the fallback to the first, or a hand edit — shows nothing rather than a pair
    // from a neuron the card is not on.
    const neuron = pickedNeuron(queue, String(ctx.params.neuron))
    const mine = tipsOf(queue, neuron)
    const here = currentOfQueue(mine, String(ctx.params.current), Number(ctx.params.rank))
    const pieces = scenePieces(
      mine,
      neuron,
      here,
      verdicts,
      ctx.params.showAccepted === true,
      neuron === undefined ? undefined : mergedSoFar(record, neuron, scope),
    )

    /*
     * **The whole shown set, not the current item**, and that is a correctness decision rather
     * than a generosity.
     *
     * An annotation layer's contents are not part of a scene's *selection*, so a layer that
     * changed on every click would make every click a full navigation of the Neuroglancer card
     * — every layer torn down, every mesh refetched, and the camera reset to whatever framing
     * the dataset publishes, which for Aedes is none. Which item is current travels on
     * `Current` instead, where it is a selection and costs nothing.
     *
     * So this layer is a map of where the work is on the picked neuron, stable while a reader
     * moves through it. Switching neuron does change it, and that one navigation is wanted.
     */
    const name = String(ctx.params.layerName).trim() || 'merge suggestions'
    const layer = suggestionLayer(
      mine.flatMap((tip) => {
        const first = tip.candidates[0]
        // No contact, no point to draw: a row without one is left off the map, not put at 0,0,0.
        const contactNm = first?.contactNm
        if (!tip.shown || !first || !contactNm) return []
        return [
          {
            neuronId: tip.neuronId,
            endUid: tip.endUid,
            tipNm: tip.tipNm,
            contactNm,
            candidateId: first.candidateId,
            q: tip.q,
            r: tip.r,
          },
        ]
      }),
      name,
    )

    return {
      // Every row that came in passes through, a hidden piece's among them — but a verdict is
      // folded on only where it is read: on a row that is listed, as `Verdicts` has it.
      tips: withVerdicts(tips, queue, stored),
      verdicts: verdictsTable(queue, stored),
      current: currentPieces(pieces, here),
      layers: {
        kind: 'layers',
        items: [...layersFrom(ctx.input('layers')), layer.layer],
      } satisfies LayersValue,
      merges: mergesTable(record),
      // The same table a reference is handed (`asReference`), from the same plan.
      [EXTENDED_PORT]: extendedTable(plan),
    }
  },
})

/**
 * What the viewer should show, as a neuron table: the pair being looked at, then every accepted
 * piece where `Show accepted` is on.
 *
 * `part` says which is which, so a downstream Neuroglancer node can colour them apart — the
 * neuron in one hue, the piece proposed for it in another, and the pieces already accepted in a
 * third.
 *
 * **`x`/`y`/`z` are where to look, not where each row is**: the cursor's contact, on every row,
 * so sorting or filtering this table cannot move the camera. With no cursor they are null and the
 * camera stays where it is.
 */
function currentPieces(
  pieces: readonly ScenePiece[],
  here: CurrentItem | undefined,
): TableValue {
  // The contact, not the tip: a merge is judged at the place the two pieces touch, which can be
  // a micrometre or two from where the neuron stops.
  const at = here?.candidate.contactNm
  return makeTable(
    currentSchema(),
    {
      [ID_COLUMN_NAME]: pieces.map((piece) => piece.id),
      part: pieces.map((piece) => piece.part),
      x: pieces.map(() => at?.[0] ?? null),
      y: pieces.map(() => at?.[1] ?? null),
      z: pieces.map(() => at?.[2] ?? null),
    },
    'neurons',
  )
}

/** The tips, with each one's verdict on its **first** candidate folded on. */
function withVerdicts(
  tips: TableValue,
  queue: readonly QueueTip[],
  verdicts: ReadonlyMap<string, Verdict>,
): TableValue {
  // By `tipKey`: two runs stacked into one table share tip numbers.
  const byTip = new Map(queue.map((tip) => [tipKey(tip.neuronId, tip.endUid), tip]))
  const cells: CellValue[] = []
  const ends = tips.data['end_uid'] ?? []
  const neurons = tips.data[ID_COLUMN_NAME] ?? []
  for (let i = 0; i < tips.length; i++) {
    const end = ends[i]
    const tip = typeof end === 'number' ? byTip.get(tipKey(String(neurons[i]), end)) : undefined
    const first = tip?.candidates[0]
    cells.push(
      tip && first ? (verdictFor(verdicts, tip.neuronId, first.candidateId) ?? null) : null,
    )
  }
  return makeTable(
    reviewedSchema(tips.schema),
    { ...tips.data, [VERDICT_COLUMN]: cells },
    tips.kind,
  )
}

/**
 * Every verdict, one row each — **including** those on a candidate other than the first.
 *
 * The folded column on `Tips` can only answer about first candidates, since a tip is one row.
 * A reader who paged to rank 4 and said "this one" has made a judgement worth keeping, and this
 * is where it survives. A verdict is about a piece and a neuron (`verdictKey`), so a piece listed
 * at three tips is one row, not three: at the tip, and rank, where the queue first lists it.
 */
function verdictsTable(
  queue: readonly QueueTip[],
  verdicts: ReadonlyMap<string, Verdict>,
): TableValue {
  const ids: CellValue[] = []
  const ends: CellValue[] = []
  const candidateIds: CellValue[] = []
  const ranks: CellValue[] = []
  const said: CellValue[] = []
  const byHand: CellValue[] = []
  const listed = new Set<string>()
  for (const tip of queue) {
    for (const candidate of tip.candidates) {
      const verdict = verdictFor(verdicts, tip.neuronId, candidate.candidateId)
      const key = verdictKey(tip.neuronId, candidate.candidateId)
      if (!verdict || listed.has(key)) continue
      listed.add(key)
      ids.push(tip.neuronId)
      ends.push(tip.endUid)
      candidateIds.push(candidate.candidateId)
      ranks.push(candidate.rank)
      said.push(verdict)
      byHand.push(candidate.hand === true)
    }
  }
  return makeTable(verdictsSchema(), {
    [ID_COLUMN_NAME]: ids,
    end_uid: ends,
    candidateId: candidateIds,
    rank: ranks,
    [VERDICT_COLUMN]: said,
    by_hand: byHand,
  })
}
