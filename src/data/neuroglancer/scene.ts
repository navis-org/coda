/**
 * Neuroglancer scenes: read the one a dataset publishes, point it at a set of segments, and
 * turn it back into a URL.
 *
 * This knows nothing about neuPrint. A neuroglancer state is an artefact of the *dataset* —
 * FlyWire and CAVE publish them too — so it sits beside `precomputed/` rather than inside
 * `neuprint/`, and the neuPrint half is one endpoint call in `neuprint/nglayers.ts`.
 *
 * **A published scene is edited, never rebuilt.** The curated camera, the ROI meshes, the
 * synapse layers and the EM volume are the entire reason to reuse it; a hand-rolled state
 * would be a segmentation layer floating in space. Only what has to change is changed.
 *
 * The states are not uniform, which is why this is a module and not a template. Checked
 * against the live endpoint:
 *
 *   hemibrain:v1.2.1  `{ layers }` and nothing else — no dimensions, position or layout
 *   hemibrain:v1.1    `{ layers, badlayers }` — `badlayers` is neuPrint Explorer bookkeeping
 *   manc:v1.2.3       full state, 11 layers, `layout: "3d"`, `showSlices: false`
 *   optic-lobe:v1.1   full state, 17 layers
 *   male-cns:v0.9     full state, 38 layers, 38 kB of JSON before a single neuron is added
 *
 * Two consequences worth keeping. Datasets that publish no camera need `layout` and
 * `showSlices` supplied, or neuroglancer opens hemibrain in 4-panel with EM planes cutting
 * through the neurons. And male-CNS is the reason `layers: 'segmentation'` exists: 38 kB of
 * curated context is worth having until you want to paste the link somewhere.
 */

import { uniqueName } from '../../core/types'

/** A neuroglancer viewer state. Opaque apart from the handful of keys touched here. */
export type NgScene = Readonly<Record<string, unknown>>

interface NgLayer {
  type?: string
  name?: string
  [key: string]: unknown
}

/**
 * The public instance to embed.
 *
 * Janelia's own Explorer links here, it sends neither `X-Frame-Options` nor a CSP
 * `frame-ancestors`, so it can be iframed — verified against the live response headers.
 */
export const DEFAULT_NEUROGLANCER_URL = 'https://neuroglancer-demo.appspot.com'

export type NgLayout = '3d' | '4panel' | 'xy-3d' | 'xy'

/** Layers to carry over from the published scene. */
export type NgLayerSet = 'all' | 'segmentation'

export interface SceneOptions {
  /** Dataset id, used to find the layer holding this dataset's neurons. */
  datasetId: string
  /** Segment (body) ids to display. */
  segments: readonly (number | string)[]
  /**
   * Per-segment `#rrggbb`. Omit for a single-colour scene and pass `segmentDefaultColor`
   * instead — a map repeating one colour 500 times is 15 kB of URL saying nothing.
   */
  segmentColors?: Readonly<Record<string, string>> | undefined
  segmentDefaultColor?: string | undefined
  layout?: NgLayout | undefined
  layers?: NgLayerSet | undefined
  /** Cross-section planes inside the 3D panel. Off unless asked for; they hide the meshes. */
  showSlices?: boolean | undefined
  /**
   * Layers to add to the published ones — what a `Neuroglancer Source` node contributes.
   *
   * **Appended, never merged in.** Order in this list is neuroglancer's draw and panel order, and
   * a published scene is somebody's curated arrangement; inserting into it would reorder theirs.
   * Added *after* `layers: 'segmentation'` has done its filtering, too: that option is about how
   * much of the *published* scene to carry, and a layer somebody wired up explicitly is not
   * published context to be trimmed.
   */
  extraLayers?: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined
}

/**
 * Keys a published state carries that are not part of neuroglancer's own schema.
 *
 * `badlayers` is neuPrint Explorer's note-to-self about layers it knows are broken. Passing
 * it on is harmless in practice but it is not viewer state, and stripping it keeps the URL
 * honest about what it is.
 */
