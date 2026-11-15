/**
 * From one end's assessor logits to the columns the review card reads.
 *
 * The join between `assessEnds.ts` (which runs the checkpoint) and `stages.ts` (which is the
 * arithmetic SEAM published), written once so the node's loop stays a loop. Everything here is
 * per end and allocates per end, which is what a streaming run can afford: a list is tens of
 * candidates and the two tables are rebuilt after every one.
 *
 * ## The order a list is published in changes, and `geo_rank` is what keeps the other one
 *
 * SEAM ranks a published list by `logit` — ref's fit of the assessor's score together with
 * `-geo_rank` and `log vol` — so the first row of an assessed list is the assessor's choice and
 * not the forest's. `rank` is that order and `geo_rank` stays the forest's, which is SEAM's own
 * pair of columns rather than a convention invented here: a reader comparing the two is reading
 * how much the assessor moved.
 *
 * ## A tip with no candidates is scored, not skipped
 *
 * Its `segclr` is the fit's own floor, its `p_tip` a real number — the tip may well be a false
 * split; it is the *candidate* that is missing — and its `q` is zero, so it is withheld. SEAM
 * publishes such a tip, and leaving it blank would make it look unsearched.
 */

import type { Warner } from '../../core/limits'
import { agree, plural } from '../../style/format'
import type { Triple } from '../../data/precomputed/volume'
import type { PipelineFits } from './pipelineFits'
import type { SearchedEnd } from './searchRun'
import type { AssessedEnd, EndScores, PublishedEnd } from './searchTips'
import { decideTip, scoreList } from './stages'

/**
 * One assessed end, as the two tables will publish it.
 *
 * `eTip` is the tip's own `e_tip`, **or `undefined` where Model E found no cell near it** —
 * `decideTip` substitutes the fit's floor, which is the value the fit saw rather than a neutral
 * one. The node passes the column's cell straight through, nulls and all.
 */
export function publishedEnd(
  end: SearchedEnd,
  assessed: AssessedEnd,
  eTip: number | undefined,
  fits: PipelineFits,
): PublishedEnd {
  const n = end.rows
  const list = scoreList(
    {
      geoRank: columnOf(end, 'geo_rank', n),
      volUm3: columnOf(end, 'vol_um3', n),
      // One seed, because a manifest is one checkpoint — `assessorFits` refuses anything else
      // before the weights are fetched, so this cannot be a list of the wrong length here.
      assessor: [Array.from(assessed.score)],
    },
    fits,
  )
  const tip = decideTip(list, eTip, fits)

  const conf = new Float64Array(n)
  for (let i = 0; i < n; i++) conf[i] = tip.pTip * list.pCand[i]!

  const scores: EndScores = {
    columns: {
      score_s0: assessed.score,
      logit: list.logit,
      p_cand: list.pCand,
      conf,
    },
    filled: assessed.filled,
    ...(assessed.refusal === undefined ? {} : { refusal: assessed.refusal }),
    tip: {
      segclr: list.segclr,
      p_tip: tip.pTip,
      /*
       * `p_top` is ref's confidence in **its own** first candidate, so it is read off `first`
       * rather than off row 0 of the published order. They are the same row — `first` is where
       * the order came from — and asking the same question twice is how they stop being.
       */
      p_top: list.pTop,
      q: tip.q ?? null,
      r: tip.against?.r ?? null,
      /*
       * **A verdict's absence, not `false`.** `null` here means the configuration published no
       * cutoff for the quantity this tip could reach, which `seam:review` draws as "no verdict";
       * `false` would say the cutoff was applied and this tip did not clear it. The single-seed
       * configuration always decides, so this is the arm nothing takes today and the one a
       * split configuration scored live would.
       */
      shown: tip.against ? tip.against.verdict === 'shown' : null,
    },
  }
  // `list.order` rather than an inversion of `list.rank`: `scoreList` built that permutation
  // to make `rank` and `first` from, and `ListScores.order` says why it is carried.
  return { end, order: list.order, scores }
}

/**
 * One of the search's columns as a plain array, refusing a short one by name.
 *
 * `scoreList` takes `geo_rank` and `vol_um3` as ref's first two features, and a column the pool
 * did not carry would arrive as `undefined` per row — `-undefined` is `NaN`, `Math.log` of it is
 * `NaN`, and a `NaN` through a softmax makes **every** candidate of the tip `NaN`. One tip's
 * whole list silently unscored, under a heading that says it was scored.
 */
