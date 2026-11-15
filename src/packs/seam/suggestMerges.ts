/**
 * Suggest Merges: run SEAM's search over a neuron's open ends and publish the ranked candidates.
 *
 * ## It computes a set; it does not read one
 *
 * `seam:suggestions` reads the lists SEAM's pipeline produced on a cluster. This does stages 4
 * and 5 — the 6 µm box, the eleven geometric features, the forest, the cut, the own-tip rule —
 * in the browser, for the ends on the wire. Everything it publishes was measured here, from the
 * segmentation as the chosen materialization saw it.
 *
 * **The pipeline is Coda's, not a published run's.** The box size, the pool radius, the cut, the
 * own-tip radius and the forest's feature order are one decision — every number was fixed when
 * the forest was fitted — so they ride in the model manifest beside the weights and are picked
 * together by `Ranker` (`rankerConfig.ts`). The node used to read them out of whichever
 * suggestion set it was pointed at, which made Coda's pipeline a property of somebody else's run.
 *
 * ## It streams, because a reader starts before the run ends
 *
 * Each end is measured, ranked, ruled and **published** on its own, so the review card fills as
 * the search sweeps the arbour rather than after it. What makes that honest is that a published
 * end is final: the own-tip rule reads the tip *positions*, which are known before any box is
 * read, so a later end cannot change an earlier one. `searchRun.ts` yields them one at a time and
 * says what that cost.
 *
 * ## What it answers, and what it does not — read this before wiring it to a queue
 *
 * The search says **where** a candidate is and **how the forest ranks it**: `geo_rank`, `rank`,
 * `vol_um3`, `min_dist_um` and the contact point. It says nothing about how *likely* the merge is
 * to be right — `p_cand`, `conf`, the assessor scores and SEAM's own cutoff are stage 6 and
 * later, which needs models Coda cannot run yet. Those columns are **not published at all**
 * (`searchTips.ts` says why absent beats null here).
 *
 * So a review queue fed from here is ordered by geometry and SEAM's cutoff has not been applied.
 * That is a real answer — the forest is fitted to rank, and its first candidate is the piece most
 * likely to be the continuation — but it is not a probability, and the node says so on itself
 * rather than leaving a reader to work it out from what is missing.
 *
 * ## It does not cut, and that is the lesson from `seam:findMerges`
 *
 * A whole neuron is hundreds of open ends and each is a ~19 MB cutout, so something has to
 * narrow them. It is not this node. `seam:findMerges` shipped a `Score cutoff` inside an
 * expensive node, and the cost was that every nudge re-ran the whole thing and a discarded
 * answer looked like a verdict the model had given. Narrowing here is a `Filter Table` on `e_tip`
 * above this node, where the cut is a thing somebody did. What this node has instead is a guard
 * rail: it prices the wait and warns, and runs anyway (`docs/limits.md`).
 *
 * **Narrowing the ends also narrows the own-tip rule, and that is not a bug to fix here.** The
 * rule drops a candidate whose contact is nearer some *other* tip of the neuron, and the only
 * tips it can measure against are the rows it was given. Filter to twenty ends and a candidate
 * that belonged to one of the other four hundred is now kept, and published as one of the twenty's
 * first. Ends this node drops itself — a box outside the volume — stay competitors for exactly
 * this reason; rows a `Filter Table` removed are not here to keep. So a filtered run is a
 * slightly more generous answer than SEAM's, never a different ranking of the same list, and a
 * reader comparing against a published set should search the whole neuron.
 *
 * ## Read-only
 *
 * Boxes out of a public bucket, roots and chunk counts out of the chunkedgraph, and nothing
 * written anywhere. The merge is the proofreader's own, in their own viewer, with their own
 * token — SEAM's invariant 7, which holds in every phase of this pack.
 */