const NON_VIEWER_KEYS = ['badlayers']

function layerList(scene: NgScene): NgLayer[] {
  const raw = scene['layers']
  if (!Array.isArray(raw)) return []
  return raw.filter((layer): layer is NgLayer => Boolean(layer) && typeof layer === 'object')
}

/**
 * Index of the layer holding the dataset's own neurons, as an index into `layerList`.
 *
 * Matched by name, exactly as the mesh-source resolver does: every state checked names that
 * layer after the dataset (`manc:v1.2.3`), and the *other* segmentation layers are ROI
 * shells, nuclei and cross-dataset mesh overlays — male-CNS ships thirty of them, and
 * writing neuron ids into `brain-shell` would display nothing with no visible cause.
 *
 * Falling back to the first segmentation layer keeps a differently-named state usable.
 * Returns -1 when the scene has no segmentation layer at all.
 */
export function segmentationLayerIndex(scene: NgScene, datasetId: string): number {
  const layers = layerList(scene)
  const family = datasetId.split(':')[0] ?? datasetId
  const named = layers.findIndex(
    (layer) =>
      layer.type === 'segmentation' &&
      typeof layer.name === 'string' &&
      layer.name.startsWith(family),
  )
  if (named >= 0) return named
  return layers.findIndex((layer) => layer.type === 'segmentation')
}

/**
 * Point a published scene at a set of segments.
 *
 * Pure: the input scene is never mutated, since it is cached per dataset by the source and
 * shared by every node that asks for it.
 */
export function buildScene(published: NgScene | undefined, options: SceneOptions): NgScene {
  const base: NgScene = published ?? {}
  const layers = layerList(base)
  const target = segmentationLayerIndex(base, options.datasetId)
  const segments = options.segments.map(String)

  const decorated = layers.map((layer, index) => {
    if (index !== target) return layer
    const colors = options.segmentColors
    return {
      ...layer,
      segments,
      // Explicitly cleared rather than left behind: manc publishes a `segmentColors` entry
      // for one body, which would otherwise survive as a stray colour nobody chose.
      ...(colors && Object.keys(colors).length > 0
        ? { segmentColors: colors }
        : { segmentColors: {} }),
      ...(options.segmentDefaultColor
        ? { segmentDefaultColor: options.segmentDefaultColor }
        : {}),
    }
  })

  const kept =
    options.layers === 'segmentation' && target >= 0
      ? decorated.filter((_, index) => index === target)
      : decorated

  const scene: Record<string, unknown> = { ...base }
  for (const key of NON_VIEWER_KEYS) delete scene[key]

  scene['layers'] = [...kept, ...withUniqueNames(options.extraLayers ?? [], kept)]
  scene['layout'] =
    options.layout ?? (typeof base['layout'] === 'string' ? base['layout'] : '3d')
  scene['showSlices'] =
    options.showSlices ?? (typeof base['showSlices'] === 'boolean' ? base['showSlices'] : false)

  /*
   * Two defaults a published scene gets wrong for an *embedded* viewer, overridden rather than
   * offered as options because there is no version of these worth opting into.
   *
   * The axis lines are drawn through the middle of the volume and read as anatomy at a glance.
   * And MANC and male-CNS both publish `selectedLayer.visible: true`, which opens the layer
   * side panel over a third of a card already smaller than the browser window those states
   * were framed for.
   *
   * Neither is in `SCENE_PATCH_KEYS`, and that is the point: they are *opening* defaults, so a
   * later update merges without slamming shut a panel the user has since opened.
   */
  scene['showAxisLines'] = false
  const selected = base['selectedLayer']
  if (selected && typeof selected === 'object') {
    // Keep the panel's width and which layer it points at; only force it shut.
    scene['selectedLayer'] = { ...(selected as Record<string, unknown>), visible: false }
  }

  return scene
}

