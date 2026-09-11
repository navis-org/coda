/**
 * Exporting a connection query through the canvas's own Cypher — the half that is not a language.
 *
 * `fetch_adjacencies` and neuprintr's connection table return the weight and nothing else about a
 * connection, so a node asking for an edge property has no library route: the notebook and the R
 * document both run the canvas's query text through `fetch_custom`/`neuprint_fetch_custom`. What
 * that takes — which legs, their query text, the columns each returns by position and what they
 * are renamed to, the canvas's column order and dedupe key, whether the primary region list has to
 * be fetched first — is decided here once, and each emitter only spells it. Written per emitter it
 * was the same forty lines twice, which is how the R emitter's region test once came apart from
 * the notebook's.
 *
 * `profile.ts` is the precedent: shared export logic that belongs to neither language.
 */

import type { ParamValues } from '../../core/node'
import type { PopulationFilter } from '../../core/types'
import { columnNames } from '../../core/types'
import { populationFromType } from '../../nodes/lib/populationParams'
import type { NeutralContext } from '../neutral'
import { adjacencyCypher, connectivityCypher } from '../../data/neuprint/cypher'
import type { ConnectionDirection } from '../../data/source'
import {
  CANONICAL_SCHEMAS,
  CONNECTIVITY_ROI_COLUMN,
  connectivitySchemaWithEdgeProperties,
  connectivitySchemaWithRoi,
  edgePropertyColumns,
} from '../../data/source'
import type { EdgeDirection } from '../../nodes/lib/connectivityOps'
import {
  DIRECTION_COLUMN,
  HOP_COLUMN,
  POST_ID,
  PRE_ID,
  connectivityOutputSchema,
  foundAs,
  hopDirections,
  readTraversalDirection,
  regionOptions,
  renamesFor,
} from '../../nodes/lib/connectivityOps'

/**
 * What an exported query carries where the canvas's carries values, filled when the code runs.
 *
 * Braced names, because nothing a builder writes contains one: Cypher's own braces open a map
 * literal (`{roi: r, …}`), never a bare word. One table so the notebook, the R document and the
 * profile helpers' own source cannot each pick a spelling.
 */
export const CYPHER_PLACEHOLDERS = {
  ids: '{ids}',
  rois: '{rois}',
  sources: '{sources}',
  targets: '{targets}',
} as const

/** One direction of a Connectivity export. */
export interface ConnectivityExportLeg {
  /** The canvas's `direction` column for rows found this way — `foundAs`. */
  label: EdgeDirection
  query: string
  /**
   * The query-relative columns onto pre/post — the traversal's own `renamesFor`, so the export
   * orients a row exactly as the canvas does, from one table.
   */
  renames: Record<string, string>
}

export interface ConnectivityExportPlan {
  legs: ConnectivityExportLeg[]
  /** The columns each query returns, by position — `fetch_custom` names them after expressions. */
  fetched: string[]
  /** The edge list's columns in the canvas's order, `hop` and `direction` aside. */
  ordered: string[]
  /** The canvas's dedupe key — the region too, where a region is part of a row. */
  dedupe: string[]
  /**
   * Whether the region list is `CYPHER_PLACEHOLDERS.rois`, the primary set fetched when the code
   * runs. A split with nothing chosen covers the primary set on the canvas (`evaluate` resolves
   * it off the listing before it queries), and without it the export would split over every
   * nested region a connection mentions, the parts adding up to several times the weight.
   */
  primaryRois: boolean
}