import type { EvalContext } from '../../core/node'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { warnOverWait } from '../../core/limits'
import type { TableValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { agree, plural } from '../../style/format'
import {
  CAVE_DATASET_INPUT,
  caveDatastackIssues,
  caveDatastackParam,
  caveTargetOfValue,
} from '../../nodes/lib/caveParams'
import { NM_PER_UM } from '../../data/units'
import type { CandidatePoolRequest, PoolSizesRequest } from '../../pyodide/cutoutSummary'
import { runCandidatePool, runPoolSizes } from '../../pyodide/cutoutSummary'
import { l2ChunkCounts } from '../../data/cave/rootIds'

import { MERGE_RANKER_MODELS, mergeRankerModel } from './models'
import { afterShare } from './progress'
import { openTreeRanker } from './rankerConfig'
import { searchEnds } from './searchRun'
import type { SearchedEnd } from './searchRun'
import type { TipRow } from './searchTips'
import {
  SEARCH_CANDIDATE_FIELDS,
  candidatesTable,
  tipPositions,
  tipsByNeuron,
  tipsFromTable,
  tipsSchema,
  tipsWithFirsts,
} from './searchTips'
import { schemaOf } from './suggestionTables'
import { boxFits, endToSearch, forgetRoots, openSearchVolume } from './searchVolume'

/** How much of the progress bar the ranker gets before the search starts. It is 1.3 MB. */
const MODEL_SHARE = 0.02

/**
 * What one open end costs, in seconds, measured on Aedes.
 *
 * The box is ~19 MB over the network and the pool is 560 ms of Pyodide warm; the chunkedgraph
 * calls ride on top and are shared between neighbouring ends, so they are not in the figure.
 * Two seconds is the whole-end number the probe reports on a warm worker with the box cached,
 * rounded up — a cold first end is some four seconds more and is not worth modelling.
 *
 * **A rate, not a limit.** `WAIT_WARN_SECONDS` decides when the number is worth saying; this only
 * turns a count of ends into it, which is `docs/limits.md`' rule about stating a limit in the
 * units of what it protects.
 */
export const SECONDS_PER_END = 2

export const suggestMergesNode = packNode({
  type: 'seam:suggestMerges',
  label: 'Suggest Merges',
  category: 'analysis',
  description:
    'Searches around each open end for the piece of segmentation most likely to be its continuation, and ranks them with SEAM’s forest.',
  guide:
    'Takes a table of open ends and, for each, reads a 6 µm box of segmentation around it, ' +
    'measures every object that comes near the neuron there, and ranks them with the forest ' +
    'picked in Ranker. Each end is published as it finishes, so Review Suggestions fills while ' +
    'the rest of the neuron is still being measured. The thing to know is what it cannot say: ' +
    'the ranking is geometric, so there is no calibrated probability and no cutoff — those need ' +
    'assessors Coda cannot run yet, and the columns are absent rather than empty. It also ' +
    'searches every row it is given, so narrow the ends with a Filter Table above it rather ' +
    'than looking for a cutoff here — though filtering also narrows what the own-tip rule can ' +
    'compare against, so a filtered run keeps a few candidates a whole-neuron run would drop.',
  cost: 'expensive',

  inputs: [{ id: 'tips', label: 'Tips', type: T.table() }, CAVE_DATASET_INPUT],
  outputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    { id: 'candidates', label: 'Candidates', type: T.table() },
  ],
  params: [
    {
      id: 'model',
      kind: 'enum',
      label: 'Ranker',
      default: MERGE_RANKER_MODELS[0]!.id,
      options: MERGE_RANKER_MODELS.map((model) => ({ value: model.id, label: model.label })),
      help: 'Which forest to order each open end’s candidates with. The model carries the pipeline it was fitted with — the box size, the pool radius, the cut and the feature order — so picking a ranker picks all of them together.',
    },
    caveDatastackParam(
      'Which datastack’s segmentation to search, as `datastack:materialization`. Wire a Dataset instead and this follows it. The materialization decides *when* the supervoxels are read as belonging to a neuron, so it should be the one the open ends were found in.',
    ),
  ],

  /*
   * The full published shape, before anything runs — invariant 2's reason. A column picker on a
   * downstream Filter Table is the first thing a reader reaches for, and it cannot wait for a
   * neuron's worth of boxes. The tips half keeps the incoming table's own columns beside the
   * published ones, because a tip carries whatever Find Open Ends gave it.
   */
  inferOutputs: (ctx) => ({
    tips: T.table(tipsSchema(ctx.schema('tips'))),
    candidates: T.table(schemaOf(SEARCH_CANDIDATE_FIELDS)),
  }),

  validate: (ctx) => {
    const id = String(ctx.params.model)
    const issues = mergeRankerModel(id)
      ? []
      : [`This build does not have a ranker called \`${id}\`. Pick one in \`Ranker\`.`]
    issues.push(...caveDatastackIssues(ctx.inputs.dataset, ctx.params))
    return issues
  },

  evaluate: async (ctx) => {
    const table = ctx.input('tips')
    if (!isTableValue(table)) throw new Error('Tips input is missing')
    const target = caveTargetOfValue(ctx.input('dataset'), ctx.params)
    if (!target) {
      throw new Error(
        'No datastack. Wire a Dataset, or type one as `datastack:materialization` in `Datastack`.',
      )
    }

    /*
     * **The table is read first, before a byte is fetched.** `tipsFromTable` refuses by name, and
     * the thing a reader is most likely to have done is wire this to the wrong node — so paying
     * three round trips and 1.3 MB of forest before saying "wire this to Find Open Ends" is the
     * one wait that buys nothing. Its own docstring promises it refuses before any fetch; this is
     * the call site honouring it.
     */
    const { rows, dropped } = tipsFromTable(table)
    if (dropped > 0) {
      ctx.warn(
        `${plural(dropped, 'row')} of the Tips table could not be searched — no position, no ` +
          '`end_uid`, or a neuron that is not a chunkedgraph id. ' +
          `${agree(dropped, 'It is', 'They are')} passed through unsearched.`,
      )
    }
    /*
     * Through `tipsWithFirsts` rather than handing back `table`, so the empty answer is the shape
     * `inferOutputs` promised: one schema function, one value writer, and no path that publishes
     * a table a column picker below has not been offered.
     */
    if (rows.length === 0) {
      return { tips: tipsWithFirsts(table, [], []), candidates: candidatesTable([], []) }
    }
    warnOverWait(ctx, {
      seconds: rows.length * SECONDS_PER_END,
      what: `Searching ${plural(rows.length, 'open end')}`,
      lever:
        'Each end is a 6 µm box of segmentation, about 19 MB. Narrow them with a Filter Table ' +
        'on `e_tip` above this node.',
    })

    const id = String(ctx.params.model)
    const model = mergeRankerModel(id)
    if (!model) {
      throw new Error(`This build does not have a ranker called \`${id}\`.`)
    }
    /*
     * **One instant for the whole run.** Every box is turned into roots at the same moment, so
     * the supervoxels two neighbouring ends share are asked about once — which is what
     * `SearchVolume.roots` then makes free. The materialization is the dataset's, not the
     * clock's, which also makes the answer the same on a re-run.
     */
    const when = { version: target.version } as const
    const options = { deployment: target.deployment, signal: ctx.signal }

    /*
     * Independent, so together: the forest is a file on the model host, the volume is three CAVE
     * round trips. The ranker is opened first in the pair only because its refusals — a manifest
     * this build cannot read, a config missing a number — are the cheap ones.
     */
    const opened = await openTreeRanker(model, {
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(fraction * MODEL_SHARE, note),
    })
    const { ranker, config: plan } = opened
    ctx.progress(MODEL_SHARE, 'opening the segmentation')
    const volume = await openSearchVolume(target.datastack, plan.xyNm, when, options)

    const steps = {
      measure: (request: CandidatePoolRequest) =>
        runCandidatePool(request, { signal: ctx.signal }),
      sizes: (request: PoolSizesRequest) => runPoolSizes(request, { signal: ctx.signal }),
      counts: (roots: readonly string[]) => l2ChunkCounts(volume.graphene, roots, options),
    }
    const halfWidthNm = plan.halfWidthUm * NM_PER_UM

    /*
     * **Which ends can be searched, not which tips exist.** A box that clamps to nothing throws,
     * and one such end would abort a run of several hundred after the expensive ones had been
     * paid for — so it is answered here, once, and counted.
     *
     * The distinction matters below: an end that cannot be searched is still a **tip**, and the
     * own-tip rule measures a candidate against every one of its neuron's tips. Dropping it from
     * that set would keep a candidate that is nearer the unsearchable end and publish it as
     * another end's first — which is a plausible suggestion in the wrong place.
     */
    const fits = new Set(rows.filter((tip) => boxFits(volume, tip, halfWidthNm)))
    if (fits.size < rows.length) {
      const outside = rows.length - fits.size
      ctx.warn(
        `${plural(outside, 'open end')} ${agree(outside, 'lies', 'lie')} outside the ` +
          'segmentation volume, so no box could be read there. The rest were searched.',
      )
    }

    /*
     * **Published as they land, because a reader starts before the run does.** `ReviewBody`
     * draws its queue from `inputValues`, so every end that arrives here reaches the review card
     * with nothing downstream re-running (`core/node.ts`, `publish`). An end is yielded only
     * once the own-tip rule has run over it, so a row a reader is looking at never changes.
     *
     * **No throttle, and that is a measurement rather than an oversight.** `publish`'s rule is
     * to throttle because each call repaints every card; an end costs ~560 ms warm and a 19 MB
     * box before that, so the gap between two publishes is already far above the
     * `PUBLISH_INTERVAL_MS` a geometry channel needs. A throttle here would only ever delay the
     * last end of a neuron.
     */
    const searched: SearchedEnd[] = []
    // The last thing published *is* the answer, so the final return does not build it again.
    let answer = published(table, searched, rows)
    let done = 0
    for (const [neuron, at] of tipsByNeuron(rows)) {
      const mine = at.map((i) => rows[i]!)
      // One neuron's ends overlap; two neurons' do not. See `forgetRoots`.
      forgetRoots(volume)
      // `tip` indexes every one of this neuron's tips, which is what the own-tip rule compares
      // against; only the ones with a readable box become an end to search.
      const ends = mine.flatMap((tip, i) =>
        fits.has(tip) ? [endToSearch(volume, tip, i, halfWidthNm, options)] : [],
      )
      if (ends.length === 0) continue
      for await (const end of searchEnds(
        tipPositions(mine),
        ends,
        { ranker, topK: plan.topK, ownUm: plan.ownUm },
        steps,
        { signal: ctx.signal },
      )) {
        // Back to the whole table's numbering: `searchEnds` indexes this neuron's tips alone.
        searched.push({ ...end, tip: at[end.tip]! })
        done += 1
        ctx.progress(afterShare(MODEL_SHARE, done / fits.size), `searching ${neuron}`)
        answer = published(table, searched, rows)
        ctx.publish(answer)
      }
    }

    reportOnEnds(ctx, searched)
    return answer
  },
})

