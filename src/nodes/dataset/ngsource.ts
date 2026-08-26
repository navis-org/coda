/**
 * Neuroglancer Source — a **datasource** rather than a dataset.
 *
 * The other nodes in this directory each stand for a connectome: neurons, connectivity, regions,
 * a published viewer state. This one stands for a single address holding a single kind of data,
 * which is what a neuroglancer layer's `source` field names. Paste one and the Meshes node can
 * fetch from it, with `Input IDs` supplying the segment ids — there is no neuron table to pick
 * them out of, and that is the difference the two words are drawing.
 *
 * ## Why it still emits `Dataset`
 *
 * Because `Meshes`, `Skeletons` and `ROI Meshes` take a Dataset socket and resolve
 * `dataset.sourceId` out of the registry, so a datasource that emits one plugs into all three
 * with no change to any of them. `SourceCapabilities` is what keeps that honest: almost
 * everything on `PrecomputedSource` is false, so the query nodes refuse rather than silently
 * answering with nothing. The word **Datasource** is on the output socket, which is where
 * somebody reading the canvas needs it.
 *
 * One consequence worth knowing rather than discovering: a canvas holding both a Dataset node and
 * one of these has *two* dataset producers, so `autoWireDataset` stops guessing and a newly added
 * query node arrives with an empty socket. That is the right answer — with a connectome and a
 * mesh bucket both on the canvas, which one a new Meshes node should read is a real question.
 *
 * ## `cheap`, and what that costs
 *
 * It resolves metadata and nothing else, so it belongs with the other dataset nodes: switching a
 * URL updates the downstream column pickers without waiting for a Run. The fetch behind it is
 * one small `info` per URL, memoised **including the failure** (see `precomputed/probe.ts`), so a
 * URL that 404s is asked once. What remains is one request per committed edit of the text field,
 * because each distinct URL is its own cache key — the same trade `Custom CAVE` makes for a
 * hand-typed datastack, held down by the param's debounce rather than by a special case here.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { DatasetValue, LayersValue, Value } from '../../core/values'
import { PRECOMPUTED } from '../../data/neuroglancer/sourceUrl'
import { peekPrecomputed } from '../../data/precomputed/probe'
import { precomputedSourceFor } from '../../data/precomputed/registry'
import { parseIdList } from '../lib/idList'

/** What the placeholder shows, and what the guide quotes. One spelling of the example. */
const EXAMPLE = 'precomputed://gs://flyem-male-cns/v1.0/segmentation/'

