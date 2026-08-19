/**
 * Can this graph be exported, and what is a node called?
 *
 * Deliberately tiny and deliberately outside `src/export/python`. Two surfaces ask the
 * question before anything is exported — the Save menu and the command palette — and the
 * palette asks it on **every store change**, so importing the exporter to find out would drag
 * every emitter and every generated Python helper into the main chunk for a feature that runs
 * on an explicit click. Same doctrine as elkjs, three.js and sigma; measured at 54 kB raw /
 * 17.6 kB gzipped before this module existed.
 *
 * It is also the one place the refusal policy is stated. The two surfaces *present* it
 * differently — a menu can answer back, a palette row cannot — but what counts as
 * unexportable is one rule in one place.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { getNodeDef } from '../core/registry'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'

export interface ExportRefusal {
  /** Short phrase naming the problem. */
  reason: string
  /**
   * What to do about it, in full. A refusal that does not say this reads as the feature being
   * broken rather than as a graph that needs one change.
   */
  detail: string
  /**
   * The same instruction, terse.
   *
   * Both surfaces have to say what to change, and they have very different room to say it in:
   * the Save menu replaces the item with a paragraph, while a palette row gets one breadcrumb
   * segment. One rule with two lengths, rather than two surfaces inventing their own wording
   * and drifting.
   */
  fix: string
}

/**
 * What a node is called, for a message about it.
 *
 * The user's own title first, because that is what they are looking at on the canvas.
 */
export function nodeLabel(node: GraphNode | undefined): string {
  if (!node) return 'a node'
  return node.title || getNodeDef(node.type)?.label || node.type
}

/**
 * Synthetic dataset nodes, which are the reason an export can be refused outright.
 *
 * A `dataset.mock.*` connectome is generated in the browser: no server, no token, and no id
 * that means anything outside this tab. Every other gap in the translation degrades to a TODO
 * comment because the surrounding cells are still worth having — here the *first* cell is the
 * one with nothing behind it, so what would come out is a notebook nobody can fix without
 * knowing which real dataset was meant.
 */
export function syntheticDatasetNodes(graph: CodaGraph): GraphNode[] {
  return graph.nodes.filter((node) => familyForNodeType(node.type)?.synthetic === true)
}

/** The refusal, or undefined when the graph can be exported. */
export function canExportNotebook(graph: CodaGraph): ExportRefusal | undefined {
  if (graph.nodes.length === 0) {
    return {
      reason: 'this graph is empty',
      detail: 'Add a dataset and a query before exporting.',
      fix: 'add a dataset and a query first',
    }
  }

  const synthetic = syntheticDatasetNodes(graph)
  if (synthetic.length > 0) {
    const names = synthetic.map((n) => `“${nodeLabel(n)}”`)
    return {
      reason:
        names.length === 1
          ? `${names[0]} is a synthetic dataset`
          : `${names.join(', ')} are synthetic datasets`,
      detail:
        'Coda generates these connectomes in the browser, so there is no server for a ' +
        'notebook to query. Replace them with a real dataset node and export again.',
      fix: 'generated in the browser — swap in a real dataset first',
    }
  }
  return undefined
}
