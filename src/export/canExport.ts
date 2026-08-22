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
 *
 * **The rule is per language, though the policy is not.** The two exporters no longer cover the
 * same backends — FlyWire emits caveclient in Python and nothing in R — so the question is
 * "can this graph be exported *as this*", and every caller says which. Sharing the policy while
 * splitting the answer is what stops the Save menu offering an R document of nothing but TODOs
 * while correctly offering the notebook beside it.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { getNodeDef } from '../core/registry'
import type { ExportLanguage } from '../nodes/lib/datasetFamilies'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'

/**
 * A node the walk could not translate, so its cell is a TODO.
 *
 * Reported by both walks rather than derived from the finished document, because a TODO is a
 * fact about a *node* and a cell is text — recovering the pairing by scanning for `# TODO:`
 * would be matching on prose, which is the coupling `reportAuthFailure` exists to avoid.
 *
 * Every reason lands here: no emitter for this language, a backend the emitter was not written
 * against, an unwired required port, an upstream that was itself a TODO, and whatever an
 * emitter refuses on its own. A surface warning about them does not need to tell them apart —
 * what the reader wants to know before clicking is *how much of my graph will be missing*.
 */
export interface TodoStep {
  nodeId: string
  /** What the node is called on the canvas. */
  label: string
}

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

/**
 * Dataset nodes from a backend this language has no emitter for.
 *
 * The second refusal, and it exists for the same reason as the first rather than as an
 * exception to it: the dataset cell is the one with nothing behind it, and `emit.ts` cascades a
 * TODO to every node downstream — so what comes out is a document of nothing but TODOs. Both
 * exporters already skip the families they cannot emit; this is the half that stops the menu
 * offering it.
 *
 * `synthetic` is excluded so the two refusals cannot both fire on one node: a mock family has no
 * `notebook` either, and its own message is the more useful one.
 */
export function untranslatableDatasetNodes(
  graph: CodaGraph,
  language: ExportLanguage,
): GraphNode[] {
  return graph.nodes.filter((node) => {
    const family = familyForNodeType(node.type)
    return family !== undefined && !family.synthetic && family.notebook?.[language] === undefined
  })
}

/** What the generated document would be built on, for a message naming what is missing. */
const STACK: Record<ExportLanguage, string> = {
  python: 'neuprint-python and caveclient',
  r: 'neuprintr',
}

/** The refusal, or undefined when the graph can be exported as this. */
export function canExportNotebook(
  graph: CodaGraph,
  language: ExportLanguage,
): ExportRefusal | undefined {
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
  const untranslatable = untranslatableDatasetNodes(graph, language)
  if (untranslatable.length > 0) {
    const names = untranslatable.map((n) => `“${nodeLabel(n)}”`)
    const what = language === 'python' ? 'notebook' : 'document'
    return {
      reason:
        names.length === 1
          ? `${names[0]} has no ${what} equivalent`
          : `${names.join(', ')} have no ${what} equivalent`,
      detail:
        `The generated ${what} is built on ${STACK[language]}, and there is no emitter for ` +
        `this backend yet — so every cell after the dataset would be a TODO.` +
        (language === 'r' ? ' The Jupyter notebook may still cover it.' : ''),
      fix: `no ${what} can be built for this backend yet`,
    }
  }
  return undefined
}
