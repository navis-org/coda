/**
 * Moving geometry: the arithmetic, and the bookkeeping that has to travel with it.
 *
 * One operation today — the reflection half of a mirror, `x' = c - x` about a template's own
 * midline — but the shape here is the shape every transform takes, because what is fiddly about
 * moving a neuron is not the coordinates. It is everything that stops being true when they
 * move: a mesh's triangle winding, the bounding box, and whether anything downstream can still
 * tell the copy from the original.
 *
 * ## Three things that stop being true
 *
 * **A reflection reverses orientation, so every triangle's normal flips.** Left alone, a
 * mirrored mesh renders inside-out — lit from within, faces culled the wrong way — which reads
 * as a broken renderer rather than as a broken transform, and so gets reported as a bug in the
 * viewer. navis does `faces[:, ::-1]`; this reverses each triple in `indices`. It applies to a
 * reflection *only*: a bridging warp preserves orientation and reversing there would introduce
 * the very fault this prevents.
 *
 * **Bounds are a roll-up**, and a mirrored set claiming the box it came from frames a 3D viewer
 * on empty space beside the neurons. Same rule and same reason as `sliceElements`.
 *
 * **The ids do not change, and that is deliberate.** A mirrored neuron *is* that neuron, seen
 * on the other side — invariant 8 makes an id an identity, not a label to decorate. What that
 * costs is that stacking the original and the mirror gives two items answering to one id, and
 * `viewer3d` keys its selection on exactly that. So the attribute table gains a `mirrored`
 * column instead: the honest record of what happened, it colours the two apart in a viewer with
 * no new machinery, and it leaves the id alone.
 *
 * ## The pair
 *
 * `mirroredSchema` and `mirroredTable` sit side by side, invariant 3's arrangement, and are
 * unconditional. A `Mark mirrored rows` switch would make the schema depend on a param — the
 * one shape that lets an edit-time promise and a run-time result disagree — to save a column
 * that is one boolean wide.
 */

import type { CodaType, ColumnSchema, TableSchema } from '../../core/types'
import { T, column, tableSchema, uniqueName } from '../../core/types'
import type {
  ColumnData,
  MeshDetail,
  MeshGeometry,
  MeshesValue,
  PointsValue,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { boundsOf, makeTable } from '../../core/values'
import type { MirrorSpec } from '../../data/transforms/spaces'
import type { StackOptions } from './tableOps'
import { stackTables } from './tableOps'
import type { LandmarkPairs } from '../../data/transforms/landmarks'
import { warpPoints } from '../../pyodide/warp'

/** How far along, and what is happening. Both halves reach the node's status bar. */
type Report = (fraction: number, note?: string) => void

/** The three value kinds a transform moves. Not a `CodaType`; see `mirrorableKind`. */
export type GeometryValue = SkeletonsValue | MeshesValue | PointsValue

export function isGeometryValue(v: unknown): v is GeometryValue {
  if (!v || typeof v !== 'object') return false
  const kind = (v as { kind?: unknown }).kind
  return kind === 'skeletons' || kind === 'meshes' || kind === 'points'
}

/**
 * Whether a *type* could carry geometry, which is what `validate` asks.
 *
 * `any` counts, on `isIterableKind`'s rule: unknown is not a refusal, and an unresolved socket
 * is the ordinary state before anything upstream has run.
 */
export function isGeometryKind(kind: string | undefined): boolean {
  return kind === undefined || kind === 'any' || kind === 'skeletons' || kind === 'meshes' || kind === 'points'
}

/** What one item of a value is called, for a message that reads. */
/**
 * The output type for a node that hands geometry straight through, with an optional new schema.
 *
 * Three nodes spelled this out — mirror, transform, stack — and a fourth geometry kind would
 * mean finding all three. `T.any()` for anything else is what `validate` is already refusing,
 * so the type says so rather than promising a shape the node will decline to produce.
 */
/**
 * The attribute schema of a geometry *type*, or undefined where it carries none.
 *
 * `schemaOf` in `core/types.ts` answers this for the two tabular kinds and deliberately not for
 * geometry — its own comment draws the line — so the three geometry kinds needed their own, and
 * had it as an inline `'schema' in input` in one node out of three.
 */
export function schemaOfGeometry(type: CodaType | undefined): TableSchema | undefined {
  return type && 'schema' in type ? type.schema : undefined
}

export function geometryTypeOf(
  kind: string | undefined,
  schema: TableSchema | undefined,
): CodaType {
  if (kind === 'skeletons') return T.skeletons(schema)
  if (kind === 'meshes') return T.meshes(schema)
  if (kind === 'points') return T.points(schema)
  return T.any()
}

export function geometryNoun(v: GeometryValue): string {
  if (v.kind === 'skeletons') return v.items.length === 1 ? 'skeleton' : 'skeletons'
  if (v.kind === 'meshes') return v.items.length === 1 ? 'mesh' : 'meshes'
  return 'points'
}

/** How many coordinates a value holds — what a transform's cost is proportional to. */
export function geometryPointCount(v: GeometryValue): number {
  if (v.kind === 'points') return v.positions.length / 3
  let total = 0
  for (const item of v.items) total += item.positions.length / 3
  return total
}

// ---------------------------------------------------------------------------
// The reflection
// ---------------------------------------------------------------------------

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const

/**
 * Reflect interleaved xyz coordinates about a plane, into a new buffer.
 *
 * A copy rather than in place, and not for tidiness: the buffer handed in belongs to the
 * upstream node's cached result. Writing through it would silently move the neurons the node
 * above is still holding, and the 3D viewer an inch away would redraw somewhere else with
 * nothing connecting the two.
 */
export function flipPositions(
  positions: Float32Array,
  axis: 'x' | 'y' | 'z',
  flipAt: number,
): Float32Array {
  const out = new Float32Array(positions)
  for (let i = AXIS_INDEX[axis]; i < out.length; i += 3) out[i] = flipAt - out[i]!
  return out
}

/**
 * Reverse each triangle's winding, into a new buffer.
 *
 * `[a, b, c]` becomes `[c, b, a]`. Only the order matters — the same three vertices bound the
 * same triangle either way — so this is what puts the normal back the way round it was before
 * the reflection turned the mesh inside out.
 */
export function reverseWinding(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length)
  for (let i = 0; i + 2 < indices.length; i += 3) {
    out[i] = indices[i + 2]!
    out[i + 1] = indices[i + 1]!
    out[i + 2] = indices[i]!
  }
  return out
}