function columnOf(end: SearchedEnd, name: string, rows: number): number[] {
  /*
   * **An end with no rows carries no columns at all**, and that is a state rather than a gap:
   * `searchRun.ts`' `emptyEnd` is `{ rows: 0, columns: {} }`, which is what a tip whose query
   * root had no voxel in its own box yields — and what every end of a run pointed at the wrong
   * materialization yields. Asking for a column first turned the commonest recoverable failure
   * in the whole node into a throw that ended the run on its first end.
   */
  if (rows === 0) return []
  const column = end.columns[name]
  if (!column || column.length < rows) {
    throw new Error(
      `seam assessor: the search's list carries no \`${name}\`, and ref's fit is on it. ` +
        'Every candidate of this tip would score as not-a-number and still be ranked.',
    )
  }
  return Array.from(column.subarray(0, rows))
}

/**
 * Where each of one end's candidates comes nearest the query, as triples.
 *
 * Triples because that is the form both consumers want — `EndToAssess.contactsNm` has the full
 * account of why, and one statement of it is enough.
 */
export function contactsOf(end: SearchedEnd): Triple[] {
  // No rows, no contacts — `columnOf` says why this comes before the columns are asked for.
  if (end.rows === 0) return []
  const x = end.columns['contact_x_nm']
  const y = end.columns['contact_y_nm']
  const z = end.columns['contact_z_nm']
  if (!x || !y || !z) {
    throw new Error(
      'seam assessor: the search measured no contact point, and a patch is centred on one. ' +
        'A patch centred anywhere else is a different 4 µm of the volume.',
    )
  }
  const out: Triple[] = []
  for (let i = 0; i < end.rows; i++) out.push([x[i]!, y[i]!, z[i]!])
  return out
}

/**
 * What the run found, as warnings a reader can act on.
 *
 * **Here rather than in the node, and taking a `Warner` rather than an `EvalContext`**, which is
 * what makes any of it reachable from a test: `evaluate` needs a CAVE token, a volume and a GPU,
 * so counting code left inside it is counting code nothing checks. `affinityClusters.ts` and
 * `findMerges.ts` hand their reporters a `Warner` for the same reason.
 *
 * **Every sentence below is conditional, and that is a rule rather than a coincidence.**
 * `docs/limits.md` records the failure twice from two directions — "attributing on every run
 * instead is a line people learn to skip", "a warning raised over half a minute teaches a reader
 * to dismiss the next one". A run that went well says nothing here; what it found is in the
 * table, and `seam:review` is the surface that counts it.
 */
export function reportOnRun(warner: Warner, ends: readonly PublishedEnd[]): void {
  reportOnSearch(warner, ends)
  reportOnScores(warner, ends)
}

/**
 * The search's own two failures.
 *
 * **Every end missing its own query root is one sentence, not hundreds.** It has one likely
 * cause — the materialization is not the one the ends were found in, so the neuron's root id
 * names nothing in the box — and that is a thing the reader can fix. Scattered per end it reads
 * as a data problem.
 */
function reportOnSearch(warner: Warner, ends: readonly PublishedEnd[]): void {
  let missing = 0
  const refused: string[] = []
  for (const { end } of ends) {
    if (end.missingQuery) missing += 1
    if (end.refusal) refused.push(end.refusal)
  }
  if (missing === ends.length && ends.length > 0) {
    warner.warn(
      `None of the ${plural(ends.length, 'open end')} had its own neuron in the box around it, ` +
        'so there was nothing to measure a candidate against. The usual cause is a ' +
        '`Datastack` whose materialization is not the one these ends were found in — the ' +
        'neuron’s root id named nothing in the segmentation at that moment.',
    )
  } else if (missing > 0) {
    warner.warn(
      `${plural(missing, 'open end')} had no voxel of its own neuron in the box around it, so ` +
        `${agree(missing, 'it has', 'they have')} no candidates. The rest were searched.`,
    )
  }
  /*
   * **One sentence for all of them, quoting one.** Every refusal here is the same kind of fact —
   * an object the chunkedgraph does not list — and a reader can act on "how many" and "for
   * instance"; hundreds of lines naming eighteen-digit ids is noise. A whole run refused is
   * worth saying differently, because then it is not the objects.
   */
  if (refused.length === 0) return
  const scale = refused.length === ends.length ? 'Every one of the' : `${refused.length} of the`
  warner.warn(
    `${scale} ${plural(ends.length, 'open end')} could not be sized: ${refused[0]!}. ` +
      `${agree(refused.length, 'It has', 'They have')} no candidates; the rest were searched.`,
  )
}

