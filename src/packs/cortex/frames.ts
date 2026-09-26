/**
 * Cortical frames: where "depth below the pia" and "which layer" come from, per dataset.
 *
 * **No MICrONS table stores a layer per cell** — both are computed from a position, and the rule
 * that does it is a fact about one volume's orientation and one published set of boundaries. So a
 * frame is **data**, declared once per dataset and read by everything that draws or tabulates
 * depth; the gallery is the first reader. See `docs/cortex.md` for where each number came from.
 *
 * **Keyed on the dataset id, the way a template space is** (`bindingFor`, `data/transforms/
 * spaces.ts`): a frame is a fact about coordinates, and a Dataset value carries a source and a
 * dataset id — never a family key — whether it came from a shipped family or a Custom CAVE node.
 *
 * ## The depth transform is rigid, and says so
 *
 * `standard_transform`'s minnie65 transform (version 1.4, unchanged since package 1.0): rotate the
 * nanometre position +5° about z to flatten the pia, then move the pia point to y = 0. The pia
 * point is declared rather than the offset it produces (396,671 nm), so the number that can be
 * checked against the package's source is the number written here. It is exact near the column
 * and drifts away from it, the cortex being curved; the package's streamline field is the
 * correction and is deliberately not taken yet. Checked against `standard_transform` 2.0.0 on
 * four points (`frames.test.ts`).
 *
 * ## Layers are bands with tops, and the last one has no bottom
 *
 * Each band is named by where it **starts**; it ends where the next begins, and the last — white
 * matter — runs on. The flattening puts a few somata above the pia (down to −31 µm on minnie65),
 * and those read as the first band: the cell is in cortex and the frame is what is approximate.
 * **But only within the frame's measured allowance** — a position in voxels, or from another
 * volume, lands hundreds of micrometres above, and reading that as L1 too would draw a clean,
 * plausible column of wrong layers. Beyond the allowance a depth has no layer.
 */

import { NM_PER_UM } from '../../data/transforms/landmarks'
import { inRange } from '../../nodes/lib/chartSelection'
import type { DatasetBinding } from '../../data/transforms/spaces'
import { bindingFor } from '../../data/transforms/spaces'
import type { DatasetIdentity } from '../../nodes/lib/caveParams'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'

/** A rotation about z that flattens the pia, and the pia point that then becomes depth 0. */
export interface RigidDepth {
  /** Degrees, positive as scipy's `from_euler('z', …)`. */
  rotateZ: number
  /** A point on the pia, in nanometres. */
  pia: readonly [number, number, number]
}

/** One layer, from where it starts. */
export interface LayerBand {
  name: string
  /** Micrometres below the pia. */
  top: number
}

export interface CorticalFrame extends DatasetBinding {
  depth: RigidDepth
  /** In order, shallowest first; the first starts at 0. */
  layers: readonly LayerBand[]
  /** How far above the pia (µm) a depth may be and still read as the first layer. */
  aboveTolerance: number
  /**
   * The tables a cell's type can be read from, the first the default — the gallery's `Cell type source`
   * dropdown. Declared rather than listed off the datastack, which publishes synapse tables and
   * coregistrations beside a dozen typings: every entry here was read live and arrives one row per
   * neuron with a `type` column (`cell_type`, renamed by the reader).
   */
  cellTypes: readonly CellTypeSource[]
  /**
   * Which table says how much of a cell was proofread, and which of its columns, where the dataset
   * publishes that at all. Read whichever typing is chosen, so switching tables never switches the
   * proofreading filter off. Absent means the filter has nothing to read.
   */
  proofreading?: {
    table: string
    dendrite: string
    axon: string
    /** A column naming how far the axon was traced, and the values that mean "to its ends". */
    strategy?: { column: string; complete: RegExp }
  }
  /** Where the numbers come from, for a caption. */
  source: string
}

/**
 * What a `cell_type_reference` table is read for: its coarse class and the type, which the CAVE
 * table reader renames `type`.
 */
const REFERENCE_COLUMNS = 'classification_system, cell_type'

/**
 * The typing a dataset's own annotation chain reads (`DatasetFamily.annotationChain`) — the
 * gallery's default, derived rather than restated, so the gallery and every node behind that chain
 * agree on what a cell's type is, and their reads are one cache entry. Throws at load for a family
 * with no such chain, a declaration error rather than a state to handle.
 */