// ---------------------------------------------------------------------------
// The `mirrored` column: schema half and value half
// ---------------------------------------------------------------------------

/**
 * What the column is called. `uniqueName` gives way to an incumbent, so a table that already
 * has a `mirrored` column of its own keeps it and this one becomes `mirrored_2`.
 */
export const MIRRORED_COLUMN = 'mirrored'

function mirroredColumn(schema: TableSchema): ColumnSchema {
  return column(uniqueName(new Set(schema.columns.map((c) => c.name)), MIRRORED_COLUMN), 'bool')
}

/** Schema half. See the pair note at the top of this file. */
export function mirroredSchema(schema: TableSchema | undefined): TableSchema {
  const base = schema ?? tableSchema()
  return tableSchema(...base.columns, mirroredColumn(base))
}

/** Value half. Must agree with `mirroredSchema` — `transformOps.test.ts` asserts it does. */
export function mirroredTable(table: TableValue): TableValue {
  const added = mirroredColumn(table.schema)
  const data: Record<string, ColumnData> = { ...table.data }
  data[added.name] = new Array<boolean>(table.length).fill(true)
  return makeTable(tableSchema(...table.schema.columns, added), data, table.kind)
}

// ---------------------------------------------------------------------------
// The whole operation
// ---------------------------------------------------------------------------

/**
 * Reflect a geometry value about its template's midline.
 *
 * The affine half of a mirror, and on a symmetric template the whole of one. On a real
 * connectome it is an approximation: a fly brain is not symmetric, and the residual is what the
 * spline half corrects — about 7 µm on average for FlyWire and 33 µm for MaleCNS, measured
 * against the shipped landmarks. Worth having on its own because it needs no Python runtime at
 * all, which is a ten megabyte difference on a first Run.
 *
 * **`space` is stamped rather than carried through**, and the two differ in exactly one case
 * that matters: geometry that arrived without a space, mirrored because the user named one on
 * the node. A mirror maps a space onto itself, so the output is in the space the reflection was
 * performed in — and recording it is what puts the user's claim on the card, in the footer, and
 * in front of whatever runs next. Passing it in rather than reading `value.space` is what makes
 * that unskippable: a caller has to have resolved a space to call this at all.
 *
 * ## The round trip is exact in float64 and not in float32
 *
 * Coordinates are `Float32Array`, and `flipAt - x` is evaluated in double and then rounded to
 * the float32 grid *at the midline*, which is a much coarser grid than the one `x` sits on.
 * Mirroring twice therefore lands within half a ULP of the midline rather than exactly back:
 * about 0.016 nm for MANC and 0.031 nm for FlyWire, against an EM voxel of 4 nm. Worth knowing
 * before writing an equality assertion; not worth carrying a float64 copy of every skeleton to
 * avoid.
 */
