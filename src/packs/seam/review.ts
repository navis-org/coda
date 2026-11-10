/**
 * Review Suggestions: work through SEAM's merge candidates, one tip at a time.
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
 * `seam:suggestions` is the expensive half and nothing here re-runs it.
 *
 * The filters and the sort are **presentational**: they narrow what the card lists and change no
 * output at all. A reader hunting for the right threshold should not be re-keying anything.
 *
 * ## Read-only
 *
 * Nothing here writes to a chunkedgraph. A verdict is a note in the workflow; the merge is the
 * proofreader's own, made with their own token in the viewer.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { packNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { CellValue, LayersValue, TableValue } from '../../core/values'
import { isTableValue, layersFrom, makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'
import { suggestionLayer } from './scene'
import type { CurrentItem, QueueTip, Verdict } from './reviewQueue'
import { buildQueue, currentOfQueue, decodeVerdicts, verdictFor } from './reviewQueue'

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
  )
}

/**
 * The pair being looked at, and where to look.
 *
 * Shaped for `out.neuroglancer`'s `Control` port: ids to show, `part` to colour them apart, and
 * the contact in nanometres on **both** rows, since the camera reads the first and a reader
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
  type: 'seam:review',
  label: 'Review Suggestions',
  category: 'utility',
  cardWidth: 560,
  description:
    'Works through SEAM’s merge suggestions one tip at a time, showing each tip’s candidate in neuroglancer and recording whether it belongs.',
  guide:
    'A queue of merge suggestions. Each row is a tip and one of its candidates; clicking a row ' +
    'shows that candidate beside its neuron and points the camera at where they touch. Accept, ' +
    'reject or mark unsure, and page through a tip’s other candidates with the arrows. The ' +
    'verdicts are saved with the workflow and come out as a table. Nothing is written to the ' +
    'segmentation — the merge is yours to make.',
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
  ],
  params: [
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
      help: 'The tip being reviewed, by its `end_uid`. Set by clicking a row.',
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
    {
      id: 'minConfidence',
      kind: 'string',
      label: 'Min confidence',
      default: '',
      presentational: true,
      placeholder: '(any)',
      help: 'List only tips whose `r` — the chance their first candidate is right — is at least this. A reading aid: it changes nothing this node publishes.',
    },
    {
      id: 'minVolume',
      kind: 'string',
      label: 'Min size',
      default: '',
      presentational: true,
      placeholder: '(any)',
      help: 'List only tips whose first candidate is at least this many µm³. Small pieces are often fragments rather than continuations.',
    },
    {
      id: 'shownOnly',
      kind: 'boolean',
      label: 'Only SEAM’s shown set',
      default: false,
      presentational: true,
      help: 'List only the tips SEAM itself shows — the ones clearing its calibrated cutoff. Off lists everything, ordered by confidence, which is where most of the real merges are.',
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
      help: 'Whether a row is a tip with its suggestion, or every candidate of every tip. Per tip the number is `r`, the calibrated chance the first candidate is right; per candidate it is that candidate’s own confidence, which is not calibrated.',
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
  }),

  validate: (ctx) => {
    const issues: string[] = []
    for (const [id, what] of [
      ['minConfidence', '`Min confidence` is a chance, so it is between 0 and 1'],
      ['minVolume', '`Min size` is a volume in µm³, so it is not negative'],
    ] as const) {
      const text = String(ctx.params[id]).trim()
      if (!text) continue
      const value = Number(text)
      const ok = id === 'minConfidence' ? value >= 0 && value <= 1 : value >= 0
      if (!Number.isFinite(value) || !ok) issues.push(`${what} — not “${text}”.`)
    }
    return issues
  },

  evaluate: (ctx) => {
    const tips = ctx.input('tips')
    if (!isTableValue(tips)) {
      throw new Error(
        'Nothing is wired into `Tips`. Wire in the Merge Suggestions node’s Tips.',
      )
    }
    const candidates = ctx.input('candidates')
    if (!isTableValue(candidates)) {
      throw new Error(
        'Nothing is wired into `Candidates`. The candidate lists are what the arrows page ' +
          'through, so the node needs both of Merge Suggestions’ tables.',
      )
    }
    const queue = buildQueue(tips, candidates)
    const verdicts = decodeVerdicts(ctx.params.verdicts)
    const here = currentOfQueue(queue, String(ctx.params.current), Number(ctx.params.rank))

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
     * So this layer is a map of where the work is, stable while a reader moves through it.
     */
    const name = String(ctx.params.layerName).trim() || 'merge suggestions'
    const layer = suggestionLayer(
      queue.flatMap((tip) => {
        const first = tip.candidates[0]
        if (!tip.shown || !first) return []
        return [
          {
            neuronId: tip.neuronId,
            endUid: tip.endUid,
            tipNm: tip.tipNm,
            contactNm: first.contactNm,
            candidateId: first.candidateId,
            r: tip.r ?? 0,
          },
        ]
      }),
      name,
    )

    return {
      tips: withVerdicts(tips, queue, verdicts),
      verdicts: verdictsTable(queue, verdicts),
      current: currentPair(here),
      layers: {
        kind: 'layers',
        items: [...layersFrom(ctx.input('layers')), layer.layer],
      } satisfies LayersValue,
    }
  },
})

/**
 * The pair being looked at, as a two-row neuron table.
 *
 * `part` says which is which, so a downstream Neuroglancer node can colour them apart — the
 * neuron in one hue and the piece proposed for it in another, which is the whole picture a
 * reader is judging.
 */
function currentPair(here: CurrentItem | undefined): TableValue {
  const ids: CellValue[] = []
  const part: CellValue[] = []
  const x: CellValue[] = []
  const y: CellValue[] = []
  const z: CellValue[] = []
  if (here) {
    ids.push(here.tip.neuronId, here.candidate.candidateId)
    part.push('neuron', 'candidate')
    // The contact, not the tip: a merge is judged at the place the two pieces touch, which can
    // be a micrometre or two from where the neuron stops.
    for (const _ of ids) {
      x.push(here.candidate.contactNm[0])
      y.push(here.candidate.contactNm[1])
      z.push(here.candidate.contactNm[2])
    }
  }
  return makeTable(currentSchema(), { [ID_COLUMN_NAME]: ids, part, x, y, z }, 'neurons')
}

/** The tips, with each one's verdict on its **first** candidate folded on. */
function withVerdicts(
  tips: TableValue,
  queue: readonly QueueTip[],
  verdicts: ReadonlyMap<string, Verdict>,
): TableValue {
  const byEnd = new Map(queue.map((tip) => [tip.endUid, tip]))
  const cells: CellValue[] = []
  const ends = tips.data['end_uid'] ?? []
  for (let i = 0; i < tips.length; i++) {
    const tip = typeof ends[i] === 'number' ? byEnd.get(ends[i] as number) : undefined
    const first = tip?.candidates[0]
    cells.push(
      tip && first ? (verdictFor(verdicts, tip.endUid, first.candidateId) ?? null) : null,
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
 * is where it survives.
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
  for (const tip of queue) {
    for (const candidate of tip.candidates) {
      const verdict = verdictFor(verdicts, tip.endUid, candidate.candidateId)
      if (!verdict) continue
      ids.push(tip.neuronId)
      ends.push(tip.endUid)
      candidateIds.push(candidate.candidateId)
      ranks.push(candidate.rank)
      said.push(verdict)
    }
  }
  return makeTable(verdictsSchema(), {
    [ID_COLUMN_NAME]: ids,
    end_uid: ends,
    candidateId: candidateIds,
    rank: ranks,
    [VERDICT_COLUMN]: said,
  })
}
