/**
 * 3D morphology viewer, on three.js via react-three-fiber.
 *
 * Geometry is built into flat typed arrays once per input value, not per frame: a hundred
 * skeletons is ~40k segments, and rebuilding that on a colour change would stutter. Colour
 * lives in a per-vertex buffer so an encoding change only rewrites the colour attribute.
 *
 * Picking raycasts the skeleton lines and maps the hit vertex back to its neuron through a
 * segment→item lookup, which is why the geometry builder keeps that array around.
 *
 * Everything that is arithmetic rather than three.js lives in `viewer3dScene.ts`, because
 * jsdom has no WebGL: what stays in this file cannot be tested at all, so as little as
 * possible does.
 *
 * ## The scene is drawn at the origin, and that is load-bearing
 *
 * Connectome coordinates are absolute nanometres — a fly brain sits some 10^5 nm from the
 * world origin — so `SceneContents` translates everything by −centre and the camera orbits
 * (0, 0, 0). Two things depend on it. The compass computes its snap distance from the
 * camera's distance to the *world origin* rather than to the controls' target, so off-origin
 * scenes flew the camera into the next county on a click; and float32 positions keep their
 * precision where the numbers are small.
 */

import { Canvas, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, TrackballControls } from '@react-three/drei'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { FlexLineMaterial, setLineWidths } from './flexLineMaterial'
import { applyOpacity } from './materialOpacity'
import { AmbientOcclusion } from './ambientOcclusion'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

