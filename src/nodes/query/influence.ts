/**
 * Influence: how strongly one set of neurons drives another, through every route at once.
 *
 * Where `Paths` answers "how does this reach that?" with a handful of ranked routes, this
 * answers "how much of what this neuron does is attributable to that one?" — summed over every
 * path of every length, which is a different question and the one people mostly have. It is
 * Bates et al.'s influence score, and the arithmetic lives in `lib/influenceOps.ts`, which is
 * where the identity with the published implementation is argued and where the probe pins it.
 *
 * Four things about this node are not obvious from its controls.
 *
 *  - **The direction decides who is seeded, and it is the *readout* that is seeded upstream.**
 *    "Which sensory neurons most influence my LHONs" is answered by starting at the LHONs and
 *    walking towards their inputs: the backward walk hands back the whole row of the inverse,
 *    i.e. a score for every neuron that reaches them. Nothing has to be named in advance.
 *  - **`Denominator` is not a display option; it decides what the node can do.** Summing the
 *    fetched input list is free, works on every backend and is the reference implementation's own
 *    rule — but it can only be computed from the postsynaptic end, so it rules out the downstream
 *    direction and the meet-in-the-middle. Published totals cost a query per hop and unlock both.
 *    See `Denominator` below.
 *  - **The answer is a lower bound, and the node says by how much.** Every term is non-negative,
 *    so hops that were not walked, mass the frontier limit dropped and drive that went to a
 *    fragment can only have been left out. All three are reported through `ctx.warn`.
 *  - **`Gain` is the published `lambda_max` and its default here is deliberately not the
 *    published one.** At 0.99 the series has a hundred-hop time constant, so four hops sees six
 *    per cent of it — measured, in `scripts/probe-influence.py`. See the param's note.
 *
 * Neuron level throughout, never collapsed to cell types — the opposite of `Paths`, on purpose.
 * The model is linear over neurons, and influence is linear, so a per-type total is a downstream
 * `Aggregate` over these rows and is exactly right. Collapsing during the traversal would change
 * W and make it something else.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { refuseIfOverCrashFloor, warnOverThreshold } from '../../core/limits'
import { idColumn } from '../lib/tableOps'
import { connectivityFor, synapseTotalsFor } from '../../data/queries'
import type { SynapseTotalsBasis } from '../../data/source'
import { canTotalSynapses } from '../../data/source'
import type { NeuronId } from '../../core/ids'
import {
  connectivityRequest,
  publishedNeurons,
  requireDataset,
  schemasForDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import { totalsLookup } from '../lib/connectivityOps'
import type { DenominatorLookup, PropagateResult } from '../lib/influenceOps'
import {
  FRONTIER_BATCH,
  batched,
  combineHalves,
  influencePairs,
  influencePairsSchema,
  influenceParamsFrom,
  influenceSchema,
  influenceTable,
  mergeProvenance,
  needsPublishedTotals,
  propagate,
  spreadMass,
  splitHops,
  summedVector,
  truncation,
} from '../lib/influenceOps'

/** Above this the fan-out is worth saying out loud. A warning, never a refusal. */
const NOISY_HOPS = 6

/**
 * Above this many (query, influencer) rows, the Per Query port is worth a sentence.
 *
 * `tableOps.pivotTable`'s cell ceiling, deliberately the same number: this table exists to be
 * pivoted, so the threshold that matters to whoever builds it is the one the *next* node will
 * apply. A second number half an order of magnitude away would be a claim about a difference
 * that does not exist.
 */
const PAIR_ROWS_WARN = 2_000_000

/**
 * The share of the propagating signal a loss has to reach before it is worth a line on the card.
 *
 * A percent. Below that the sentence costs more attention than the caveat is worth, and every
 * run of a real query loses a trace of mass to something.
 */
const LOSS_WARN = 0.01

/** A percentage for prose, never more precise than the thing it describes. */
function percent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  return fraction < 0.001 ? '<0.1%' : `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`
}

