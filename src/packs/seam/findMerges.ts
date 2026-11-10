/**
 * Find Merges: run SEAM's Model A over a neuron's surface and say where it looks like two
 * neurons were joined.
 *
 * The parts are in their own modules and this file is the card. What is decided *here*:
 *
 * ## It shows a confidence; it does not draw a line
 *
 * Every window the tiling produces is scored and every score reaches the `Table` and the scene,
 * where the colour *is* the confidence. That is the shape SEAM's invariant 14 forces: a
 * candidate list is cut by an absolute **calibrated** score, and `A_d256_e80` ships
 * `config.calibration: null` because the only scores it has are its test fold's — exactly what a
 * cutoff may not be chosen on. So `Score cutoff` is **empty by default** and, more to the point,
 * is `presentational`: it marks a line on the card's histogram and counts what is above it, and
 * `evaluate` never reads it. The actual cutting is a `Filter Table` on `score`, where it is
 * visible as an operation somebody performed.
 *
 * That is not only honesty about calibration. A cutoff `evaluate` read would be part of the
 * provenance key, so every nudge of the line would re-tile and re-score the neuron — minutes, to
 * change a comparison the card can do in a frame. Keeping the whole answer and drawing the line
 * on top is what makes looking for the right line affordable.
 *
 * ## The whole neuron, every time
 *
 * There is no default cap on windows. A merge missed because its part of the arbour was never
 * sampled is worse than a longer wait, and a capped run would read the neuron in *grid order* —
 * one corner of it — because that is the order `tile_centres` returns. `Max windows` exists as
 * an `advanced` hard stop and says so.
 *
 * ## The wait is projected, not measured, and the sentence says so
 *
 * The window count is not known until a mesh is tiled, and tiling needs the mesh in Pyodide — so
 * counting every neuron first would re-send every mesh. Instead the run projects itself from
 * what it has tiled so far and warns once, before the inference that would make it true.
 *
 * ## Read-only
 *
 * Nothing here writes to a segmentation. The outputs are a reader's: a table to sort, a cloud to
 * draw, and a neuroglancer layer to look at the suspect sites over the EM, where the proofreader
 * makes the edit with their own tools.
 */

import { warnOverWait, WAIT_WARN_SECONDS } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import type { LayersValue, MeshesValue, PointsValue } from '../../core/values'
import { boundsOf, isMeshesValue, layersFrom } from '../../core/values'
import { runSeamWindows } from '../../pyodide/seamWindows'
import { agree, plural } from '../../style/format'
import type { WindowConfig } from './windowConfig'
import { windowFieldsFrom } from './windowConfig'
import type { DrawnWindow, NeuronWindows, ScoredWindow } from './mergeTables'
import {
  drawnPointsSchema,
  drawnPointsTable,
  fragmentName,
  minorityShare,
  neuronSummarySchema,
  neuronSummaryTable,
  summariseWindows,
  windowTable,
  windowTableSchema,
} from './mergeTables'
import { MERGE_WINDOW_MODELS, MERGE_WINDOW_TASK, mergeWindowModel } from './models'
import { openWindowModel } from './openWindowModel'
import type { ScoredPoints } from './scene'
import { fragmentLayer, scoreLayer } from './scene'
import { probability, scoreWindows } from './windowRun'

/**
 * How long one window costs end to end: ~43 ms to build plus ~49 ms to score, both measured
 * (`docs/python-pyodide.md`, `docs/ml.md`). Only ever used to project a wait.
 */
const SECONDS_PER_WINDOW = 0.095

/** Where the weights land on the progress bar before the first window is built. */
const DOWNLOAD_SHARE = 0.15

/** Points kept per window for drawing. The model still sees every one of them. */
const DEFAULT_DRAW_EVERY = 16