import type { ParamValue } from '../../core/node'
import type { MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { writeOverrides } from '../../nodes/lib/encodingParams'
import { CHART_INK, currentMode } from '../colors'
import { plural } from '../format'
import type { ResolvedColor } from '../encoding'
import { resolveColor } from '../encoding'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import type { LegendControls } from './LegendKeys'
import { ChannelToggle, ClearSelection, ColorKey } from './LegendKeys'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import type {
  BackgroundChoice,
  Framing,
  SkeletonSegments,
  SkeletonWidthMode,
} from './viewer3dScene'
import {
  aoRadiusFor,
  buildPoints,
  buildSkeletonSegments,
  compassLayout,
  detailNote,
  emphasisSizes,
  framingFor,
  hiddenCount,
  labelIndex,
  neuronAtSegment,
  neuronAtVertex,
  sceneLights,
  sceneMode,
  sceneSurface,
  skeletonNote,
  skeletonSegmentColors,
  skeletonWidthPlan,
  surfaceStyle,
  toggleHiddenLabel,
  toggleLabelSelection,
  toggleSelection,
  visibilityFor,
  wantsAmbientOcclusion,
} from './viewer3dScene'
import { useStable } from './useStable'
import { rememberCamera, recallCamera, forgetCamera } from './cameraMemo'

export interface Viewer3DProps {
  skeletons?: SkeletonsValue | undefined
  meshes?: MeshesValue | undefined
  points?: PointsValue | undefined
  /** Neuropil shells. The same value type as `meshes`, drawn as context rather than as subject. */
  volumes?: MeshesValue | undefined
  skeletonColor: ColorSpec
  meshColor: ColorSpec
  pointColor: ColorSpec
  volumeColor: ColorSpec
  skeletonWidth: number
  /**
   * Where a skeleton's line width comes from, and in which space: one number, the radius in
   * pixels, or the radius in nanometres.
   *
   * The two radius modes are the reason `SkeletonGeometry.radii` exists at all — every backend
   * has been filling it since skeletons were added and nothing drew it. See
   * `skeletonSegmentWidths` and `skeletonSegmentWorldWidths` for the two mappings, and for what
   * they both do on a source that publishes no radii.
   */
  skeletonWidthMode: SkeletonWidthMode
  /** The width the thickest neurites are drawn at, in pixels, under `radius`. */
  skeletonRadiusWidth: number
  /** A multiplier on the published radius under `world`. 1 is the calibre as recorded. */
  skeletonWorldWidth: number
  /** Scales both scene lights together. 1 is the calibrated pair; see `sceneLights`. */
  lightIntensity: number
  meshOpacity: number
  pointSize: number
  volumeOpacity: number
  background: BackgroundChoice
  /**
   * Re-frame the camera whenever the scene's extent changes, rather than framing once.
   *
   * The deliberate opt-out of `CameraRig`'s central rule — see the note there, and the param's
   * own on `out.viewer3d`. It exists for the `For Each` case: a loop putting four hundred
   * different neurons through one viewer frames on the first and draws the other 399 under its
   * camera, which is right for a comparable set and wrong when the elements are far apart.
   */
  refit?: boolean
  selection: string[]
  /**
   * Whether a click in the scene picks the neuron under it.
   *
   * Gates the draw sites rather than `onSelectionChange`, and the difference is the legend:
   * clearing the callback would take the labels' select with it, which is the one route into a
   * selection that is unambiguous about what it names. Off means the skeleton object carries no
   * `onClick` at all, so it leaves React Three Fiber's interaction set and stops being raycast —
   * "not pickable" in the sense that costs nothing, rather than a handler that declines.
   */
  selectByClick: boolean
  /**
   * How strongly screen-space ambient occlusion darkens the opaque surfaces. 0 is off, 1 is
   * where a fully occluded pixel goes black, and the param's slider runs on to 2.
   *
   * A request rather than an instruction: `wantsAmbientOcclusion` decides whether the composer
   * is actually mounted, because the pass cannot see lines or points at all and a skeleton
   * scene would pay four passes and three render targets to multiply the image by 1. A strength
   * of 0 is the off state and does not mount it either.
   */
  ambientOcclusion: number
  /**
   * A colour per skeleton *node*, overriding the neuron's own where it answers.
   *
   * Neuron Topology's compartment and Strahler channels: a colour that varies *along* one
   * arbour, which `skeletonColor` cannot express — a `ColorSpec` resolves against the attribute
   * table, and that has one row per neuron. Undefined for a node falls back to the ordinary
   * encoding, so a partly-labelled arbour draws the rest normally.
   */
  skeletonNodeColor?: (itemIndex: number, nodeIndex: number) => string | undefined
  /**
   * Whether `pointSize` is nanometres (the default) or screen pixels.
   *
   * See `PointCloud`'s own note. Opt-in, so every existing caller keeps world-space dots.
   */
  pointSizeAttenuation?: boolean
  /**
   * Which synapse rows are the subject right now — drawn larger and opaque, the rest pushed back.
   *
   * Opt-in, so a scene that has not asked for it draws one uniform cloud as before. Used by
   * `out.topology` to make a lit partner findable: on a dense cell the lit set is tens of dots
   * among tens of thousands, and colour alone does not separate them.
   */
  pointEmphasis?: ((rowIndex: number) => boolean) | undefined
  /** How faint the un-emphasised synapses go. Only read when `pointEmphasis` is given. */
  pointDimOpacity?: number
  /**
   * How solid the skeleton is drawn, 0..1. Opaque unless a caller says otherwise.
   *
   * Both line paths honour it — the hairline through `lineBasicMaterial` and the fat one through
   * `LineMaterial.opacity`, which is a setter onto the shader's own uniform (`float alpha =
   * opacity` in three's fragment source, a line `flexLineMaterial`'s patches do not touch).
   */
  skeletonOpacity?: number
  onSelectionChange?: (ids: string[]) => void
  /**
   * Legend keys hidden per channel, by the param prefix that stores them.
   *
   * Three lists rather than one, because the keys are per encoding: `LC4` under a skeleton
   * colour and `LC4` under a point colour are different sets of rows that happen to share a
   * word, and one list would hide both.
   */
  hidden: { skeleton: string[]; mesh: string[]; point: string[]; volume: string[] }
  /**
   * Whether each socket is drawn at all, above and beyond the legend's per-key hiding.
   *
   * A coarser question than the legend's, and one the legend often cannot ask: keys exist only
   * where an encoding is categorical, so a constant colour — which is what neuropil shells ship
   * with — has nothing to click. Folded into the per-channel `visible` predicates rather than
   * checked separately at each draw site, so the caption's hidden count, the geometry builder
   * and the raycast all agree without four places remembering to consult it.
   */
  shown: { skeletons: boolean; meshes: boolean; points: boolean; volumes: boolean }
  /** Writes the legend's own params — hidden keys and colour overrides — back to the node. */
  onParamChange?: (paramId: string, value: ParamValue) => void
  /**
   * Which viewer this is, for the camera that outlives it.
   *
   * The node id, so the card and the overlay are one continuous view of the same scene rather
   * than two that reset each other. `NetworkViewer` takes the same prop for the same reason.
   */
  viewerId?: string
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/**
 * How far the pointer may travel and still count as a click, in CSS pixels.
 *
 * Small enough that a deliberate tap on a thin neurite still lands, large enough to absorb the
 * shake of a trackpad click. The same order as the slop every drag-versus-click gesture in a
 * desktop UI uses.
 */
const DRAG_SLOP = 4

/** Resolved encodings for the three channels, computed once above the canvas. */
interface SceneColors {
  skeletons: ResolvedColor
  meshes: ResolvedColor
  points: ResolvedColor
  volumes: ResolvedColor
}

/** Whether a given row of each channel is still drawn, after the legend's hidden keys. */
interface SceneVisibility {
  skeletons: (rowIndex: number) => boolean
  meshes: (rowIndex: number) => boolean
  points: (rowIndex: number) => boolean
  volumes: (rowIndex: number) => boolean
}

/**
 * The param prefix each channel's legend writes to, beside the word the strip labels it with.
 *
 * A table rather than three copies of the same four lines: every one of hide, solo, recolour
 * and reset is the same operation with a different prefix substituted, and writing them out
 * per channel is how `meshHidden` ends up being written by the points key.
 */
const CHANNELS = [
  { key: 'skeletons', prefix: 'skeleton', name: 'skeletons', show: 'showSkeletons' },
  { key: 'meshes', prefix: 'mesh', name: 'meshes', show: 'showMeshes' },
  { key: 'points', prefix: 'point', name: 'points', show: 'showPoints' },
  { key: 'volumes', prefix: 'volume', name: 'volumes', show: 'showVolumes' },
] as const

/** The predicate a switched-off channel gets, in place of whatever its legend decided. */
const NEVER = () => false
type ChannelKey = (typeof CHANNELS)[number]['key']

export function Viewer3D(props: Viewer3DProps) {
  const {
    skeletons,
    meshes,
    points,
    volumes,
    background,
    refit = false,
    meshOpacity,
    volumeOpacity,
    ambientOcclusion,
    lightIntensity,
    selection,
    onSelectionChange,
    onParamChange,
    compact = false,
    baseName,
    onExpand,
    onError,
    viewerId,
  } = props

  /*
   * Bumped by the Reset view control, and nothing else re-frames.
   *
   * A nonce rather than a callback into the canvas: the control lives in the caption, outside
   * `<Canvas>`, and the thing it wants is "do the mount-time framing again" — which is an
   * effect keyed on a dependency, not a method.
   */
  const [resetAt, setResetAt] = useState(0)

  const mode = currentMode()
  const surface = sceneSurface(background, mode)
  // Pinning the background to light while the app is dark flips what counts as ink *inside*
  // the canvas. The compass labels are the only thing that reads it, and they would be black
  // on black without.
  const ink = CHART_INK[sceneMode(background, mode)].primary
  const lights = sceneLights(lightIntensity)

  /*
   * Memoised **by value**, which is the rule CLAUDE.md states and this viewer was breaking.
   * `readColorSpec` mints a fresh object on every render of the parent, so every memo keyed on
   * one invalidated on every unrelated store tick — and what hangs off these is a 40k-segment
   * colour buffer, rebuilt from scratch each time. `useStable` exists for exactly this; the
   * network and scatter viewers already use it, for the same reason.
   */
  const skeletonColor = useStable(props.skeletonColor)
  const meshColor = useStable(props.meshColor)
  const pointColor = useStable(props.pointColor)
  const volumeColor = useStable(props.volumeColor)
  const hidden = useStable(props.hidden)
  const shown = useStable(props.shown)

  /*
   * All three encodings resolve here rather than inside the canvas, because the legend needs
   * them and the legend is not in the canvas. Colouring meshes used to be resolved down in
   * `SceneContents`, which is exactly why mesh and point encodings had no key on screen: the
   * strip could not see them.
   */
  const colors: SceneColors = {
    skeletons: useMemo(
      () => resolveColor(skeletons?.attributes, skeletonColor, mode),
      [skeletons, skeletonColor, mode],
    ),
    meshes: useMemo(
      () => resolveColor(meshes?.attributes, meshColor, mode),
      [meshes, meshColor, mode],
    ),
    points: useMemo(
      () => resolveColor(points?.attributes, pointColor, mode),
      [points, pointColor, mode],
    ),
    volumes: useMemo(
      () => resolveColor(volumes?.attributes, volumeColor, mode),
      [volumes, volumeColor, mode],
    ),
  }

  /**
   * One predicate per channel, rebuilt only when its encoding, its hidden list or its switch
   * changes.
   *
   * The channel switch is folded in *here* rather than checked at each draw site, so there is
   * one answer to "is this row drawn" and the caption's hidden count, the geometry builder and
   * the raycast cannot come to different ones.
   */
  const visible: SceneVisibility = {
    skeletons: useMemo(
      () =>
        shown.skeletons
          ? visibilityFor(colors.skeletons.labelAt, new Set(hidden.skeleton))
          : NEVER,
      [colors.skeletons, hidden.skeleton, shown.skeletons],
    ),
    meshes: useMemo(
      () => (shown.meshes ? visibilityFor(colors.meshes.labelAt, new Set(hidden.mesh)) : NEVER),
      [colors.meshes, hidden.mesh, shown.meshes],
    ),
    points: useMemo(
      () =>
        shown.points ? visibilityFor(colors.points.labelAt, new Set(hidden.point)) : NEVER,
      [colors.points, hidden.point, shown.points],
    ),
    volumes: useMemo(
      () =>
        shown.volumes ? visibilityFor(colors.volumes.labelAt, new Set(hidden.volume)) : NEVER,
      [colors.volumes, hidden.volume, shown.volumes],
    ),
  }

  /*
   * Volumes come last, and only when nothing else is there.
   *
   * A shell is one to two orders of magnitude larger than the arbour inside it, so framing on
   * the union would answer "show me this neuron in LO(R)" with a picture of LO(R) and a speck.
   * The scene still draws the whole shell — `far` is 40× the framed extent — it is just not
   * what the camera is pointed at. Same precedence rule the other three already followed.
   */
  // A switched-off channel is skipped here too, so `Reset view` frames what is on screen
  // rather than what would be if everything were.
  const bounds =
    (shown.skeletons ? skeletons?.bounds : undefined) ??
    (shown.meshes ? meshes?.bounds : undefined) ??
    (shown.points ? points?.bounds : undefined) ??
    (shown.volumes ? volumes?.bounds : undefined)
  const framing = useMemo(() => framingFor(bounds), [bounds])

  /*
   * How many items the legend is currently holding back, per channel.
   *
   * The caption says so, and that is not decoration: a scene drawing 6 of 21 neurons looks
   * exactly like a scene that only fetched 6. This is the same admission `labels thinned` and
   * `meshes simplified` make — the rule is that nothing silently removes data from a picture.
   *
   * Memoised, and up here rather than beside the caption, because it walks *every row of every
   * channel* — a synapse cloud is six figures — and this component re-renders on every unrelated
   * store tick. The early return below is what forces the position: a hook cannot sit after it.
   */
  const hiddenTotal = useMemo(
    () =>
      (skeletons ? hiddenCount(skeletons.items.length, visible.skeletons) : 0) +
      (meshes ? hiddenCount(meshes.items.length, visible.meshes) : 0) +
      (points ? hiddenCount(points.attributes.length, visible.points) : 0) +
      (volumes ? hiddenCount(volumes.items.length, visible.volumes) : 0),
    [
      skeletons,
      meshes,
      points,
      volumes,
      visible.skeletons,
      visible.meshes,
      visible.points,
      visible.volumes,
    ],
  )

  /*
   * Each key's ids, for the two channels whose rows are neurons.
   *
   * One pass over the items instead of one per key — see `labelIndex`. Points and volumes are
   * absent on purpose: their rows are synapses and regions, so no key there addresses a
   * selection at all.
   */
  const keyIds = {
    skeletons: useMemo(
      () => labelIndex(skeletons?.items ?? [], colors.skeletons.labelAt),
      [skeletons, colors.skeletons],
    ),
    meshes: useMemo(
      () => labelIndex(meshes?.items ?? [], colors.meshes.labelAt),
      [meshes, colors.meshes],
    ),
  }

  /*
   * The read-back that PNG export needs, published from inside the canvas.
   *
   * A ref rather than state: `ViewerActions` sits outside `<Canvas>` and there is nothing to
   * re-render when the renderer becomes available — the button is offered either way, and
   * says "not rendered yet" if it is asked before there is a frame to read.
   */
  const captureRef = useRef<((transparent: boolean) => string | null) | null>(null)

  /**
   * The composer's render, while there is one, so the export goes through the same chain.
   *
   * Null whenever ambient occlusion is not mounted, which is most scenes — and `CaptureBridge`
   * reads that as "render the ordinary way" rather than as a failure.
   */
  const renderFrameRef = useRef<(() => void) | null>(null)

  /*
   * Whether the composer is mounted at all. Counted from the *sockets* rather than from the
   * per-key legend, because this is a mount decision and not a correctness one: hiding the
   * last mesh through the legend leaves an AO pass running over nothing for as long as it
   * stays hidden, which costs a pass and changes no pixel.
   */
  const aoActive = wantsAmbientOcclusion({
    strength: ambientOcclusion,
    meshes: shown.meshes ? (meshes?.items.length ?? 0) : 0,
    meshOpacity,
    volumes: shown.volumes ? (volumes?.items.length ?? 0) : 0,
    volumeOpacity,
  })

  const exportSource: ExportSource = useMemo(() => {
    const attributes =
      skeletons?.attributes ?? meshes?.attributes ?? points?.attributes ?? volumes?.attributes
    return {
      ...(attributes ? { csv: () => tableToCsvParts(attributes) } : {}),
      png: (options) => captureRef.current?.(options?.transparent === true) ?? null,
    }
  }, [skeletons, meshes, points, volumes])

  /*
   * Stable, so React Three Fiber's shallow compare leaves the live camera alone. It re-applies
   * these props whenever the object differs, which on a fresh literal every render would snap
   * the camera home on every unrelated store tick.
   */
  const cameraProps = useMemo(
    () => ({
      position: framing.position,
      /*
       * Up is −Y, which is navis's default view and the convention every fly EM volume here
       * follows: image Y increases *ventrally*, so a +Y camera up shows every brain upside
       * down. It is a default rather than a rule — the trackball has no up constraint, so a
       * drag can put it anywhere.
       */
      up: [0, -1, 0] as [number, number, number],
      fov: 45,
      near: framing.near,
      far: framing.far,
    }),
    [framing],
  )

  if (!skeletons && !meshes && !points && !volumes) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          Connect skeletons, meshes, points or volumes to see a scene.
        </div>
      </div>
    )
  }

  const detail = detailNote(meshes)
  // Where the skeletons came from, which is a bigger difference than a mesh's level of detail —
  // see `skeletonNote`.
  const provenance = skeletonNote(skeletons)

  /** The sockets with something on them — the question both the names and the switches ask. */
  const values = { skeletons, meshes, points, volumes }
  const wired = CHANNELS.filter((channel) => !!values[channel.key])
  /*
   * Named — and switchable — only when there is more than one channel on screen.
   *
   * A scene of skeletons alone has a single subject, and labelling it "skeletons" spends the
   * strip's width restating what the card already is; the same call `NetworkLegend` makes about
   * nodes. The switch follows the name for the same reason and one of its own: switching off
   * the only thing in the scene is a control whose single use is making the viewer blank.
   */
  const named = wired.length > 1
  const switchable = named && !!onParamChange

  const anyHidden =
    hidden.skeleton.length + hidden.mesh.length + hidden.point.length + hidden.volume.length > 0
  /** The live spec per prefix, so the legend's handlers merge into the right override map. */
  const specs = {
    skeleton: skeletonColor,
    mesh: meshColor,
    point: pointColor,
    volume: volumeColor,
  }
  const anyOverride = Object.values(specs).some(
    (spec) => Object.keys(spec.overrides ?? {}).length > 0,
  )

  function controlsFor(
    key: ChannelKey,
    prefix: 'skeleton' | 'mesh' | 'point' | 'volume',
  ): LegendControls {
    const resolved = colors[key]
    const labels =
      resolved.legend?.kind === 'categorical'
        ? resolved.legend.entries.map((entry) => entry.label)
        : []
    /** Undefined where a channel's keys address no selection — see below. */
    const ids = key === 'skeletons' || key === 'meshes' ? keyIds[key] : undefined

    const base: LegendControls = {
      hidden: new Set(hidden[prefix]),
      ...(onParamChange
        ? {
            onToggleHidden: (label, solo) =>
              onParamChange(
                `${prefix}Hidden`,
                toggleHiddenLabel(hidden[prefix], labels, label, solo),
              ),
            onRecolor: (label, hex) =>
              onParamChange(
                `${prefix}ColorOverrides`,
                writeOverrides({ ...(specs[prefix].overrides ?? {}), [label]: hex }),
              ),
          }
        : {}),
    }

    /*
     * Selection is offered only where a row *is* a neuron. Points are synapses — `evaluate`
     * excludes their table from the selection for the same reason — so the points key renders
     * its label as text rather than as a button that would select nothing.
     */
    if (!ids || !onSelectionChange) return base
    const chosen = new Set(selection)
    return {
      ...base,
      selected: new Set(
        labels.filter((label) => {
          const held = ids.get(label)
          return !!held?.length && held.every((id) => chosen.has(id))
        }),
      ),
      onSelect: (label) =>
        onSelectionChange(toggleLabelSelection(selection, ids.get(label) ?? [])),
    }
  }

  const resetAll = (what: 'hidden' | 'colors') => {
    if (!onParamChange) return
    for (const channel of CHANNELS) {
      onParamChange(
        `${channel.prefix}${what === 'hidden' ? 'Hidden' : 'ColorOverrides'}`,
        what === 'hidden' ? [] : '',
      )
    }
  }

  return (
    <div className="viewer">
      {/*
       * Right-drag pans the camera, and the same gesture is React Flow's "open this node's
       * menu" — so on an unexpanded card every pan left the context menu sitting over the
       * scene it had just moved.
       *
       * `preventDefault` is not the missing half: `TrackballControls` already calls it, which
       * is why the *browser's* menu never appeared. What it does not call is `stopPropagation`,
       * and Coda's menu is a React handler at the root rather than a native one on the canvas —
       * so the event sailed past the controls and reached `onNodeContextMenu` anyway. Stopping
       * it here is what the controls cannot do for us.
       *
       * Both halves, and `preventDefault` is not redundant: the controls skip theirs when
       * `enabled` is false, and a disabled camera should not start showing a browser menu.
       *
       * The cost is that right-click over the scene no longer opens the node's menu at all —
       * there is no way to tell a click from the start of a drag, since `contextmenu` fires on
       * mousedown. The card's header and its ☰ button still do.
       */}
      <div
        className="viewer3d-canvas nowheel"
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {/*
         * `flat` is `NoToneMapping`, and it is a correctness setting here rather than a look.
         *
         * React Three Fiber defaults a canvas to `ACESFilmicToneMapping` — a film response
         * curve for scenes with lights that blow out, which this one has nothing of: an ambient
         * and a key light over flat-shaded neurons, and no highlight to roll off.
         *
         * What forced the setting is that the curve makes ambient occlusion change the picture
         * where it is doing nothing. Tone mapping in the ordinary path is applied *per
         * material*, so a scene background — a clear, not a material — never receives it; through
         * a composer it is applied once at the end, to the whole image, background included.
         * Measured on the dark surface `#1a1a19`: unchanged without the composer, `#080808`
         * with it, so switching AO on visibly darkened the canvas behind a scene it had not
         * touched. Short of pre-compensating for the curve there is no way to keep it on the
         * geometry and off the background in a composited path, so the curve goes and the two
         * paths agree — re-measured at `#1a1a19` either way.
         *
         * It does change how surfaces look, which is the trade and not a side effect: the same
         * mesh pixel went from `#71a430` to `#61962d` without the curve. Reverting this means
         * finding another answer for the background, not just putting the curve back.
         */}
        <Canvas flat frameloop="demand" camera={cameraProps}>
          <SceneSurface color={surface} />
          <ambientLight intensity={lights.ambient} />
          <directionalLight position={[1, 1, 1]} intensity={lights.key} />
          <PointerGestures>
            <SceneContents
              {...props}
              shown={shown}
              colors={colors}
              visible={visible}
              framing={framing}
            />
          </PointerGestures>
          {/*
           * `staticMoving` for the same reason `enableDamping` was off before it: inertia under
           * a demand frameloop is a decaying stream of invalidations, which is a render loop
           * running after the hand has left the trackpad.
           *
           * `keys` is blanked because three-stdlib binds A/S/D on *window* — a global shortcut
           * claimed by every mounted card, in an app whose canvas is full of text fields. It
           * wants three key codes, and `''` is the code no key reports.
           */}
          {/*
           * Speeds well above the library defaults, which were measured by hand rather than
           * guessed: `rotateSpeed` 1.0 needs most of the canvas dragged for half a turn, and
           * `zoomSpeed` 1.2 is several wheel gestures to cross the scale of a brain.
           */}
          <TrackballControls
            makeDefault
            staticMoving
            rotateSpeed={3}
            zoomSpeed={2.4}
            panSpeed={0.8}
            keys={['', '', '']}
          />
          <PickRadius size={framing.size} />
          <CameraRig
            framing={framing}
            resetAt={resetAt}
            refit={refit}
            {...(viewerId ? { viewerId } : {})}
          />
          <Compass ink={ink} compact={compact} />
          {aoActive && (
            <AmbientOcclusion
              radius={aoRadiusFor(framing.size)}
              intensity={ambientOcclusion}
              renderFrame={renderFrameRef}
            />
          )}
          <CaptureBridge target={captureRef} renderFrame={renderFrameRef} />
        </Canvas>
      </div>

      {(CHANNELS.some((channel) => shown[channel.key] && colors[channel.key].legend) ||
        switchable) && (
        <div className="legend">
          {/*
           * The whole-socket switches, ahead of the keys.
           *
           * Shown only when more than one socket has something on it, because switching off the
           * only channel in a scene leaves an empty canvas — a control whose single use is to
           * make the viewer blank. With two or more it is the fastest thing on the strip: the
           * neuropil shell in front of the arbour goes away in one click, without opening a
           * panel or knowing that shells are called volumes here.
           */}
          {wired.map((channel) => {
            const off = !shown[channel.key]
            // One handler, read by both branches below. Written twice, it is two places to edit
            // and one to forget.
            const onToggle = () => onParamChange?.(channel.show, off)
            const toggle = switchable ? { channelHidden: off, onToggleChannel: onToggle } : {}
            /*
             * A key strip where there is one to draw, and the bare switch where there is not.
             *
             * The second branch is the interesting one and it is not rare: `ColorKey` renders
             * nothing at all for an encoding with no keys, which is every constant colour —
             * including the one neuropil shells ship with. Without this, the only channel
             * somebody actually wants out of the way would be the one with no way to remove it.
             */
            if (shown[channel.key] && colors[channel.key].legend) {
              return (
                <ColorKey
                  key={channel.key}
                  colors={colors[channel.key]}
                  {...(named ? { name: channel.name } : {})}
                  controls={{ ...controlsFor(channel.key, channel.prefix), ...toggle }}
                />
              )
            }
            if (!switchable) return null
            return (
              <span key={channel.key} className="legend__group">
                <ChannelToggle name={channel.name} hidden={off} onToggle={onToggle} />
              </span>
            )
          })}
          {/*
             The way back out, shown only when there is something to come back from. Per-channel
             clears exist in the inspector; what the strip needs is the one-click undo for a
             solo three cards deep, without hunting for which of six params holds it.
          */}
          {(anyHidden || anyOverride) && onParamChange && (
            <span className="legend__group legend__reset">
              {anyHidden && (
                <button type="button" className="nodrag" onClick={() => resetAll('hidden')}>
                  show all
                </button>
              )}
              {anyOverride && (
                <button type="button" className="nodrag" onClick={() => resetAll('colors')}>
                  reset colours
                </button>
              )}
            </span>
          )}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {[
            skeletons ? plural(skeletons.items.length, 'skeleton') : '',
            meshes ? plural(meshes.items.length, 'mesh') : '',
            points ? plural(points.attributes.length, 'point') : '',
            volumes ? plural(volumes.items.length, 'volume') : '',
            /*
             * The selected count moves out of this text and into the button below whenever
             * clearing is possible, rather than being restated in both places. It stays here
             * for a viewer with no `onSelectionChange` — a read-only surface still has to be
             * able to say the picture is showing a selection.
             */
            selection.length > 0 && !onSelectionChange ? `${selection.length} selected` : '',
            hiddenTotal > 0 ? `${hiddenTotal} hidden` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {/*
         * The way out of a selection, and it is the count itself rather than a control beside
         * it — the same affordance the histogram, distribution and pie viewers already put in
         * this row, down to the class and the glyph. Shown only when there is a selection, for
         * the reason the legend's `show all` is: a permanent control for an empty state is a
         * button that does nothing most of the time.
         *
         * It matters more here than on those three. `Select by clicking` is off by default, so
         * a selection made and then regretted could otherwise only be undone through the
         * inspector's `Selected` row — a list of ids, three panels away from the picture.
         */}
        {selection.length > 0 && onSelectionChange && (
          <ClearSelection
            label={`${selection.length} selected`}
            onClear={() => onSelectionChange([])}
          />
        )}
        {provenance && !compact && (
          <span className="viewer__note" title={provenance.title}>
            {provenance.label}
          </span>
        )}
        {detail && !compact && (
          <span className="viewer__note" title={detail.title}>
            {detail.label}
          </span>
        )}
        {/*
         * The way back, and the reason the camera can afford to be stubborn everywhere else.
         * A view that never re-frames itself needs one control that does.
         */}
        <button
          type="button"
          className="viewer-actions__btn nodrag"
          title="Frame the whole scene again"
          aria-label="Reset view"
          onClick={() => {
            if (viewerId) forgetCamera(viewerId)
            setResetAt((n) => n + 1)
          }}
        >
          ⟲{!compact && <span>Reset view</span>}
        </button>
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, '3d')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The background colour, applied on every change rather than once at creation.
 *
 * This was `onCreated={({ gl }) => gl.setClearColor(surface)}`, which fires exactly once —
 * so the `Background` param was a control that did nothing after the first frame, and
 * switching the app's theme left the canvas in the old one. The `invalidate` is the other
 * half: under `frameloop="demand"` a clear colour nobody redraws with is not visible either.
 */
function SceneSurface({ color }: { color: string }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    /*
     * `scene.background` rather than `gl.setClearColor`, and the difference only shows once
     * something renders to a texture.
     *
     * A renderer's clear colour is converted to the colour space of whatever target is bound
     * *at the moment it is set*. `RenderPass` sets it before binding the composer's buffer, so
     * under ambient occlusion the surface was converted for the screen, written into a linear
     * target, and then encoded a second time by `OutputPass`. Measured: `#1a1a19` came out
     * `#585855` — a dark canvas turning mid-grey the moment AO was switched on, with the
     * geometry on top of it unchanged, because only the clear took the extra conversion.
     *
     * A scene background is painted inside `renderer.render`, after the target is bound, so it
     * is converted against the buffer it actually lands in. One mechanism, both paths.
     */
    scene.background = new THREE.Color(color)
    /*
     * The clear colour is still set, and is not redundant: it is what shows through wherever
     * the background is *not* painted — which is exactly the transparent export, where
     * `CaptureBridge` drops the background for one render and the clear alpha with it.
     */
    gl.setClearColor(color, 1)
    invalidate()
  }, [gl, scene, color, invalidate])

  return null
}

/**
 * Whether the gesture that is ending was a camera drag rather than a click.
 *
 * A ref through context rather than state: it is read inside an event handler at the moment of
 * the click and must never cause a render.
 */
const Dragging = createContext<{ current: boolean }>({ current: false })

/**
 * Ask for a frame whenever the pointer does something the controls will act on later.
 *
 * `frameloop="demand"` and `TrackballControls` do not compose on their own, and the failure is
 * total rather than degraded: dragging did nothing at all. The trackball records the gesture in
 * its pointer handlers but only *integrates* it inside `update()`, which drei calls from
 * `useFrame` — and under a demand loop `useFrame` runs only when something has asked for a
 * frame. Nothing had. The controls emit `change` from `update()`, so the one event that would
 * have asked for the frame is the one the missing frame was supposed to produce.
 *
 * `OrbitControls` hid this because it integrates in its own handlers and dispatches `change`
 * from there, which is why swapping the camera model turned a working viewer into a still
 * picture with no error anywhere.
 *
 * Deliberately not `frameloop="always"`: a canvas rendering sixty times a second whether or not
 * anything moved is a cost every card on the graph would pay, forever, for a gesture that
 * happens occasionally.
 */
function PointerGestures({ children }: { children: React.ReactNode }) {
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const dragged = useRef(false)

  useEffect(() => {
    const element = gl.domElement
    // The move and release land on the *document*, which is where the controls listen for them:
    // a drag that leaves the canvas still turns the scene, and has to keep asking for frames.
    const doc = element.ownerDocument
    let from: { x: number; y: number } | null = null

    const start = (event: PointerEvent) => {
      from = { x: event.clientX, y: event.clientY }
      /*
       * Reset here rather than on release, because the click this guards against is dispatched
       * *after* the pointerup — so the verdict has to survive the end of the gesture and be
       * cleared by the start of the next one.
       */
      dragged.current = false
      invalidate()
    }
    const move = (event: PointerEvent) => {
      if (!from) return
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > DRAG_SLOP) {
        dragged.current = true
      }
      invalidate()
    }
    const end = () => {
      from = null
      invalidate()
    }
    const nudge = () => invalidate()

    element.addEventListener('pointerdown', start)
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', end)
    doc.addEventListener('pointercancel', end)
    element.addEventListener('wheel', nudge, { passive: true })
    element.addEventListener('touchmove', nudge, { passive: true })

    return () => {
      element.removeEventListener('pointerdown', start)
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', end)
      doc.removeEventListener('pointercancel', end)
      element.removeEventListener('wheel', nudge)
      element.removeEventListener('touchmove', nudge)
    }
  }, [gl, invalidate])

  return <Dragging.Provider value={dragged}>{children}</Dragging.Provider>
}

/**
 * How close a click has to be to a skeleton to count as hitting it, in nanometres.
 *
 * three's default line threshold is **1 world unit**, which is a sensible number in a scene
 * measured in metres and an absurd one here: a nanometre is some 1/50th of a pixel at a normal
 * framing, so clicking a neuron meant landing inside a line to within a fiftieth of a pixel.
 * Selection was not flaky, it was unreachable — and it looked like a viewer that had simply
 * decided not to respond.
 *
 * Scaled off the scene rather than fixed, because "a few pixels" is the thing being expressed
 * and the only stable proxy for it here is the extent the camera was framed against.
 */
function PickRadius({ size }: { size: number }) {
  const raycaster = useThree((state) => state.raycaster)

  useEffect(() => {
    raycaster.params.Line = { ...raycaster.params.Line, threshold: size / 200 }
    /*
     * A second key, because a fat line is picked in a different space. `LineSegments2` works
     * in *screen* pixels and adds this to the material's own width, so it needs a number that
     * has nothing to do with the scene's extent — where the hairline path measures in
     * nanometres. Both are set: which one is live depends on the `Line width` setting.
     */
    raycaster.params.Line2 = { ...raycaster.params.Line2, threshold: 4 }
  }, [raycaster, size])

  return null
}

/**
 * An orientation gizmo in the corner, and a way back to a known view.
 *
 * A trackball has no up constraint — which is the point, and is also how a scene ends up
 * rolled with no idea which way is anterior. Clicking an axis head flies to that view.
 *
 * **The axis colours are deliberately not from the chart palette.** They are chrome with a
 * fixed meaning, and a compass drawn in the categorical ramp would read as three data
 * series parked in the corner. Red/green/blue for X/Y/Z is the convention every 3D tool
 * here shares, including neuroglancer, and the labels carry the same information as the
 * colour, so nothing rests on telling the red arm from the green one.
 */
function Compass({ ink, compact }: { ink: string; compact: boolean }) {
  const size = useThree((state) => state.size)
  const { scale, margin } = compassLayout(compact, size)

  return (
    <GizmoHelper alignment="bottom-right" margin={margin}>
      <GizmoViewport
        scale={scale}
        axisColors={['#ff5470', '#3ec46d', '#4a9df5']}
        labels={['x', 'y', 'z']}
        labelColor={ink}
        /*
         * The labels are drawn into a fixed 64px texture and then scaled with the group, so
         * halving the gizmo would halve them into illegibility. A larger font on the same
         * texture fills more of the sprite and buys most of it back — they end up a little
         * smaller than on the overlay rather than half the size.
         */
        font={compact ? '30px Inter var, Arial, sans-serif' : undefined}
        axisHeadScale={0.9}
      />
    </GizmoHelper>
  )
}

/**
 * Publishes a "render one frame and read it back" function for PNG export.
 *
 * A WebGL drawing buffer cannot be read after it has been presented unless the context was
 * created with `preserveDrawingBuffer`, which taxes every frame of every scene for the sake
 * of a button most sessions never press. So the export renders on demand and calls
 * `toDataURL` in the *same task*, before the compositor gets a turn.
 *
 * The pixel ratio is raised to at least 2 for the read, matching the 2× that `downloadPng`
 * gives every other viewer — a figure exported at CSS resolution is a screenshot.
 *
 * The compass is not in the file, and that is on purpose: it lives in a HUD scene of its own,
 * and a north arrow baked into a figure is somebody else's decision to undo in Illustrator.
 */
function CaptureBridge({
  target,
  renderFrame,
}: {
  target: RefObject<((transparent: boolean) => string | null) | null>
  /**
   * The composer's render when one is mounted, and null the rest of the time.
   *
   * Read at call time rather than captured, because a scene can gain and lose its composer —
   * turning ambient occlusion on, or dropping the last opaque mesh — while this bridge stays
   * mounted throughout. A callback closed over the ref's *value* would export through a chain
   * that had since been disposed.
   */
  renderFrame: RefObject<(() => void) | null>
}) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)

  const capture = useCallback(
    (transparent: boolean): string | null => {
      const ratio = gl.getPixelRatio()
      const wanted = Math.max(2, ratio)
      /*
       * Transparency is a property of the *clear*, not of the scene, so it costs one setting
       * changed for the length of one render. The context is created with `alpha: true` — it
       * has an alpha channel all along; the background is opaque only because the clear alpha
       * is 1. Dropping it to 0 for the read-back gives a cut-out of exactly what was drawn.
       */
      const clear = new THREE.Color()
      gl.getClearColor(clear)
      const clearAlpha = gl.getClearAlpha()
      const background = scene.background
      try {
        if (wanted !== ratio) gl.setPixelRatio(wanted)
        /*
         * Both halves, because the surface is painted twice over: `SceneSurface` sets a scene
         * background *and* a clear colour, and a cut-out needs neither. Dropping only the clear
         * alpha would leave the background painted opaque over it and export a picture with no
         * transparency in it at all — which is what a screenshot already is.
         */
        if (transparent) {
          scene.background = null
          gl.setClearColor(clear, 0)
        }
        /*
         * Through the composer when there is one, or a figure exported from a scene with
         * ambient occlusion on comes out without it — the one difference between what is on
         * screen and what lands in the file being the effect somebody switched on.
         */
        if (renderFrame.current) renderFrame.current()
        else gl.render(scene, camera)
        return gl.domElement.toDataURL('image/png')
      } finally {
        if (wanted !== ratio) gl.setPixelRatio(ratio)
        if (transparent) {
          scene.background = background
          gl.setClearColor(clear, clearAlpha)
        }
        invalidate()
      }
    },
    [gl, scene, camera, invalidate, renderFrame],
  )

  useEffect(() => {
    target.current = capture
    return () => {
      if (target.current === capture) target.current = null
    }
  }, [capture, target])

  return null
}