export function mirrorGeometry(
  value: GeometryValue,
  spec: MirrorSpec,
  space: string,
): GeometryValue {
  const { axis, flipAt } = spec
  const attributes = mirroredTable(value.attributes)

  if (value.kind === 'points') {
    const positions = flipPositions(value.positions, axis, flipAt)
    return { ...value, positions, attributes, bounds: boundsOf([positions]), space }
  }

  if (value.kind === 'skeletons') {
    // `radii` and `parents` ride along untouched. A reflection is rigid, so a radius is
    // unchanged and the tree is the same tree; only where it sits has moved. (A *warp* does
    // change local scale and leaves the radii slightly wrong — navis has the same gap, and the
    // node's guide says so rather than implying a precision that is not there.)
    const items = value.items.map((item) => ({
      ...item,
      positions: flipPositions(item.positions, axis, flipAt),
    }))
    return {
      ...value,
      items,
      attributes,
      bounds: boundsOf(items.map((item) => item.positions)),
      space,
    }
  }

  const items: MeshGeometry[] = value.items.map((item) => ({
    ...item,
    positions: flipPositions(item.positions, axis, flipAt),
    // The half that is easy to leave out and impossible to see in a test that checks numbers.
    indices: reverseWinding(item.indices),
  }))
  return {
    ...value,
    items,
    attributes,
    bounds: boundsOf(items.map((item) => item.positions)),
    space,
  }
}

// ---------------------------------------------------------------------------
// The spline half: one buffer out, one buffer back
// ---------------------------------------------------------------------------

/**
 * Every coordinate of a value in one buffer, for a single crossing of the bridge.
 *
 * A set of skeletons is one buffer per neuron, and calling into Python once per neuron would
 * pay the marshalling five hundred times to do work that is a flat reduction either way. So
 * they are concatenated, warped as one array, and scattered back by the same offsets.
 *
 * The copy is not optional: `callPython` transfers what it is given, and these buffers belong
 * to the upstream node's cached result. Concatenating makes the copy as a side effect, which is
 * the only reason this is free.
 */
export function gatherPositions(value: GeometryValue): Float32Array {
  if (value.kind === 'points') return value.positions.slice()

  let total = 0
  for (const item of value.items) total += item.positions.length
  const out = new Float32Array(total)
  let at = 0
  for (const item of value.items) {
    out.set(item.positions, at)
    at += item.positions.length
  }
  return out
}

/**
 * The same value with new coordinates, scattered back item by item.
 *
 * Everything that is not a coordinate rides through untouched — the attribute table, the
 * reversed winding, the radii, the tree — because the spline moves points and nothing else.
 * Bounds are recomputed, being a roll-up over exactly what changed.
 *
 * **`space` has three states, because the operation does.** A mirror maps a space onto itself
 * and passes nothing — *keep*. A bridge into a known space passes its id — *set*. A bridge
 * through somebody's own registration, whose author did not say where it lands, passes `null` —
 * *clear*, because the coordinates are no longer in the space they started in, and leaving the
 * old id there would have a later Mirror look up landmarks for a space they have left. Two
 * states plus a companion function was the first shape, and it made the third outcome something
 * the caller had to remember rather than something the signature asks for.
 */
