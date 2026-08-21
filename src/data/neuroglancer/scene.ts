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

  scene['layers'] = kept
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
export function sceneUrl(viewerBase: string | undefined, scene: NgScene): string {
  return `${viewerRoot(viewerBase)}/#!${encodeURIComponent(JSON.stringify(scene))}`
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
export function scenePatchUrl(viewerBase: string | undefined, scene: NgScene): string {
  const patch: Record<string, unknown> = {}
  for (const key of SCENE_PATCH_KEYS) {
    if (scene[key] !== undefined) patch[key] = scene[key]
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
 * The layer this app writes into: the one `buildScene` decorated.
 *
 * Identified by carrying a `segments` array, which `buildScene` sets on exactly one layer —
 * always, even when the selection is empty. That is what makes it findable again inside a
 * state the user has since edited.
 */
function ownedLayerName(scene: NgScene): string | undefined {
  for (const layer of layerList(scene)) {
    if (Array.isArray(layer['segments']) && typeof layer.name === 'string') return layer.name
  }
  return undefined
}

/**
 * Put this app's selection into a state the *viewer* currently holds.
 *
 * The answer to "why can't we just change the segments and leave everything else alone" —
 * because a merge's finest granularity is a top-level key, and `layers` is one key, so writing
 * it replaces the whole list. Starting from the live state instead means the list we write back
 * already contains the user's hidden layers, their added layers and their ordering; only the
 * one layer's selection differs.
 *
 * Resolves undefined when the layer is not in the live state — the user deleted it, and
 * re-adding a layer they removed would be a worse answer than starting over.
 */
export function spliceSegments(live: NgScene, next: NgScene): NgScene | undefined {
  const name = ownedLayerName(next)
  if (name === undefined) return undefined

  const source = layerList(next).find((layer) => layer.name === name)
  const liveLayers = layerList(live)
  const index = liveLayers.findIndex((layer) => layer.name === name)
  if (!source || index < 0) return undefined

  const layers = liveLayers.map((layer, at) => {
    if (at !== index) return layer
    const patched: Record<string, unknown> = { ...layer }
    for (const key of SEGMENT_FIELDS) {
      if (key in source) patched[key] = source[key]
      else delete patched[key]
    }
    return patched
  })
  return { ...live, layers }
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
