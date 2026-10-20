/**
 * Neuroglancer viewer node.
 *
 * Takes a dataset and a neuron table and emits a **URL**: the dataset's own published
 * neuroglancer scene, pointed at those neuron ids and coloured by a column. The widget beside
 * it is an iframe on that URL, so the workhorse rendering — EM, segmentation, ROI meshes,
 * synapse layers, all at full resolution and lazily paged — is done by neuroglancer rather
 * than by us. The `3D View` node stays for scenes Coda builds itself.
 *
 * **Everything that reaches the URL is output-affecting, and that is deliberate.** Elsewhere
 * an encoding is `presentational` because it changes only what a viewer draws. Here the
 * artefact *is* the view: the colours are baked into the URL the node emits, and a link that
 * renders differently from the panel above it is the exact failure `presentational` exists to
 * prevent. The single exception is `uiScale`, which scales the iframe and cannot change a byte
 * of what `evaluate` returns.
 *
 * `cheap`, despite fetching, because the fetch is one small JSON per dataset that the source
 * caches — the failure included. Everything after that is string building, which is what
 * makes restyling feel live.
 *
 * The neuron table is optional. A dataset on its own resolves to the published scene with no
 * segments selected, which is a perfectly good thing to look at — and is what a starter graph
 * shows before anyone has ticked a neuron.
 *
 * **`Selected` is what the scene shows, including what somebody changed inside it.** The frame is
 * Coda's own copy of neuroglancer (`neuroglancer.html`), so it can be read; double-clicking a
 * neuron in or out of the scene is written into `selectionEdits` (`selectionEdits.ts` for the
 * model), and the output is the input minus what was removed plus what was added. An added neuron
 * the input did not have is looked up in the dataset for its columns — see `lookupNeurons`.
 */

import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import { warnAboveParam } from '../lib/limitParams'
import { registerNode } from '../../core/registry'
import type { EvalContext, ParamValues } from '../../core/node'
import { ID_COLUMN_NAME, idText, isSegmentId } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { T, column } from '../../core/types'
import type { DatasetValue, TableValue } from '../../core/values'
import { emptyTable, isTableValue, makeTable, str, tableFromRows } from '../../core/values'
import { LruMap } from '../../core/lruMap'
import { memoPromise, untilAborted } from '../../data/memoPromise'
import { datasetCacheKey } from '../../data/neuronIndex'
import { unmatchedIds } from '../lib/idList'
import { errorMessage } from '../../core/errors'
import { plural } from '../../style/format'
import {
  applySelectionEdits,
  decodeSelectionEdits,
} from '../../data/neuroglancer/selectionEdits'
import type { NgLayerSet, NgLayout, ViewerKind } from '../../data/neuroglancer/scene'
import type { DataSource, SegmentPlacement } from '../../data/source'
import {
  DEFAULT_NEUROGLANCER_URL,
  buildScene,
  sceneUrl,
  viewerBaseFor,
} from '../../data/neuroglancer/scene'
/*
 * The one import from `src/ui` in the node pack, and it is the palette resolver on purpose:
 * "never re-implement colour mapping in a viewer" applies just as much to an external one.
 * Reusing it is what makes a neuron the same colour in the 3D view and in neuroglancer.
 * Both modules are pure — no DOM, no React — so this stays testable headlessly.
 */
import { constantColor, resolveColor } from '../../style/encoding'
import {
  datasetRequest,
  requireDataset,
  schemasForDataset,
  neuronSchemaOf,
  sourceSupports,
} from '../lib/datasetParam'
import { ID_ONLY_SCHEMA, concatBatches, foldColumns, rowsWithIds } from '../lib/tableOps'
import { colorParams, readColorSpec } from '../lib/encodingParams'

/**
 * Where the segment count starts being worth a sentence.
 *
 * A different guard rail from the morphology nodes' `Warn above`, which is about what *Coda*
 * fetches. Nothing is fetched here — the cost is neuroglancer's own mesh loading plus URL
 * length, and the URL is the harder limit in practice: male-CNS publishes a 38 kB state
 * before a single neuron id is added, and each coloured segment costs ~40 bytes more.
 *
 * The reason it warns rather than refuses is that the failure it guards against is *somebody
 * else's*: a link too long for a browser or a deployment fails visibly, at the far end, and it
 * is not Coda's to prevent on a number nobody has measured against every neuroglancer in use.
 */