export const findMergesNode = packNode({
  type: 'seam:findMerges',
  label: 'Find Merges',
  category: 'analysis',
  description:
    'Runs SEAM’s merge detector over each mesh’s surface and scores every 15 µm window for whether it holds a false merge, so a segment made of two neurons shows up as a bright patch.',
  guide:
    'Tiles each neuron’s surface into 15 µm cells and scores every one for a false merge, with ' +
    'the model’s own split of each cell published beside it. The card’s histogram is where you ' +
    'find a cutoff; moving it re-runs nothing. Layers goes into the Neuroglancer node, putting ' +
    'the sites over the EM. A 71 MB download, asked for once.',
  cost: 'expensive',
  /*
   * **Retired, and kept registered.** Measured against the thing it is for, neither checkpoint
   * in this pack earns a place in anybody's palette: the affinity transformer scores at chance
   * on real FlyWire merges, and Model A's window head missed a merge a proofreader had already
   * found while firing on eight other cells of the same neuron. Neither is a defect in the
   * node — the input path, the window geometry and both heads were checked against PyTorch —
   * so nothing here is deleted. `hidden` takes it out of the palette and leaves it loading,
   * running and testable, which is what a retrained checkpoint would need on the day it lands.
   * See `docs/seam-plan.md` for the measurements behind this.
   */
  hidden: true,
  inputs: [
    { id: 'in', label: 'Meshes', type: T.meshes() },
    // Chains like Neuroglancer Source: a port takes one wire, so several layers reach one scene
    // by passing through.
    { id: 'layers', label: 'Layers', type: T.layers(), required: false },
  ],
  outputs: [
    { id: 'meshes', label: 'Meshes', type: T.meshes() },
    { id: 'windows', label: 'Table', type: T.table() },
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'layers', label: 'Layers', type: T.layers() },
  ],
  params: [
    {
      id: 'model',
      kind: 'enum',
      label: 'Model',
      default: MERGE_WINDOW_MODELS[0]!.id,
      options: MERGE_WINDOW_MODELS.map((model) => ({ value: model.id, label: model.label })),
      help: MERGE_WINDOW_MODELS.map((model) => `${model.label}: ${model.detail}`).join(' '),
    },
    {
      id: 'download',
      kind: 'boolean',
      label: 'Download the model',
      default: false,
      help: 'The weights are about 71 MB and are fetched once, then kept in this browser. Tick this to allow the download; after it has happened the box no longer matters.',
    },
    {
      /*
       * A `string`, not a `number`, and empty by default. `0` is a real line — "every cell,
       * including the ones the model is sure about in the other direction" — so a numeric param
       * could not express "no line" at all. `out.heatmap`'s limits are a `string` for the same
       * reason.
       *
       * **`presentational`, which is what makes it free to move.** It is read by the card and by
       * nothing in `evaluate`: the scored cells, their fragments and both layers are what the
       * model returned, whole, so sliding this line changes no result and invalidates no cache
       * (invariant 4). The line is the reader's, and the node never pretends it is the model's.
       */
      id: 'cutoff',
      kind: 'string',
      label: 'Score cutoff',
      default: '',
      presentational: true,
      placeholder: '(no line)',
      help: 'A line drawn on the card’s histogram, between 0 and 1: the summary counts the cells at or above it. It does not filter anything — moving it costs nothing and re-runs nothing. To actually keep those cells, put the number into a Filter Table on `score`. This model ships no calibration curve, so the line is yours rather than one the model earned.',
    },
    {
      id: 'drawEvery',
      kind: 'int',
      label: 'Draw every nth point',
      default: DEFAULT_DRAW_EVERY,
      min: 1,
      step: 4,
      advanced: true,
      help: 'How densely the Points output and the neuroglancer layer are drawn. The model always sees every point of a window; this only thins what comes back, which at the default is a sixteenth of the coordinates.',
    },
    {
      id: 'maxWindows',
      kind: 'int',
      label: 'Max windows',
      default: 0,
      min: 0,
      step: 100,
      advanced: true,
      help: 'A hard stop on the windows scored per neuron; 0 covers the whole neuron, which is the default and what you usually want. It is not a preview: windows are taken in the order the tiling produces them, which sweeps the neuron rather than sampling it, so a capped run looks at part of the arbour and not at a thinner version of all of it.',
    },
    {
      id: 'layerName',
      kind: 'string',
      label: 'Layer name',
      default: '',
      advanced: true,
      placeholder: 'suspected merges',
      help: 'The annotation layer’s name in neuroglancer.',
    },
  ],

  inferOutputs: (ctx) => ({
    meshes: T.meshes(neuronSummarySchema(ctx.attributes('in'))),
    windows: T.table(windowTableSchema()),
    points: T.points(drawnPointsSchema()),
    layers: T.layers(),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    const id = String(ctx.params.model)
    if (!mergeWindowModel(id)) issues.push(unknownModel(id))
    const cutoff = readCutoff(ctx.params.cutoff)
    if (typeof cutoff === 'string') issues.push(cutoff)
    if (!ctx.params.download) {
      issues.push(
        'Tick `Download the model` to allow the weights to be fetched. Nothing is downloaded ' +
          'until you do, and once they are cached this stops mattering.',
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const meshes = ctx.input('in')
    if (!isMeshesValue(meshes)) {
      throw new Error(
        'Nothing is wired into `Meshes`. Wire in meshes, e.g. from the Meshes node.',
      )
    }
    if (meshes.units !== 'nm') {
      // Not a substitution: `scan.py` multiplies the window radius by 1,000 to reach nanometres,
      // so a voxel mesh tiles at a wrong physical scale and comes back with plausible windows,
      // plausible scores and nothing to say any of it is wrong.
      throw new Error(
        `These meshes are in ${meshes.units ?? 'unknown units'}, and the model's windows are ` +
          `physical sizes in nanometres. There is nothing to convert them with.`,
      )
    }
    const id = String(ctx.params.model)
    const model = mergeWindowModel(id)
    if (!model) throw new Error(unknownModel(id))

    const { session, config } = await openWindowModel({
      model,
      task: MERGE_WINDOW_TASK,
      download: ctx.params.download === true,
      downloadShare: DOWNLOAD_SHARE,
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(fraction, note),
    })
    warnOnCalibration(ctx, model.label, config)

    const items = meshes.items
    const rows: ScoredWindow[] = []
    const drawn: DrawnWindow[] = []
    const scenePoints: ScoredPoints[] = []
    const summaries: (NeuronWindows | undefined)[] = new Array(items.length)
    const drawEvery = Math.max(1, Math.round(Number(ctx.params.drawEvery)))
    const maxWindows = Math.max(0, Math.round(Number(ctx.params.maxWindows)))
    let tiledSoFar = 0
    let warned = false
    let skipped = 0

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const share = (done: number) =>
          DOWNLOAD_SHARE + ((1 - DOWNLOAD_SHARE) * (i + done)) / items.length
        if (item.indices.length === 0) {
          // A mesh with no faces tiles into nothing. Counted rather than warned per neuron.
          skipped += 1
          continue
        }

        ctx.progress(share(0), `${item.id}: tiling (${i + 1} of ${items.length})`)
        const built = await runSeamWindows(
          {
            positions: item.positions,
            indices: item.indices,
            units: meshes.units,
            ...windowFieldsFrom(config.preprocessing),
            limit: maxWindows,
            drawEvery,
          },
          { signal: ctx.signal, onProgress: (f) => ctx.progress(share(f * 0.4)) },
        )
        if (built.windows === 0) {
          skipped += 1
          summaries[i] = summariseWindows([])
          continue
        }

        // Projected from what has been tiled, and said once. The count is not knowable before a
        // mesh is tiled, and tiling every neuron up front would re-send every mesh.
        tiledSoFar += built.windows
        if (!warned) {
          const projected = (tiledSoFar / (i + 1)) * items.length * SECONDS_PER_WINDOW
          if (projected > WAIT_WARN_SECONDS) {
            warnOverWait(ctx, {
              seconds: projected,
              what:
                `Scoring about ${Math.round((tiledSoFar / (i + 1)) * items.length).toLocaleString()} ` +
                `windows across ${plural(items.length, 'neuron')}`,
              lever:
                'That is projected from the neurons tiled so far, not measured. Every window is ' +
                'scored on purpose — a merge in a part of the arbour nobody looked at is the ' +
                'thing this node exists to avoid — so the lever is fewer neurons, not fewer ' +
                'windows. Progress is per neuron and Cancel is seen within about half a second.',
            })
            warned = true
          }
        }

        const scored = await scoreWindows(
          session,
          built.points,
          built.feats,
          built.windows,
          config.preprocessing.nPoints,
          { signal: ctx.signal, onProgress: (f) => ctx.progress(share(0.4 + f * 0.6)) },
        )

        const perNeuron: number[] = []
        for (let w = 0; w < built.windows; w++) {
          const logit = scored.windowLogits[w]!
          const score = probability(logit)
          perNeuron.push(score)

          /*
           * Only the points in this window's **own cell**. A window crops a 15 µm sphere while
           * the tiling puts a centre every ~8 µm, so most of its points are a neighbour's
           * subject and this window's context. Keeping all of them would label one surface point
           * once per window that can see it, with no way to reconcile the labels — which is the
           * problem this split avoids rather than solves.
           */
          const keep: number[] = []
          for (let p = 0; p < built.drawnPerWindow; p++) {
            if (built.inOwnCell[w * built.drawnPerWindow + p]) keep.push(p)
          }

          /*
           * **The bipartition is always published**, whatever the cell scored. It is what the
           * model returned, and a node that showed it only above a line would be answering a
           * question the reader had already answered — which is how `Score cutoff` came to
           * trigger a re-run, and why the per-point head was invisible until somebody guessed a
           * number. What the reader needs instead is the number to judge it by: `balance` says
           * how much of the cell went to the smaller side, and on a cell the model called clean
           * that is usually near zero. `piece_loss` skips windows with no masked points, so the
           * head is untrained on clean windows and a confident-looking cut there means nothing
           * on its own — the card's histogram is where the two are read together.
           */
          const positions = new Float32Array(keep.length * 3)
          const fragments: string[] = []
          let positives = 0
          for (const [slot, p] of keep.entries()) {
            const at = (w * built.drawnPerWindow + p) * 3
            positions[slot * 3] = built.sourceNm[at]!
            positions[slot * 3 + 1] = built.sourceNm[at + 1]!
            positions[slot * 3 + 2] = built.sourceNm[at + 2]!
            const side = scored.pointLogits[w * config.preprocessing.nPoints + p * drawEvery]!
            if (side > 0) positives += 1
            fragments.push(fragmentName(w, side > 0 ? 1 : 0))
          }

          rows.push({
            neuronId: item.id,
            cell: w,
            centreNm: [
              built.centresNm[w * 3]!,
              built.centresNm[w * 3 + 1]!,
              built.centresNm[w * 3 + 2]!,
            ],
            score,
            logit,
            points: keep.length,
            balance: minorityShare(positives, keep.length),
          })
          if (keep.length === 0) continue
          drawn.push({ neuronId: item.id, cell: w, score, fragments })
          scenePoints.push({ neuronId: item.id, cell: w, score, positions, fragments })
        }
        summaries[i] = summariseWindows(perNeuron)
      }
    } finally {
      await session.close()
    }

    if (skipped > 0) {
      ctx.warn(
        `${plural(skipped, 'mesh', 'meshes')} had no surface to tile and ` +
          `${agree(skipped, 'was', 'were')} left out. ${agree(skipped, 'It is', 'They are')} ` +
          `in the Meshes output with no windows.`,
      )
    }

    const positions = concatPositions(scenePoints)
    const cloud: PointsValue = {
      kind: 'points',
      positions,
      attributes: drawnPointsTable(drawn),
      bounds: boundsOf([positions]),
      units: 'nm',
      ...(meshes.space ? { space: meshes.space } : {}),
    }
    const summary = neuronSummaryTable(meshes.attributes, summaries)
    const labelled: MeshesValue = { ...meshes, attributes: summary }

    /*
     * Two layers, same points: the score on the sequential ramp and the bipartition in two hues.
     * Neuroglancer's own layer checkbox is the switch between them, which is why this is not a
     * param — a mode would have been a param `evaluate` reads, and that is a re-run per look.
     */
    const name = String(ctx.params.layerName).trim() || 'suspected merges'
    const byScore = scoreLayer(scenePoints, name)
    const byFragment = fragmentLayer(scenePoints, `${name} — fragments`)
    if (byScore.dropped > 0) {
      ctx.warn(
        `Each neuroglancer layer draws the first ${plural(byScore.drawn, 'point')} and leaves ` +
          `${byScore.dropped.toLocaleString()} out — a local annotation layer of more than that ` +
          `does not draw at a usable frame rate. The Table and Points outputs are whole; a ` +
          `larger \`Draw every nth point\` thins the layers without thinning what was scored.`,
      )
    }
    const layers: LayersValue = {
      kind: 'layers',
      items: [...layersFrom(ctx.input('layers')), byScore.layer, byFragment.layer],
    }

    return { meshes: labelled, windows: windowTable(rows), points: cloud, layers }
  },
})