function chainTyping(family: string, note: string): CellTypeSource {
  const node = DATASET_FAMILIES.find((f) => f.family === family)?.annotationChain?.nodes.find(
    (n) => n.type === 'annotation.caveTable',
  )
  const table = node?.params?.['table']
  const columns = node?.params?.['columns']
  if (typeof table !== 'string' || typeof columns !== 'string') {
    throw new Error(`${family} declares no CAVE table in its annotation chain.`)
  }
  return { table, note, columns }
}

/** One table a cell's type can be read from. */
export interface CellTypeSource {
  table: string
  /** What the table is, drawn after its name in the dropdown. */
  note: string
  /** The columns kept, comma-separated as the CAVE table reader takes them. */
  columns: string
}

/**
 * Every declared frame. MICrONS minnie65: the pia point is `standard_transform`'s voxel
 * `[183013, 83535, 21480]` at its `[4, 4, 45]` nm (sic — 45 rather than the volume's 40, and
 * irrelevant, the rotation being about z). The layer tops are Allen's `cortical-layers` classifier
 * (`minnie65_phase3-sub6`) at the column, the only published set with L6a split from L6b, and the
 * one the column's own labelled cells agree with. The allowance is the measured −31 µm, padded.
 */
export const CORTICAL_FRAMES: readonly CorticalFrame[] = [
  {
    scope: 'cave',
    dataset: 'minnie65_public',
    depth: { rotateZ: 5, pia: [183013 * 4, 83535 * 4, 21480 * 45] },
    layers: [
      { name: 'L1', top: 0 },
      { name: 'L2/3', top: 57.6 },
      { name: 'L4', top: 226.4 },
      { name: 'L5', top: 361.3 },
      { name: 'L6a', top: 501.6 },
      { name: 'L6b', top: 678.1 },
      { name: 'WM', top: 716.6 },
    ],
    aboveTolerance: 40,
    // `aibs_cell_info`'s, through minnie65's annotation chain.
    // `cell_type_reference` tables keyed to the nuclei unless noted; `classification_system` is
    // each one's coarse class. Read live at v1822: 1,351 to 94,014 rows, 0.4 to 3.3 s each.
    cellTypes: [
      chainTyping('minnie65_public', 'AIBS, combined by precedence'),
      ...[
        ['aibs_metamodel_celltypes_v661', 'volume-wide cell types'],
        ['aibs_metamodel_mtypes_v661_v2', 'volume-wide m-types'],
        ['allen_v1_column_types_slanted_ref', 'column census cell types'],
        ['allen_column_mtypes_v2', 'column m-types'],
        ['cell_type_multifeature_combo', 'dendrite, soma and spine features'],
        ['baylor_gnn_cell_type_fine_model_v2', 'Baylor GNN, fine'],
        ['baylor_log_reg_cell_type_coarse_v1', 'Baylor, excitatory or inhibitory'],
      ].map(([table, note]) => ({ table: table!, note: note!, columns: REFERENCE_COLUMNS })),
    ],
    proofreading: {
      table: 'aibs_cell_info',
      dendrite: 'dendrite_cleaned',
      axon: 'axon_cleaned',
      strategy: { column: 'axon_strategy', complete: /fully_extended|interareal/ },
    },
    source:
      'Depth: standard_transform (rigid, 5° about z). Layers: Allen cortical-layers, at the column.',
  },
]

/** The frame for a dataset — a Dataset value's `sourceId` and `datasetId` — or undefined. */
export function frameFor(sourceId: string, datasetId: string): CorticalFrame | undefined {
  return bindingFor(CORTICAL_FRAMES, sourceId, datasetId)
}

/** `frameFor` from an identity whose halves may not have resolved yet — a type, or a card's. */
export function frameOf(dataset: DatasetIdentity | undefined): CorticalFrame | undefined {
  return dataset?.sourceId && dataset.datasetId
    ? frameFor(dataset.sourceId, dataset.datasetId)
    : undefined
}

/**
 * A frame's projection, with its constants worked out once — the gallery runs it over every
 * vertex of hundreds of skeletons, where recomputing the trigonometry per point and allocating a
 * result per point was measured at up to 13 times the cost of this. Nanometres in, micrometres
 * out: `lateral` across the cortex, `depth` below the pia (negative above it), `z` unchanged. One
 * rigid motion, so it serves a whole skeleton as well as a soma.
 */