export const SEGMENTS_WARN = 10000

/** Neuroglancer renders on black, so the dark palette is the right one whatever Coda's theme is. */
const VIEWER_MODE = 'dark' as const

/**
 * What the card's frame opens, from `Viewer type` and `Viewer`. The link is not decided here: it
 * is always the datastack's own viewer, in that viewer's own format, so it opens the same thing for
 * whoever it is sent to.
 *
 *  - `own`: Coda's bundled neuroglancer — the default, and the only frame that can be read back.
 *  - `link`: the link's own deployment, a one-way embed.
 *  - `custom`: a deployment somebody typed into `Viewer`.
 *
 * `flavour` is the format the frame's scene is written in (`ViewerKind`), where it is not to be
 * worked out from the deployment — a custom host this build has never met. Pure: the card resolves
 * `own` against its page (`selfHostedViewer`).
 */
export type FrameTarget =
  | { use: 'own'; flavour?: undefined }
  | {
      use: 'link'
      flavour?: ViewerKind
      /** A custom deployment was chosen and has no URL yet — `validate` asks for one. */
      pending?: true
    }
  | { use: 'custom'; base: string; flavour?: ViewerKind }

export function frameTarget(params: ParamValues): FrameTarget {
  // Read plainly (invariant 4): every context fills declared defaults, `absentMeans` included.
  const typed = typeof params.viewer === 'string' ? params.viewer.trim() : ''
  const type = params.viewerType
  switch (type) {
    case 'dataset':
      return { use: 'link' }
    case 'spelunker':
    case 'seunglab': {
      const flavour: ViewerKind = type
      // A custom choice with no URL yet frames the dataset's viewer in that format — which is also
      // what a graph saved with `Seung-lab` and an empty `Viewer` did. `validate` says so.
      return typed
        ? { use: 'custom', base: typed, flavour }
        : { use: 'link', flavour, pending: true }
    }
    case 'auto':
      // Retired: a typed `Viewer`, in a format read off its host; otherwise Coda's own copy.
      return typed ? { use: 'custom', base: typed } : { use: 'own' }
    default:
      return { use: 'own' }
  }
}

/** Whether a neuron hidden in the viewer stays in `Selected`, with a `visible` column saying so. */
export function keepsHidden(params: ParamValues): boolean {
  return params.hiddenNeurons === 'keep'
}

/** The column `Selected` carries under `Hidden neurons: stay in Selected`. */
const VISIBLE_COLUMN = 'visible'

/** Added, or taking the place of an input column of that name (`foldColumns`, position kept). */
function withVisibleColumn(schema: TableSchema): TableSchema {
  return foldColumns(schema, [column(VISIBLE_COLUMN, 'bool')])
}