/**
 * Extra layers renamed where they would collide with something already in the scene.
 *
 * Neuroglancer keys layers by name and a duplicate is not a merge — the second one wins and the
 * first becomes unreachable, silently. Names here are whatever somebody typed on a node card, so
 * a scene that already publishes `segmentation` and a datasource left on its default is not an
 * unusual case; it is the first one anybody will hit.
 *
 * Suffixed rather than refused, because the name is a label rather than an identity: nothing
 * downstream looks a layer up by it except `ownedLayerNames`, which reads the name back off the
 * scene this produced.
 *
 * The suffixing itself is `uniqueName` from `core/types.ts`, which calls itself "the one statement
 * of Coda's collision rule" and records that the two hand-rolled copies before it had already
 * parted company on the case that matters. A third loop here would be the same bet again for the
 * sake of a space instead of an underscore.
 */
function withUniqueNames(
  extras: ReadonlyArray<Readonly<Record<string, unknown>>>,
  kept: readonly NgLayer[],
): Array<Record<string, unknown>> {
  const taken = new Set(
    kept.map((layer) => layer.name).filter((name): name is string => typeof name === 'string'),
  )
  return extras.map((layer) => {
    const wanted = typeof layer['name'] === 'string' && layer['name'] ? layer['name'] : 'layer'
    return { ...layer, name: uniqueName(taken, wanted) }
  })
}

/**
 * A viewer URL for a scene.
 *
 * Neuroglancer reads its whole state from the fragment, which is why this needs no server
 * and no CORS: the bytes never leave the browser until the iframe navigates. The JSON is
 * percent-encoded because a raw state contains `#` (every colour) and `"`.
 *
 * This is the *replacing* form: neuroglancer calls `reset()` before restoring it, so it
 * discards the camera, the panel layout and every runtime tweak. Use `scenePatchUrl` for an
 * update to a viewer someone is already looking through.
 */
/**
 * Which deployment to open, given what somebody chose and what the dataset asks for.
 *
 * One resolver because there are two consumers and they had already drifted: `out.neuroglancer`
 * learned to prefer the dataset's own viewer and `NeuroglancerProfileFrame` did not, so the
 * Profile 3D tile on a CAVE dataset drew the EM volume with no segmentation in it — precisely
 * the failure `DatasetInfo.viewerSite` exists to prevent, on the other one of its two callers.
 *
 * Empty means the dataset's own and then the built-in default, which `sceneUrl` applies. A CAVE
 * segmentation is `graphene://middleauth+…`, which only a spelunker-flavoured viewer
 * authenticates.
 */
export function viewerBaseFor(
  chosen: string | undefined,
  viewerSite: string | undefined,
): string {
  return chosen?.trim() || viewerSite || ''
}

/**
 * Which flavour of neuroglancer a deployment is, because they disagree about one prefix.
 *
 * `middleauth+` on a graphene source is **not** universal, which is what this used to assume.
 * It is spelunker's, and caveclient says so in a fork nothing in the transcription noticed:
 * `output_map` routes `"neuroglancer"` to `format_graphene` (plain) and
 * `"cave-explorer"`/`"spelunker"` to `format_verbose_graphene` (prefixed), and
 * `build_neuroglancer_url` sets `auth_text = ""` for `seunglab` against `"middleauth+"` for the
 * rest. A seunglab-flavoured viewer runs its own login and **refuses** the prefix; a spelunker
 * one needs it or the segmentation layer is present and empty.
 *
 * caveclient decides by fetching `<viewer>/version.json` — 404 on a seunglab fork, 200 on the
 * others. Coda cannot: measured against both deployments, **that endpoint sends no
 * `Access-Control-*` headers at all**, so a browser can never read it. Hence a table, which is
 * also what makes the answer synchronous everywhere it is needed.
 *
 * Unknown is read as spelunker, deliberately: the seunglab fork is a small enumerable set of
 * lab deployments, where anything built on google's neuroglancer since is the other one — and
 * `out.neuroglancer`'s `Viewer type` is the escape hatch for a host this table has not met.
 */