export function projector(frame: CorticalFrame): {
  lateral(x: number, y: number): number
  depth(x: number, y: number): number
  /** A flat xyz buffer as a flat (lateral, depth, z) buffer — `SkeletonGeometry.positions`. */
  project(positions: ArrayLike<number>, out?: Float32Array): Float32Array
} {
  const angle = (frame.depth.rotateZ * Math.PI) / 180
  // The µm conversion folded into the constants: three divisions a vertex fewer.
  const sin = Math.sin(angle) / NM_PER_UM
  const cos = Math.cos(angle) / NM_PER_UM
  const [piaX, piaY] = frame.depth.pia
  const pia = sin * piaX + cos * piaY
  return {
    lateral: (x, y) => cos * x - sin * y,
    depth: (x, y) => sin * x + cos * y - pia,
    project(positions, out = new Float32Array(positions.length)) {
      for (let i = 0; i + 2 < positions.length; i += 3) {
        const x = positions[i]!
        const y = positions[i + 1]!
        out[i] = cos * x - sin * y
        out[i + 1] = sin * x + cos * y - pia
        out[i + 2] = positions[i + 2]! / NM_PER_UM
      }
      return out
    },
  }
}

/**
 * The bottom of the deepest layer. It has none — white matter runs on — and a depth range stored
 * as a selection must be finite (`decodeRange`), so a depth no cortex reaches stands in.
 */
const DEEPEST_UM = 1e6

/** One layer's depths, `lo` inclusive and `hi` exclusive, µm. */
export interface LayerRange {
  name: string
  lo: number
  hi: number
}

const RANGES = new WeakMap<CorticalFrame, readonly LayerRange[]>()

/**
 * Each layer's depths, shallowest first — the one statement of the bounds, which `layerOf` reads
 * and a laminar profile stores as a layer's selection, so a clicked layer selects exactly what it
 * counted. The first layer reaches up to the frame's allowance above the pia (see the module note
 * for why no further). Worked out once per frame: `layerOf` runs per point.
 */
export function layerRanges(frame: CorticalFrame): readonly LayerRange[] {
  let ranges = RANGES.get(frame)
  if (!ranges) {
    ranges = frame.layers.map((band, i) => ({
      name: band.name,
      lo: i === 0 ? -frame.aboveTolerance : band.top,
      hi: frame.layers[i + 1]?.top ?? DEEPEST_UM,
    }))
    RANGES.set(frame, ranges)
  }
  return ranges
}

/** The layer a depth falls in, or undefined beyond `layerRanges`. */
export function layerOf(frame: CorticalFrame, depth: number): string | undefined {
  for (const range of layerRanges(frame)) {
    if (inRange(range, depth)) return range.name
  }
  return undefined
}

/** Where a set of positions sits in a frame, one entry per position: µm, and null where unknown. */
export interface Placed {
  lateral: (number | null)[]
  depth: (number | null)[]
  layer: (string | null)[]
  /** Positions with a depth and no layer — too far above the pia to be read as the first. */
  outside: number
}

/**
 * `count` positions placed in a frame — the one walk the gallery's somata and Cortical Depth's
 * points both take, so a soma and a synapse at one place cannot come out at two depths. `x` and
 * `y` are nanometres by index; `NaN` is a position the source did not have, which places as null
 * rather than at the pia.
 */
export function placeAll(
  frame: CorticalFrame,
  count: number,
  x: (i: number) => number,
  y: (i: number) => number,
): Placed {
  const project = projector(frame)
  const placed: Placed = { lateral: [], depth: [], layer: [], outside: 0 }
  for (let i = 0; i < count; i++) {
    const px = x(i)
    const py = y(i)
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      placed.lateral.push(null)
      placed.depth.push(null)
      placed.layer.push(null)
      continue
    }
    const depth = project.depth(px, py)
    const layer = layerOf(frame, depth)
    if (layer === undefined) placed.outside++
    placed.lateral.push(project.lateral(px, py))
    placed.depth.push(depth)
    placed.layer.push(layer ?? null)
  }
  return placed
}

/**
 * What a node says of a Dataset no frame is declared for — and nothing while the Dataset has not
 * said which it is, an unresolved wire not being a dataset without a frame.
 */
export function frameIssue(dataset: DatasetIdentity | undefined): string | undefined {
  if (!dataset?.sourceId || !dataset.datasetId || frameOf(dataset)) return undefined
  return (
    'No cortical frame is declared for this dataset, so there is no depth or layer to place ' +
    `anything at. Declared for: ${CORTICAL_FRAMES.map((f) => f.dataset).join(', ')}.`
  )
}