/** One sentence for the two surfaces that say it. */
const unknownModel = (id: string) =>
  `This build does not carry a model called "${id}". Pick one from \`Model\`.`

/**
 * The cutoff as a number, `undefined` for "no cut", or a sentence saying what is wrong with it.
 *
 * One function returning all three because both surfaces need all three and they must agree:
 * the card reports the problem at edit time and `evaluate` refuses on it, and a separate checker
 * beside a separate parser is two readings of one string that can disagree.
 */
function readCutoff(raw: unknown): number | undefined | string {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) return `\`Score cutoff\` is not a number: "${text}".`
  if (value < 0 || value > 1) {
    return `\`Score cutoff\` is a probability, so it is between 0 and 1 — not ${value}.`
  }
  return value
}

function concatPositions(windows: readonly ScoredPoints[]): Float32Array {
  let total = 0
  for (const window of windows) total += window.positions.length
  const out = new Float32Array(total)
  let at = 0
  for (const window of windows) {
    out.set(window.positions, at)
    at += window.positions.length
  }
  return out
}

/**
 * Say that the model has no calibration curve, and what that means for a cutoff.
 *
 * Raised on every run, because the reader will draw a line somewhere — on the card's histogram or
 * in a `Filter Table` downstream — and the sentence is about what that line can and cannot mean.
 * Not a refusal: the node is for looking, and `ctx.warn` collapses repeats.
 */
function warnOnCalibration(ctx: Warner, label: string, config: WindowConfig): void {
  if (config.calibration) return
  ctx.warn(
    `${label} ships no calibration curve, so a score is the model's raw confidence and not a ` +
      `probability you can read a rate off. Compare cells against each other rather than ` +
      `against a number, and treat any cutoff as your own line.`,
  )
}