function SceneContents({
  skeletons,
  meshes,
  points,
  volumes,
  skeletonWidth,
  skeletonWidthMode,
  skeletonRadiusWidth,
  skeletonWorldWidth,
  skeletonNodeColor,
  skeletonOpacity,
  selectByClick,
  meshOpacity,
  pointSize,
  pointSizeAttenuation,
  pointEmphasis,
  pointDimOpacity,
  volumeOpacity,
  selection,
  onSelectionChange,
  shown,
  colors,
  visible,
  framing,
}: Viewer3DProps & {
  colors: SceneColors
  visible: SceneVisibility
  framing: Framing
}) {
  const selected = useMemo(() => new Set(selection), [selection])
  const { center } = framing

  return (
    <group position={[-center[0], -center[1], -center[2]]}>
      {/*
       * A switched-off channel is not rendered at all, not rendered with an all-false predicate.
       * The predicate would already have emptied the buffers — the same rule hiding a key
       * follows — but building an empty geometry and handing it to a material still costs a
       * pass over the value on every restyle, for a socket somebody has said they do not want
       * to see. `visible` stays the authority for *rows*; this is the authority for *sockets*.
       */}
      {shown.skeletons && skeletons && (
        <SkeletonLines
          skeletons={skeletons}
          colorAt={colors.skeletons.at}
          nodeColorAt={skeletonNodeColor}
          {...(skeletonOpacity === undefined ? {} : { opacity: skeletonOpacity })}
          visible={visible.skeletons}
          selected={selected}
          width={skeletonWidth}
          widthMode={skeletonWidthMode}
          radiusWidth={skeletonRadiusWidth}
          worldWidth={skeletonWorldWidth}
          pickable={selectByClick}
          {...(onSelectionChange ? { onSelectionChange } : {})}
          selection={selection}
        />
      )}
      {shown.meshes && meshes && (
        <MeshChannel
          items={meshes.items}
          colorAt={colors.meshes.at}
          visible={visible.meshes}
          opacity={meshOpacity}
          dimmed={selected.size > 0 ? (id) => !selected.has(id) : undefined}
        />
      )}
      {shown.points && points && (
        <PointCloud
          points={points}
          colorAt={colors.points.at}
          visible={visible.points}
          size={pointSize}
          {...(pointSizeAttenuation === false ? { attenuate: false } : {})}
          emphasis={pointEmphasis}
          {...(pointDimOpacity === undefined ? {} : { dimOpacity: pointDimOpacity })}
        />
      )}
      {/*
       * Shells come last in the tree and never dim. A region is not a neuron: dimming it when
       * a neuron is selected would say it had been *deselected*, which is a claim about a
       * thing that was never in the selection to begin with. It is drawn at whatever the
       * opacity setting says, all the time, which is what makes it read as the room rather
       * than as another occupant of it.
       */}
      {shown.volumes && volumes && (
        <MeshChannel
          prefix="volume"
          items={volumes.items}
          colorAt={colors.volumes.at}
          visible={visible.volumes}
          opacity={volumeOpacity}
        />
      )}
    </group>
  )
}

