/**
 * Find Open Ends: where a reconstruction stops short, scored by SEAM's Model E.
 *
 * **Stage 3 of the merge-candidate pipeline, in the node that will eventually run all nine.**
 * `seam:suggestions` reads a run somebody else did on a server; this does the work in the
 * browser, on demand, for the neuron on the wire. The stages that find a *candidate* for each
 * open end — the 6 µm search, the geometric ranker, the three assessors — are not here yet, and
 * the output already has their columns, null. They fill in behind the same shape rather than
 * changing it, which is why this is one node arriving in pieces rather than a node per stage
 * that would have to be retired when the next one lands.
 *
 * ## What it answers, and what it does not
 *
 * `e_tip` per tip: the best Model E cell within 1 µm of it. That is the feature `p_tip` is fitted
 * on, and on its own it is a ranking of the neuron's ends by how much they look like somewhere a
 * neurite was cut off. It is **not** `p_tip` and it is not a probability — `p_tip` also needs
 * `segclr`, which is the assessors' output, and the cutoff and `r` are calibrated on both.
 *
 * ## Why it streams
 *
 * A whole Aedes neuron is 417 windows and about a minute of scanning (measured, with the tiling
 * kept). A tip, though, is finished long before that: its `e_tip` can only come from a window
 * whose centre is within the crop radius plus 1 µm, so once those centres are scored, nothing
 * later can change it. `openEndsOps.ts` holds that bookkeeping; what it buys is rows appearing as
 * the scan sweeps the arbour rather than a minute of nothing.
 *
 * ## The skeleton
 *
 * A tip is a leaf of a skeleton, and which skeleton decides what a tip is. The `Skeletons` port
 * is the honest answer — Skeletonize Meshes and Clean Skeletons are on the canvas where their
 * settings are visible and their results cached. Unwired, the node skeletonizes the mesh itself
 * with SEAM's own settings, so the thing works on a bare Meshes wire.
 *
 * **Both paths end in one function.** `tipsOf` is the only definition of a tip in Coda, so the
 * two cannot come to disagree about one — which is the failure a choice like this invites, and it
 * would show up as a slightly different set of ends, never as an error.
 *
 * ## Kinks
 *
 * `Also look for kinks` adds SEAM's fifth decision: a sharp turn inside an unbranched run, where
 * a side branch swallowed the real end so the skeleton carried on instead of stopping. Off by
 * default, and the default is the measurement — on the Aedes neuron this was measured on kinks
 * were 111 of 964 candidates, every one of them scored like a tip, so about an eighth more run.
 * They are not bad candidates when looked at (19 of 38 judged right against the tips' 216 of
 * 359), but almost none of them clear the cutoff: 2 of the fixture's 610 are `shown`. An eighth
 * more run for a handful of ends is a reader's decision, not a default. The rule is `tips.ts`'.
 */

import { packNode } from '../../core/registry'
import type { EvalContext } from '../../core/node'
import { T } from '../../core/types'
import { isMeshesValue } from '../../core/values'
import type {
  MeshGeometry,
  MeshesValue,
  SkeletonGeometry,
  SkeletonsValue,
  Value,
} from '../../core/values'
import {
  forgetSeamScan,
  meshKeyFor,
  runSeamReduce,
  runSeamWindows,
} from '../../pyodide/seamWindows'
import type { SeamWindowRequest } from '../../pyodide/seamWindows'
import type { ModelSession } from '../../ml/session'
import type { WindowConfig } from './windowConfig'
import type { Tips } from './tips'
import { NM_PER_UM } from '../../data/units'
import type { NeuronId } from '../../core/ids'
import { idText, isNeuronId } from '../../core/ids'
import { caveServerFor } from '../../data/cave/datastack'
import { somataFor } from '../../data/cave/nuclei'
import {
  CAVE_DATASET_INPUT,
  caveTableParam,
  caveTargetOfValue,
} from '../../nodes/lib/caveParams'
import { runOpenEnds } from './openEndRun'
import { TIP_FIELDS, schemaOf } from './suggestionTables'
import { notNanometres, windowFieldsFrom } from './windowConfig'
import { scoreWindows } from './windowRun'
import { OPEN_END_MODELS, OPEN_END_TASK, openEndModel } from './models'
import { openWindowModel } from './openWindowModel'
import { warnSkeletonizeWait } from '../../nodes/lib/skeletonizeOps'
import type { TipRule } from './tips'
import { SEAM_TIP_RULE, tipsOf } from './tips'
import { SEAM_SKELETONIZE, tipSkeletons } from './tipSkeleton'
import type { OpenEnd } from './openEndsOps'
import { E_TIP_UM, openEndsTable, reachNm } from './openEndsOps'