export function withPositions(
  value: GeometryValue,
  positions: Float32Array,
  space?: string | null,
): GeometryValue {
  if (positions.length !== geometryPointCount(value) * 3) {
    // A length mismatch scatters every coordinate after the discrepancy onto the wrong point,
    // which is a neuron that still draws and is no longer the neuron it was.
    throw new Error(
      `Transform returned ${positions.length / 3} points for ${geometryPointCount(value)}`,
    )
  }

  /*
   * The key is *removed* rather than set to `undefined` on a clear, because these values are
   * structure-cloned into the scheduler's cache and compared by it, and an absent key and a
   * present-but-undefined one are not the same round trip. Same rule as `geometryFrame`.
   */
  const kept = space === null ? withoutSpaceKey(value) : value
  const moved = typeof space === 'string' ? { space } : {}

  if (kept.kind === 'points') {
    return { ...kept, ...moved, positions, bounds: boundsOf([positions]) }
  }

  let at = 0
  const items = kept.items.map((item) => {
    const slice = positions.slice(at, at + item.positions.length)
    at += item.positions.length
    return { ...item, positions: slice }
  })
  return {
    ...kept,
    ...moved,
    items,
    bounds: boundsOf(items.map((item) => item.positions)),
  } as GeometryValue
}

/** `value` without its `space` key — the deletion half of `withPositions`' third state. */
function withoutSpaceKey(value: GeometryValue): GeometryValue {
  if (!value.space) return value
  const { space: _dropped, ...rest } = value
  return rest as GeometryValue
}

/**
 * What a spline costs, and the ceiling that stops a tab from locking up on one.
 *
 * The cost is **points times landmarks** — every point is a reduction over every landmark —
 * and neither factor is visible from the other: the landmark count comes from the template the
 * geometry happens to be in, and the point count from a fetch several nodes upstream. That is
 * the shape `docs/gotchas.md` records for a node whose output size is a product of two
 * independently-resolved things, and the answer is the same: check before allocating, and name
 * both factors when refusing.
 *
 * The budget is set from a measurement rather than a guess. In this runtime, single-threaded,
 * the throughput is about 8.9e8 point-landmark products per second (262k points per second
 * against 3,390 landmarks; 878k against 1,023 — the product is what stays flat). 1e10 is
 * therefore roughly eleven seconds on the machine that was measured, and perhaps half a minute
 * on a slow laptop.
 *
 * What it allows in practice: 2.9 million points against FlyWire's mirror, which is about two
 * thousand average skeletons — comfortably past the Skeletons node's own 500-neuron ceiling, so
 * no skeleton chain can reach this. **Meshes can.** One hemibrain neuron at the finest level of
 * detail is around 100,000 vertices, so this bites at about thirty of them, and the message
 * says which knob moves.
 */
export const MAX_WARP_PRODUCT = 1e10

export function checkWarpSize(points: number, landmarks: number): void {
  const product = points * landmarks
  if (product <= MAX_WARP_PRODUCT) return
  const seconds = Math.round(product / 8.9e8)
  throw new Error(
    `Warping ${points.toLocaleString()} points through ${landmarks.toLocaleString()} landmarks ` +
      `would take around ${seconds} seconds in the browser, single-threaded. Fetch fewer ` +
      'neurons, take meshes at a coarser level of detail, or turn Warp off for a plain flip.',
  )
}

// ---------------------------------------------------------------------------
// Two collections into one
// ---------------------------------------------------------------------------

/**
 * Whether two geometry values can be stacked, and what to say when they cannot.
 *
 * Three questions, in the order that a reader would want them answered — and each of the three
 * is a case where combining anyway produces a picture rather than an error.
 *
 * - **Kind.** Skeletons and meshes are different value kinds and cannot share one collection.
 *   The 3D viewer takes them on separate ports precisely because they draw differently, so the
 *   message points there rather than implying the wire was wrong.
 *
 * - **Units.** A set in nanometres and a set in voxels stacked together is one collection where
 *   half the neurons are eight times too small, drawn in the same scene, with a bounding box
 *   that frames neither. `checkNblastUnits`' reasoning exactly, and its rule for absence: a
 *   value that does not say is not refused.
 *
 * - **Space.** The one this whole feature exists to make checkable. Two datasets' coordinates
 *   are hundreds of micrometres apart, so combining them un-transformed draws two clouds in
 *   opposite corners of an empty scene — which reads as a broken viewer rather than as a
 *   missing step. Naming `Transform Neurons` is the difference between the two readings.
 *
 * Absent means unknown throughout: the mock connectome and any Custom dataset produce geometry
 * with no space at all, and refusing on a fact nobody stated would break every example.
 */