export type ViewerKind = 'spelunker' | 'seunglab'

/**
 * Deployments running the Seung-lab fork, **measured rather than assumed** — each 404s on
 * `version.json`, which is caveclient's own test:
 *
 *   ngl.flywire.ai             404  seunglab
 *   neuroglancer.neuvue.io     404  seunglab   (caveclient's own `fallback_ngl_url`)
 *   neuroglancer.bossdb.io     404  seunglab
 *   spelunker.cave-explorer.org 200 spelunker
 *   ngl.cave-explorer.org      200  spelunker
 *   ngl.microns-explorer.org   200  spelunker
 *   neuroglancer-demo.appspot.com 200 spelunker  (`DEFAULT_NEUROGLANCER_URL`)
 *
 * `ngl.cave-explorer.org` is on that list for a reason: it was guessed into the seunglab set on
 * the strength of its name and is not one. The names do not tell you.
 *
 * `ngl.flywire.ai` is the entry that matters — it is `flywire_fafb_public`'s published
 * `viewer_site`, so it is what a FlyWire Neuroglancer node opens with nothing configured.
 */
const SEUNGLAB_HOSTS: ReadonlySet<string> = new Set([
  'ngl.flywire.ai',
  'neuroglancer.neuvue.io',
  'neuroglancer.bossdb.io',
])

/**
 * Ask this about the deployment somebody chose, never about a same-origin proxy path — `/ng` is
 * a path on *this* origin and names no deployment at all. `NeuroglancerViewer` is the one caller
 * that rewrites a base for proxying, and it passes the kind of the base it started from rather
 * than of the path it produced.
 */
export function viewerKind(viewerBase: string | undefined): ViewerKind {
  let host: string
  try {
    host = new URL(viewerRoot(viewerBase)).hostname
  } catch {
    return 'spelunker'
  }
  return SEUNGLAB_HOSTS.has(host) ? 'seunglab' : 'spelunker'
}

/**
 * A graphene source carrying the prefix this viewer wants, and not the one it does not.
 *
 * Normalising rather than only adding, so the answer does not depend on what the source
 * happened to arrive as: a published state somebody hand-wrote, or a datastack that names its
 * segmentation with the prefix already on it, both come out right. Only `graphene://` is
 * touched — caveclient prefixes `precomputed://` sources only for the annotation and
 * segment-property URLs CAVE serves itself, and neither appears in a scene built here.
 */
function grapheneFor(source: string, kind: ViewerKind): string {
  const rest = source.slice(GRAPHENE.length).replace(/^middleauth\+/, '')
  return kind === 'seunglab' ? `${GRAPHENE}${rest}` : `${GRAPHENE}middleauth+${rest}`
}

const GRAPHENE = 'graphene://'

/**
 * What a segmentation layer is *called*, which the two flavours also disagree about.
 *
 * The Seung-lab fork has a layer type of its own for a chunked-graph source —
 * `segmentation_with_graph`, carrying the proofreading tools a plain segmentation has no use
 * for — and it warns when it is handed a graphene source under the plain name:
 *
 *     The layer specification for graphene://… is deprecated.
 *     Key 'layerType' must be 'segmentation_with_graph'. Please reload this page.
 *
 * That banner sits along the bottom of the viewer and only a **document reload** clears it, so
 * on a node card it costs a real share of the drawing until somebody reloads the whole app.
 *
 * `nglui` is the reference and its rule is the source scheme rather than the datastack:
 * `_smart_add_segmentation_layer` builds a `ChunkedgraphSegmentationLayer` (which is
 * `type="segmentation_with_graph"`) for a `graphene://` source and a plain `SegmentationLayer`
 * for `precomputed://`. Mainline knows no such type, and nglui 4.x — which targets spelunker
 * only — emits `segmentation` throughout, so this normalises **both** ways for the reason the
 * prefix does: a scene parsed back out of a seunglab URL and re-sent to a spelunker viewer
 * would otherwise carry a layer type that viewer cannot construct.
 */