export const ngSourceNode = registerNode({
  type: 'dataset.ngsource',
  label: 'Neuroglancer Source',
  category: 'dataset',
  description: 'Read meshes, skeletons or region shells from a neuroglancer precomputed URL.',
  guide:
    'A single neuroglancer source — the string in a layer’s Source box — with two uses. Its ' +
    'Datasource output is something the Meshes, Skeletons and ROI Meshes nodes can fetch from, so ' +
    'a bucket no connectome server knows about is still usable. A source that publishes segment ' +
    'properties can also be browsed and queried by name; one that does not takes its ids from an ' +
    'Input IDs node. Its ' +
    'Layers output plugs into the Neuroglancer node’s Extra layers socket, which is how a brain ' +
    'shell, a second segmentation or somebody’s own annotations get into that scene — chain ' +
    'these nodes to add more than one. Paste any of the three spellings and the card says what ' +
    'it found at the other end.',
  cost: 'cheap',
  /*
   * The pairing `NodeDefinition.dataCache` documents: the Clear Cache button appears *and*
   * `evaluate` honours `ctx.refresh`. What it drops here is the probe's memo of an unreachable
   * URL — which is the only way back from a transient failure now that a run does not retry on
   * its own, and a node holding a stale refusal with no way to clear it is the
   * control-that-does-nothing this flag exists to prevent.
   */
  dataCache: true,
  inputs: [
    /*
     * How more than one extra layer reaches a scene, since an input port takes exactly one wire:
     * chain the nodes. `Datasource → Datasource → Neuroglancer` emits both layers in wiring
     * order, which is `Stack`'s answer to the same constraint.
     */
    { id: 'layers', label: 'Layers', type: T.layers(), required: false },
  ],
  outputs: [
    // "Datasource", not "Dataset": the socket label is where the distinction is read, since the
    // type is a Dataset by design — see the header.
    { id: 'dataset', label: 'Datasource', type: T.dataset() },
    { id: 'layers', label: 'Layers', type: T.layers() },
  ],
  params: [
    {
      id: 'url',
      kind: 'string',
      label: 'Source',
      default: '',
      placeholder: EXAMPLE,
      help:
        'A neuroglancer source URL. All of `gs://bucket/path`, `precomputed://gs://bucket/path` ' +
        'and `gs://bucket/path|neuroglancer-precomputed:` name the same directory. Point it at a ' +
        'segmentation and its mesh directory is followed automatically, or at the mesh ' +
        'directory itself.',
    },
    /*
     * Everything below is for the Layers output only, and all of it is `advanced` — the card's
     * job is the URL, and four more fields on it would bury the one thing that has to be right.
     * None of them is `presentational`: a layer is *the* output here, exactly as the URL is the
     * output of the Neuroglancer node, so a setting that changes one changes what this node
     * returns.
     */
    {
      id: 'layerName',
      kind: 'string',
      label: 'Layer name',
      default: '',
      advanced: true,
      placeholder: '(from the URL)',
      help: 'What the layer is called in neuroglancer. Empty names it after the last path segment. A name already in the scene is suffixed rather than silently replacing it.',
    },
    {
      id: 'layerType',
      kind: 'enum',
      label: 'Layer type',
      default: 'auto',
      advanced: true,
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'segmentation', label: 'Segmentation' },
        { value: 'image', label: 'Image' },
        { value: 'annotation', label: 'Annotation' },
      ],
      help: 'Automatic reads it off the source: an image volume becomes an image layer, meshes and skeletons a segmentation. Override it for a source whose `info` says something this build has not met.',
    },
    {
      id: 'segments',
      kind: 'string',
      label: 'Segments',
      default: '',
      advanced: true,
      placeholder: '720575940628857210, 720575940624... ',
      help: 'Segment ids to show in this layer, comma- or whitespace-separated. Empty shows the layer with nothing selected, which is the right thing for a brain shell or an EM volume.',
    },
    {
      id: 'settings',
      kind: 'string',
      label: 'Layer settings',
      default: '',
      multiline: true,
      advanced: true,
      placeholder: '{ "objectAlpha": 0.3, "segmentDefaultColor": "#88aacc" }',
      help: 'JSON merged over the generated layer, so anything neuroglancer accepts is reachable — opacity, colours, a shader. Your keys win over the generated ones.',
    },
  ],

  /*
   * Registering the source here is what makes the rest of the graph work at edit time: the type
   * carries a `sourceId`, and everything downstream — `schemasFromType`, `sourceSupports`, the
   * 3D viewer's colour picker — resolves that id out of the registry. Synchronous and
   * network-free, which is `neuPrintSourceFor`'s rule for the same call.
   */
  inferOutputs: (ctx) => {
    const source = precomputedSourceFor(String(ctx.params.url ?? ''))
    return {
      dataset: source ? T.dataset(source.id, source.datasetId) : T.dataset(),
      layers: T.layers(),
    }
  },

  validate: (ctx) => {
    const text = String(ctx.params.url ?? '').trim()
    if (!text) return [`Paste a neuroglancer source URL, e.g. ${EXAMPLE}`]

    /*
     * `parseIdList` rather than a split on commas, and the same reader `Input IDs` uses: the ids
     * for a layer come from exactly where its ids come from, so the paste is the same paste —
     * brackets, quotes, a spreadsheet header line. A bogus token written silently into somebody's
     * neuroglancer link is invariant 8's failure with nothing to report it.
     */
    const segments = parseIdList(ctx.params.segments)
    if (segments.error) return [segments.error]

    const settings = readSettings(ctx.params.settings)
    if (typeof settings === 'string') return [settings]

    /*
     * Through the registry rather than `parseNgSource` directly: `inferOutputs` has already
     * parsed this exact string on this exact mutation, and the source it registered is holding
     * the result. Parsing again is a dozen allocations per node per graph edit for an answer one
     * `Map.get` away.
     */
    const ref = precomputedSourceFor(text)?.ref
    if (!ref) return [`"${text}" is not a source URL`]
    if (ref.scheme !== PRECOMPUTED) {
      /*
       * `graphene` gets a sentence of its own because it is the one anybody will actually paste
       * here by mistake: it is what a CAVE segmentation layer's Source box says, it looks exactly
       * like a precomputed URL, and Coda has a whole backend for it one node over. Sending
       * somebody there is a better answer than naming the format and stopping.
       */
      return [
        ref.scheme === 'graphene'
          ? `That is a graphene:// segmentation, which is a CAVE datastack — use a CAVE dataset ` +
            `node for it. This node reads precomputed sources.`
          : `Coda reads precomputed sources; this one is ${ref.scheme}.`,
      ]
    }
    if (!ref.url) {
      return [
        `${ref.location} is not a location Coda can fetch from. Object stores (gs://, s3://) ` +
          `and plain https:// directories work.`,
      ]
    }

    /*
     * Undefined means the probe has not landed, which is the ordinary state on a fresh session
     * and is deliberately silent — the same silence `versionsFor` keeps for a listing in flight.
     * Reporting it would put a warning on every one of these cards for the first second of every
     * load.
     */
    const probe = peekPrecomputed(ref.url)
    if (!probe) return []
    if (!probe.ok) return [`Could not read ${ref.location}: ${probe.error}`]
    if (!probe.source.meshUrl) {
      /*
       * A warning rather than the end of the story, and the wording says which half is affected:
       * an image volume or an annotation source has nothing for `Meshes` and is a perfectly good
       * **layer**, which is the other thing this node emits.
       */
      return [
        `${ref.location} is ${probe.source.summary} — there is no geometry here for a Meshes ` +
          `node, though it still works as a Neuroglancer layer.`,
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    const text = String(ctx.params.url ?? '').trim()
    if (!text) throw new Error(`Paste a neuroglancer source URL, e.g. ${EXAMPLE}`)
    const source = precomputedSourceFor(text)
    if (!source) throw new Error(`"${text}" is not a source URL`)

    /*
     * `retry` comes from **Clear Cache**, not from every run.
     *
     * It used to be unconditional here, on the reasoning that `evaluate` runs only when the URL
     * changes. That is wrong for the case it matters in: a node whose `evaluate` *throws* is not
     * cached, so it re-runs on every auto pass — and an unreachable URL then re-requested itself
     * a few times a second, which is invariant 6's hazard arriving by the back door. `validate`
     * cannot stop it either; its strings are warnings, not errors.
     *
     * So the failure memo is honoured like any other cache, and the sanctioned escape hatch is
     * the one control that already means "drop what you are holding and read again". A success is
     * never re-read regardless — a published `info` does not change under a fixed URL.
     */
    const described = await source.describe({
      ...(ctx.refresh ? { retry: true } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

    const dataset: DatasetValue = {
      kind: 'dataset',
      sourceId: source.id,
      datasetId: source.datasetId,
      // The summary rides in the label, because this card has no version dropdown and no
      // Description companion to say what was found — "flyem-male-cns/segmentation ·
      // segmentation · full-resolution meshes" is the whole of what a downstream node can show.
      label: `${source.label} · ${described.summary}`,
    }

    const settings = readSettings(ctx.params.settings)
    if (typeof settings === 'string') throw new Error(settings)
    const parsed = parseIdList(ctx.params.segments)
    if (parsed.error) throw new Error(parsed.error)
    const segments = parsed.ids

    const layer = {
      type: layerTypeFor(String(ctx.params.layerType ?? 'auto'), described.kind, described.volumeType),
      name: String(ctx.params.layerName ?? '').trim() || source.label.split('/').pop() || 'layer',
      // The canonical spelling, which is why `parseNgSource` keeps the location in its own
      // scheme: neuroglancer wants `precomputed://gs://…` back, not the storage.googleapis.com
      // URL Coda fetches through.
      source: source.ref.canonical,
      // Absent rather than empty: the two are different to neuroglancer, and "show this layer
      // with nothing selected" is what a brain shell or an EM volume wants.
      ...(segments.length ? { segments } : {}),
      // Last, so they win. That is the whole point of the field: anything neuroglancer accepts is
      // reachable without this node having to grow a control for it.
      ...settings,
    }

    const upstream = ctx.input('layers')
    const layers: LayersValue = {
      kind: 'layers',
      items: [...layersFrom(upstream), layer],
    }
    return { dataset, layers }
  },
})

/** Layers arriving on the chaining input, or none. */
function layersFrom(value: Value | undefined): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return value?.kind === 'layers' ? value.items : []
}

/**
 * The settings blob as an object, or a **string saying what is wrong with it**.
 *
 * One function returning both because both callers need both halves and they must agree: the card
 * reports the problem at edit time and `evaluate` refuses on it, and a separate checker beside a
 * separate parser is two `JSON.parse`s of one string that can disagree about what counts as
 * valid. Edit time matters here more than on most fields, because this is the one whose mistake
 * is a typo — a missing brace contributing nothing silently looks exactly like a setting
 * neuroglancer ignored.
 */
function readSettings(raw: unknown): Record<string, unknown> | string {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return `Layer settings is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Layer settings must be a JSON object, e.g. { "objectAlpha": 0.3 }'
  }
  return parsed as Record<string, unknown>
}

/**
 * The layer `type` neuroglancer needs, chosen or derived.
 *
 * Derived from what the source turned out to be rather than from the URL, which cannot tell you:
 * `…/segmentation` and `…/aligned` are directory names, and the `info` is the only thing that
 * says which holds what. `segmentation` is the fallback because it is the one that draws meshes
 * and skeletons — the two things this node exists to reach.
 */
function layerTypeFor(chosen: string, kind: string, volumeType: string | undefined): string {
  if (chosen !== 'auto') return chosen
  if (kind === 'annotations') return 'annotation'
  if (kind === 'volume' && volumeType === 'image') return 'image'
  return 'segmentation'
}