/**
 * What the assessor made of the run — **only where something is worth saying**.
 *
 * The three sentences are three admissions about the answer, which is what `ctx.warn` is for:
 *
 * - ends where no patch box could be read, so those tips are ranked by geometry alone;
 * - candidates that took the checkpoint's floor instead of being scored, with the two causes
 *   named apart because they are fixed by different things — a param the reader set, against the
 *   segmentation near a contact;
 * - **a run that assessed real candidates and showed none of them.** This is the one worth
 *   reading twice: "the node ran and found nothing" and "the node found nothing because it was
 *   pointed at the wrong thing" are identical from the outside, so the empty answer says so
 *   itself. A run that *does* show something says nothing — the count is a column.
 *
 * `shown` has three states and they are counted as three. Folding `null` — the configuration
 * published no cutoff for the quantity these tips could reach — in with `false` would print "0
 * of 2,708 above the cutoff" about a cutoff that was never applied.
 */
function reportOnScores(warner: Warner, ends: readonly PublishedEnd[]): void {
  const scored = ends.flatMap((one) => (one.scores ? [one.scores] : []))
  if (scored.length === 0) return

  const refused = scored.map((one) => one.refusal).filter((why) => why !== undefined)
  if (refused.length > 0) {
    /*
     * **The whole clause, per branch, not a prefix glued to one verb.** It read "None of the N
     * … could have a patch box read" when every end failed, and "3 of the N … could have a
     * patch box read" when three did — which says the opposite of what happened, in the sentence
     * whose whole job is to say what happened. `reportOnSearch`'s sibling got this right and
     * this one did not, which is what two sentences sharing a shape and not a statement does.
     */
    const all = refused.length === scored.length
    const scale = all
      ? `No patch box could be read around any of the ${plural(scored.length, 'searched end')}`
      : `${refused.length} of the ${plural(scored.length, 'searched end')} could not have a ` +
        'patch box read around ' +
        agree(refused.length, 'it', 'them')
    warner.warn(
      `${scale}: ${refused[0]!}. Every candidate there carries the checkpoint’s floor, so ` +
        `${agree(refused.length, 'that tip is', 'those tips are')} ranked by geometry alone.`,
    )
  }

  /*
   * Counting the **published words**, which is what makes this honest: `WhyFilled` is a union,
   * so a reworded cause is a type error here rather than a tally that quietly goes to zero.
   */
  let capped = 0
  let noPatch = 0
  let candidates = 0
  for (const one of scored) {
    for (const why of one.filled) {
      candidates += 1
      if (why === 'capped') capped += 1
      else if (why === 'no patch') noPatch += 1
    }
  }
  if (capped + noPatch > 0) {
    const parts: string[] = []
    if (capped > 0) parts.push(`${capped} past \`Assess top\``)
    if (noPatch > 0) parts.push(`${noPatch} with no patch to cut`)
    warner.warn(
      `${capped + noPatch} of ${plural(candidates, 'candidate')} took the checkpoint’s lowest ` +
        `score instead of being assessed — ${parts.join(', ')}. They are still ranked and ` +
        'still carry a share of their tip, marked in `filled`.',
    )
  }

  const decided = scored.filter((one) => one.tip.shown !== null)
  const shown = decided.filter((one) => one.tip.shown === true).length
  if (decided.length > 0 && shown === 0 && candidates > capped + noPatch) {
    warner.warn(
      `None of the ${plural(decided.length, 'assessed tip')} has a first candidate above the ` +
        'cutoff this model was fitted with, so the queue is a ranking without a recommendation. ' +
        'That is an ordinary answer on a well-reconstructed neuron — but it is also what a ' +
        '`Datastack` whose materialization is not the one these ends were found in looks like.',
    )
  }
}
