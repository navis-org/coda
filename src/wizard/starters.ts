/**
 * Starter graphs — what "New ▸ hemibrain" and the start page's dataset rail build.
 *
 * An empty canvas is a poor first screen: it asks the newcomer to know both which nodes exist
 * and which dataset they want, before they have seen a single neuron. A starter answers the
 * second question from the menu and the first by example, and lands you somewhere you can
 * immediately look around.
 *
 * **A starter is a Workflow Wizard answer**, and nothing more: the dataset, *Interactive Search*,
 * *Neuron table only*, and a Table — plus Neuroglancer where the source publishes a scene:
 *
 *   Dataset ─┬─▸ Explore ──(Selected)─┬─▸ Table
 *            └────────────────────────┴─▸ Neuroglancer
 *
 * One builder, so a starter cannot answer a question the wizard also asks — which viewer, which
 * Explore port, `Additional tags`, the annotation chain — differently. Three things are said
 * differently, each a `BuildOptions` field rather than a branch in here:
 *
 *  - **the dataset node** is the spec's own type and params — a pinned version, a custom server,
 *    or a custom dataset node that is no family at all;
 *  - **no overview note.** The hints stay, docked to the two cards somebody has to act on, and so
 *    does a chain's caption; the paragraph saying the wizard built this from four answers would be
 *    describing questions nobody was asked;
 *  - **its name and description** are the starter's, since "Browsing hemibrain" is what it is for.
 *
 * `selection` and `page` arrive **empty**: the Explore widget writes both, so a starter carrying
 * either would ship whoever built it's browsing position. `defaultParams` supplies them, so this
 * is a matter of not overriding them, which nothing here does.
 *
 * It opens with the wizard's one layout pass as well (`loadStarter` in the store), under the
 * wizard's own remembered preference: its positions are arithmetic nobody chose.
 */

import type { CodaGraph } from '../core/graph'
import type { DatasetFamily } from '../nodes/lib/datasetFamilies'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'
import { buildWorkflow } from './build'
import type { VisualisationId } from './options'
import { sourceCan } from './options'

export interface StarterSpec {
  /** Dataset node type to open with, e.g. `dataset.malecns`. */
  nodeType: string
  /** Display label, used for the graph's name. */
  label: string
  /** Which registered source it belongs to, so the starter can ask what that source can do. */
  sourceId?: string
  /** Params for the dataset node — a pinned version, or a custom server and dataset. */
  params?: Record<string, unknown>
}

/** The starter a family's menu row or start-page card opens. */
export function starterFor(family: DatasetFamily): StarterSpec {
  return { nodeType: `dataset.${family.key}`, label: family.label, sourceId: family.sourceId }
}

export function buildStarter(spec: StarterSpec): CodaGraph {
  const family = familyForNodeType(spec.nodeType)
  /*
   * An *offer* question — is a scene cell worth putting in the graph — asked of the ceiling, as
   * the wizard asks it (`familyCan` is this same reading, of a family's source). Of the spec's own
   * source rather than the family's, because a custom dataset node has a source and no family. The
   * mock generates its geometry in the browser and has no bucket for an external viewer to read,
   * so on a mock starter the node would open as one that can only ever warn.
   */
  const visualisations: VisualisationId[] = sourceCan(spec.sourceId, 'viewerScene')
    ? ['table', 'neuroglancer']
    : ['table']
  const graph = buildWorkflow(
    {
      // The family key where there is one. A custom node is no family, and its key is then only a
      // name nothing looks up: `dataset` below is what builds its node.
      datasets: [family?.key ?? spec.nodeType],
      start: 'browse',
      analysis: 'neurons',
      visualisations,
      notes: true,
      dashboard: false,
    },
    {
      dataset: {
        type: spec.nodeType,
        ...(spec.params ? { params: spec.params } : {}),
        ...(spec.sourceId ? { sourceId: spec.sourceId } : {}),
      },
      overview: false,
    },
  )
  const chain = family?.annotationChain
  const labels = chain ? `, with ${chain.title} wired in as its labels` : ''
  return {
    ...graph,
    meta: {
      ...graph.meta,
      name: spec.label,
      description: `Browsing ${spec.label}${labels}. Search in the Explore Dataset node, tick neurons, then Run.`,
    },
  }
}