/** Of the progress bar, before a window is built. The model is 71 MB on a cold browser. */
const DOWNLOAD_SHARE = 0.15

/**
 * Centres built, scored and folded before the next page.
 *
 * The page is three things at once: how often rows can appear, how much tensor is in flight, and
 * how long Cancel takes — a call is inside ONNX Runtime and Pyodide with no interrupt point a
 * message reaches, so the signal is read between pages. Thirty-two windows is a few seconds.
 */
const PAGE = 32

const unknownModel = (id: string) =>
  `This graph names the open-end model \`${id}\`, which this build does not carry. ` +
  `Choose one under \`Model\`.`

export const openEndsNode = packNode({
  type: 'seam:openEnds',
  label: 'Find Open Ends',
  category: 'analysis',
  description:
    'Score a neuron’s tips for whether the reconstruction stops short there, with SEAM’s ' +
    'open-end model.',
  guide:
    'Scores the surface around each of a neuron’s skeleton tips with SEAM’s Model E. `e_tip` is ' +
    'the best score within a micrometre of the tip: a ranking of where a neurite looks cut off, ' +
    'not a probability. Rows appear as the scan reaches them. Wire `Skeletons` to decide what a ' +
    'tip is; unwired, the node skeletonizes the mesh itself.',
  cost: 'expensive',
  inputs: [
    { id: 'meshes', label: 'Meshes', type: T.meshes() },
    {
      id: 'skeletons',
      label: 'Skeletons',
      type: T.skeletons(),
      required: false,
    },
    /*
     * A **reference**: it names the datastack the nucleus table is read from rather than
     * consuming anything. The meshes on the wire cannot say which datastack they came from, and
     * a reference creates no ordering dependency, so this does not make a cycle out of
     * `Dataset → Meshes → Find Open Ends` plus `Dataset → Find Open Ends`.
     */
    CAVE_DATASET_INPUT,
  ],
  outputs: [{ id: 'tips', label: 'Tips', type: T.table() }],
  params: [
    {
      id: 'model',
      kind: 'enum',
      label: 'Model',
      default: OPEN_END_MODELS[0]!.id,
      options: OPEN_END_MODELS.map((model) => ({ value: model.id, label: model.label })),
      help: 'Which open-end checkpoint to score with.',
    },
    {
      id: 'download',
      kind: 'boolean',
      label: 'Download the model',
      default: false,
      help: 'The weights are tens of megabytes, fetched once and kept in this browser. Off by default so a graph that opens on its own does not reach for them.',
    },
    {
      id: 'prune',
      kind: 'number',
      label: 'Prune twigs (µm)',
      default: SEAM_TIP_RULE.pruneUm,
      min: 0,
      step: 0.5,
      help: 'Twigs shorter than this go before the tips are taken, as SEAM does. A wavefront skeleton sprouts single-node spurs off the backbone and every one of them is a false open end. 0 keeps them.',
    },
    {
      id: 'heal',
      kind: 'number',
      label: 'Heal fragments (µm)',
      default: SEAM_TIP_RULE.healUm,
      min: 0,
      step: 0.5,
      help: 'Join fragments whose loose ends are this close, end to end, before the tips are taken. A skeleton of a segmentation is normally several disconnected pieces, and the ends where it was cut are not open ends — on the neuron this was measured on they outnumbered the real ones four to one. 0 heals nothing; a long bridge invents topology, which is why SEAM caps it at 1 µm.',
    },
    caveTableParam({
      id: 'nucleusTable',
      label: 'Nucleus table',
      placeholder: 'nucleus_detection_v0',
      help: 'A CAVE table of nuclei, read for each neuron’s soma so `Soma mask` has something to measure from. Only needed where the dataset does not publish soma positions itself; wire the Dataset it belongs to.',
    }),
    {
      id: 'somaMask',
      kind: 'number',
      label: 'Soma mask (µm)',
      default: SEAM_TIP_RULE.somaUm,
      min: 0,
      step: 1,
      help: 'No tip within this of the soma, where the source knows where it is. A cell body is a hairball of ends and none of them is a missing neurite. 0 keeps them.',
    },
    {
      id: 'kinks',
      kind: 'boolean',
      label: 'Also look for kinks',
      default: false,
      help: `Score the sharp turns inside a branch as well as the tips. Where a small side branch swallowed the real end, the skeleton carries on around a corner instead of stopping, so there is no tip to ask about — only a turn of more than ${SEAM_TIP_RULE.kinkTurnDeg}° over ${SEAM_TIP_RULE.kinkLengthUm} µm of path. Off by default: on the neuron this was measured on kinks were 111 of 964 candidates and far fewer of the answers, so they cost about an eighth of the run for a small number of extra ends.`,
    },
  ],

  /**
   * The same schema `seam:suggestions` promises, from the same list — so a column picker
   * downstream is offered the same choices whichever node feeds it, and is offered them **before
   * anything runs**. Invariant 2's reason: inference may not fetch, and a schema that only
   * appeared after a minute of scanning would leave every picker below it empty until then.
   */
  inferOutputs: () => ({ tips: T.table(schemaOf(TIP_FIELDS)) }),

  validate(ctx) {
    const issues: string[] = []
    const id = String(ctx.params.model)
    if (!openEndModel(id)) issues.push(unknownModel(id))
    return issues
  },

  async evaluate(ctx) {
    const meshes = ctx.input('meshes')
    if (!isMeshesValue(meshes)) throw new Error('Meshes input is missing')
    const given = ctx.input('skeletons') as SkeletonsValue | undefined
    // Both inputs, since a voxel skeleton is as wrong as a voxel mesh and fails less visibly.
    for (const [what, units] of [
      ['meshes', meshes.units],
      ['skeletons', given?.units],
    ] as const) {
      const refusal = notNanometres(what, units)
      if (refusal) throw new Error(refusal)
    }
    const id = String(ctx.params.model)
    const model = openEndModel(id)
    if (!model) throw new Error(unknownModel(id))

    const { session, config } = await openWindowModel({
      model,
      task: OPEN_END_TASK,
      download: ctx.params.download === true,
      downloadShare: DOWNLOAD_SHARE,
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(fraction, note),
      // `e_tip` is defined over pooled cells, so the cell size is part of the question and not a
      // default this node may pick. A checkpoint that does not publish one was not scored this
      // way, and guessing 0.5 µm would be answering with a number nobody fitted.
      check: (parsed) =>
        parsed.scan
          ? undefined
          : `${model.label} publishes no \`scan\` block, so there is no cell size to pool its ` +
            'scores at. This node needs a checkpoint scored over a whole neuron.',
    })
    // Narrowed by `check`, which refused before the weights were fetched.
    const scan = config.scan!

    const bySkeletonId = new Map<string, SkeletonGeometry>()
    for (const item of given?.items ?? []) bySkeletonId.set(String(item.id), item)

    /*
     * SEAM's numbers with the card's three laid over them: the kink constants have no field of
     * their own, so spreading is what keeps them from being three more numbers to keep in step.
     */
    const rule: TipRule = {
      ...SEAM_TIP_RULE,
      pruneUm: Math.max(0, Number(ctx.params.prune)),
      healUm: Math.max(0, Number(ctx.params.heal)),
      somaUm: Math.max(0, Number(ctx.params.somaMask)),
    }
    const kinks = Boolean(ctx.params.kinks)
    const ends: OpenEnd[] = []
    const items = meshes.items
    let endUid = 0
    let skipped = 0
    let unsnapped = 0
    let nearSoma = 0
    let kinkCount = 0

    /*
     * **The session is open from here**, so everything that can throw is inside the `finally`
     * that closes it. `nucleiFor` used to sit above this line, and it is the likeliest throw in
     * the whole node — a datastack that has no such table answers 500, which is how a mistyped
     * table name arrives. That left a WebGPU session and a 71 MB model holding a heap nothing
     * would give back, on the one path a reader is most likely to take twice.
     */
    try {
      /*
       * The skeletonizing is said before it starts, where it is long — the house rule for a wait,
       * and this one is not free: a 3.7 M-face neuron is a minute of wavefront before a single
       * window is built. Only for meshes the node will skeletonize itself; a wired skeleton has
       * already been paid for on the canvas.
       */
      const unwired = meshes.items.filter((item) => !bySkeletonId.has(String(item.id)))
      if (unwired.length > 0) {
        warnSkeletonizeWait(ctx, { ...meshes, items: unwired }, SEAM_SKELETONIZE.waves)
      }

      /*
       * The somata, if a table was named: read at `[1, 1, 1]` through the same path the datastacks
       * that *do* declare a nucleus table use (`somataFor`), so they arrive in nanometres like the
       * meshes. That is the whole reason this reads the table itself rather than taking one from a
       * wired CAVE table node: a plain table query answers in the table's own **voxels**, and a
       * soma a factor out either masks nothing or masks the neuron, with nothing failing.
       *
       * A neuron with no row keeps every tip, which is what no soma has always meant here; a root
       * holding two nuclei is a merge and `somataFor` gives it none, for the same reason.
       */
      const somata = await nucleiFor(ctx, meshes, ctx.input('dataset'))

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const neuronId = String(item.id)
        const share = (done: number) =>
          DOWNLOAD_SHARE + ((1 - DOWNLOAD_SHARE) * (i + done)) / items.length
        if (item.indices.length === 0) {
          skipped += 1
          continue
        }

        ctx.progress(share(0), `${neuronId}: the skeleton (${i + 1} of ${items.length})`)
        const wired = bySkeletonId.get(neuronId)
        const made = await tipSkeletons(
          { ...meshes, items: [item] },
          wired ? { ...(given as SkeletonsValue), items: [wired] } : undefined,
          rule,
          ctx.signal,
        )
        // The table first where there is one, else whatever the source published with the mesh.
        const soma = somata.get(neuronId) ?? (item.soma ? somaPoint(item) : undefined)
        const tips = tipsOf(made.items[0]!, item, {
          rule,
          kinks,
          ...(soma ? { somaNm: soma } : {}),
        })
        unsnapped += tips.unsnapped
        nearSoma += tips.nearSoma
        kinkCount += tips.kinks
        if (tips.positions.length === 0) continue

        const firstUid = endUid
        endUid += tips.positions.length / 3
        await scoreTips({
          mesh: item,
          tips,
          session,
          config,
          reduceUm: scan.reduceUm,
          signal: ctx.signal,
          progress: (done, total) => {
            ctx.progress(
              share(0.05 + (0.95 * done) / total),
              `${neuronId}: window ${done} of ${total}`,
            )
          },
          onSettled: (settled, best) => {
            for (const t of settled) {
              ends.push({
                neuronId,
                endUid: firstUid + t,
                kind: tips.kinds[t]!,
                x: tips.positions[t * 3]!,
                y: tips.positions[t * 3 + 1]!,
                z: tips.positions[t * 3 + 2]!,
                eTip: best[t]! === -Infinity ? null : best[t]!,
              })
            }
            // In the order the final table uses, which is the order they settled in.
            ctx.publish({ tips: openEndsTable(ends) })
          },
        })
      }
    } finally {
      // Neither of these may mask what brought us here, and the second must run whatever the
      // first does: a failed `close` would otherwise leave the cached tiling — on a large neuron
      // over a hundred megabytes of float64 mesh — in a heap that never gives it back.
      await session.close().catch(() => undefined)
      // The tiling holds the mesh as float64 — on a large neuron, over a hundred megabytes in a
      // heap that never gives it back. Nothing follows this run, so it goes.
      await forgetSeamScan().catch(() => undefined)
    }

    if (skipped > 0) ctx.warn(`${skipped} of ${items.length} meshes have no faces, so no tips.`)
    if (unsnapped > 0) {
      ctx.warn(
        `${unsnapped} ends had no mesh surface within reach and were dropped. A skeleton and a ` +
          'mesh that disagree this much are usually from different timepoints.',
      )
    }
    if (nearSoma > 0) {
      ctx.warn(`${nearSoma} ends were dropped for sitting within ${rule.somaUm} µm of a soma.`)
    }
    /*
     * The cost, not a census. `kind` already carries which candidate is which, so a tally would
     * say nothing the table does not — what a reader cannot read off the table is that these are
     * the rows the extra time went on. No message where there were none: a warning that fires on
     * every run with the switch on is one a reader learns to scroll past, and nothing was spent.
     */
    if (kinkCount > 0) {
      // The tips are the denominator, and a neuron can have none of them — every tip masked at
      // the soma or dropped for having no surface, with kinks surviving further out. `… % more
      // than nothing` is not a number, so that case says what happened instead.
      const tipCount = ends.length - kinkCount
      ctx.warn(
        tipCount > 0
          ? `${kinkCount} of the ${ends.length} candidates are kinks, so this run scored about ` +
              `${Math.round((100 * kinkCount) / tipCount)}% more windows than the tips alone ` +
              'would have.'
          : `Every one of the ${kinkCount} candidates is a kink, so without \`Also look for ` +
              'kinks` this neuron would have had no open ends at all.',
      )
    }
    return { tips: openEndsTable(ends) }
  },
})

