/**
 * What the exports of the nodes that read from somewhere decide, before either language says it:
 * the dataset nodes, Input IDs, Raw Cypher, Skeletons and a Google Sheet.
 *
 * Their refusals are a node that names nothing to read — no dataset, no query, no sheet, a pasted
 * id list that does not parse — and their notes say which copy of the data the document reads:
 * which release a "Latest" dataset was pinned to, and that a Skeletons node set to the published
 * layer is translated as neuPrint's own SWC. Each was a test written into both emitters beside a
 * sentence, and the notes' sentences really do differ — a notebook is not a document — so those
 * ride as keys (`neutral.ts`' note rule).
 */

import type { ParamValues } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { sheetConfigFrom, sheetExportUrl } from '../../data/annotations'
import { namedColumns } from '../../data/annotations/types'
import { DEFAULT_SERVER } from '../../data/neuprint/servers'
import { SKELETON_ROUTES } from '../../data/skeletonRoutes'
import { datasetFamily, resolveDatasetId } from '../../nodes/lib/datasetFamilies'
import { parseIdList } from '../../nodes/lib/idList'
import { SKELETON_SOURCE_PARAM } from '../../nodes/lib/skeletonParams'
import type { NeutralContext, Noted, Refusable } from '../neutral'
import { synapsesBetweenCypher } from '../../data/neuprint/cypher'
import type { SynapseLocation } from '../../data/source'
import { minSynapseConfidence } from '../../nodes/lib/synapseParams'
import { CYPHER_PLACEHOLDERS } from './connectivity'

// ---------------------------------------------------------------------------
// Dataset nodes
// ---------------------------------------------------------------------------

/** A note a dataset export may carry. The texts are each renderer's; *whether* is decided here. */
export type DatasetNote =
  /** "Latest", and the export could not resolve which release that is, so it names the family. */
  | 'unresolvedLatest'
  /** "Latest", pinned to the release it resolved to at export. */
  | 'pinnedLatest'

/** Which dataset on which server a document connects to. */
export type DatasetPlan = Refusable<{
  datasetId: string
  server: string
  notes: DatasetNote[]
}>

/**
 * A family's dataset node. The listing is what turns "Latest" into a version, and it is a network
 * call the exporter has not made — so an unresolved "Latest" names the family alone, which still
 * connects, and says so; leaving it silent would put an unpinned dataset into a file somebody
 * shares, which is the provenance question mark the version dropdown exists to close.
 */
export function datasetFamilyPlan(familyKey: string, params: ParamValues): DatasetPlan {
  const family = datasetFamily(familyKey)
  if (!family) return { refusal: `Unknown dataset family "${familyKey}".` }
  const version = params.version
  const resolved = resolveDatasetId(family, version)
  return {
    datasetId: resolved || family.family,
    server: String(params.server ?? '') || DEFAULT_SERVER,
    notes: !resolved ? ['unresolvedLatest'] : !version ? ['pinnedLatest'] : [],
  }
}

/** The Custom neuPrint node, which names its own deployment and dataset — no family to consult. */
export function neuprintNodePlan(params: ParamValues): DatasetPlan {
  const datasetId = String(params.dataset)
  if (!datasetId) return { refusal: 'This neuPrint node names no dataset.' }
  return { datasetId, server: String(params.server), notes: [] }
}

/** The superseded generic picker, still exported because a saved graph may hold one. */
export function datasetNodePlan(params: ParamValues): DatasetPlan {
  const datasetId = String(params.dataset)
  if (!datasetId) return { refusal: 'This Dataset node names no dataset.' }
  return { datasetId, server: DEFAULT_SERVER, notes: [] }
}

// ---------------------------------------------------------------------------
// Input IDs
// ---------------------------------------------------------------------------

export type InputIdsPlan = Refusable<{
  /** The pasted ids, as text — invariant 8; each renderer spells them exactly. */
  ids: string[]
  /** The upstream table on the Ids port, when one is wired. */
  from?: string
  /** The column of `from` the ids are read out of. */
  column: string
  /**
   * The upstream variable on the optional Dataset port, or the note saying the node is then the
   * ids alone — a one-column table, which is what it emits on the canvas.
   */
  dataset: Noted<{ connection: string }>
}>

/**
 * A pasted list that does not parse refuses only when nothing is wired to take its place — the
 * node's own reading, where a wired table is an answer on its own.
 */
export function inputIdsPlan(
  ctx: Pick<NeutralContext, 'params' | 'input' | 'column'>,
): InputIdsPlan {
  const parsed = parseIdList(String(ctx.params.ids))
  const from = ctx.input('ids')
  if (parsed.error && !from) {
    return { refusal: `The pasted id list is not valid: ${parsed.error}` }
  }
  const connection = ctx.input('dataset')
  return {
    ids: parsed.ids,
    from,
    column: ctx.column('column') ?? ID_COLUMN_NAME,
    dataset: connection
      ? { connection }
      : {
          note: 'No Dataset is wired, so this is the ids alone — exactly what the node emits.',
        },
  }
}