/**
 * One surface socket's meshes.
 *
 * `Meshes` and `Volumes` differ only in their opacity, their dimming rule and their React key —
 * so they are one component rendered twice rather than the same twelve lines thirty lines apart,
 * where a fix to the first is a fix somebody has to remember to make to the second.
 *
 * A hidden item is not rendered at all rather than rendered invisible: a transparent surface
 * still sorts, still writes nothing useful to the depth buffer, and still turns up in a raycast.
 */
function MeshChannel({
  prefix = 'mesh',
  items,
  colorAt,
  visible,
  opacity,
  dimmed,
}: {
  prefix?: string
  items: readonly { id: string; positions: Float32Array; indices: Uint32Array }[]
  colorAt: (index: number) => string
  visible: (index: number) => boolean
  opacity: number
  /** Omitted where nothing dims — a region is not a neuron, so shells never do. */
  dimmed?: ((id: string) => boolean) | undefined
}) {
  return (
    <>
      {items.map((item, index) =>
        visible(index) ? (
          <MeshItem
            /*
             * Keyed by id, with the index only as a fallback for an item that has none.
             *
             * It was `id`-and-index, which is stable for a value that only ever grows at the end
             * — and a streamed one does not. `onPartial` publishes what has arrived *in final
             * order*, so body 40 appears at index 3 and then at index 27 as the ones before it
             * land. Folding the index into the key makes every one of those a different
             * component: React unmounts it, `MeshItem`'s `useMemo` mints a fresh
             * `BufferGeometry`, and a 300-body fill rebuilds the whole scene a dozen times over
             * for geometry that never changed.
             */
            key={`${prefix}-${item.id || index}`}
            positions={item.positions}
            indices={item.indices}
            color={colorAt(index)}
            opacity={opacity}
            dimmed={dimmed?.(item.id) ?? false}
          />
        ) : null,
      )}
    </>
  )
}