/** A Connectivity node's one-hop export, from its params and the edge properties it asks for. */
export function connectivityExportPlan(
  params: ParamValues,
  properties: readonly string[],
): ConnectivityExportPlan {
  const minWeight = Math.max(1, Number(params.minWeight ?? 1))
  const { rois, splitByRoi, primaryOnly } = regionOptions(params)
  const primaryRois = splitByRoi && rois.length === 0 && primaryOnly
  const withProperties = connectivitySchemaWithEdgeProperties(
    CANONICAL_SCHEMAS.connectivity,
    undefined,
    properties,
  )
  const legs = hopDirections(readTraversalDirection(params.direction)).map(
    (direction): ConnectivityExportLeg => ({
      label: foundAs(direction),
      renames: renamesFor(direction),
      query: connectivityCypher(
        {
          datasetId: '',
          neuronIds: [],
          direction,
          minWeight,
          edgeProperties: properties,
          ...(rois.length ? { rois } : {}),
          ...(splitByRoi ? { splitByRoi: true } : {}),
        },
        {
          ids: CYPHER_PLACEHOLDERS.ids,
          ...(primaryRois ? { rois: CYPHER_PLACEHOLDERS.rois } : {}),
          // The libraries' own restriction on the far end, which the rest of both exporters takes.
          ...(params.includeFragments === true ? {} : { partnerLabel: 'Neuron' as const }),
        },
      ),
    }),
  )
  return {
    legs,
    // Read off the schema functions the canvas builds with, since both are assigned by position.
    fetched: columnNames(
      splitByRoi ? connectivitySchemaWithRoi(withProperties) : withProperties,
    ),
    ordered: columnNames(
      connectivityOutputSchema(CANONICAL_SCHEMAS.connectivity, {
        splitByRoi,
        edgeProperties: edgePropertyColumns(undefined, properties),
      }),
    ).filter((name) => name !== HOP_COLUMN && name !== DIRECTION_COLUMN),
    dedupe: splitByRoi ? [PRE_ID, POST_ID, CONNECTIVITY_ROI_COLUMN] : [PRE_ID, POST_ID],
    primaryRois,
  }
}

/**
 * Adjacency's `Weight`, as the canvas's query with both id lists left as placeholders.
 *
 * The property stays the fifth column, so each emitter names it `weight` by position and the rest
 * of its cell reads it with no idea there was a choice — the canvas decoder's arrangement.
 */
export function adjacencyExportQuery(weight: string): string {
  return adjacencyCypher(
    { datasetId: '', sourceIds: [], targetIds: [], weight },
    { sourceIds: CYPHER_PLACEHOLDERS.sources, targetIds: CYPHER_PLACEHOLDERS.targets },
  )
}

/**
 * Neuron Profile's `Count by`, as two queries for the profile helpers — one per direction.
 *
 * Query-relative, as the helpers' partner tables are, with the property after the weight; the
 * helper makes it the weight and applies the threshold to it, since that is the count the card
 * shows — which is also why no `Min weight` is written in. The far end is `:Neuron`, the library
 * calls' restriction everywhere else in those helpers.
 */
export function profilePropertyQueries(
  property: string,
): Record<'upstream' | 'downstream', string> {
  const query = (direction: ConnectionDirection) =>
    connectivityCypher(
      { datasetId: '', neuronIds: [], direction, edgeProperties: [property] },
      { ids: CYPHER_PLACEHOLDERS.ids, partnerLabel: 'Neuron' },
    )
  return { upstream: query('inputs'), downstream: query('outputs') }
}

/**
 * What a Connectivity export's partner restriction cannot carry: the population the Dataset node
 * narrows to, or nothing when there is nothing to say.
 *
 * Both libraries restrict the far end by label alone — `:Neuron` unless `Include fragments` is
 * ticked, and ticked there is no restriction to fall short of — so a Dataset node's population
 * checkboxes reach the seeds on the canvas and no partner in either document. Small and said
 * rather than large and silent: on male-CNS the label alone keeps 496 partners and the label plus
 * superclass keeps 492. The list rides as data because each language names it inside its own
 * sentence.
 */
export function unexpressedPopulation(
  ctx: Pick<NeutralContext, 'params' | 'inputType'>,
): PopulationFilter[] {
  if (ctx.params.includeFragments === true) return []
  return populationFromType(ctx.inputType('dataset'))
}
