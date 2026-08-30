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
 * No `Selected` output: an iframe on a foreign origin cannot be read, so unlike the network
 * and 3D viewers this one is genuinely one-way. Picking neurons stays upstream.
 */

import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import { warnAboveParam } from '../lib/limitParams'
import { registerNode } from '../../core/registry'
import type { ParamValues } from '../../core/node'
import { idText } from '../../core/ids'
import { T } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, str } from '../../core/values'
import type { NgLayerSet, NgLayout, ViewerKind } from '../../data/neuroglancer/scene'
import {
  DEFAULT_NEUROGLANCER_URL,
  buildScene,
  isSegmentId,
  sceneUrl,
  viewerBaseFor,
} from '../../data/neuroglancer/scene'
/*
 * The one import from `src/ui` in the node pack, and it is the palette resolver on purpose:
 * "never re-implement colour mapping in a viewer" applies just as much to an external one.
 * Reusing it is what makes a neuron the same colour in the 3D view and in neuroglancer.
 * Both modules are pure — no DOM, no React — so this stays testable headlessly.
 */
import { resolveColor } from '../../ui/encoding'
import { requireDataset, sourceSupports } from '../lib/datasetParam'
import type { ColorMode } from '../lib/encodingParams'
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
const SEGMENTS_WARN = 10000

/** Neuroglancer renders on black, so the dark palette is the right one whatever Coda's theme is. */
const VIEWER_MODE = 'dark' as const

/**
 * The `Viewer type` param as a kind, or undefined for "work it out".
 *
 * One statement because two surfaces read it: this node, which bakes the answer into the URL,
 * and `ValuePreview`, which hands it to the embedded frame. The frame cannot recover it from the
 * URL — `sceneForViewer` *normalises*, so re-deriving from the host would strip an explicit
 * override back out, which is the whole of what the escape hatch is for.
 */
export function chosenViewerKind(params: ParamValues): ViewerKind | undefined {
  const chosen = String(params.viewerType ?? 'auto')
  return chosen === 'auto' ? undefined : (chosen as ViewerKind)
}

