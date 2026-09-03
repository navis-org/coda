/**
 * The node guide's data, read off the node registry.
 *
 * ## This module never reaches the browser
 *
 * It imports `../nodes` for its registration side effect, which drags in `src/core`,
 * `src/data` and — through the neuroglancer node — a corner of `src/ui`. Measured as a
 * browser bundle that is **660 kB (211 kB gzipped)** plus elkjs and the Draco decoder, against
 * a tutorial page that is 4 kB. So the guide page must not import it: `vite/nodeGuideData.ts`
 * loads this module *at build time* through Vite's SSR pipeline and hands the page the finished
 * JSON as `virtual:node-guide-data`.
 *
 * That indirection is what buys the property worth having — the guide cannot drift. There is no
 * generated file to regenerate, no second list of node names to keep in step, and a node added
 * next month appears with a correct entry, correct sockets and a correct preview card without
 * anyone touching this directory.
 *
 * ## What is *not* here
 *
 * Anything the page can derive for itself. Glyphs, socket colours, section grouping and the
 * preview card's construction are all in `main.ts`, because they are drawing decisions; this
 * module answers only "what does the registry say".
 */

import '../nodes'
/*
 * The sources too, not only the node pack — the trap `CLAUDE.md` records under module init order.
 * The wizard's option space is gated on `capabilityOf`, which answers *true* for a source nobody
 * registered, so this module SSR'd on its own would enumerate combinations the app never offers
 * and credit a Neuroglancer cell to the synthetic dataset. `registerBuiltinSources` is idempotent
 * and the browser never loads this file, which is what makes a side effect here affordable.
 */
import { registerBuiltinSources } from '../data/builtins'
import { DEMO_DATASET, buildWorkflow } from '../wizard/build'
import { analysisOption, analysisOptions, everyCombination } from '../wizard/options'
import type { NodeCategory, NodeDefinition, ParamDef, ResolvedPort } from '../core/node'
import type { DatasetGlyph } from '../nodes/lib/datasetFamilies'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'
import { listableNodeDefs } from '../core/registry'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'
/*
 * Shared with the help figures, which print a parameter's value in the same awkward cases —
 * `resolved live`, `first compatible`, an enum's option label. There was one copy here; a second
 * would have been a second place to get them wrong. Headless, so it loads in Node at build time
 * like the rest of this module.
 */
import { paramIsPicker, paramValueLabel } from '../help/paramText'
import { socketStyle } from '../ui/socketStyle'
import type { SocketFamily, SocketShape } from '../ui/socketStyle'

export interface GuidePort {
  id: string
  label: string
  /** Type *kind* rather than the full type: the column list is unknown before wiring. */
  kind: string
  family: SocketFamily
  shape: SocketShape
  required: boolean
}

export interface GuideParam {
  id: string
  label: string
  kind: ParamDef['kind']
  help?: string
  /** Inspector-only: not drawn on the card. */
  advanced: boolean
  /** Cannot change what `evaluate` returns, so editing it stales nothing. */
  presentational: boolean
  /** The default, rendered the way the card renders it — see `help/paramText.ts`. */
  value: string
  /** Draws as a dropdown or a column picker, so the preview gives it a ▾. */
  picker: boolean
}

export interface GuideNode {
  type: string
  label: string
  category: NodeCategory
  description: string
  guide: string
  cost: 'cheap' | 'expensive'
  /** Annotations draw their own card: no header, no sockets, no state bar. */
  annotation: boolean
  inputs: GuidePort[]
  outputs: GuidePort[]
  params: GuideParam[]
  /** Wizard workflows whose graph contains this type, by the question they answer. */
  workflows: string[]
  /**
   * Which specimen silhouette a dataset node's family declares, for the nodes that have one.
   *
   * Registry data rather than a drawing decision — `glyph` is a field on `DatasetFamily` — which
   * is what lets it travel in this JSON while `main.ts` keeps deciding what to do with it. The
   * page cannot look it up for itself: reading the family table in the browser would put every
   * blurb and version list behind a document that needs one field.
   */
  datasetGlyph?: DatasetGlyph
}