interface ScoreTipsOptions {
  readonly mesh: MeshGeometry
  readonly tips: Tips
  readonly session: ModelSession
  readonly config: WindowConfig
  /** `config.scan.reduceUm`, resolved once by the caller. */
  readonly reduceUm: number
  readonly signal?: AbortSignal
  readonly progress: (done: number, total: number) => void
  readonly onSettled: (settled: readonly number[], best: Float64Array) => void
}

/**
 * One neuron's tips scored: tile once, then sweep, score and pool page by page.
 *
 * Out of `evaluate` because this is the part a reader follows on its own — the three calls a
 * page costs and the one conversion between them — and inside `evaluate` it could only be read
 * with the whole per-neuron scope in mind.
 *
 * **The tiling and the mesh cross once.** Every call after the first names the key and sends
 * neither, which is measured at 5.4 s a tip against 0.4 s. The key is minted from the mesh's own
 * arrays rather than written here: a key a node describes a mesh with is a key two different
 * meshes can share.
 */
async function scoreTips(options: ScoreTipsOptions): Promise<void> {
  const { config, mesh, session, signal, tips } = options
  const pre = config.preprocessing
  const meshKey = meshKeyFor(mesh.positions, mesh.indices)
  const ask = (over: Partial<SeamWindowRequest>) =>
    runSeamWindows(
      {
        positions: new Float32Array(0),
        indices: new Uint32Array(0),
        units: 'nm',
        ...windowFieldsFrom(pre),
        drawEvery: 1,
        limit: 0,
        meshKey,
        ...over,
      },
      { signal },
    )

  // An empty selection: tile, and say where the windows are. Nothing is built yet.
  const tiling = await ask({
    positions: mesh.positions,
    indices: mesh.indices,
    only: new Int32Array(0),
  })

  await runOpenEnds({
    tipsNm: tips.positions,
    centresNm: tiling.tilingCentresNm,
    within: reachNm(pre.windowRadiusUm),
    tipReachNm: E_TIP_UM * NM_PER_UM,
    cellUm: options.reduceUm,
    pageSize: PAGE,
    signal,
    onSettled: options.onSettled,
    score: async (centres, done, total) => {
      options.progress(done, total)
      const page = await ask({ only: centres })
      if (page.windows === 0)
        return { cellsNm: new Float32Array(0), scores: new Float32Array(0) }
      const scored = await scoreWindows(
        session,
        page.points,
        page.feats,
        page.windows,
        pre.nPoints,
        {
          signal,
        },
      )
      /*
       * **Pooled to cells before anything reads it**, which is not a tidy-up: `e_tip` is the best
       * *cell* within a micrometre, and a cell is the best point in a 0.5 µm box standing at that
       * point's position. Folding the raw points instead would count a point whose own cell is
       * represented somewhere outside the micrometre — a slightly higher score, on every tip,
       * with nothing to say so.
       *
       * Per page, which is what `score_neuron` does and what the idempotence of a maximum allows:
       * the page's points are pooled and thrown away, and a neuron's — tens of millions of them —
       * never exist at once.
       */
      const cells = await runSeamReduce(
        { pointsNm: page.sourceNm, scores: scored.pointLogits, cellUm: options.reduceUm },
        { signal },
      )
      return { cellsNm: cells.pointsNm, scores: cells.scores }
    },
  })
}