const GRAPHENE_LAYER_TYPE: Readonly<Record<ViewerKind, string>> = {
  seunglab: 'segmentation_with_graph',
  spelunker: 'segmentation',
}

/** `nglui`'s own `SEGMENTATION_LAYER_TYPES`: the two names one layer can be going under. */
const SEGMENTATION_TYPES: ReadonlySet<string> = new Set(Object.values(GRAPHENE_LAYER_TYPE))

/**
 * The scene as this particular viewer needs it.
 *
 * Applied here rather than where the scene is built, because the prefix is a fact about the
 * **viewer** and the scene is assembled before anybody has chosen one — `caveScene` runs inside
 * `fetchViewerScene`, which a `DataSource` answers with no idea which deployment the node will
 * open. Both URL builders funnel through it so the two cannot drift, which is the reason
 * `viewerBaseFor` exists one function up.
 */
function sceneForViewer(scene: NgScene, kind: ViewerKind): NgScene {
  const layers = scene.layers
  if (!Array.isArray(layers)) return scene
  return {
    ...scene,
    layers: layers.map((layer) => {
      const l = layer as NgLayer
      // Only a graphene layer: `precomputed://` is prefixed by caveclient for the annotation and
      // segment-property URLs CAVE serves itself, neither of which a scene built here carries,
      // and the layer *type* is a fact about a chunked-graph source specifically.
      if (typeof l.source !== 'string' || !l.source.startsWith(GRAPHENE)) return layer
      return {
        ...l,
        source: grapheneFor(l.source, kind),
        // Left alone unless it is already a segmentation under one of its two names — an image
        // layer is not turned into one by having a source this recognises.
        type: SEGMENTATION_TYPES.has(String(l.type)) ? GRAPHENE_LAYER_TYPE[kind] : l.type,
      }
    }),
  }
}

export function sceneUrl(
  viewerBase: string | undefined,
  scene: NgScene,
  kind: ViewerKind = viewerKind(viewerBase),
): string {
  const state = sceneForViewer(scene, kind)
  return `${viewerRoot(viewerBase)}/#!${encodeURIComponent(JSON.stringify(state))}`
}

/** Viewer instance a URL is built against, normalised: no trailing slash, no fragment. */
function viewerRoot(viewerBase: string | undefined): string {
  return (viewerBase?.trim() || DEFAULT_NEUROGLANCER_URL)
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
}

/**
 * The keys an update is allowed to carry — deliberately just the one.
 *
 * Everything else in a scene belongs to whoever is looking through the viewer, and a merge
 * leaves absent keys alone, so the shorter this list is the more of their session survives an
 * edit upstream. It is also a *stability* budget, not only a courtesy one.
 *
 * `layout` used to be here and was removed after a report of neuroglancer erroring under rapid
 * updates — a cascade of "can't access property 'generation' of undefined" ending in
 * `Error restoring property "layout"`, which names this exact key. Restoring `layers` tears
 * down and rebuilds every layer, and restoring `layout` in the same pass rebuilds the panels
 * that hold references to them; doing both while the user is interacting is asking the two to
 * race. Sending only `layers` takes the named property out of the update path entirely.
 *
 * The cost is that `layout` and `showSlices` now fall into `sceneIdentity`, so changing either
 * re-navigates instead of merging and the camera returns to the published framing. That is the
 * right trade: they are structural, they change rarely, and a selection change — the thing that
 * happens constantly — is what has to stay cheap.
 */
export const SCENE_PATCH_KEYS = ['layers'] as const