export interface GuideData {
  nodes: GuideNode[]
  /** Every workflow name, so the page can say how many graphs the cross-reference covers. */
  workflows: string[]
}

/**
 * `internal` params are excluded and `advanced` ones are not.
 *
 * A nonce or a pager is machinery some widget writes, and listing it in a guide would be
 * documenting a control nobody sets — the same reason the card's "… N more" counter skips it.
 * `advanced` is the opposite case: those are real settings that happen to live in the
 * inspector, and a guide is exactly where somebody finds out they exist.
 */
function paramsOf(def: NodeDefinition): GuideParam[] {
  return (def.params ?? [])
    .filter((p) => !p.internal)
    .map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      ...(p.help ? { help: p.help } : {}),
      advanced: p.advanced === true,
      presentational: p.presentational === true,
      value: paramValueLabel(p),
      picker: paramIsPicker(p),
    }))
}

function portsOf(ports: readonly ResolvedPort[]): GuidePort[] {
  return ports.map((p) => ({
    id: p.id,
    label: p.label ?? p.id,
    kind: p.type.kind,
    ...socketStyle(p.type),
    required: p.required !== false,
  }))
}

/**
 * Which wizard workflows use each type, derived rather than listed.
 *
 * This was a pass over the four bundled examples. They are gone, and the replacement is better
 * for the same reason the wizard is: it enumerates **every combination the wizard can build** on
 * the synthetic dataset, so a viewer that only one answer reaches — the pie chart, the graph
 * metrics card — is credited, where four hand-written graphs mentioned whatever they happened to
 * contain.
 *
 * Named by the *analysis* rather than by the combination, because "Who they connect to" is a
 * question a reader recognises and "Demo Data / browse / partners / pie" is a row of settings.
 * Several combinations therefore collapse onto one name, which is what makes the list short
 * enough to read.
 *
 * Notes are built too and then not indexed: `note.text` would otherwise be "seen in" every
 * workflow there is, which says nothing.
 */
function workflowIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const answers of everyCombination(DEMO_DATASET)) {
    const name = analysisOption(answers.analysis)?.label ?? answers.analysis
    for (const node of buildWorkflow({ ...answers, notes: false }).nodes) {
      const seen = index.get(node.type) ?? new Set<string>()
      seen.add(name)
      index.set(node.type, seen)
    }
  }
  return index
}

/**
 * The workflow names, in the order the wizard offers them.
 *
 * Asked of the analyses directly rather than by walking the combinations a second time and
 * deduping their labels — which is the same list by construction, since every analysis is
 * reachable (`wizard.test.ts`: "never offers a question with nothing in it").
 */
function workflowNames(): string[] {
  return analysisOptions(DEMO_DATASET).map((option) => option.label)
}

/**
 * Spread rather than assigned, so a node with no family carries no key at all. The JSON is
 * inlined into the page, and 90-odd `"datasetGlyph": undefined` entries are bytes every reader
 * downloads to learn nothing.
 */
function glyphOf(type: string): { datasetGlyph?: DatasetGlyph } {
  const glyph = familyForNodeType(type)?.glyph
  return glyph ? { datasetGlyph: glyph } : {}
}

export function guideData(): GuideData {
  registerBuiltinSources()
  const usedIn = workflowIndex()
  const nodes = listableNodeDefs()
    .map((def): GuideNode => ({
      type: def.type,
      label: def.label,
      description: def.description ?? '',
      guide: def.guide ?? def.description ?? '',
      category: def.category,
      cost: def.cost,
      annotation: def.annotation === true,
      // The node guide describes a *type*, so a variadic node is shown at the arity a fresh
      // one opens at — the same reading the palette and the browser take.
      inputs: portsOf(defaultInputPorts(def)),
      outputs: portsOf(defaultOutputPorts(def)),
      params: paramsOf(def),
      workflows: def.annotation ? [] : [...(usedIn.get(def.type) ?? [])],
      ...glyphOf(def.type),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return { nodes, workflows: workflowNames() }
}