/**
 * The two tables, from the ends finished so far.
 *
 * One builder for the partial answer and the final one, because `publish`'s whole promise is
 * that what a reader sees mid-run is what they will have at the end — two code paths would be
 * two shapes, and the review card reads them by column name and would say nothing about the
 * difference.
 */
function published(table: TableValue, ends: readonly SearchedEnd[], tips: readonly TipRow[]) {
  return { tips: tipsWithFirsts(table, ends, tips), candidates: candidatesTable(ends, tips) }
}

/**
 * What the run found, as warnings a reader can act on.
 *
 * **Every end missing its own query root is one sentence, not hundreds.** It has one likely
 * cause — the materialization is not the one the ends were found in, so the neuron's root id
 * names nothing in the box — and that is a thing the reader can fix. Scattered per end it reads
 * as a data problem.
 */
function reportOnEnds(ctx: EvalContext, ends: readonly SearchedEnd[]): void {
  let missing = 0
  const refused: string[] = []
  for (const end of ends) {
    if (end.missingQuery) missing += 1
    if (end.refusal) refused.push(end.refusal)
  }
  if (missing === ends.length && ends.length > 0) {
    ctx.warn(
      `None of the ${plural(ends.length, 'open end')} had its own neuron in the box around it, ` +
        'so there was nothing to measure a candidate against. The usual cause is a ' +
        '`Datastack` whose materialization is not the one these ends were found in — the ' +
        'neuron’s root id named nothing in the segmentation at that moment.',
    )
  } else if (missing > 0) {
    ctx.warn(
      `${plural(missing, 'open end')} had no voxel of its own neuron in the box around it, so ` +
        `${missing === 1 ? 'it has' : 'they have'} no candidates. The rest were searched.`,
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
  ctx.warn(
    `${scale} ${plural(ends.length, 'open end')} could not be sized: ${refused[0]!}. ` +
      `${refused.length === 1 ? 'It has' : 'They have'} no candidates; the rest were searched.`,
  )
}