export function checkStackable(top: GeometryValue, bottom: GeometryValue): void {
  if (top.kind !== bottom.kind) {
    throw new Error(
      `Top is ${geometryNoun(top)} and Bottom is ${geometryNoun(bottom)}. These are different ` +
        'kinds of geometry and cannot share one collection — wire them to separate ports on ' +
        'the 3D View instead.',
    )
  }

  if (top.units && bottom.units && top.units !== bottom.units) {
    throw new Error(
      `Top is in ${top.units} and Bottom is in ${bottom.units}. Stacked, half the collection ` +
        'would be drawn at the wrong scale with nothing to say so.',
    )
  }

  if (top.space && bottom.space && top.space !== bottom.space) {
    throw new Error(
      `Top is in ${top.space} and Bottom is in ${bottom.space}. Two template spaces are ` +
        'hundreds of micrometres apart, so this would draw two clouds in opposite corners of ' +
        'an empty scene. Put both sides through Transform Neurons first.',
    )
  }
}

/**
 * Two geometry collections end to end, with their attribute tables stacked alongside.
 *
 * **The two halves have to move together**, which is the whole difficulty and the reason this
 * is not just array concatenation. `SkeletonsValue` promises one attribute row per item *in the
 * same order*; every consumer reads a neuron's type by indexing the table with the item's
 * position. Concatenating the items and the rows in different orders is a collection where
 * every neuron after the first input's length wears somebody else's name — and it draws.
 *
 * ## What is recomputed, and what is dropped
 *
 * **Bounds** are recomputed, being a roll-up over exactly what changed. **`detail`** is kept
 * only where both sides agree: a mesh set at the finest level stacked with one at the coarsest
 * has no single level of detail, and a caption claiming one is worse than a caption claiming
 * none. Same call `filterNetwork` makes about degrees.
 *
 * **`units` and `space` survive when either side states them**, having been checked compatible
 * by `checkStackable` — so a set that knows where it is passes that on to a collection whose
 * other half did not, which is the only direction that adds information.
 *
 * ## Ids are left exactly alone
 *
 * Two items can now share an id: the obvious case is a neuron stacked with its own mirror, and
 * they are the same neuron. It is tempting to disambiguate the *draw key* — `SkeletonGeometry.id`
 * is documented as a draw and export key rather than the identity, so respelling it would not
 * break invariant 8. It would break something else: the 3D viewer hands its selection back as a
 * list of those keys, and `rowsWithIds` matches them against the attribute table's `neuronId`,
 * which is the identity and cannot be respelled. A suffixed key matches no row and the Selected
 * output comes back empty.
 *
 * So clicking a mirrored neuron selects its original too, and the Selected table has a row for
 * each — told apart by whatever the source column is called. That is the honest answer as well
 * as the only workable one: they *are* the same neuron.
 */
export function stackGeometry(
  top: GeometryValue,
  bottom: GeometryValue,
  options: StackOptions = {},
): GeometryValue {
  checkStackable(top, bottom)
  const attributes = stackTables(top.attributes, bottom.attributes, options)

  // `units` and `space` are equal or one-sided by the time `checkStackable` has passed, so
  // either side's answer is the collection's. Built without the key rather than with an
  // explicit `undefined`, for `geometryFrame`'s structured-clone reason.
  const frame = {
    ...(top.units ?? bottom.units ? { units: top.units ?? bottom.units } : {}),
    ...(top.space ?? bottom.space ? { space: top.space ?? bottom.space } : {}),
  }

  if (top.kind === 'points' && bottom.kind === 'points') {
    const positions = new Float32Array(top.positions.length + bottom.positions.length)
    positions.set(top.positions)
    positions.set(bottom.positions, top.positions.length)
    return { kind: 'points', positions, attributes, bounds: boundsOf([positions]), ...frame }
  }

  if (top.kind === 'skeletons' && bottom.kind === 'skeletons') {
    const items = [...top.items, ...bottom.items]
    return {
      kind: 'skeletons',
      items,
      attributes,
      bounds: boundsOf(items.map((item) => item.positions)),
      ...frame,
    }
  }

  const meshTop = top as MeshesValue
  const meshBottom = bottom as MeshesValue
  const items = [...meshTop.items, ...meshBottom.items]
  // Two levels of detail in one collection is no level of detail. Compared by value rather than
  // by identity: these come from two fetches and are structurally equal at best.
  const detail =
    meshTop.detail && meshBottom.detail && sameDetail(meshTop.detail, meshBottom.detail)
      ? meshTop.detail
      : undefined
  return {
    kind: 'meshes',
    items,
    attributes,
    bounds: boundsOf(items.map((item) => item.positions)),
    ...(detail ? { detail } : {}),
    ...frame,
  }
}

