/**
 * What the start page puts on its two rails.
 *
 * Two groups, and they are not interchangeable. **Examples** run on the synthetic sources
 * generated in the browser, so they open, run and draw with no token and no network — which is
 * what makes them safe to hand a first-time visitor. **Datasets** build a starter graph pointed
 * at a live server, which is the real tool and needs a token before Run does anything.
 *
 * Both card kinds carry an optional `image`. Nothing sets it yet and the tile falls back to a
 * glyph, so a screenshot can drop in later without the layout moving — and, more importantly,
 * an example added next year is never blank. Same rule as `NodeThumbnail`, same reason.
 *
 * Built on demand rather than at module load: resolving a node type requires the node pack to
 * be registered, and a module-level constant here would make import order in `App.tsx`
 * load-bearing for no gain.
 */

import type { NodeCategory } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { EXAMPLES } from '../../examples'
import type { StarterSpec } from '../../examples/starters'
import type { DatasetGlyph } from '../../nodes/lib/datasetFamilies'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import type { WorkflowSummary } from '../../store/library'
import { formatAgo, plural } from '../format'

interface CardBase {
  id: string
  title: string
  blurb: string
  /** A real picture of the result. Unset today; the tile draws a glyph instead. */
  image?: string
}

export interface ExampleCard extends CardBase {
  kind: 'example'
  /** Node type whose glyph the tile draws. */
  nodeType: string
  category: NodeCategory
}

export interface DatasetCard extends CardBase {
  kind: 'dataset'
  glyph: DatasetGlyph
  starter: StarterSpec
}

/** A graph the user saved in this browser. See `store/library.ts`. */
export interface WorkflowCard extends CardBase {
  kind: 'workflow'
  /** Node type whose glyph the tile draws, chosen the same way an example's is. */
  nodeType: string
  category: NodeCategory
}

export type StartCard = ExampleCard | DatasetCard | WorkflowCard

/**
 * The node an example's tile stands for: the last visualisation node in its graph.
 *
 * Derived from `build()` rather than declared on the example, so a new example gets a correct
 * tile for free. Falls back to the last node of any kind and then to the table viewer, because
 * a tile that throws is worse than a tile that is merely generic.
 */
function tileNode(types: string[]): { nodeType: string; category: NodeCategory } {
  const viewer = [...types]
    .reverse()
    .find((type) => getNodeDef(type)?.category === 'visualisation')
  const type = viewer ?? types.at(-1) ?? 'out.table'
  return { nodeType: type, category: getNodeDef(type)?.category ?? 'visualisation' }
}

export function exampleCards(): ExampleCard[] {
  return EXAMPLES.map((example) => ({
    kind: 'example',
    id: example.id,
    title: example.name,
    blurb: example.summary,
    ...tileNode(example.build().nodes.map((node) => node.type)),
  }))
}

/**
 * One card per live dataset family.
 *
 * The mock families are excluded because the rail says these are live datasets that want a
 * token — putting the synthetic ones under that caption would be a lie, and they are already
 * what every example on the other rail runs on. Filtering on "not the mock" rather than on
 * "is neuPrint" means a source added later shows up here on its own.
 */
export function datasetCards(): DatasetCard[] {
  return DATASET_FAMILIES.filter((family) => family.sourceId !== 'mock').map((family) => ({
    kind: 'dataset',
    id: family.key,
    title: family.label,
    blurb: family.description,
    glyph: family.glyph,
    starter: {
      nodeType: `dataset.${family.key}`,
      label: family.label,
      sourceId: family.sourceId,
    },
  }))
}

/**
 * One card per workflow saved in this browser, newest first — the order `listWorkflows` returns.
 *
 * The rail is built from summaries rather than from the graphs, which is the whole reason
 * `WorkflowSummary` carries `nodeTypes`: a shelf of ten graphs is megabytes of JSON, and the
 * start page needs a glyph from each, not a document.
 *
 * The blurb says when it was saved and how big it is, because a shelf of the user's own graphs
 * is distinguished by *which* copy this is, not by a description of what it does. Same rule as
 * the other two rails on the art: derived from what the app already draws, never per-item.
 */
export function workflowCards(library: WorkflowSummary[], now = Date.now()): WorkflowCard[] {
  return library.map((entry) => ({
    kind: 'workflow',
    id: entry.id,
    title: entry.name,
    blurb: `Saved ${formatAgo(entry.savedAt, now)} · ${plural(entry.nodeTypes.length, 'node')}`,
    ...tileNode(entry.nodeTypes),
  }))
}