/**
 * Every skeleton in one LineSegments.
 *
 * A draw call per neuron would be 100+ calls a frame for no benefit — the whole collection
 * shares a material, and selection is expressed through the colour buffer rather than
 * through separate objects.
 */
function SkeletonLines({
  skeletons,
  colorAt,
  nodeColorAt,
  opacity = 1,
  visible,
  selected,
  width,
  widthMode,
  radiusWidth,
  worldWidth,
  pickable,
  selection,
  onSelectionChange,
}: {
  skeletons: SkeletonsValue
  colorAt: (index: number) => string
  nodeColorAt?: ((itemIndex: number, nodeIndex: number) => string | undefined) | undefined
  /** 0..1. Passed to whichever of the two line paths draws. */
  opacity?: number
  visible: (itemIndex: number) => boolean
  selected: Set<string>
  width: number
  widthMode: SkeletonWidthMode
  radiusWidth: number
  worldWidth: number
  pickable: boolean
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
}) {
  /**
   * Rebuilt when the skeletons change — or when the legend hides one of them.
   *
   * Hiding is the one restyle that does cost a geometry pass, and it earns it: the alternative
   * is drawing the hidden neurons with an alpha of zero, which keeps them in the raycast and in
   * the vertex budget while claiming to have removed them.
   */
  const built: SkeletonSegments = useMemo(
    () => buildSkeletonSegments(skeletons, visible),
    [skeletons, visible],
  )

  /** Colour is a separate memo, so restyling does not rebuild positions. */
  const colors = useMemo(
    () => skeletonSegmentColors(built, skeletons, colorAt, selected, nodeColorAt),
    [built, skeletons, colorAt, selected, nodeColorAt],
  )

  /**
   * The mode resolved into what the renderer needs, in the module a test can reach.
   *
   * A memo because it allocates a width per endpoint, not because the arithmetic is expensive.
   */
  const plan = useMemo(
    () =>
      skeletonWidthPlan(built, widthMode, {
        uniform: width,
        radius: radiusWidth,
        world: worldWidth,
      }),
    [built, widthMode, width, radiusWidth, worldWidth],
  )

  /*
   * A drag is not a click, and the DOM disagrees.
   *
   * `click` fires on pointerup whatever happened in between, so turning the scene selected
   * whichever neuron happened to be under the cursor when the hand stopped — every time. It
   * was invisible until the trackball started working at all; before that, dragging did
   * nothing, so nothing followed it.
   */
  const dragged = useContext(Dragging)
  const pick = (neuronId: string | undefined, event: ThreeEvent<MouseEvent>) => {
    if (dragged.current || !onSelectionChange || !neuronId) return
    event.stopPropagation()
    onSelectionChange(toggleSelection(selection, neuronId))
  }

  /*
   * `undefined` rather than a conditional spread: R3F's `applyProps` deletes a handler it is
   * given `undefined` for, so `eventCount` still falls to zero and the object still leaves the
   * interaction set — which is the whole promise of `Select by clicking`.
   */
  if (plan.fat) {
    return (
      <FatSkeletonLines
        built={built}
        colors={colors}
        opacity={opacity}
        width={plan.uniform}
        widths={plan.widths}
        worldUnits={plan.worldUnits}
        onPick={
          pickable
            ? (event) =>
                pick(neuronAtSegment(built, skeletons, event.faceIndex ?? undefined), event)
            : undefined
        }
      />
    )
  }
  return (
    <ThinSkeletonLines
      built={built}
      colors={colors}
      opacity={opacity}
      onPick={
        pickable
          ? (event) => pick(neuronAtVertex(built, skeletons, event.index), event)
          : undefined
      }
    />
  )
}