function sameDetail(a: MeshDetail, b: MeshDetail): boolean {
  return a.lod === b.lod && a.levels === b.levels && a.decimated === b.decimated
}

// ---------------------------------------------------------------------------
// Somebody else's landmarks, off a table
// ---------------------------------------------------------------------------

/**
 * Three columns of a table as an `n * 3` float64 buffer in nanometres.
 *
 * float64 rather than the float32 geometry uses, because these are landmarks rather than
 * coordinates: they are what a spline is *fitted from*, and the fit is a cubic solve where the
 * conditioning is worse than anything the transform itself does.
 */
export function landmarkTriple(
  table: TableValue,
  names: readonly string[],
  scale: number,
): Float64Array {
  const out = new Float64Array(table.length * 3)
  for (let axis = 0; axis < 3; axis++) {
    const name = names[axis]!
    const values = table.data[name]
    if (!values) throw new Error(`The landmark table has no column called "${name}".`)
    for (let row = 0; row < table.length; row++) {
      const cell = values[row]
      /*
       * A null coordinate is not a landmark, and there is no substitute for it. Zero would put
       * a control point at the origin and drag every neuron near it — a spline interpolates its
       * landmarks *exactly*, so one bad pair is not averaged away, it is honoured. Refused by
       * row number so it can be found in the file it came from.
       */
      if (typeof cell !== 'number' || !Number.isFinite(cell)) {
        throw new Error(
          `Row ${row + 1} of "${name}" is not a finite number. A spline interpolates its ` +
            'landmarks exactly, so one missing coordinate pins a control point at the origin ' +
            'and pulls every neuron near it.',
        )
      }
      out[row * 3 + axis] = cell * scale
    }
  }
  return out
}

/** The floor for a 3-D thin-plate spline: the affine part alone needs four points. */
export const MIN_LANDMARKS = 4

export function checkLandmarkCount(rows: number): void {
  if (rows < MIN_LANDMARKS) {
    throw new Error(
      `A 3-D thin-plate spline needs at least ${MIN_LANDMARKS} landmarks; this table has ${rows}.`,
    )
  }
}

/**
 * Ceiling, gather, warp, scatter — the whole of applying a spline to a geometry value.
 *
 * Four call sites had this open-coded (both branches of `Mirror Neurons`, both of
 * `Transform Neurons`) and three of the four steps fail *silently* when one is skipped: no
 * `checkWarpSize` is a locked tab, no `gatherPositions` is a detached buffer that leaves the
 * upstream node's cached value empty, and a scatter of the wrong length is a set of neurons
 * that all still draw and are each made of somebody else's branches. The duplication had
 * already drifted — one of the four skipped its progress line — which is how a sequence whose
 * steps must stay together announces that it is one operation.
 *
 * `progress` is handed the whole 0..1 of the spline and the caller decides where that sits in
 * its own bar, so the `0.1 + 0.9 *` ramp is written once here rather than four times.
 */
export async function warpGeometry(
  value: GeometryValue,
  legs: readonly LandmarkPairs[],
  options: { progress: Report; signal?: AbortSignal; space?: string | null },
): Promise<GeometryValue> {
  const points = geometryPointCount(value)
  // Every leg pays the full point count, and the ceiling is about wall-clock rather than about
  // the journey — a set that would take eleven seconds outbound takes eleven seconds back.
  for (const leg of legs) checkWarpSize(points, leg.count)

  /*
   * Gathered once and scattered once, however many legs there are: the intermediate buffers are
   * coordinates in a space nothing looks at, so rebuilding a whole value between hops would
   * allocate a set of neurons and a bounding box for nobody.
   */
  let positions = gatherPositions(value)
  const share = 1 / Math.max(1, legs.length)
  for (const [index, leg] of legs.entries()) {
    const result = await warpPoints(leg, positions, {
      onProgress: (fraction, note) => options.progress(share * (index + fraction), note),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    positions = result.positions
  }
  return withPositions(value, positions, options.space)
}