/**
 * Each neuron's soma from a CAVE nucleus table, in nanometres — or nothing, where none was named.
 *
 * **Read here rather than taken from a wired CAVE table node.** A plain table query answers in
 * the table's own voxels — `spec.ts` records measuring exactly that, "a client that took the raw
 * column would put every synapse a factor out, with nothing failing, because the cloud is
 * internally consistent either way" — and a soma a factor out either masks nothing or masks the
 * whole neuron. `somataFor` asks at `[1, 1, 1]`, so there is no setting to get wrong.
 *
 * The CAVE table card *can* now be asked for nanometres (`Position units`), so the wired route
 * is no longer impossible — this stays the default because it needs nothing configured and is
 * the same path the datastacks that declare a nucleus table already take.
 *
 * It is also the path the datastacks that *do* declare a nucleus table already take, so a
 * dataset that later declares one answers the same way with this field left empty.
 */
async function nucleiFor(
  ctx: EvalContext,
  meshes: MeshesValue,
  dataset: Value | undefined,
): Promise<Map<string, [number, number, number]>> {
  const table = String(ctx.params.nucleusTable ?? '').trim()
  if (!table) return new Map()
  const target = caveTargetOfValue(dataset, ctx.params)
  if (!target) {
    throw new Error(
      `\`Nucleus table\` names \`${table}\`, but there is no datastack to read it from. Wire ` +
        'the Dataset these meshes came from into `Dataset`.',
    )
  }
  const options = { deployment: target.deployment, signal: ctx.signal }
  const server = await caveServerFor(target.datastack, options)
  const ids: NeuronId[] = []
  for (const item of meshes.items) {
    const id = idText(item.id)
    if (id && isNeuronId(id)) ids.push(id)
  }
  const found = await somataFor(server, target.datastack, target.version, table, ids, options)
  const missing = ids.length - found.size
  if (missing > 0) {
    // Not an error: a nucleus table is routinely incomplete, and a root holding two nuclei is a
    // merge that `somataFor` gives no soma at all. Those tips are kept, which is what no soma
    // has always meant here — said rather than left as a quietly uneven mask.
    ctx.warn(
      `${missing} of ${ids.length} neurons have no row in \`${table}\`, so their tips are not ` +
        'masked near the soma. A neuron holding two nuclei is a merge and counts as none.',
    )
  }
  return new Map([...found].map(([id, at]) => [id, [at[0], at[1], at[2]]]))
}

/** The source's soma position, as a tuple the tip rule can read. */
function somaPoint(mesh: MeshGeometry): [number, number, number] {
  const at = mesh.soma!
  return [at[0]!, at[1]!, at[2]!]
}