/**
 * Hairlines: one `LineSegments`, one vertex per endpoint, one pixel wide whatever anyone asks.
 *
 * The cheap path and the default. `gl.lineWidth` is clamped to 1 in every browser that matters,
 * which is why `Line width` above 1 has to become different geometry entirely rather than a
 * material setting.
 */
function ThinSkeletonLines({
  built,
  colors,
  opacity,
  onPick,
}: {
  built: SkeletonSegments
  colors: Float32Array
  opacity: number
  /** Absent when `Select by clicking` is off, which takes the object out of the raycast. */
  onPick?: ((event: ThreeEvent<MouseEvent>) => void) | undefined
}) {
  const invalidate = useThree((state) => state.invalidate)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeBoundingSphere()
    return g
  }, [built, colors])

  useEffect(() => {
    invalidate()
    return () => geometry.dispose()
  }, [geometry, invalidate])

  return (
    <lineSegments geometry={geometry} onClick={onPick}>
      {/*
       * `depthWrite` off once it is faded, `PointSprites`' rule and for its reason: a see-through
       * skeleton that still writes depth hides the synapses behind it, so the arbour would be
       * transparent to the background and opaque to the very cloud somebody faded it to see.
       */}
      <lineBasicMaterial
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
      />
    </lineSegments>
  )
}