export const influenceNode = registerNode({
  type: 'neuron.influence',
  label: 'Influence',
  category: 'query',
  description:
    'Score every neuron by how strongly it drives, or is driven by, a set of neurons.',
  /*
   * Under 400 characters, which `help.test.ts` enforces for a node that has a document: the
   * overlay prints this above the document under a `TL;DR` label, and a nine-sentence paragraph
   * wearing that label is a lie about itself. Everything this used to say about the gain and
   * about what a lower bound means lives in `src/help/nodes/neuron.influence.md`.
   */
  guide:
    'How strongly one neuron drives another through every path at once rather than along one ' +
    'route \u2014 the influence score of Bates et al. Seed the neurons you care about, walk ' +
    'upstream, and everything that reaches them comes back ranked. Bounded by hops rather than ' +
    'solved over the whole connectome, so every score is a lower bound the node puts a number on.',
  cost: 'expensive',

  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
    /*
     * The optional far end.
     *
     * Named for what it holds rather than for either direction, because which end it is flips:
     * travelling upstream these are presynaptic candidates, travelling downstream they are
     * postsynaptic ones. `sources`/`targets` would have been right for one direction and a lie
     * for the other — `combineHalves` carries the same note one layer down.
     *
     * Wiring it does two things, and only the first is guaranteed: the result is restricted to
     * these neurons, and — where the denominator allows it — the walk meets in the middle
     * instead of going the whole way from one end. The restriction alone changes no number,
     * which is what makes falling back to a single pass a cost difference rather than a
     * different answer.
     */
    { id: 'candidates', label: 'Candidates', type: T.neurons(), required: false },
  ],
  /*
   * One port whose shape follows its control, which is `Connectivity`'s `Split by region`
   * arrangement: one row per connection becomes one row per connection per region on the same
   * port. A second port would be empty on most runs, and the totals are a `Group By` away from
   * the pre-aggregation table — there is no information in one that is not in the other.
   *
   * **The `kind` changes with it, and that is the honest half.** Off, this is a `Neurons` value —
   * one row per neuron, wirable straight into Skeletons or Adjacency. On, `neuronId` repeats once
   * per query neuron, which is not a neuron set however much it looks like one, so it is declared
   * a plain table and a wire into a Neurons-only input goes red until a `Group By` sits between
   * them. Louder than a picker clearing, and it is the switch doing what it says.
   */
  outputs: [{ id: 'influence', label: 'Influence', type: T.neurons() }],

  params: [
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      help: 'Upstream asks what influences your neurons; downstream asks what they influence. Upstream is the usual question and the only one every backend can answer \u2014 downstream needs published synapse totals.',
      default: 'inputs',
      options: [
        { value: 'inputs', label: 'upstream (what influences them)' },
        { value: 'outputs', label: 'downstream (what they influence)' },
      ],
    },
    {
      id: 'maxHops',
      kind: 'int',
      label: 'Max hops',
      help: 'How many synapses of indirect effect to include. More hops can only raise a score, never lower one, and the node reports a ceiling on what the hops it did not walk could have added.',
      default: 4,
      min: 1,
      max: 12,
      step: 1,
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min synapses',
      /*
       * Five, which is the reference implementation's `count_thresh` default rather than a
       * number chosen here. It matters more than it looks: under the `traversal` denominator it
       * is applied *before* the input fractions are computed, exactly as the package does it, so
       * raising it does not merely drop rows — it redistributes the shares of the ones that
       * remain.
       */
      help: 'Ignore connections below this many synapses. Under the default denominator it is applied before each connection\u2019s share is worked out, so raising it also raises the share of every connection that survives.',
      default: 5,
      min: 1,
      step: 1,
    },
    {
      id: 'gain',
      kind: 'number',
      label: 'Gain',
      /*
       * The published `lambda_max`, and the default is deliberately not the published 0.99.
       *
       * With input-fraction weights W is row-stochastic — measured on the reference
       * implementation's own C. elegans matrix, `lambda_max(W) = 1.0000000000` — so their
       * rescale by `lambda_max / lambda_max(W)` *is* a per-hop factor of `lambda_max`, and this
       * control is the same knob rather than an analogue of one.
       *
       * Which is what makes the default a real decision. The fraction of the series a budget of
       * H hops covers is `1 - g^(H+1)`, so at their 0.99 four hops is 5% of it, and the
       * package's own docstring says 0.99 amplifies the leading eigenmode a hundredfold — an
       * eigenmode belonging to the whole connectome rather than to anybody's seed, i.e. exactly
       * the part a bounded walk can neither see nor should want to. `pnpm probe:influence`
       * measures the consequence against the exact solve on 300 neurons: at 0.5 and four hops,
       * 97% of the score and 19 of the exact top 20; at 0.99 and four hops, 6.5% and 6 of 20.
       */
      help: 'How much of a signal survives each further synapse; 0.5 means half. This is the published lambda_max. Its 0.99 default reaches a hundred hops, far more than a bounded walk can see, so this defaults lower \u2014 at 0.5 four hops covers 97% of the score against 6% at 0.99.',
      default: 0.5,
      min: 0.01,
      max: 0.99,
      step: 0.05,
    },
    {
      id: 'denominator',
      kind: 'enum',
      label: 'Denominator',
      /*
       * The fork, and it gates the modes rather than being swapped underneath somebody.
       *
       * Both options are a real definition of W and they differ by the input mass sitting below
       * `Min synapses` — so a node that picked per backend would compute two different matrices
       * under one column name, which is the substitution `Connectivity`'s `Normalize` already
       * refuses one layer down.
       *
       * `traversal` is the default because it is the only one every backend can answer:
       * `synapseTotals` is true on neuPrint and the mock and false on CAVE, CATMAID and
       * precomputed, so defaulting to published totals would put a validate issue on the node
       * the moment a CAVE user created it. The cost of that choice is that the two things it
       * cannot do have to say so, which `validate` does, naming the fix.
       */
      help: 'How each connection\u2019s share of a neuron\u2019s input is worked out. Summed within the traversal uses the input list the walk already fetched \u2014 free, works everywhere, and is what the reference implementation computes, but it rules out downstream and meeting in the middle. Published totals ask the dataset instead: a query per hop, and both become available.',
      default: 'traversal',
      options: [
        { value: 'traversal', label: 'summed within the traversal' },
        { value: 'connected', label: 'published totals, reconstructed partners only' },
        { value: 'all', label: 'published totals, all synapses' },
      ],
    },
    {
      id: 'includeFragments',
      kind: 'boolean',
      label: 'Include fragments',
      /*
       * The same control `Connectivity` carries, and it means the same thing — but it interacts
       * with the denominator in a way that one does not, and the interaction is the honest half.
       * A dropped fragment's synapses stay in the denominator, so its share of the drive is
       * *lost* rather than redistributed to the neurons that remain. That loss is counted and
       * warned about; inflating everyone else to cover it would be a fabrication.
       *
       * No `absentMeans`: this node has never shipped, so there is no stored graph whose absence
       * of the key means something other than the default. See `ParamBase.absentMeans` for the
       * case where there is.
       */
      help: 'Off, only proofread neurons carry the signal onwards \u2014 what counts as proofread is set on the Dataset node. Drive that reaches a fragment is reported as lost rather than shared out among the rest, which would be an invented number.',
      default: false,
    },
    {
      id: 'frontierLimit',
      kind: 'int',
      label: 'Frontier limit',
      help: 'Carry at most this many neurons into the next hop, strongest first. This is what bounds the cost, and whatever it discards is reported as a share of the signal so a limit that is biting is visible. 0 is no limit.',
      default: 2000,
      min: 0,
      step: 500,
    },
    {
      id: 'perQuery',
      kind: 'boolean',
      label: 'Per query neuron',
      /*
       * The mechanism already existed — `propagate`'s `perSeedChannels`, which the forward half
       * of a meet-in-the-middle uses to keep the candidates apart. This points it at the other
       * end. Which is also why the two cannot both be on: the channels index one set, and asking
       * for both would be an outer product per reached neuron rather than a vector.
       */
      help: 'Emit one row per query neuron per influencer, before the scores are summed across your neurons — which is what a Pivot needs to build a queries x influencers matrix for a Heatmap. Group By on the influencer gets you back to the plain ranking. It costs one row per reached neuron per query neuron, and the result is no longer a neuron set, so it is off by default.',
      default: false,
    },
    {
      id: 'seedWeighting',
      kind: 'enum',
      label: 'Seed weighting',
      help: 'Whether a score is the sum or the mean across the neurons you wired in. One each gives every seed its own unit, so a score is their sum \u2014 the reference implementation\u2019s choice, and a bigger seed set gives bigger scores. Share of one divides one unit between them, making a score their mean, which is what lets two runs over different-sized sets be compared.',
      default: 'each',
      options: [
        { value: 'each', label: 'one each' },
        { value: 'share', label: 'share of one' },
      ],
      advanced: true,
    },
  ],

  /*
   * Fixed but for the id and type columns, which are the dataset's — `influenceSchema` carries
   * them over whole from the source's connectivity schema, so a CAVE root id stays `str` here.
   * Nothing else varies with a param, so no picker downstream can be cleared by a setting.
   */
  /*
   * Both branches are exactly what `evaluate` returns — invariant 3 by construction, the split
   * `Connectivity`'s `neuronSet` already makes. The schema-and-value pairs are
   * `influenceSchema`/`influenceTable` and `influencePairsSchema`/`influencePairs`.
   */
  inferOutputs: (ctx) => {
    const connectivity = schemasFromType(ctx.inputs.dataset).connectivity
    return {
      influence: influenceParamsFrom(ctx.params).perQuery
        ? T.table(influencePairsSchema(connectivity))
        : T.neurons(influenceSchema(connectivity)),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const label = sourceLabel(ctx.inputs.dataset) ?? 'This data source'
    const settings = influenceParamsFrom(ctx.params)
    const published = settings.denominator !== 'traversal'
    const downstream = settings.direction === 'outputs'
    const hasCandidates = ctx.inputs.candidates !== undefined

    /*
     * The two things the traversal denominator cannot do, each said at edit time rather than
     * after a run — a cost or a refusal that arrives once somebody has waited is a description
     * of something that already happened.
     */
    if (needsPublishedTotals(settings)) {
      issues.push(
        'Downstream needs a denominator belonging to the far end of each connection, which cannot be summed from an outputs query. Set Denominator to published totals, or use Upstream.',
      )
    }
    if (settings.perQuery && hasCandidates) {
      issues.push(
        'Per query neuron uses the channels to keep the query neurons apart, so there are none left to index the candidates and this cannot meet in the middle. Candidates still restrict which rows come back — the scores are the same, the walk is just the full depth from the Neurons end.',
      )
    }
    if (hasCandidates && !published && !downstream && !settings.perQuery) {
      issues.push(
        'Candidates are wired, but meeting in the middle needs published totals — this will run as a single full-depth walk and filter the result, which gives the same scores for more queries. Set Denominator to published totals to halve the depth.',
      )
    }
    // The capability, asked only when the control is actually used. `sourceSupports` folds in
    // the edge-set arm: a dataset answering from an imported file has no totals either.
    if (published && !sourceSupports(ctx.inputs.dataset, 'synapseTotals')) {
      issues.push(
        `${label} does not publish the per-neuron synapse totals this denominator divides by. Use "summed within the traversal", which needs no second query.`,
      )
    }

    const { maxHops: hops, minWeight, gain } = settings
    if (hops >= NOISY_HOPS && minWeight <= 1) {
      issues.push(
        `${hops} hops at Min synapses ${minWeight} expands almost every partner of every partner. Raise Min synapses, or lower the Frontier limit — which bounds the cost and reports what it cost you.`,
      )
    }

    /*
     * Not a refusal, and not phrased as one: a gain this high is a legitimate thing to ask for
     * and is what the reference implementation defaults to. What is worth saying is that the
     * budget on this card cannot see most of what it buys.
     */
    if (gain > 0 && gain < 1 && hops >= 1) {
      const covered = 1 - Math.pow(gain, hops + 1)
      if (covered < 0.5) {
        issues.push(
          `At gain ${gain}, ${hops} hops covers ${percent(covered)} of the score — the rest is in paths longer than this walk. Lower the gain or raise Max hops.`,
        )
      }
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)

    /*
     * **Both lists are deduplicated here, and that is load-bearing rather than tidy.**
     *
     * `propagate` gives each seed a channel of its own under `perSeedChannels`, and it sizes
     * that channel array from `[...new Set(opts.seeds)]`. Two readers then index those channels
     * *by position* — `influencePairs`' `queries` and `combineHalves`' `scored` — so a repeated
     * id shifted every channel after the first duplicate onto the wrong neuron: neuron 3's
     * influencers came back filed under neuron 1, and neuron 3 vanished from the table. Past the
     * channel count the read ran off the end of the `Float64Array` and scored `NaN`, which the
     * `score > floor` filter then dropped in silence.
     *
     * A `Neurons` table is free to repeat an id — `Stack Tables` over two overlapping searches
     * keeps the kind and the duplicates, and so do both import nodes — so the fix belongs at the
     * one point that turns a table into a list rather than at each of the readers.
     *
     * It also fixes `seedMass` below, which divided one unit of drive by the *raw* length and so
     * started a `share` run with less than a whole unit in it.
     */
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')
    const seedColumn = idColumn(neurons, 'neuronId')
    const seeds = [...new Set(seedColumn)]
    if (seeds.length === 0) throw new Error('No neuronIds in the incoming Neurons table')

    const wired = ctx.input('candidates')
    const candidateColumn = isTableValue(wired) ? idColumn(wired, 'neuronId') : []
    const candidates = [...new Set(candidateColumn)]

    // Said rather than done quietly: a set the user believes is 400 neurons and is really 380 is
    // a fact about their wiring, and the scores are per *neuron* either way.
    const repeated =
      seedColumn.length - seeds.length + (candidateColumn.length - candidates.length)
    if (repeated > 0) {
      ctx.warn(
        `${repeated.toLocaleString()} repeated ${repeated === 1 ? 'id was' : 'ids were'} folded ` +
          `away — an influence score is per neuron, so listing one twice cannot mean anything ` +
          `here. Check the Neurons wire if you expected them to be distinct.`,
      )
    }

    const settings = influenceParamsFrom(ctx.params)
    const { denominator, gain, frontierLimit, minWeight } = settings
    const direction = settings.direction
    const downstream = direction === 'outputs'
    const hops = settings.maxHops
    const seedMass = settings.shareSeedMass ? 1 / seeds.length : 1

    if (needsPublishedTotals(settings)) {
      throw new Error(
        'Downstream influence divides each connection by the *receiving* neuron’s total ' +
          'input, which an outputs query never returns. Set Denominator to one of the published ' +
          'totals options, or switch Direction to Upstream.',
      )
    }
    /*
     * The same predicate `synapseTotalsFor` will apply, asked here so the refusal can name the
     * fix — `pathStepFor`'s rule about one predicate rather than a second spelling. The funnel's
     * own message is correct and says nothing about the control that would make this work, and
     * a refusal arriving from two hops down the stack reads as a broken dataset.
     */
    if (
      denominator !== 'traversal' &&
      !canTotalSynapses(source, dataset.datasetId, dataset.edges !== undefined)
    ) {
      throw new Error(
        `${source.label} does not publish the per-neuron synapse totals this denominator ` +
          `divides by. Set Denominator to "summed within the traversal", which divides by the ` +
          `input list the walk already has.`,
      )
    }

    const sourceSchema = schemasForDataset(source, dataset).connectivity
    const projection = connectivityRequest(dataset)

    const fetch = batched(
      (neuronIds: NeuronId[], hopDirection) =>
        connectivityFor(source, {
          ...projection,
          neuronIds,
          direction: hopDirection,
          minWeight,
          signal: ctx.signal,
        }),
      FRONTIER_BATCH,
    )

    /*
     * The denominator lookup, or nothing.
     *
     * `synapseTotalsFor` chunks internally and refuses a dataset answering from an attached edge
     * file, which is the same refusal `validate` made above — one predicate, asked twice, rather
     * than a second spelling of it. `side: 'inputs'` always: W's divisor is what the
     * *postsynaptic* neuron receives, whichever way the walk is travelling, and writing it out
     * here is what stops the flip.
     */
    /*
     * Both lookups are **memoised across the two halves of a split**, which is not an
     * optimisation so much as the split's own premise: the halves meet, so their balls overlap
     * by construction, and each `propagate` keeps only its own bookkeeping. Without this the
     * backward half re-asks the network about every id the forward half already resolved — the
     * slowest part of the node, paid twice. Neither answer depends on which way a walk is
     * travelling: `side: 'inputs'` always, and `findNeurons` does not care.
     */
    const totalsSeen = new Map<NeuronId, number>()
    const denominators: DenominatorLookup | undefined =
      denominator === 'traversal'
        ? undefined
        : async (postIds) => {
            const missing = postIds.filter((id) => !totalsSeen.has(id))
            if (missing.length > 0) {
              // `totalsLookup`, not a reader of its own: it is the existing headless
              // totals-table → Map, it keys by `idText`, and a second spelling of cell → id is
              // what invariant 8 is about — `String(cell)` on a wide id keys a neuron that does
              // not exist, and every denominator then reads as "not published".
              const totals = await synapseTotalsFor(source, {
                ...projection,
                neuronIds: missing,
                side: 'inputs',
                basis: denominator as SynapseTotalsBasis,
                signal: ctx.signal,
              })
              // Negatives are cached too, as 0: an id the dataset publishes no total for would
              // otherwise be re-queried by the second half. `propagate` reads 0 as missing,
              // which is the answer.
              for (const id of missing) totalsSeen.set(id, 0)
              for (const [id, value] of totalsLookup(totals)) totalsSeen.set(id, value)
            }
            return totalsSeen
          }

    const publishedSeen = new Map<NeuronId, boolean>()
    const lookUpPublished = publishedNeurons(source, dataset, ctx.signal)
    const published = settings.includeFragments
      ? undefined
      : async (ids: NeuronId[]) => {
          const missing = ids.filter((id) => !publishedSeen.has(id))
          if (missing.length > 0) {
            const answered = await lookUpPublished(missing)
            for (const id of missing) publishedSeen.set(id, answered.has(id))
          }
          return new Set(ids.filter((id) => publishedSeen.get(id) === true))
        }

    /*
     * How the budget is divided.
     *
     * `splitHops` is asked in the pre-to-post orientation it is written in, so the two sets swap
     * places with the direction: travelling upstream the candidates are presynaptic and lead the
     * forward half, travelling downstream the seeds are. A split of zero is the ordinary
     * single-pass run and covers three of the four cases — no candidates, no forward denominator,
     * or a budget of one.
     */
    const forwardAvailable =
      candidates.length > 0 && denominators !== undefined && !settings.perQuery
    const preSide = downstream ? seeds : candidates
    const postSide = downstream ? candidates : seeds
    const split = splitHops(hops, preSide.length, postSide.length, forwardAvailable)

    const run = async (
      walkSeeds: readonly NeuronId[],
      walkDirection: 'inputs' | 'outputs',
      depth: number,
      perSeedChannels: boolean,
      from: number,
      to: number,
      mass = seedMass,
    ): Promise<PropagateResult> =>
      propagate({
        seeds: walkSeeds,
        seedMass: mass,
        perSeedChannels,
        direction: walkDirection,
        hops: depth,
        gain,
        frontierLimit,
        fetch,
        ...(denominators ? { denominators } : {}),
        ...(published ? { published } : {}),
        signal: ctx.signal,
        onHop: (hop, total, carrying) =>
          ctx.progress(
            from + ((to - from) * (hop - 1)) / Math.max(1, total),
            `${walkDirection === 'inputs' ? 'upstream' : 'downstream'} hop ${hop}/${total} · ${carrying.toLocaleString()} neurons`,
          ),
      })

    ctx.progress(0.05, `${seeds.length.toLocaleString()} neurons`)

    let scores: Map<NeuronId, number>
    let halves: PropagateResult[]
    /** What the completion note says the walk was — one depth, or the two a split used. */
    let walked: string
    if (split.forward === 0) {
      // The single pass, at full depth. Its `total` already *is* the answer for every neuron it
      // reached; candidates, when wired, only decide which of those rows are reported.
      const pass = await run(seeds, direction, hops, settings.perQuery, 0.05, 0.9)
      halves = [pass]
      walked = `${hops} hops`
      if (candidates.length === 0) scores = summedVector(pass.total)
      else {
        // Read straight off the spread rather than materialising one entry per reached neuron
        // and deleting all but a few: the ball is tens of thousands of neurons and the candidate
        // set is usually a handful.
        scores = new Map<NeuronId, number>()
        for (const id of candidates) {
          const values = pass.total.get(id)
          if (!values) continue
          // Summed over channels, not `[0]`: under `Per query neuron` the channels are the query
          // neurons and channel 0 is one of them rather than the answer.
          let value = 0
          for (let c = 0; c < values.length; c++) value += values[c]!
          if (value !== 0) scores.set(id, value)
        }
        if (denominators === undefined) {
          ctx.warn(
            `Candidates are wired but the denominator is summed within the traversal, so this ` +
              `walked the full ${hops} hops from the Neurons end and filtered the result. The ` +
              `scores are the same either way — switching Denominator to published totals ` +
              `would split the budget and fetch far fewer neurons.`,
          )
        }
      }
    } else {
      /*
       * Meeting in the middle. The channelled half is whichever one seeds the neurons being
       * *scored* — the candidates — because that is the half whose per-seed split survives the
       * dot product. Upstream that is the forward walk; downstream it is the backward one.
       */
      // Mass 1 on the channelled half: its channels index *which candidate*, so the seeding is
      // an identity rather than a weighting. `Seed weighting` belongs to the pooled half, which
      // is the one seeded at the neurons somebody wired in.
      const forward = await run(
        preSide,
        'outputs',
        split.forward,
        !downstream,
        0.05,
        0.5,
        downstream ? seedMass : 1,
      )
      const backward = await run(
        postSide,
        'inputs',
        split.backward,
        downstream,
        0.5,
        0.9,
        downstream ? 1 : seedMass,
      )
      halves = [forward, backward]
      walked = `${split.forward} + ${split.backward} hops`
      scores = downstream
        ? combineHalves(backward, forward, candidates)
        : combineHalves(forward, backward, candidates)
    }

    /*
     * Everything the answer does not contain, said before the table is built.
     *
     * Three separate losses and they are not the same kind of thing, so they are three
     * sentences: the unwalked tail is a property of the budget, the frontier limit is a property
     * of a control on this card, and the drive that went to a fragment is a property of the
     * dataset. Each is compared against the signal it came out of rather than reported as a bare
     * number, because "0.004 of mass" means nothing to a reader and "3% of the signal" does.
     */
    for (const half of halves) {
      /*
       * Every loss is reported as a share of the signal that half started with, because a bare
       * "0.004 of mass" means nothing to a reader and "3% of the signal" does. Read off term 0
       * rather than recomputed from the seed count: the two halves of a split are seeded
       * differently — one per-seed at mass 1, the other pooled at whatever `Seed weighting`
       * says — so anything derived from `seeds.length` would be the wrong denominator for one
       * of them.
       */
      const seedTotal = Math.max(1e-30, half.terms[0] ? spreadMass(half.terms[0]) : 1)

      /*
       * The unwalked tail, and **only for a single pass**. Under a split each half's bound is a
       * ceiling on *its own* series rather than on the combined one, and the combined tail is
       * not either of them — so reporting a half's number beside a meet-in-the-middle result
       * would be a precise-looking figure that bounds the wrong quantity. The node still says
       * it is a lower bound, in the guide and in the help; what it declines to do is put a
       * number on it that is not the number.
       */
      if (halves.length === 1) {
        const bound = truncation(half)
        if (bound !== null && bound / seedTotal > LOSS_WARN) {
          ctx.warn(
            `These scores are a lower bound: paths longer than the hop budget could add up to ` +
              `${percent(bound / seedTotal)} more. Raising Max hops or lowering Gain closes the gap.`,
          )
        }
      }

      const droppedTotal = half.droppedMass.reduce((sum, value) => sum + value, 0)
      if (droppedTotal / seedTotal > LOSS_WARN) {
        ctx.warn(
          `The frontier limit discarded ${percent(droppedTotal / seedTotal)} of the propagating ` +
            `signal, so weakly-connected neurons are missing or under-scored. Raise Frontier ` +
            `limit, or raise Min synapses so fewer neurons compete for the slots.`,
        )
      }
      const fragmentTotal = half.fragmentMass.reduce((sum, value) => sum + value, 0)
      if (fragmentTotal / seedTotal > LOSS_WARN) {
        ctx.warn(
          `${percent(fragmentTotal / seedTotal)} of the signal went to bodies the dataset does ` +
            `not publish as neurons and stopped there. That share is left out rather than ` +
            `shared among the rest; tick "Include fragments" to follow it.`,
        )
      }
      if (half.missingDenominator.size > 0) {
        ctx.warn(
          `${half.missingDenominator.size.toLocaleString()} neurons have no published input ` +
            `total, so nothing was propagated through them. They are a break in the paths ` +
            `running through them rather than rows missing from the result.`,
        )
      }
    }

    ctx.progress(0.95, 'ranking')
    const { cells, types } = mergeProvenance(halves)
    /*
     * Meaningless under a split — a neuron's `hops` there is its distance from whichever end
     * happened to reach it, which is two different measurements in one column. Left empty rather
     * than filled with the nearer of the two, which would read as a distance and be one only half
     * the time. `Per query neuron` never splits, so it always has one.
     */
    const firstHop = halves.length === 1 ? halves[0]!.firstHop : new Map<NeuronId, number>()

    const route =
      denominator === 'traversal'
        ? 'denominator summed within the traversal'
        : `denominator from published totals (${denominator === 'all' ? 'all synapses' : 'reconstructed partners only'})`

    if (settings.perQuery) {
      /*
       * The refusal is made against the *measured* shape rather than the estimate warned about
       * before the walk: `Frontier limit` bounds what carries onwards per hop and not what has
       * accumulated, so the reached set is only knowable now — and this is the allocation, one
       * cell per column per row. The gotcha this follows is the one about an output sized by the
       * product of two independently-resolved things; here the two are the query set and a ball
       * nobody chose directly.
       */
      const columns = influencePairsSchema(sourceSchema).columns.length
      refuseIfOverCrashFloor(
        `Per query neuron over ${seeds.length.toLocaleString()} query neurons and ` +
          `${halves[0]!.total.size.toLocaleString()} reached neurons`,
        seeds.length * halves[0]!.total.size * columns * 8,
      )
      const pairs = influencePairs({
        total: halves[0]!.total,
        queries: seeds,
        schema: influencePairsSchema(sourceSchema),
        cells,
        types,
        firstHop,
        ...(candidates.length > 0 ? { keep: new Set(candidates) } : {}),
      })
      if (pairs.length > PAIR_ROWS_WARN) {
        warnOverThreshold(ctx, {
          count: pairs.length,
          threshold: PAIR_ROWS_WARN,
          unit: 'query-influencer pairs',
          control: 'the width a Pivot is usually meant to have',
          cost: 'Group By on the influencer collapses it to one row per neuron.',
        })
      }
      ctx.progress(
        1,
        `${pairs.length.toLocaleString()} pairs · ${seeds.length.toLocaleString()} queries · ${walked} · ${route}`,
      )
      return { influence: pairs }
    }

    const table = influenceTable({
      scores,
      schema: influenceSchema(sourceSchema),
      cells,
      types,
      firstHop,
      seeds,
    })
    ctx.progress(1, `${table.length.toLocaleString()} neurons · ${walked} · ${route}`)
    return { influence: table }
  },
})