export const neuroglancerNode = registerNode({
  type: 'out.neuroglancer',
  label: 'Neuroglancer',
  category: 'visualisation',
  description: "View neurons in the dataset's own neuroglancer scene.",
  guide:
    'View neurons in the dataset’s own published neuroglancer scene — the EM volume, the region ' +
    'meshes and the synapse layers that scene already carries, with your neurons added to it. ' +
    'Emits a URL that works both as a viewer and as a shareable link, and the card embeds it. ' +
    'Every setting is inspector-only, so the embed keeps the space somebody opened the node for.',
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
  outputs: [{ id: 'url', label: 'Link', type: T.string() }],
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
      // useful and the shortest link there is: no colour data travels at all.
      allowDefault: { label: "neuroglancer's own" },
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
      help: 'How much of what the *dataset* publishes to carry — EM, ROI meshes, synapses — or just the neurons. Neurons-only makes a far shorter link; male-CNS publishes 38 layers. Anything on the Extra layers socket is added either way: you wired it up, so it is not published context to trim.',
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
       * The one presentational param here, and it earns it: it scales the *frame*, so it
       * cannot change a byte of the URL. Deliberately not called "zoom" — neuroglancer has a
       * camera zoom of its own and two things by that name on one card is a trap.
       *
       * Below 1 the frame is laid out larger and drawn smaller, so neuroglancer's toolbar and
       * panels take less of the card and the scene gets the room. It also means more pixels
       * to render, which is the trade at the bottom of the range.
       */
      help: "Scales neuroglancer's whole frame, so its toolbar and panels take up less of the card. Nothing to do with the camera zoom inside it.",
      default: 0.75,
      min: 0.5,
      max: 1.5,
      step: 0.05,
      presentational: true,
      advanced: true,
    },
    {
      id: 'showSlices',
      kind: 'boolean',
      label: 'Section planes',
      default: false,
      advanced: true,
      help: 'Draw the EM cross-sections inside the 3D panel. Off by default: they cut through the meshes.',
    },
    warnAboveParam({
      threshold: SEGMENTS_WARN,
      min: 1,
      cost:
        'the scene is built either way, and what it costs is neuroglancer’s own drawing plus ' +
        'the length of the link.',
    }),
    {
      id: 'viewer',
      kind: 'string',
      label: 'Viewer',
      // Empty rather than the constant, so the *dataset's* own deployment can win — see
      // `evaluate`. A graph saved with the old explicit default keeps pointing where it did.
      default: '',
      advanced: true,
      placeholder: DEFAULT_NEUROGLANCER_URL,
      help: 'Which neuroglancer deployment to open. Empty uses the one the dataset names, and otherwise the default above. The whole scene travels in the URL fragment, so the instance never sees your data, but it must allow being embedded.',
    },
    {
      id: 'viewerType',
      kind: 'enum',
      label: 'Viewer type',
      default: 'auto',
      advanced: true,
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'spelunker', label: 'Spelunker / mainline' },
        { value: 'seunglab', label: 'Seung-lab (FlyWire, NeuVue)' },
      ],
      /*
       * The escape hatch for a deployment `viewerKind`'s table has not met. `Viewer` is free
       * text, so the table can never be complete, and a wrong answer here is a scene that opens
       * with no segmentation in it and nothing naming the cause — which has happened once
       * already, in the other direction.
       */
      help: 'How a CAVE segmentation is authenticated. Spelunker builds need a middleauth+ prefix on the source; the Seung-lab fork runs its own login and refuses it. Automatic reads it off the deployment, and is right for every viewer this app knows about.',
    },
  ],

  validate: (ctx) => {
    const issues: string[] = []
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

    const limit = Number(ctx.params.limit ?? SEGMENTS_WARN) || SEGMENTS_WARN
    const spec = readColorSpec('segment', ctx.params, ctx.column)
    const { segments, colors } = segmentColors(neurons, spec, limit, ctx)

    const published = await source.fetchViewerScene({
      datasetId: dataset.datasetId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!published) {
      throw new Error(
        `${dataset.label} publishes no neuroglancer scene, so there is nothing to point a viewer at.`,
      )
    }

    const extra = ctx.input('layers')
    if (extra !== undefined && extra.kind !== 'layers') {
      throw new Error('Extra layers input is not a layer set')
    }

    const scene = buildScene(published, {
      datasetId: dataset.datasetId,
      segments,
      ...colorFields(spec.mode, segments, colors),
      layout: String(ctx.params.layout ?? '3d') as NgLayout,
      layers: String(ctx.params.layers ?? 'all') as NgLayerSet,
      showSlices: ctx.params.showSlices === true,
      ...(extra ? { extraLayers: extra.items } : {}),
    })

    const viewer = viewerBaseFor(
      String(ctx.params.viewer ?? ''),
      source.peekDataset(dataset.datasetId)?.viewerSite,
    )
    return { url: str(sceneUrl(viewer, scene, chosenViewerKind(ctx.params))) }
  },
})

/**
 * How the resolved colours are written into the layer, which differs by mode.
 *
 * `default` sends none at all and lets neuroglancer hash-colour each segment. A constant goes
 * in one field rather than repeated per segment — the map form costs ~40 bytes a neuron to say
 * the same thing two hundred times. Only a data-driven encoding needs the map.
 */
function colorFields(
  mode: ColorMode,
  segments: readonly string[],
  colors: Readonly<Record<string, string>>,
): { segmentColors?: Record<string, string>; segmentDefaultColor?: string } {
  if (mode === 'default') return {}
  if (mode === 'constant') {
    const flat = colors[segments[0] ?? '']
    return flat ? { segmentDefaultColor: flat } : {}
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
): { segments: string[]; colors: Record<string, string> } {
  if (!neurons) return { segments: [], colors: {} }

  const resolved = resolveColor(neurons, spec, VIEWER_MODE)
  const ids = neurons.data['neuronId']
  if (!ids) throw new Error('Neurons input has no neuronId column')

  const segments: string[] = []
  const colors: Record<string, string> = {}
  /** Rows that held something, but not something a segment id can be made of. */
  let unreadable = 0
  for (let row = 0; row < neurons.length; row++) {
    const raw = ids[row]
    if (raw === null || raw === undefined) continue
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
      `${unreadable} of ${neurons.length} rows have an id neuroglancer cannot use, so they ` +
        `are left out of the scene. It takes plain whole numbers only, and one it cannot read ` +
        `costs the whole layer rather than the one neuron.`,
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
        'Nothing is downloaded here, but neuroglancer has to draw every one and they all ' +
        'travel in the link, which some deployments and some browsers will cut off.',
    })
  }
  return { segments, colors }
}
