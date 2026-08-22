/**
 * Graph to notebook.
 *
 * Walks the graph in topological order and asks each node's emitter for a cell. Everything
 * that is not a per-node decision lives here: variable naming, where the notes land, the
 * setup cell, and the one case where the whole export is refused.
 */

import type { CodaGraph, GraphNode } from '../../core/graph'
import { inboundIndex, nodesById, portKey } from '../../core/graph'
import { exportOrder } from '../order'
import { inferGraph } from '../../core/inference'
import type { NodeDefinition, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { getNodeDef, isAnnotation } from '../../core/registry'
import type { CodaType } from '../../core/types'
import type { ExportRefusal, TodoStep } from '../canExport'
import { canExportNotebook, nodeLabel } from '../canExport'
import type { Notebook } from './notebook'
import { buildNotebook } from './notebook'
import { pyComment, pyIdent } from './py'
import { emitterBackends, getEmitter, resolveHelpers } from './registry'
import type { Cell, EmitContext, PyModule } from './types'
import { MODULES } from './types'

export interface ExportOptions {
  /**
   * Timestamp for the provenance line, ISO 8601. Injected rather than read from the clock so
   * a golden file can be compared at all — the same reason workflow scripts elsewhere here
   * are forbidden `Date.now()`. Omitted entirely when absent.
   */
  now?: string
  /** App version for the provenance line. */
  appVersion?: string
}

export type ExportResult =
  | { ok: true; notebook: Notebook; warnings: string[]; todos: TodoStep[] }
  | ({ ok: false } & ExportRefusal)

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"` — for a message listing ports or nodes. */
function quoted(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`)
  return q.length <= 2 ? q.join(' and ') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`
}

// ---------------------------------------------------------------------------
// Variable naming
// ---------------------------------------------------------------------------

/**
 * One variable per node, named after what the node is called on the canvas.
 *
 * The title if it has one, the definition's label otherwise, so a renamed node carries its
 * name into the notebook — which is the whole reason someone renames a node. Collisions take
 * a numeric suffix rather than being silently merged, and the suffix starts at 2 so the first
 * `Filter` stays `filter_` and only the second becomes `filter_2`.
 */
function assignNames(order: string[], nodes: Map<string, GraphNode>): Map<string, string> {
  const names = new Map<string, string>()
  const used = new Map<string, number>()

  for (const id of order) {
    const node = nodes.get(id)
    if (!node) continue
    const def = getNodeDef(node.type)
    if (!def || def.annotation) continue

    const base = pyIdent(node.title || def.label, 'step')
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    names.set(id, seen === 0 ? base : `${base}_${seen + 1}`)
  }
  return names
}

/**
 * The variable for one output port.
 *
 * A single-output node takes the node's name unadorned, which is the overwhelming majority
 * and the readable case. A node with several outputs suffixes the port — `paths_network`,
 * `paths_layout` — because `paths[0]`, `paths[1]` says nothing about which is which.
 */
function outputName(base: string, def: NodeDefinition, portId: string): string {
  const outputs = def.outputs ?? []
  if (outputs.length <= 1) return base
  return `${base}_${pyIdent(portId, 'out')}`
}

/**
 * The backend behind a source id.
 *
 * `neuprint`, `cave`, `mock` — the part before the colon, since a non-default neuPrint
 * deployment registers as `neuprint:https://…` (see `sourceIdForServer`) and is still neuPrint
 * as far as which library can query it.
 */
function backendOf(sourceId: string): string {
  const at = sourceId.indexOf(':')
  return at === -1 ? sourceId : sourceId.slice(0, at)
}

/** How a backend is spelled in prose, since a source id is lower case and a name is not. */
const BACKEND_NAMES: Record<string, string> = { cave: 'CAVE', neuprint: 'neuPrint' }

/**
 * A dataset backend this node's emitter was not written against, or undefined.
 *
 * Read off `def.inputs` rather than by asking for a port called `dataset`, which is the bug
 * class `ports.test.ts` exists for — a hardcoded port id that is wrong for one node and fails
 * silently on it. Every dataset-shaped port is checked, reference ports included, since a
 * reference names a datastack and naming a CAVE one is exactly the case at issue.
 *
 * An *unresolved* dataset type says nothing and refuses nothing: no `sourceId` is the ordinary
 * state before a listing lands (invariant 2), and refusing there would turn a cold session into
 * a notebook of TODOs.
 */
function unsupportedBackend(
  def: NodeDefinition,
  inputTypes: Readonly<Record<string, CodaType | undefined>>,
): string | undefined {
  const supported = emitterBackends(def.type)
  for (const port of def.inputs ?? []) {
    if (port.type.kind !== 'dataset') continue
    const resolved = inputTypes[port.id]
    const sourceId = resolved?.kind === 'dataset' ? resolved.sourceId : undefined
    if (sourceId && !supported.includes(backendOf(sourceId))) return backendOf(sourceId)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export function exportNotebook(graph: CodaGraph, options: ExportOptions = {}): ExportResult {
  const refusal = canExportNotebook(graph, 'python')
  if (refusal) return { ok: false, ...refusal }

  // Referenced nodes first — see `exportOrder`; `topoSort` alone is the running order, which
  // is the opposite of the writing order.
  const { order, cyclic } = exportOrder(graph)
  const nodes = nodesById(graph)
  const inbound = inboundIndex(graph)
  const inference = inferGraph(graph)
  const names = assignNames(order, nodes)

  const warnings: string[] = []
  /** Nodes whose cell came out as a TODO, in walk order. See `TodoStep`. */
  const todos: TodoStep[] = []
  const modules = new Map<PyModule, Set<string>>()
  const helpers = new Set<string>()
  /** Output port → variable, for ports that actually produced one. */
  const bound = new Map<string, string>()

  const require = (module: PyModule, ...names_: string[]): void => {
    const set = modules.get(module) ?? new Set<string>()
    for (const n of names_) set.add(n)
    modules.set(module, set)
  }

  const bodyCells: Cell[] = []

  for (const nodeId of order) {
    const node = nodes.get(nodeId)
    if (!node) continue
    const def = getNodeDef(node.type)

    // A note is not in the dataflow: it becomes a markdown cell and binds nothing.
    if (isAnnotation(node.type)) {
      const text = String(node.params?.text ?? '').trim()
      if (text) bodyCells.push({ kind: 'markdown', source: text.split('\n') })
      continue
    }

    if (!def) {
      warnings.push(`Unknown node type "${node.type}" — emitted as a comment.`)
      // It binds nothing, so everything downstream is blocked — which is exactly what a TODO
      // step is, and a surface warning about them would otherwise miss the worst case there is.
      todos.push({ nodeId, label: node.title || node.type })
      bodyCells.push({
        kind: 'code',
        source: pyComment(`Unknown node type "${node.type}". Skipped.`),
      })
      continue
    }

    const header = `# ── ${node.title || def.label} ──`

    if (node.disabled) {
      bodyCells.push({
        kind: 'code',
        source: [
          header,
          ...pyComment(
            'Muted on the canvas, so it produced nothing and nothing downstream of it ' +
              'ran. Left here rather than dropped, because a node missing from the ' +
              'notebook and a node deliberately switched off look identical otherwise.',
          ),
        ],
      })
      continue
    }

    const emitter = getEmitter(node.type)
    const params: ParamValues = { ...defaultParams(def), ...node.params }
    const inputTypes = inference.nodes[nodeId]?.inputs ?? {}
    const inferCtx = makeInferContext(def, params, inputTypes)
    const varName = names.get(nodeId) ?? 'step'

    const inputVar = (portId: string): string | undefined => {
      const edge = inbound.get(portKey(nodeId, portId))
      if (!edge) return undefined
      return bound.get(portKey(edge.source, edge.sourceHandle))
    }

    // A TODO is the single channel for "no code came out of this". Tracking it here is what
    // stops a node that could not be translated from binding variables nothing ever assigns —
    // which read downstream as working code referring to a name that does not exist.
    let emittedTodo = false
    const ctx: EmitContext = {
      node,
      def,
      params,
      name: varName,
      input: inputVar,
      wired: (portId) => {
        const variable = inputVar(portId)
        if (variable === undefined) {
          throw new Error(
            `emitter asked for required input "${portId}", which ${def.type} does not have`,
          )
        }
        return variable
      },
      output: (portId) => outputName(varName, def, portId),
      inputType: (portId): CodaType | undefined => inputTypes[portId],
      // Delegated rather than rebuilt: `makeInferContext` already composes exactly these three
      // out of `resolveColumn`/`resolveColumns`, and invariant 5 turns on infer, eval and the
      // provenance key resolving a column the same way. A second copy here is a fourth way for
      // them to disagree.
      schema: (portId) => inferCtx.schema(portId),
      column: (paramId) => inferCtx.column(paramId),
      columns: (paramId) => inferCtx.columns(paramId),
      require,
      helper: (name) => helpers.add(name),
      todo: (message) => {
        emittedTodo = true
        return pyComment(`TODO: ${message}`)
      },
      note: (message) => pyComment(`NOTE: ${message}`),
    }

    /*
     * Both ways an input can fail to arrive, asked of the **definition** rather than left to
     * each emitter.
     *
     * They are different facts and are worth saying differently: an *unwired* required port is
     * a graph somebody has not finished, where a *blocked* one is wired to a node this
     * translation could not emit — conflating them sends the reader to the canvas to fix a wire
     * that is already there. Blocked mirrors the scheduler, which reaches its own `blocked`
     * state down exactly this edge.
     *
     * Hoisting it here is what removed thirty-odd hand-written `if (!ctx.input('in')) return
     * ctx.todo('Nothing is wired…')` guards, each of which hardcoded a port id as a string.
     * That is the bug class `ports.test.ts` exists for — `out.profile` read an input called
     * `in` on a node whose port is `neurons`, so it reported "nothing is wired" for a node
     * plainly wired on the canvas. The walk reads the ids off `def.inputs` and cannot mistype
     * one. Emitters keep only the guards that are genuinely conditional: an optional port, an
     * unpicked column, an unset field.
     */
    const unwired: string[] = []
    const blockedBy: string[] = []
    for (const port of def.inputs ?? []) {
      const edge = inbound.get(portKey(nodeId, port.id))
      if (!edge) {
        if (port.required !== false) unwired.push(port.label ?? port.id)
        continue
      }
      if (bound.has(portKey(edge.source, edge.sourceHandle))) continue
      /*
       * A reference is not a value dependency, so an unbound one is not a blockage. It can only
       * be unbound when the referenced node comes *later* — which `referencesFirst` avoids where
       * it can and cannot avoid at all for the wiring references exist for, since there the
       * dataset consumes the very node referencing it. An emitter reading a reference falls back
       * to the referenced node's type, which is all a reference ever promised.
       */
      if (port.reference === true) continue
      blockedBy.push(nodeLabel(nodes.get(edge.source)))
    }

    const foreign = unsupportedBackend(def, inputTypes)

    let body: string[]
    if (unwired.length > 0) {
      body = ctx.todo(
        `${quoted(unwired)} ${unwired.length === 1 ? 'is' : 'are'} not wired on this ` +
          `${def.label}, so there is nothing to translate.`,
      )
    } else if (blockedBy.length > 0) {
      body = ctx.todo(
        `nothing upstream produced a value — ${quoted([...new Set(blockedBy)])} ` +
          `${blockedBy.length === 1 ? 'was' : 'were'} not translated.`,
      )
    } else if (!emitter) {
      warnings.push(`${def.label} has no Python equivalent yet.`)
      body = ctx.todo(
        `"${def.label}" has no notebook equivalent yet, so this step is missing from ` +
          'the translation. Everything downstream of it refers to variables that were ' +
          'never bound.',
      )
    } else if (foreign !== undefined) {
      /*
       * A third way a node fails to translate, and worth saying apart from the other two for the
       * same reason those are said apart: this is a graph that is perfectly well wired, on a
       * backend nobody has written *this node's* cell for. Sending the reader to the canvas to
       * check a wire would be sending them nowhere.
       */
      const named = BACKEND_NAMES[foreign] ?? foreign
      warnings.push(`${def.label} has no ${named} equivalent yet.`)
      body = ctx.todo(
        `"${def.label}" is wired to a ${named} dataset, and its notebook cell has only been ` +
          `written for neuPrint. The dataset itself is a real client, so this is the step to ` +
          `fill in by hand.`,
      )
    } else {
      try {
        body = emitter(ctx)
      } catch (err) {
        warnings.push(`${def.label} failed to export: ${(err as Error).message}`)
        body = ctx.todo(`"${def.label}" could not be exported: ${(err as Error).message}`)
      }
    }

    // Only bind the outputs if the emitter actually produced code. A TODO binds nothing, so
    // downstream sees an unconnected input and says so, rather than referring to a variable
    // that does not exist.
    if (emittedTodo) todos.push({ nodeId, label: nodeLabel(node) })

    if (!emittedTodo && body.length > 0) {
      for (const port of def.outputs ?? []) {
        bound.set(portKey(nodeId, port.id), outputName(varName, def, port.id))
      }
    }

    bodyCells.push({ kind: 'code', source: [header, ...body] })
  }

  for (const nodeId of cyclic) {
    warnings.push(`"${nodeLabel(nodes.get(nodeId))}" is part of a cycle and was not exported.`)
  }

  // Helpers first, and not for tidiness: a helper declares modules of its own, so building
  // the setup cell before them would leave a generated function calling an import nobody made.
  const helperCell = helperCells(helpers, require)

  const cells: Cell[] = [
    ...titleCells(graph, options),
    setupCell(modules),
    ...helperCell,
    ...bodyCells,
  ]

  return { ok: true, notebook: buildNotebook(cells), warnings, todos }
}

// ---------------------------------------------------------------------------
// The standing cells
// ---------------------------------------------------------------------------

function titleCells(graph: CodaGraph, options: ExportOptions): Cell[] {
  const name = graph.meta?.name?.trim() || 'Untitled workflow'
  const lines = [`# ${name}`]
  const description = graph.meta?.description?.trim()
  if (description) lines.push('', description)

  const provenance = ['Exported from Coda']
  if (options.appVersion) provenance.push(`v${options.appVersion}`)
  if (options.now) provenance.push(`on ${options.now}`)
  lines.push('', `*${provenance.join(' ')}.*`)

  return [{ kind: 'markdown', source: lines }]
}

function setupCell(modules: Map<PyModule, Set<string>>): Cell {
  // Declaration order in `MODULES`, which is already the order the block should read in —
  // an explicit `order` field would be a second copy of that, free to disagree with it.
  const declared = Object.keys(MODULES) as PyModule[]
  const entries = [...modules.entries()].sort(
    (a, b) => declared.indexOf(a[0]) - declared.indexOf(b[0]),
  )

  const pip = entries.map(([m]) => MODULES[m].pip).filter((p): p is string => !!p)
  const lines: string[] = []
  if (pip.length > 0) lines.push(`# pip install ${[...new Set(pip)].sort().join(' ')}`, '')

  for (const [module, names] of entries) {
    const spec = MODULES[module]
    if (spec.from) {
      if (names.size === 0) continue
      lines.push(`from ${spec.from} import ${[...names].sort().join(', ')}`)
    } else if (spec.statement) {
      lines.push(spec.statement)
    }
  }

  return { kind: 'code', source: lines.length > 0 ? lines : ['# No imports needed.'] }
}

/**
 * The helper cell.
 *
 * Emitted only when something asked for a helper, so a workflow of pandas one-liners carries
 * none of it. The modules a helper needs are collected *here*, after the walk, which is why
 * `require` is threaded in rather than closed over at the call site.
 */
function helperCells(
  names: Set<string>,
  require: (module: PyModule, ...names: string[]) => void,
): Cell[] {
  if (names.size === 0) return []
  const specs = resolveHelpers(names)

  for (const spec of specs) {
    for (const [module, ...imported] of spec.requires ?? []) require(module, ...imported)
  }

  const lines: string[] = [
    ...pyComment(
      'Helpers, generated by Coda. These are the parts of the workflow that have no ' +
        'equivalent in the libraries this notebook imports, written out here so it stands ' +
        'on its own.',
    ),
    '',
  ]
  specs.forEach((spec, i) => {
    if (i > 0) lines.push('', '')
    lines.push(...spec.source)
  })

  return [{ kind: 'code', source: lines }]
}