/**
 * Real widths: every segment expanded into a camera-facing quad.
 *
 * `LineSegments2` is instanced — four vertices and a shader that widens them in screen space —
 * so a width is genuinely honoured, at roughly four times the vertex data of the hairline path.
 * That cost is why this is the *other* branch rather than the only one: the default is 1, and
 * at 1 there is nothing to widen.
 *
 * Two things it needs that a normal material does not. `resolution` must be the canvas size in
 * CSS pixels, or the shader has no idea how wide a pixel is and the lines come out arbitrarily
 * thick — and it has to follow a resize. And a hit arrives as `faceIndex`, the segment, where
 * the hairline path reports a vertex; `raycaster.params.Line2.threshold` is its own key too,
 * measured in pixels rather than in nanometres.
 *
 * Built through `<primitive>` rather than as JSX elements to avoid `extend()`-ing three
 * classes into the JSX namespace for one branch of one viewer.
 */
function FatSkeletonLines({
  built,
  colors,
  opacity,
  width,
  widths,
  worldUnits,
  onPick,
}: {
  built: SkeletonSegments
  colors: Float32Array
  opacity: number
  width: number
  /**
   * A width per endpoint, or `undefined` for one width across the scene.
   *
   * Which of the two materials is built turns on this rather than on the mode, so a `radius`
   * scene whose source published no radii lands on the stock material instead of on a patched
   * shader reading an attribute that is not there — which draws every line at zero width.
   */
  widths: Float32Array | undefined
  /**
   * Whether `width` and `widths` are in nanometres rather than in CSS pixels.
   *
   * A `define` on the material, so flipping it recompiles the program — which is why it is in
   * the memo's dependencies below rather than assigned in an effect beside `resolution`.
   */
  worldUnits: boolean
  /** Absent when `Select by clicking` is off, which takes the object out of the raycast. */
  onPick?: ((event: ThreeEvent<MouseEvent>) => void) | undefined
}) {
  const invalidate = useThree((state) => state.invalidate)
  const size = useThree((state) => state.size)

  /*
   * The *presence* of a width buffer picks the material; its contents do not. Keeping that a
   * boolean is what stops a scrub — which mints a fresh `Float32Array` per pointermove —
   * recompiling a shader sixty times a second.
   */
  const hasWidths = widths !== undefined

  /*
   * Three memos and not one, because a width is *scrubbed*.
   *
   * `NumberField` drags — every pointermove past the slop is an `onChange` — so anything in a
   * memo keyed on a width is rebuilt sixty times a second while the hand moves. Positions are
   * the expensive half: `setPositions` runs `computeBoundingBox` *and* `computeBoundingSphere`
   * over the whole soup, and disposing the geometry re-uploads a megabyte of positions and
   * colours next frame. None of that depends on how wide the lines are.
   *
   * So the split follows what actually changes together: positions and colours rebuild the
   * geometry, `worldUnits` is a shader `define` and so rebuilds the material, and the two
   * widths are neither — a buffer swap and a uniform write, both below.
   */
  const geometry = useMemo(() => {
    const made = new LineSegmentsGeometry()
    made.setPositions(built.positions)
    made.setColors(colors)
    return made
  }, [built, colors])

  const material = useMemo(
    () =>
      hasWidths
        ? new FlexLineMaterial({ vertexColors: true, worldUnits })
        : new LineMaterial({ vertexColors: true, worldUnits }),
    [hasWidths, worldUnits],
  )

  const object = useMemo(() => new LineSegments2(geometry, material), [geometry, material])

  /*
   * Widths in an effect rather than in the geometry memo, and no frame is drawn in between:
   * `frameloop="demand"` means nothing renders until something calls `invalidate`, and effects
   * run on commit, before the frame this schedules. Under a continuous frameloop this would be
   * one frame of zero-width lines on mount.
   */
  useEffect(() => {
    if (!widths) return
    setLineWidths(geometry, widths)
    invalidate()
  }, [geometry, widths, invalidate])

  /** A plain uniform, so a scrub is a number write rather than a new program. */
  useEffect(() => {
    material.linewidth = width
    invalidate()
  }, [material, width, invalidate])

  /*
   * In an effect rather than in the material memo, `linewidth`'s reasoning: opacity is scrubbed,
   * and rebuilding a patched `LineMaterial` per pointermove would recompile a shader sixty times
   * a second. `LineMaterial.opacity` is a setter onto `uniforms.opacity`, so this is a uniform
   * write like the one above.
   *
   * `needsUpdate` only when `transparent` actually flips, which happens at most once per drag —
   * three lists `transparent` among the properties a material has to be recompiled for, and the
   * program cache keys by shader source, so the rebuild reuses the compiled program anyway.
   */
  useEffect(() => {
    applyOpacity(material, opacity)
    invalidate()
  }, [material, opacity, invalidate])

  useEffect(() => {
    material.resolution.set(size.width, size.height)
    invalidate()
  }, [material, size, invalidate])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <primitive object={object} onClick={onPick} />
}

function MeshItem({
  positions,
  indices,
  color,
  opacity,
  dimmed,
}: {
  positions: Float32Array
  indices: Uint32Array
  color: string
  opacity: number
  dimmed: boolean
}) {
  const invalidate = useThree((state) => state.invalidate)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    g.computeVertexNormals()
    return g
  }, [positions, indices])

  useEffect(() => {
    invalidate()
    return () => geometry.dispose()
  }, [geometry, invalidate])

  const style = surfaceStyle(color, opacity, dimmed)

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={style.color}
        transparent={style.transparent}
        opacity={style.opacity}
        depthWrite={style.depthWrite}
        side={THREE.DoubleSide}
        roughness={0.9}
      />
    </mesh>
  )
}

/**
 * One `<points>` object: the rows a predicate admits, at one size and one opacity.
 *
 * Split out because a `PointsMaterial` has exactly one size and one opacity for every vertex it
 * draws, so "these dots bigger and those dots fainter" is two draw calls and cannot be anything
 * else. `buildPoints` already filters by a predicate, so the two are complementary halves of the
 * same cloud rather than two clouds.
 */