/**
 * An update for a viewer that is already open, as neuroglancer's `#!+` merge form.
 *
 * The plain `#!` form resets first, so changing a selection threw away the framing someone
 * had just set up — the complaint this exists to answer. `#!+` restores *over* the current
 * state instead: keys it does not mention keep their live values. Verified against the
 * deployed viewer, camera included.
 *
 * **`layers` must be the whole list.** The merge is per top-level key, not per layer: a patch
 * naming only the segmentation layer deletes the EM volume and every ROI mesh beside it.
 * Confirmed the hard way — it is the one thing about this that looks like it should work.
 *
 * The corollary is what a patch *cannot* preserve: per-layer state the viewer owns, like a
 * visibility toggle or a randomised colour seed, is rebuilt from what is sent here.
 */
export function scenePatchUrl(
  viewerBase: string | undefined,
  scene: NgScene,
  kind: ViewerKind = viewerKind(viewerBase),
): string {
  // Through the same rewrite as a full navigation: `layers` is the one key a patch carries, so
  // it carries the sources, and a merge sending the wrong prefix breaks the segmentation exactly
  // as a navigation would.
  const state = sceneForViewer(scene, kind)
  const patch: Record<string, unknown> = {}
  for (const key of SCENE_PATCH_KEYS) {
    if (state[key] !== undefined) patch[key] = state[key]
  }
  return `${viewerRoot(viewerBase)}/#!+${encodeURIComponent(JSON.stringify(patch))}`
}

/**
 * The part of a scene a patch cannot change, as a comparable string.
 *
 * Two scenes with the same identity describe the same *place* — same dataset, same published
 * camera — so an update between them can be merged. A different identity means the viewer is
 * being pointed somewhere else, where keeping the old framing would leave you staring at
 * empty space next to the volume you asked for.
 */
export function sceneIdentity(scene: NgScene): string {
  const rest: Record<string, unknown> = {}
  const skip = new Set<string>(SCENE_PATCH_KEYS)
  for (const key of Object.keys(scene).sort()) {
    if (!skip.has(key)) rest[key] = scene[key]
  }
  return JSON.stringify(rest)
}

/**
 * Same-origin prefixes that proxy a viewer instance, and the reason this module cares about
 * hosting at all.
 *
 * Neuroglancer frames fine cross-origin — this is not a CORS workaround. It is the difference
 * between *replacing* the embed's state and *editing* it: a cross-origin frame's
 * `location.hash` cannot be read, so an update can only overwrite the layer list, taking the
 * user's hidden layers and their own added layers with it. Same-origin, the live state can be
 * read, our segments spliced into it, and everything else left exactly as they left it.
 *
 * A prefix has to exist on the server side too — see the `/ng` rule in `vite.config.ts`.
 */
const VIEWER_PROXIES: ReadonlyArray<{ origin: string; prefix: string }> = [
  { origin: DEFAULT_NEUROGLANCER_URL, prefix: '/ng' },
]

/** The same-origin path serving a viewer, when one is configured. */
export function proxiedViewer(viewerBase: string | undefined): string | undefined {
  const root = viewerRoot(viewerBase)
  return VIEWER_PROXIES.find((p) => p.origin === root)?.prefix
}

/** Layer keys that carry a selection. Copied as a set, so a mode change cannot leave a stray. */
const SEGMENT_FIELDS = ['segments', 'segmentColors', 'segmentDefaultColor'] as const

/**
 * The layers **this app wrote** into a scene it built.
 *
 * It cannot be recovered from the scene alone, and that is the whole of why this takes arguments.
 * The obvious test — "carries a `segments` array" — is what the code did, and it is wrong against
 * the real states: **male-CNS publishes sixteen layers with a preset `segments` array**, MANC
 * eight and optic-lobe seven, none of them ours. Reading those as ours means `spliceSegments`
 * copies our copy of a shell layer over the live one (reverting a selection the user made in it),
 * and — worse — a user who deletes any one of the sixteen makes the splice bail to the merge tier,
 * which throws away every layer edit they have made. Silently, and for a layer that has nothing to
 * do with us.
 *
 * `buildScene` knows the answer exactly: the dataset's own segmentation layer, found by
 * `segmentationLayerIndex`, and the `extraLayers` it appended to the end. So the caller supplies
 * what it knows — the dataset id and how many extras it sent — and this applies the same two
 * rules. The single-layer version was correct in practice only because the published layers
 * carrying `segments` happen to come *after* the dataset's own on both real states; that is not a
 * property anybody guaranteed.
 */
