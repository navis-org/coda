/**
 * What the start page puts on its rails.
 *
 * The groups are not interchangeable, and the split is what the rail labels are for.
 * **Browse Workflows** is one card that opens the Zoo browser — the only thing here that goes
 * to the network before it can show anything, and the only one whose graphs belong to somebody
 * else. **Examples** run on the synthetic sources
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
import { starterFamilies } from '../../nodes/lib/datasetFamilies'
import type { WorkflowSummary } from '../../store/library'
import { formatAgo, plural } from '../format'
import type { TourId } from '../tour/tourState'
import { TOURS } from '../tour/tourState'

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

/**
 * The Zoo browser: a card that opens something instead of loading something.
 *
 * It carries no graph and no starter, which is the whole of what distinguishes it — the Zoo
 * asks its own replace question over its own preview, so this card must not ask one on the
 * rail. Kept in the union rather than special-cased in `StartPage` so that `Deck`, `Card` and
 * the keyboard walk keep working on it without knowing what it is.
 */
export interface ZooCard extends CardBase {
  kind: 'zoo'
}

/** A tour, launched over the editor this page is sitting on top of. */
export interface TourCard extends CardBase {
  kind: 'tour'
  tour: TourId
}

/** A graph the user saved in this browser. See `store/library.ts`. */
export interface WorkflowCard extends CardBase {
  kind: 'workflow'
  /** Node type whose glyph the tile draws, chosen the same way an example's is. */
  nodeType: string
  category: NodeCategory
}

export type StartCard = ExampleCard | DatasetCard | WorkflowCard | ZooCard | TourCard

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
 * One card per live dataset family worth starting from.
 *
 * The mock families are excluded because the rail says these are live datasets that want a
 * token — putting the synthetic ones under that caption would be a lie, and they are already
 * what every example on the other rail runs on. Filtering on "not the mock" rather than on
 * "is neuPrint" means a source added later shows up here on its own.
 *
 * `starterFamilies` is the other filter, and it is shared with the toolbar's New menu rather
 * than repeated: both rails build the *same* graph through `buildStarter`, so a family offered
 * in one and not the other is a split that would end up depending on which file was edited last.
 * See `DatasetFamily.starter` — the nodes it holds back are still in `Add ▸ Dataset`.
 */
export function datasetCards(): DatasetCard[] {
  return starterFamilies()
    .filter((family) => family.sourceId !== 'mock')
    .map((family) => ({
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
 * The Zoo browser's card.
 *
 * A constant rather than a builder because nothing about it is derived — there is one Zoo, and
 * what it holds is not known until the browser has fetched its index. That is also the reason
 * this is one card rather than a rail of community workflows: the index is a network fetch, and
 * the start page opens on every launch (see `ZooGate` for the two deferrals that keeps).
 */
export const ZOO_CARD: ZooCard = {
  kind: 'zoo',
  id: 'zoo',
  title: 'Browse the Coda Zoo',
  blurb: 'Search workflows other people shared, each with a README and a preview.',
}

/**
 * The doors: the rail of cards that open a surface rather than handing over a graph.
 *
 * The rail is what keeps the label below it honest. Everything on **Examples** is bundled, runs
 * on synthetic data and replaces the canvas the moment it is clicked; nothing here does. The
 * three tours announce what they will do to the canvas in their own first step and are undoable
 * by the ordinary means, and the Zoo asks its replace question over the workflow being opened.
 *
 * Tours first, because "show me how" outranks "open somebody else's workflow" on a first visit,
 * and in `TOURS`' own order — which puts the dashboard tour last, the one whose blurb already
 * admits it wants a neuPrint token.
 *
 * Built from `TOURS` rather than restated: three surfaces launch these and each used to carry
 * its own wording, which is what the table was introduced to stop. A module constant, unlike
 * the other three rails, because none of it is derived from the node registry — see the note at
 * the top of this file for why that matters there and not here.
 */
const TOUR_CARDS: TourCard[] = TOURS.map((tour) => ({
  kind: 'tour',
  id: `tour:${tour.id}`,
  title: tour.label,
  blurb: tour.blurb,
  tour: tour.id,
}))

export const DOOR_CARDS: StartCard[] = [...TOUR_CARDS, ZOO_CARD]

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