registerNode({
  type: 'out.neuroglancer',
  label: 'Neuroglancer',
  category: 'visualisation',
  description: "View neurons in the dataset's own neuroglancer scene.",
  guide:
    'Shows neurons in the dataset’s own neuroglancer scene, embedded in the card. Wire in a ' +
    'dataset and, optionally, a neuron table such as the selection from Explore Dataset. The ' +
    'output is the scene URL, which you can open or share; all settings are in the inspector.',
  cost: 'cheap',
  /*
   * Big enough that the embed is worth having on the canvas at all. Only a starting point —
   * the card has resize handles, and whatever you drag it to is what gets saved.
   */
  defaultSize: { width: 460, height: 420 },
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    /*
     * Optional: a dataset alone is a legitimate scene. Janelia's published state already
     * frames the volume with its EM and ROI meshes, and being able to drop a Neuroglancer
     * node on a dataset and immediately look around is most of why this node exists —
     * requiring a neuron table first would make the empty case a dead card instead.
     */
    { id: 'neurons', label: 'Neurons', type: T.neurons(), required: false },
    /*
     * Layers from `Neuroglancer Source` nodes, added after everything the dataset publishes.
     *
     * One socket rather than several, because an input port takes one wire and those nodes chain:
     * the value on this wire is the whole list, in wiring order. It is the socket that makes a
     * brain shell, a second dataset's segmentation or somebody's own annotation layer reachable
     * without Coda having to know about any of them.
     */
    { id: 'layers', label: 'Extra layers', type: T.layers(), required: false },
  ],
  outputs: [
    { id: 'url', label: 'Link', type: T.string() },
    { id: 'selected', label: 'Selected', type: T.neurons() },
  ],
  params: [
    /*
     * Every param on this node is `advanced`, i.e. inspector-only. The node body is the
     * viewer: a row of pickers above a 400px embed is a row of pickers taking a tenth of the
     * space someone opened this for. The inspector shows the whole set for the selected node,
     * which is where a control that changes a scene belongs.
     */
    ...colorParams({
      prefix: 'segment',
      allowLiteral: true,
      from: 'neurons',
      label: 'Colour',
      /*
       * Neuroglancer's own hash colouring, not Coda's categorical palette.
       *
       * It is the mode that suits what this node emits. Coda's palette caps at eight slots and
       * folds the rest into one achromatic bucket, which is right for a chart legend and wrong
       * for a scene: past the eighth type every remaining neuron is the same grey, and colouring
       * by `neuronId` would give two unrelated neurons one hue and make them look like a group.
       * Neuroglancer gives every segment a distinct colour and needs no legend to do it.
       *
       * It is also the shortest link there is — no colour data travels at all, which matters on
       * a node whose whole output is a URL people paste into mail.
       */
      defaultMode: 'default',
      // Only reached once somebody picks a data-driven mode, and then this is the column worth
      // starting on: `neuronId` is the first compatible one and is the wrong answer, for the
      // eight-slot reason above.
      defaultColumn: 'type',
      // Baked into the URL — see the header.
      presentational: false,
      advanced: true,
      // Neuroglancer gives every segment a distinct hash colour of its own, which is both
      // useful and the shortest link there is: no colour data travels at all. A scene that
      // publishes colours for its neurons (`DataSource.placeSegments`, a BigClust project's) has
      // them used here instead — so the label names the scene rather than neuroglancer.
      allowDefault: { label: "the scene's own" },
    }),
    {
      id: 'layout',
      kind: 'enum',
      label: 'Layout',
      default: '3d',
      advanced: true,
      help: 'Panels neuroglancer opens with. 3D is meshes only; the others add EM sections.',
      options: [
        { value: '3d', label: '3D only' },
        { value: 'xy-3d', label: 'section + 3D' },
        { value: '4panel', label: '4 panels' },
      ],
    },
    {
      id: 'layers',
      kind: 'enum',
      label: 'Layers',
      default: 'all',
      advanced: true,
      help: 'Include everything the dataset publishes (EM, ROI meshes, synapses), or "neurons only" for a much shorter link. Extra layers are added either way.',
      options: [
        { value: 'all', label: 'as published' },
        { value: 'segmentation', label: 'neurons only' },
      ],
    },
    {
      id: 'uiScale',
      kind: 'number',
      label: 'Interface scale',
      /*
       * Presentational, and it earns it: it scales the *frame*, so it cannot change a byte of
       * the URL. Deliberately not called "zoom" — neuroglancer has a camera zoom of its own and
       * two things by that name on one card is a trap.
       *
       * Below 1 the frame is laid out larger and drawn smaller, so neuroglancer's toolbar and
       * panels take less of the card and the scene gets the room. It also means more pixels
       * to render, which is the trade at the bottom of the range.
       */
      help: 'Scales neuroglancer’s toolbar and panels so they take up less of the card. Does not zoom the camera.',
      default: 0.75,
      min: 0.5,
      max: 1.5,
      step: 0.05,
      presentational: true,
      advanced: true,
    },
    {
      id: 'showLayerBar',
      kind: 'boolean',
      label: 'Layer bar',
      /*
       * Presentational for the same reason as `uiScale`: it is written into what the *frame* is
       * pointed at and never into the URL, whose reader in a tab of its own has the room for the
       * bar. Off by default on every surface, the overlay included.
       */
      default: false,
      presentational: true,
      advanced: true,
      help: 'Show neuroglancer’s strip of layer chips along the top of the embed. The link always has it.',
    },
    {
      id: 'showSlices',
      kind: 'boolean',
      label: 'Section planes',
      default: false,
      advanced: true,
      help: 'Draw the EM cross-sections inside the 3D panel. Off by default: they cut through the meshes.',
    },
    {
      /*
       * Written by the frame, not typed: a neuron double-clicked into the scene or out of it. In
       * the provenance key, since `Selected` reads it — and the scene does too, so an upstream
       * edit keeps somebody's additions instead of rebuilding the scene without them.
       */
      id: 'selectionEdits',
      kind: 'ids',
      label: 'Viewer edits',
      noun: 'changes',
      default: [],
      advanced: true,
      help: 'Neurons added to or removed from the scene inside neuroglancer, by double-clicking. Applied on top of the Neurons input; clear to go back to it.',
    },
    {
      /*
       * Where the card's neuroglancer was looking — camera and panel layout — written by the
       * frame as it settles and read when a frame opens, so a saved workflow and a share link
       * reopen at the same spot. With the dataset it was taken in (`encodeSavedView`): applied to
       * another volume a camera opens on empty space, so a mismatch clears it.
       *
       * Presentational, because it reaches only the frame — the link opens the dataset's own
       * framing. Unrecorded, because a camera drag is not something to undo.
       */
      id: 'view',
      kind: 'string',
      label: 'Saved view',
      default: '',
      presentational: true,
      internal: true,
      unrecorded: true,
      advanced: true,
      help: 'Where the card’s neuroglancer was looking, saved with the workflow so it reopens there. Clear it to open at the dataset’s own framing.',
    },
    {
      /*
       * In neuroglancer a double-click *hides* a neuron and leaves its chip in the list; only
       * removing the chip takes it out. "leave Selected" makes `Selected` what is drawn. "stay"
       * makes it what is listed, hidden or not, with a `visible` column to tell them apart.
       */
      id: 'hiddenNeurons',
      kind: 'enum',
      label: 'Hidden neurons',
      default: 'remove',
      advanced: true,
      options: [
        { value: 'remove', label: 'leave Selected' },
        { value: 'keep', label: 'stay in Selected' },
      ],
      help: 'A neuron hidden in neuroglancer (double-clicked out, or its chip un-ticked) either leaves Selected, or stays in it with visible = false.',
    },
    warnAboveParam({
      threshold: SEGMENTS_WARN,
      min: 1,
      counting: 'putting more than this many segments in the scene',
    }),
    {
      /*
       * Which viewer the card embeds — never which one the link opens, which is always the
       * datastack's own. Presentational for that reason: nothing `evaluate` returns depends on it.
       *
       * `spelunker` and `seunglab` keep the values they had as the format override, since a graph
       * that set one did so for a typed `Viewer` — which is exactly what the Custom options are.
       * `auto` is the old default, retired rather than renamed so a stored card keeps its frame.
       */
      id: 'viewerType',
      kind: 'enum',
      label: 'Viewer type',
      default: 'coda',
      absentMeans: 'auto',
      presentational: true,
      advanced: true,
      options: [
        { value: 'coda', label: 'Coda’s neuroglancer' },
        { value: 'dataset', label: 'the dataset’s viewer' },
        { value: 'spelunker', label: 'custom', note: 'Spelunker / mainline' },
        { value: 'seunglab', label: 'custom', note: 'Seung-lab: FlyWire, NeuVue' },
        {
          value: 'auto',
          label: 'automatic',
          retired: 'now Coda’s neuroglancer, or custom for a typed Viewer',
        },
      ],
      help: 'Which neuroglancer the card shows. Only Coda’s own reports the neurons you pick back to Selected. The link always opens the dataset’s own viewer. For a custom deployment, pick the kind it is: Spelunker builds need a middleauth+ CAVE source, which the Seung-lab fork refuses.',
    },
    {
      id: 'viewer',
      kind: 'string',
      label: 'Viewer',
      default: '',
      presentational: true,
      advanced: true,
      placeholder: DEFAULT_NEUROGLANCER_URL,
      visibleIf: (params) => {
        const target = frameTarget(params)
        return target.use === 'custom' || (target.use === 'link' && target.pending === true)
      },
      help: 'The custom deployment the card embeds. It must allow being embedded.',
    },
  ],

  inferOutputs: (ctx) => {
    const schema = neuronSchemaOf(ctx.inputs)
    return {
      url: T.string(),
      selected: T.neurons(keepsHidden(ctx.params) ? withVisibleColumn(schema) : schema),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const target = frameTarget(ctx.params)
    if (target.use === 'link' && target.pending) {
      issues.push(
        'Enter the custom deployment in Viewer. Until then the card shows the dataset’s own viewer.',
      )
    }
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'viewerScene')) {
      issues.push('This data source publishes no neuroglancer scene')
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchViewerScene) {
      throw new Error(`${source.label} publishes no neuroglancer scene`)
    }

    const neurons = ctx.input('neurons')
    // Connected-but-wrong is still an error; *unconnected* is the empty scene.
    if (neurons !== undefined && !isTableValue(neurons)) {
      throw new Error('Neurons input is not a table')
    }

    const limit = Number(ctx.params.limit) || SEGMENTS_WARN
    const spec = readColorSpec('segment', ctx.params, ctx.column)
    const { segments: arrived, colors, dropped } = segmentColors(neurons, spec, limit, ctx)
    const edits = decodeSelectionEdits(ctx.params.selectionEdits)
    const segments = applySelectionEdits(arrived, edits)

    const published = await source.fetchViewerScene({
      datasetId: dataset.datasetId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!published) {
      throw new Error(
        `${dataset.label} publishes no neuroglancer scene, so there is nothing to show.`,
      )
    }

    // A scene of several volumes says which one each neuron is in, and may publish its colour —
    // used where this node's own colour is left on neuroglancer's.
    const placed = source.placeSegments
      ? await source.placeSegments({
          datasetId: dataset.datasetId,
          segments,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      : undefined
    const ownColors =
      spec.mode === 'default' && placed ? placedColors(placed, segments) : undefined

    const extra = ctx.input('layers')
    if (extra !== undefined && extra.kind !== 'layers') {
      throw new Error('Extra layers input is not a layer set')
    }

    // Hidden neurons are listed `!id` only where they stay selected; otherwise hiding is removing.
    const hidden = keepsHidden(ctx.params) ? shownOnly(edits.hidden, segments) : undefined
    const scene = buildScene(published, {
      datasetId: dataset.datasetId,
      segments,
      ...(hidden ? { hiddenSegments: hidden } : {}),
      ...(ownColors ?? colorFields(spec, colors)),
      ...(placed ? { placements: placed } : {}),
      layout: String(ctx.params.layout) as NgLayout,
      layers: String(ctx.params.layers) as NgLayerSet,
      showSlices: ctx.params.showSlices === true,
      ...(extra ? { extraLayers: extra.items } : {}),
    })

    // Always the datastack's own viewer, in its own format — `frameTarget` is what the card does.
    const viewer = viewerBaseFor('', source.peekDataset(dataset.datasetId)?.viewerSite)
    const selected = await selectedNeurons(source, dataset, ctx, {
      neurons,
      arrived,
      shown: segments,
      // Every row still shown, and already the kind the port declares.
      whole: neurons?.kind === 'neurons' && dropped === 0 && edits.removed.size === 0,
      adds: edits.added.size > 0,
    })
    return {
      url: str(sceneUrl(viewer, scene)),
      selected: hidden ? visibleColumn(selected, hidden) : selected,
    }
  },
})

/** The hidden ids the scene still shows — a note about a neuron since removed means nothing. */
function shownOnly(hidden: ReadonlySet<string>, segments: readonly string[]): Set<string> {
  if (hidden.size === 0) return new Set()
  const shown = new Set(segments)
  return new Set([...hidden].filter((id) => shown.has(id)))
}

/** `Selected` with its `visible` column: false for a neuron listed but hidden in the viewer. */
function visibleColumn(table: TableValue, hidden: ReadonlySet<string>): TableValue {
  const ids = table.data[ID_COLUMN_NAME] ?? []
  const visible =
    hidden.size === 0
      ? new Array<boolean>(table.length).fill(true)
      : Array.from({ length: table.length }, (_, row) => {
          const id = idText(ids[row])
          return id === null || !hidden.has(id)
        })
  return makeTable(
    withVisibleColumn(table.schema),
    { ...table.data, [VISIBLE_COLUMN]: visible },
    table.kind,
  )
}

/**
 * The `Selected` table: the input's rows for every neuron still shown, then a row for each one
 * added in the viewer that the input did not hold.
 *
 * Added rows carry the dataset's columns where the lookup answers, and only an id where it does
 * not — a segment double-clicked in the EM is often a fragment no neuron table lists, and it is
 * still something somebody chose. The output keeps the input's schema, so an added row is null in
 * any column the dataset does not publish.
 */
async function selectedNeurons(
  source: DataSource,
  dataset: DatasetValue,
  ctx: EvalContext,
  {
    neurons,
    arrived,
    shown,
    whole,
    adds,
  }: {
    neurons: TableValue | undefined
    /** The input's ids, before the edits. */
    arrived: readonly string[]
    /** What the scene shows, after them. */
    shown: readonly string[]
    /** Every input row is shown and the input is already a neuron table: pass it through. */
    whole: boolean
    /** Whether any edit adds a neuron. */
    adds: boolean
  },
): Promise<TableValue> {
  // The input itself where every row is still shown: a cheap node re-runs on every edit, and a
  // copy of a 100k-row table per restyle is the cost of not checking.
  const base = !neurons
    ? emptyTable(schemasForDataset(source, dataset).neurons, 'neurons')
    : whole
      ? neurons
      : rowsWithIds(neurons, shown)
  // Only edits add anything; most runs have none, and need no set over the whole input.
  if (!adds) return base
  const held = new Set(arrived)
  const added = shown.filter((id) => !held.has(id))
  if (added.length === 0) return base

  let found: TableValue | undefined
  try {
    found = await untilAborted(lookupNeurons(source, dataset, added), ctx.signal)
  } catch (err) {
    // A cancel is the run ending, not a lookup that failed.
    if (ctx.signal.aborted) throw err
    // Kept rather than thrown, so the scene stays on screen — but cached like any result, so say
    // how to ask again.
    ctx.warn(
      `Could not look up the ${plural(added.length, 'neuron')} added in the viewer, so they ` +
        `have only an id: ${errorMessage(err)}. Use Invalidate Results on this card to try again.`,
    )
  }
  const bare = found ? unmatchedIds(added, found) : added
  if (found && bare.length > 0) {
    ctx.warn(
      `${plural(bare.length, 'neuron')} added in the viewer ${bare.length === 1 ? 'is' : 'are'} ` +
        `not in the dataset's neuron table, so ${bare.length === 1 ? 'it has' : 'they have'} ` +
        `only an id.`,
    )
  }
  return concatBatches([
    base,
    ...(found && found.length > 0 ? [found] : []),
    ...(bare.length > 0
      ? [
          tableFromRows(
            ID_ONLY_SCHEMA,
            bare.map((neuronId) => ({ neuronId })),
            'neurons',
          ),
        ]
      : []),
  ])
}

/**
 * Neuron rows for ids added in the viewer — the one query this `cheap` node makes — kept **per id**,
 * so a request only ever asks for ids nobody has looked up yet. Keyed by the set instead, every
 * double-click re-asked for every earlier one, and an upstream filter moving an added id in and out
 * of the input sent a request per keystroke (invariant 6). Shared without a signal, each run
 * waiting on its own (`untilAborted`); a failure is forgotten, never kept (`memoPromise`).
 */
const lookups = new LruMap<string, Promise<TableValue>>(1024)

async function lookupNeurons(
  source: DataSource,
  dataset: DatasetValue,
  ids: readonly string[],
): Promise<TableValue> {
  // The annotation key too: a substituted table answers a different question about the same ids.
  const prefix = datasetCacheKey(
    'ng-lookup',
    dataset.sourceId,
    dataset.datasetId,
    dataset.annotations?.key ?? '',
  )
  // Every held promise taken before anything is added, so the inserts cannot evict one being read.
  const held: Promise<TableValue>[] = []
  const missing: string[] = []
  for (const id of ids) {
    const kept = lookups.get(`${prefix}:${id}`)
    if (kept) held.push(kept)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const batch = source.findNeurons({ ...datasetRequest(dataset), neuronIds: missing })
    for (const id of missing) {
      held.push(memoPromise(lookups, `${prefix}:${id}`, () => batch, { keep: 'resolved' }))
    }
  }
  // One table per request that answered, each cut to the ids asked about now.
  const tables = [...new Set(await Promise.all(held))]
  return concatBatches(tables.map((table) => rowsWithIds(table, ids)))
}

/**
 * The colours a source published for these segments, as `colorFields` writes them: one default
 * where every segment has the same one (fish2's project colours all 129,325 orange, at ~40 bytes a
 * segment of link to say so), a map otherwise. Undefined where it published none.
 */
function placedColors(
  placed: ReadonlyMap<string, SegmentPlacement>,
  segments: readonly string[],
): ReturnType<typeof colorFields> | undefined {
  const map: Record<string, string> = {}
  let count = 0
  let same: string | undefined
  for (const id of segments) {
    const color = placed.get(id)?.color
    if (!color) continue
    map[id] = color
    same = count++ === 0 || same === color ? color : undefined
  }
  if (count === 0) return undefined
  return same && count === segments.length
    ? { segmentDefaultColor: same }
    : { segmentColors: map }
}

/**
 * How the resolved colours are written into the layer, which differs by mode.
 *
 * `default` sends none at all and lets neuroglancer hash-colour each segment. A constant goes
 * in one field rather than repeated per segment — the map form costs ~40 bytes a neuron to say
 * the same thing two hundred times. Only a data-driven encoding needs the map.
 */
function colorFields(
  spec: ReturnType<typeof readColorSpec>,
  colors: Readonly<Record<string, string>>,
): { segmentColors?: Record<string, string>; segmentDefaultColor?: string } {
  if (spec.mode === 'default') return {}
  // From the spec, not from a row: the first segment can be one added in the viewer, which no row
  // coloured, and an empty input has no rows at all.
  if (spec.mode === 'constant') {
    return { segmentDefaultColor: constantColor(spec, VIEWER_MODE) }
  }
  return { segmentColors: { ...colors } }
}

/**
 * Neuron ids and their colours, in table order.
 *
 * Row order is preserved and duplicates keep their first colour, so the assignment matches
 * what the same encoding would draw in the 3D view — `resolveColor` ranks categories by
 * frequency over the whole column, which only agrees if it sees the whole column. Hence
 * resolving first and truncating after.
 */
function segmentColors(
  neurons: TableValue | undefined,
  spec: ReturnType<typeof readColorSpec>,
  limit: number,
  ctx: Warner,
): { segments: string[]; colors: Record<string, string>; dropped: number } {
  if (!neurons) return { segments: [], colors: {}, dropped: 0 }

  const resolved = resolveColor(neurons, spec, VIEWER_MODE)
  const ids = neurons.data['neuronId']
  if (!ids) throw new Error('Neurons input has no neuronId column')

  const segments: string[] = []
  const colors: Record<string, string> = {}
  /** Rows that held something, but not something a segment id can be made of. */
  let unreadable = 0
  /** Rows with no id at all — not worth a sentence, but not shown either. */
  let blank = 0
  for (let row = 0; row < neurons.length; row++) {
    const raw = ids[row]
    if (raw === null || raw === undefined) {
      blank++
      continue
    }
    /*
     * `idText` and then neuroglancer's own grammar, where this was `String(raw)`.
     *
     * Two failures, and the second is the expensive one. `String` on a wide `i64` cell prints
     * `1e+21`, which is invariant 8 exactly: a confident wrong id with nothing to say so.
     * `idText` refuses that instead of printing it. And a cell that is a *label* rather than an
     * id — `LC4`, a blank, a decimal — reaches the scene as a segment, where the viewer does not
     * skip it: `parseUint64` throws inside the layer's own restore, the layer is deleted before
     * it finished initialising, and the hover subscription it had already registered is left
     * behind throwing on every mouse movement for the rest of the session. One bad cell, and the
     * embed is dead until the frame is reloaded. See `isSegmentId`.
     */
    const id = idText(raw)
    if (id === null || !isSegmentId(id)) {
      unreadable++
      continue
    }
    if (colors[id] !== undefined) continue
    segments.push(id)
    colors[id] = resolved.at(row)
  }

  /*
   * Warned, not thrown — `docs/limits.md`'s rule, and it applies cleanly here: the scene is
   * perfectly good without those rows, and refusing would claim there is no useful answer when
   * most of the table is fine. What it must not do is stay quiet, because the alternative
   * reading of a short scene is that the neurons are missing meshes.
   */
  if (unreadable > 0) {
    ctx.warn(
      `${unreadable} of ${neurons.length} rows have an id neuroglancer cannot use and ` +
        `were left out. Neuroglancer only accepts ids that are plain whole numbers.`,
    )
  }

  /*
   * No throw on an empty result. An untouched Explore selection is empty, and a starter graph
   * opens in exactly that state — failing there would put an error on a node whose scene is
   * perfectly viewable.
   */
  if (segments.length > limit) {
    warnOverThreshold(ctx, {
      count: segments.length,
      threshold: limit,
      unit: 'neurons',
      control: "this node's Warn above",
      cost:
        'Nothing is downloaded, but neuroglancer draws every one and they all travel in ' +
        'the link, which some deployments and browsers cut off.',
    })
  }
  return { segments, colors, dropped: unreadable + blank }
}
