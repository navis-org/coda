/**
 * Neuroglancer viewer node.
 *
 * Takes a dataset and a neuron table and emits a **URL**: the dataset's own published
 * neuroglancer scene, pointed at those body ids and coloured by a column. The widget beside
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

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, str } from '../../core/values'
import type { NgLayerSet, NgLayout } from '../../data/neuroglancer/scene'
import { DEFAULT_NEUROGLANCER_URL, buildScene, sceneUrl } from '../../data/neuroglancer/scene'
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
 * Ceiling on the segment count.
 *
 * A different guard rail from the morphology nodes' `Max neurons`, which bounds what *Coda*
 * fetches. Nothing is fetched here — the cost is neuroglancer's own mesh loading plus URL
 * length, and the URL is the harder limit in practice: male-CNS publishes a 38 kB state
 * before a single body id is added, and each coloured segment costs ~40 bytes more.
 */
const MAX_SEGMENTS = 1000

/** Neuroglancer renders on black, so the dark palette is the right one whatever Coda's theme is. */
const VIEWER_MODE = 'dark' as const

export const neuroglancerNode = registerNode({
  type: 'out.neuroglancer',
  label: 'Neuroglancer',
  category: 'visualisation',
  description: "Open the incoming neurons in the dataset's own neuroglancer scene.",
  guide:
    'Opens the incoming neurons in the dataset’s own published neuroglancer scene — the EM volume, the region meshes and the synapse layers that scene already carries, with your neurons added to it. The node emits a URL and the card embeds it, so it is both a viewer and something to paste into an email. Every setting is inspector-only, because a row of pickers above a 400-pixel embed takes a tenth of the space somebody opened the node for.',
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
      from: 'neurons',
      label: 'Colour',
      defaultMode: 'categorical',
      // Not the first compatible column, which is `bodyId`: colouring by it caps at eight
      // slots plus grey, so two unrelated neurons share a hue and look like a group.
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
      help: 'Everything the dataset publishes — EM, ROI meshes, synapses — or just the neurons. Neurons-only makes a far shorter link; male-CNS publishes 38 layers.',
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
    {
      id: 'limit',
      kind: 'int',
      label: 'Max neurons',
      default: 200,
      min: 1,
      max: MAX_SEGMENTS,
      step: 10,
      advanced: true,
      help: 'Nothing is downloaded here — this bounds how much neuroglancer is asked to draw, and how long the link gets.',
    },
    {
      id: 'viewer',
      kind: 'string',
      label: 'Viewer',
      default: DEFAULT_NEUROGLANCER_URL,
      advanced: true,
      placeholder: DEFAULT_NEUROGLANCER_URL,
      help: 'Which neuroglancer deployment to open. The whole scene travels in the URL fragment, so this instance never sees your data — but it must allow being embedded.',
    },
  ],

  validate: (ctx) => {
    const issues: string[] = []
    if (ctx.inputs.dataset && !sourceSupports(ctx, 'viewerScene')) {
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

    const limit = Number(ctx.params.limit ?? 200) || 200
    const spec = readColorSpec('segment', ctx.params, ctx.column)
    const { segments, colors } = segmentColors(neurons, spec, limit)

    const published = await source.fetchViewerScene({
      datasetId: dataset.datasetId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!published) {
      throw new Error(
        `${dataset.label} publishes no neuroglancer scene, so there is nothing to point a viewer at.`,
      )
    }

    const scene = buildScene(published, {
      datasetId: dataset.datasetId,
      segments,
      ...colorFields(spec.mode, segments, colors),
      layout: String(ctx.params.layout ?? '3d') as NgLayout,
      layers: String(ctx.params.layers ?? 'all') as NgLayerSet,
      showSlices: ctx.params.showSlices === true,
    })

    return { url: str(sceneUrl(String(ctx.params.viewer ?? ''), scene)) }
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
 * Body ids and their colours, in table order.
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
): { segments: string[]; colors: Record<string, string> } {
  if (!neurons) return { segments: [], colors: {} }

  const resolved = resolveColor(neurons, spec, VIEWER_MODE)
  const ids = neurons.data['bodyId']
  if (!ids) throw new Error('Neurons input has no bodyId column')

  const segments: string[] = []
  const colors: Record<string, string> = {}
  for (let row = 0; row < neurons.length; row++) {
    const raw = ids[row]
    if (raw === null || raw === undefined) continue
    const id = String(raw)
    if (colors[id] !== undefined) continue
    segments.push(id)
    colors[id] = resolved.at(row)
  }

  /*
   * No throw on an empty result. An untouched Explore selection is empty, and a starter graph
   * opens in exactly that state — failing there would put an error on a node whose scene is
   * perfectly viewable.
   */
  if (segments.length > limit) {
    throw new Error(
      `${segments.length} neurons exceeds this node's Max neurons (${limit}). Nothing is ` +
        `downloaded here, but neuroglancer has to draw every one and they all travel in the ` +
        `link. Raise the limit if you mean it, or filter upstream.`,
    )
  }
  return { segments, colors }
}