function PointSprites({
  points,
  colorAt,
  visible,
  size,
  attenuate,
  opacity,
}: {
  points: PointsValue
  colorAt: (index: number) => string
  visible: (rowIndex: number) => boolean
  size: number
  attenuate: boolean
  opacity: number
}) {
  const invalidate = useThree((state) => state.invalidate)

  const geometry = useMemo(() => {
    const built = buildPoints(points, colorAt, visible)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(built.colors, 3))
    g.computeBoundingSphere()
    return g
  }, [points, colorAt, visible])

  useEffect(() => {
    invalidate()
    return () => geometry.dispose()
  }, [geometry, invalidate])

  /*
   * **`transparent` changing on a live material needs `needsUpdate`, and R3F does not set it.**
   *
   * This is the bug that survived four fixes, because every one of them was checked on a scene
   * that *mounted* already split. The card opens with no partner lit, so `PointCloud` renders one
   * `PointSprites` at opacity 1; lighting a partner renders two, and React reconciles the first by
   * position — same component, same slot, so the `<points>` and this material are **reused**. R3F
   * then writes `opacity` 1 → 0.1 and `transparent` false → true onto a material three has already
   * compiled, and three keeps the program and the blending state it built when `transparent` was
   * false. The dim half stays fully opaque and the slider does nothing to it.
   *
   * Closing the expanded card and re-opening it fixed it every time, which is the whole diagnosis:
   * a remount *constructs* the material with `transparent: true`. Reported that way by the user;
   * confirmed in a browser by flipping `pointEmphasis` from undefined to a function 800 ms after
   * mount and comparing against a panel mounted split — same props, one faded, one a white slab.
   *
   * `FatSkeletonLines` already does this by hand for the same reason a few hundred lines down,
   * which is why `Skeleton opacity` never had the bug. Only `transparent` needs it: `opacity` is a
   * uniform and `depthWrite` is state read per draw.
   *
   * `applyOpacity` holds the rule and is unit-tested against a real material; the three fields
   * are set here rather than as JSX props because R3F would re-apply them on every render without
   * the rebuild. Nothing is drawn in between: `frameloop="demand"` renders only on `invalidate`,
   * and effects run on commit — `FatSkeletonLines`' width effect makes the same argument.
   */
  const material = useRef<THREE.PointsMaterial>(null)
  useEffect(() => {
    if (!material.current) return
    applyOpacity(material.current, opacity)
    invalidate()
  }, [opacity, invalidate])

  return (
    <points geometry={geometry}>
      <pointsMaterial ref={material} vertexColors size={size} sizeAttenuation={attenuate} />
    </points>
  )
}

function PointCloud({
  points,
  colorAt,
  visible,
  size,
  attenuate = true,
  emphasis,
  dimOpacity = 1,
}: {
  points: PointsValue
  colorAt: (index: number) => string
  visible: (rowIndex: number) => boolean
  size: number
  /**
   * Whether `size` is world space (nanometres, shrinking with distance) or screen space (pixels).
   *
   * World space is the default and is what `out.viewer3d` wants: there a synapse cloud sits in a
   * scene of neurons, and a dot that stayed the same size while the neuron receded would stop
   * being part of the anatomy.
   *
   * Screen space exists for a card where the cloud is the *subject* rather than a decoration. A
   * nanometre size cannot have one good default there: 250 nm is a legible dot on a 15 µm optic
   * lobe cell and is sub-pixel on a 250 µm descending neuron, so the same setting is right and
   * then invisible depending on which neuron you paged to. See `out.topology`.
   */
  attenuate?: boolean
  /**
   * Which rows to draw larger and at full opacity, everything else being pushed back.
   *
   * Absent means one cloud drawn one way, which is every existing caller. Present splits the draw
   * in two — see `PointSprites` for why that is forced rather than chosen.
   */
  emphasis?: ((rowIndex: number) => boolean) | undefined
  /** Opacity of the un-emphasised half. Only consulted when `emphasis` is given. */
  dimOpacity?: number
}) {
  /*
   * Two predicates over one cloud rather than two clouds: `buildPoints` already filters, so the
   * halves cannot drift apart or double-count a row. Memoised because they are the identity
   * `buildPoints`' own memo is keyed on — inline arrows would rebuild both buffers every frame.
   */
  const lit = useMemo(
    () => (emphasis ? (i: number) => visible(i) && emphasis(i) : undefined),
    [visible, emphasis],
  )
  const dim = useMemo(
    () => (emphasis ? (i: number) => visible(i) && !emphasis(i) : undefined),
    [visible, emphasis],
  )
  // Both halves, from one place: the dim one is scaled *down* as well as faded, because alpha
  // alone saturates on a dense cloud. `emphasisSizes` carries the measurement.
  const sizes = emphasisSizes(size)

  if (!lit || !dim) {
    return (
      <PointSprites
        points={points}
        colorAt={colorAt}
        visible={visible}
        size={size}
        attenuate={attenuate}
        opacity={1}
      />
    )
  }

  return (
    <>
      <PointSprites
        points={points}
        colorAt={colorAt}
        visible={dim}
        size={sizes.dim}
        attenuate={attenuate}
        opacity={dimOpacity}
      />
      <PointSprites
        points={points}
        colorAt={colorAt}
        visible={lit}
        size={sizes.lit}
        attenuate={attenuate}
        opacity={1}
      />
    </>
  )
}

/**
 * The camera: framed once, then left alone.
 *
 * The rule this replaces was "re-frame whenever the extent changes", which sounds helpful and
 * is not: an upstream node re-running under a view somebody had turned and pulled in threw that
 * away, and so did expanding the card to the overlay — those are two instances of one node, and
 * a camera that lives in the component dies with it.
 *
 * So there are exactly three things that move it:
 *
 *  1. **The first time this scene has an extent at all.** Not the first mount: a viewer with
 *     nothing run yet has bounds of size 1, and framing on that and calling it done would leave
 *     the real data off-screen forever.
 *  2. **A remount, from `cameraMemo`** — which is what makes the card and the overlay one
 *     continuous view. The memo's existence is also the record that (1) has happened.
 *  3. **The Reset view control**, which forgets the memo and does (1) again.
 *
 * A bounds change still updates the clip planes, because those describe the *space* rather than
 * the view: a scene ten times larger under an unchanged camera clips through its own near plane
 * otherwise. That is the whole of what an extent change is allowed to touch.
 */
function CameraRig({
  framing,
  resetAt,
  refit,
  viewerId,
}: {
  framing: Framing
  resetAt: number
  /** See `Viewer3DProps.refit`: the switch that turns the three rules above into four. */
  refit: boolean
  viewerId?: string
}) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const framed = useRef(false)

  /** Everything an extent change is allowed to touch. */
  const clip = useCallback(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = framing.near
      camera.far = framing.far
      camera.updateProjectionMatrix()
    }
  }, [camera, framing.near, framing.far])

  const frame = useCallback(() => {
    camera.position.set(framing.position[0], framing.position[1], framing.position[2])
    camera.up.set(0, -1, 0)
    clip()
    camera.lookAt(0, 0, 0)
    invalidate()
  }, [camera, framing.position, clip, invalidate])

  // Mount: restore, or frame if this scene has an extent and has never been framed.
  useEffect(() => {
    const remembered = viewerId ? recallCamera(viewerId) : undefined
    if (remembered) {
      camera.position.fromArray(remembered.position)
      camera.up.fromArray(remembered.up)
      camera.quaternion.fromArray(remembered.quaternion)
      clip()
      framed.current = true
      invalidate()
    }
    // Deliberately mount-only: this is the restore, and re-running it on a prop change is the
    // "camera resets under you" behaviour the whole component exists to stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // `size > 1` is how a real extent is told from the placeholder one `framingFor(undefined)`
    // returns. Before a run there is nothing to frame *on*.
    if (!framed.current && framing.size > 1) {
      framed.current = true
      frame()
      return
    }
    /*
     * The fourth thing that moves the camera, and the only one that is opt-in: `Frame each`.
     *
     * Everything the rule above protects still holds while it is off, which is the default. On,
     * an extent change re-frames — which is what a `For Each` stepping through neurons in
     * different parts of the volume needs, and what anybody turning a scene by hand does not.
     * Guarded on a real extent for the same reason as the first framing: a pass whose element
     * produced nothing must not throw the camera at a placeholder box.
     */
    if (refit && framing.size > 1) {
      frame()
      return
    }
    clip()
    invalidate()
  }, [framing, frame, clip, invalidate, refit])

  useEffect(() => {
    if (resetAt === 0) return
    framed.current = true
    frame()
  }, [resetAt, frame])

  /*
   * Save on the way out, and on every settled gesture.
   *
   * Unmount alone would be enough for the card-to-overlay hand-off, but not for a reload of the
   * *other* instance while this one is still up — and a save is three small array writes, so
   * paying it per pointer-up costs nothing worth measuring.
   */
  useEffect(() => {
    if (!viewerId) return
    const save = () => {
      rememberCamera(viewerId, {
        position: camera.position.toArray() as [number, number, number],
        up: camera.up.toArray() as [number, number, number],
        quaternion: camera.quaternion.toArray() as [number, number, number, number],
      })
    }
    const element = gl.domElement
    const doc = element.ownerDocument
    doc.addEventListener('pointerup', save)
    element.addEventListener('wheel', save, { passive: true })
    return () => {
      doc.removeEventListener('pointerup', save)
      element.removeEventListener('wheel', save)
      save()
    }
  }, [viewerId, camera, gl])

  return null
}