// ---------------------------------------------------------------------------
// Raw Cypher
// ---------------------------------------------------------------------------

export function rawCypherPlan(params: ParamValues): Refusable<{ query: string }> {
  const query = String(params.query).trim()
  return query ? { query } : { refusal: 'This Raw Cypher node has no query.' }
}

// ---------------------------------------------------------------------------
// Synapses Between
// ---------------------------------------------------------------------------

/** What a Synapses Between export decides before either language writes a line. */
export type SynapsesBetweenPlan = Refusable<{
  location: SynapseLocation
  minConfidence: number
  includeFragments: boolean
  /** The column naming the side left open, when one is. */
  open: typeof ID_COLUMN_NAME | 'partnerId' | undefined
  /**
   * The canvas's Cypher with each wired end's list a placeholder, and an open end labelled
   * `:Neuron` unless fragments are included — neuprint-python's own default for an open side,
   * standing in for the Dataset-card population a document cannot ask.
   */
  query: string
}>

/**
 * Synapses Between's shared decisions, `adjacencyExportQuery`'s arrangement one level up: both
 * exporters read the open side, the label and the query from here, so the notebook and the R
 * document cannot come to run different queries for one card.
 *
 * `wired` is which ports carry a value. A wired port whose upstream emitted nothing never reaches
 * an emitter — the walk blocks the node first — so absent here really is unwired.
 */
export function synapsesBetweenPlan(
  params: ParamValues,
  wired: { sources: boolean; targets: boolean },
): SynapsesBetweenPlan {
  if (!wired.sources && !wired.targets) {
    return { refusal: 'Neither Sources nor Targets is wired, so there is nothing to ask for.' }
  }
  const location = params.location === 'post' ? 'post' : 'pre'
  const minConfidence = minSynapseConfidence(params)
  const includeFragments = params.includeFragments === true
  const open = !wired.sources ? ID_COLUMN_NAME : !wired.targets ? 'partnerId' : undefined
  const query = synapsesBetweenCypher(
    {
      datasetId: '',
      location,
      minConfidence,
      ...(wired.sources ? { sourceIds: [] } : {}),
      ...(wired.targets ? { targetIds: [] } : {}),
    },
    {
      sourceIds: CYPHER_PLACEHOLDERS.sources,
      targetIds: CYPHER_PLACEHOLDERS.targets,
      ...(open && !includeFragments ? { partnerLabel: 'Neuron' as const } : {}),
    },
  )
  return { location, minConfidence, includeFragments, open, query }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

/** A note a Skeletons export may carry. The texts are each renderer's; *whether* is decided here. */
export type SkeletonsNote =
  /**
   * The node is set to the published precomputed layer; the document reads neuPrint's own SWC.
   *
   * A note rather than a refusal, and the line is where `Detail` on the Meshes node draws it: the
   * document fetches real skeletons for the right neurons, and what differs is *which copy*. The
   * published layer is a precomputed directory whose URL is resolved from the dataset's
   * neuroglancer state at run time, and an exporter has no network. Two things genuinely differ,
   * so both notes say both: the published copy carries no radii (male-CNS declares no vertex
   * attributes at all), and its coverage is whatever was exported into it — `optic-lobe:v1.0.1`
   * answered 5 of 20 sampled bodies. A document silently a few neurons short is the failure these
   * exporters mind most.
   */
  'publishedLayer'

export interface SkeletonsPlan {
  /** `0` fetches every neuron. */
  limit: number
  notes: SkeletonsNote[]
}

export function skeletonsPlan(params: ParamValues): SkeletonsPlan {
  return {
    limit: Number(params.limit),
    notes:
      params[SKELETON_SOURCE_PARAM] === SKELETON_ROUTES.published ? ['publishedLayer'] : [],
  }
}

// ---------------------------------------------------------------------------
// Google Sheet
// ---------------------------------------------------------------------------

export type GoogleSheetPlan = Refusable<{
  /** The CSV export address of the sheet's tab. */
  url: string
  idColumn: string
  /** The named annotation columns, the id column aside. Empty reads every column. */
  columns: string[]
}>

/**
 * A sheet the params cannot locate refuses with the sentence `validate` puts on the card and
 * `evaluate` throws, rather than a fourth wording of one refusal.
 */
export function googleSheetPlan(params: ParamValues): GoogleSheetPlan {
  const { config, error } = sheetConfigFrom(params)
  if (error) return { refusal: error }
  if (!config) return { refusal: 'This node names no sheet.' }
  return {
    url: sheetExportUrl(config.documentId, config.gid),
    idColumn: config.idColumn,
    columns: namedColumns(config.columns, config.idColumn),
  }
}
