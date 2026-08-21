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
import { EXAMPLES } from '../examples'
import type { NodeCategory, NodeDefinition, ParamDef } from '../core/node'
import { listableNodeDefs } from '../core/registry'
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
  /** The default, rendered the way the card renders it — an enum shows its option's label. */
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
  /** Names of the bundled examples whose graph contains this type. */
  examples: string[]
}

export interface GuideData {
  nodes: GuideNode[]
  /** Every example name, so the page can say how many graphs the cross-reference covers. */
  examples: string[]
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
      value: defaultLabel(p),
      picker: p.kind === 'enum' || p.kind === 'column' || p.kind === 'columns',
    }))
}

/**
 * What the card would show in the value chip.
 *
 * An enum prints its *option's* label rather than the stored value, because that is what the
 * picker shows and a guide that said `outputs` where the app says `downstream (outputs)` would
 * be describing a different control. Options can be computed rather than fixed — from the
 * resolved input types (Filter's operator list is dtype-aware), from a dataset listing that has
 * not arrived (every Version picker), or from another param (Custom CAVE's Materialization
 * follows its Datastack). None can be evaluated without a graph, so they resolve to the honest
 * answer rather than to a guess. Deliberately not "depends on the input", which was true of the
 * first case and of neither of the others.
 */
function defaultLabel(p: ParamDef): string {
  switch (p.kind) {
    case 'enum': {
      if (typeof p.options === 'function') return 'resolved live'
      const hit = p.options.find((o) => o.value === p.default)
      return hit?.label ?? p.options[0]?.label ?? '—'
    }
    case 'boolean':
      return p.default ? 'on' : 'off'
    case 'column':
      return p.default || (p.optional ? 'none' : 'first compatible')
    case 'columns':
      return p.default.length ? p.default.join(', ') : 'all'
    case 'ids':
      return p.default.length ? `${p.default.length} selected` : 'none'
    default:
      return p.default === '' ? '—' : String(p.default)
  }
}

function portsOf(ports: readonly NonNullable<NodeDefinition['inputs']>[number][]): GuidePort[] {
  return ports.map((p) => ({
    id: p.id,
    label: p.label ?? p.id,
    kind: p.type.kind,
    ...socketStyle(p.type),
    required: p.required !== false,
  }))
}

/**
 * Which bundled examples use each type, derived rather than listed.
 *
 * The examples are built programmatically, so this is one pass over `build()` and cannot go
 * stale — an example rewritten to drop a node loses its mention here on the next build. Text
 * notes are skipped: every example carries several, and "seen in all five" says nothing.
 */
function exampleIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const example of EXAMPLES) {
    for (const node of example.build().nodes) {
      const seen = index.get(node.type) ?? []
      if (!seen.includes(example.name)) seen.push(example.name)
      index.set(node.type, seen)
    }
  }
  return index
}

export function guideData(): GuideData {
  const usedIn = exampleIndex()
  const nodes = listableNodeDefs()
    .map((def): GuideNode => ({
      type: def.type,
      label: def.label,
      description: def.description ?? '',
      guide: def.guide ?? def.description ?? '',
      category: def.category,
      cost: def.cost,
      annotation: def.annotation === true,
      inputs: portsOf(def.inputs ?? []),
      outputs: portsOf(def.outputs ?? []),
      params: paramsOf(def),
      examples: def.annotation ? [] : (usedIn.get(def.type) ?? []),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return { nodes, examples: EXAMPLES.map((e) => e.name) }
}