export function ownedLayerNames(
  scene: NgScene,
  datasetId: string,
  extraCount: number,
): string[] {
  const layers = layerList(scene)
  const extrasAt = layers.length - Math.max(0, extraCount)
  const names: string[] = []

  const target = segmentationLayerIndex(scene, datasetId)
  // Guarded against `target` landing inside the extras: an extra layer named after the dataset
  // family would otherwise be counted twice and the real one not at all.
  if (target >= 0 && target < extrasAt) {
    const name = layers[target]?.name
    if (typeof name === 'string') names.push(name)
  }
  for (let at = extrasAt; at < layers.length; at++) {
    const name = layers[at]?.name
    if (typeof name === 'string') names.push(name)
  }
  return names
}

/**
 * Put this app's layers into a state the *viewer* currently holds.
 *
 * The answer to "why can't we just change the segments and leave everything else alone" —
 * because a merge's finest granularity is a top-level key, and `layers` is one key, so writing
 * it replaces the whole list. Starting from the live state instead means the list we write back
 * already contains the user's hidden layers, their added layers and their ordering; only our own
 * layers' selections differ.
 *
 * `owned` names them — see `ownedLayerNames` for why it cannot be worked out from `next`. Each is
 * matched to the live layer of the same name and only `SEGMENT_FIELDS` are copied, so a layer the
 * user has since restyled keeps their opacity and their shader.
 *
 * Resolves undefined when **any** of them is missing from the live state — the user deleted one,
 * or a datasource node was wired up after the frame loaded, so the list itself has changed rather
 * than a selection within it. Re-adding a layer somebody removed would be a worse answer than
 * starting over, and the caller already has a better tier to fall back to: the merge form sends
 * our whole layer list, which is exactly what a changed list needs.
 */
export function spliceSegments(
  live: NgScene,
  next: NgScene,
  owned: readonly string[],
): NgScene | undefined {
  if (owned.length === 0) return undefined
  const ours = new Map<string, NgLayer>()
  for (const layer of layerList(next)) {
    if (typeof layer.name === 'string' && owned.includes(layer.name)) ours.set(layer.name, layer)
  }
  if (ours.size !== owned.length) return undefined

  let matched = 0
  const layers = layerList(live).map((layer) => {
    const source = typeof layer.name === 'string' ? ours.get(layer.name) : undefined
    if (!source) return layer
    matched++
    const patched: Record<string, unknown> = { ...layer }
    for (const key of SEGMENT_FIELDS) {
      if (key in source) patched[key] = source[key]
      else delete patched[key]
    }
    return patched
  })
  return matched === ours.size ? { ...live, layers } : undefined
}

/** Split a viewer URL back into the instance it points at and the scene it carries. */
export function splitSceneUrl(url: string): { base: string; scene: NgScene } | undefined {
  const at = url.indexOf('#!')
  const scene = parseSceneUrl(url)
  if (at === -1 || !scene) return undefined
  return { base: url.slice(0, at).replace(/\/+$/, ''), scene }
}

/** Read a scene back out of a viewer URL. The inverse of `sceneUrl`; used by tests. */
export function parseSceneUrl(url: string): NgScene | undefined {
  const at = url.indexOf('#!')
  if (at === -1) return undefined
  // `#!+` is the merge form; the payload after the marker is the same JSON either way.
  const body = url.slice(at + 2).replace(/^\+/, '')
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(body))
    return parsed && typeof parsed === 'object' ? (parsed as NgScene) : undefined
  } catch {
    return undefined
  }
}
