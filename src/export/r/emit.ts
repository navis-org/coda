/**
 * Graph to R Markdown.
 *
 * A copy of `python/emit.ts` rather than a shared walk, which was a deliberate call: the two
 * exporters share the fixture graph and the refusal policy, and nothing else. What that buys
 * is that a change to how R chunks are assembled cannot reach the notebook; what it costs is
 * that the structural rules — topological order, variable naming, unwired-versus-blocked,
 * where the notes land — now exist twice. **If you fix one, look at the other.**
 *
 * Two things here are genuinely R's rather than transcribed. Chunk labels have to be unique or
 * knitr aborts the render, so they are derived from the variable names the walk has already
 * deduplicated; and the setup chunk has to distinguish CRAN packages from `neuprintr`, which
 * is only on GitHub.
 */

import type { CodaGraph, GraphNode } from '../../core/graph'
import { inboundIndex, nodesById, portKey } from '../../core/graph'
import { exportOrder } from '../order'
import { inferGraph } from '../../core/inference'
import type { NodeDefinition, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { getNodeDef, isAnnotation } from '../../core/registry'
import { inputPorts, outputPorts } from '../../core/ports'
import type { CodaType } from '../../core/types'
import type { ExportRefusal, TodoStep } from '../canExport'
import { canExportNotebook, nodeLabel } from '../canExport'
import { renderRmd } from './rmarkdown'
import { chunkLabel, rComment, rIdent, rPortIdent } from './r'
import { getEmitter, resolveHelpers } from './registry'
import type { Cell, EmitContext, RPackage } from './types'
import { PACKAGES } from './types'

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
  | { ok: true; source: string; warnings: string[]; todos: TodoStep[] }
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

    const base = rIdent(node.title || def.label, 'step')
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
 *
 * The suffix goes through `rPortIdent` rather than `rIdent`, because a port id may be camelCase where
 * a node label may not — see there.
 */
function outputName(
  base: string,
  def: NodeDefinition,
  params: ParamValues,
  portId: string,
): string {
  const outputs = outputPorts(def, params)
  if (outputs.length <= 1) return base
  return `${base}_${rPortIdent(portId)}`
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export function exportRmd(graph: CodaGraph, options: ExportOptions = {}): ExportResult {
  const refusal = canExportNotebook(graph, 'r')
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
  const packages = new Set<RPackage>()
  const helpers = new Set<string>()
  /** Output port → variable, for ports that actually produced one. */
  const bound = new Map<string, string>()

  const library = (pkg: RPackage): void => {
    packages.add(pkg)
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
        label: `unknown-${bodyCells.length}`,
        source: rComment(`Unknown node type "${node.type}". Skipped.`),
      })
      continue
    }

    const header = `# ── ${node.title || def.label} ──`
    // Hoisted above the muted branch, unlike the notebook walk: every chunk needs a unique
    // label, including the one that only carries a comment.
    const varName = names.get(nodeId) ?? 'step'

    if (node.disabled) {
      bodyCells.push({
        kind: 'code',
        label: chunkLabel(varName),
        source: [
          header,
          ...rComment(
            'Muted on the canvas, so it produced nothing and nothing downstream of it ' +
              'ran. Left here rather than dropped, because a node missing from the ' +
              'document and a node deliberately switched off look identical otherwise.',
          ),
        ],
      })
      continue
    }

    const emitter = getEmitter(node.type)
    const params: ParamValues = { ...defaultParams(def), ...node.params }
    const inputTypes = inference.nodes[nodeId]?.inputs ?? {}
    const inferCtx = makeInferContext(def, params, inputTypes)

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
      output: (portId) => outputName(varName, def, node.params, portId),
      inputType: (portId): CodaType | undefined => inputTypes[portId],
      // Delegated rather than rebuilt: `makeInferContext` already composes exactly these three
      // out of `resolveColumn`/`resolveColumns`, and invariant 5 turns on infer, eval and the
      // provenance key resolving a column the same way. A second copy here is a fourth way for
      // them to disagree.
      schema: (portId) => inferCtx.schema(portId),
      attributes: (portId, part) => inferCtx.attributes(portId, part),
      column: (paramId) => inferCtx.column(paramId),
      columns: (paramId) => inferCtx.columns(paramId),
      library,
      helper: (name) => helpers.add(name),
      todo: (message) => {
        emittedTodo = true
        return rComment(`TODO: ${message}`)
      },
      note: (message) => rComment(`NOTE: ${message}`),
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
    for (const port of inputPorts(def, node.params)) {
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

    let body: string[]
    let blockedHere = false
    if (unwired.length > 0) {
      body = ctx.todo(
        `${quoted(unwired)} ${unwired.length === 1 ? 'is' : 'are'} not wired on this ` +
          `${def.label}, so there is nothing to translate.`,
      )
    } else if (blockedBy.length > 0) {
      blockedHere = true
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
    if (emittedTodo) {
      todos.push({ nodeId, label: nodeLabel(node), ...(blockedHere ? { blocked: true } : {}) })
    }

    if (!emittedTodo && body.length > 0) {
      for (const port of outputPorts(def, node.params)) {
        bound.set(portKey(nodeId, port.id), outputName(varName, def, node.params, port.id))
      }
    }

    bodyCells.push({ kind: 'code', label: chunkLabel(varName), source: [header, ...body] })
  }

  for (const nodeId of cyclic) {
    warnings.push(`"${nodeLabel(nodes.get(nodeId))}" is part of a cycle and was not exported.`)
  }

  // Helpers first, and not for tidiness: a helper attaches packages of its own, so building
  // the setup chunk before them would leave a generated function calling a library nobody
  // attached.
  const helperCell = helperChunk(helpers, library)

  const cells: Cell[] = [
    ...titleCells(graph),
    setupChunk(packages),
    ...helperCell,
    ...bodyCells,
  ]

  const source = renderRmd(cells, {
    title: graph.meta?.name?.trim() || 'Untitled workflow',
    ...(options.now ? { date: options.now } : {}),
  })
  return { ok: true, source, warnings, todos }
}

// ---------------------------------------------------------------------------
// The standing cells
// ---------------------------------------------------------------------------

/**
 * The prose above the setup chunk.
 *
 * The title itself lives in the YAML header rather than here, so `#` at the top of the body
 * would render a second one.
 */
function titleCells(graph: CodaGraph): Cell[] {
  const description = graph.meta?.description?.trim()
  const provenance = '*Exported from Coda.*'
  return [
    { kind: 'markdown', source: description ? [description, '', provenance] : [provenance] },
  ]
}

/**
 * `library(...)` for everything used, and an install line above it.
 *
 * **`neuprintr` is not on CRAN**, so a single `install.packages(...)` line covering everything
 * would fail on the one package the document cannot run without — and fail in a way that reads
 * as a typo rather than as a different install route. The two sources are therefore listed
 * separately.
 *
 * The chunk is `include=FALSE`: attaching packages prints startup chatter about masked objects,
 * which is noise at the top of every rendered document.
 */
function setupChunk(packages: Set<RPackage>): Cell {
  const declared = (Object.keys(PACKAGES) as RPackage[]).filter((p) => packages.has(p))
  if (declared.length === 0)
    return { kind: 'code', label: 'setup', source: ['# No packages needed.'] }

  const cran = declared.filter((p) => !PACKAGES[p].github)
  const github = declared.filter((p) => PACKAGES[p].github)

  const lines: string[] = []
  if (cran.length > 0) {
    lines.push(`# install.packages(c(${cran.map((p) => `"${p}"`).join(', ')}))`)
  }
  for (const pkg of github) {
    lines.push(`# remotes::install_github("${PACKAGES[pkg].github}")  # not on CRAN`)
  }
  lines.push('')
  for (const pkg of declared) lines.push(`library(${pkg})`)

  return { kind: 'code', label: 'setup', source: lines }
}

/**
 * The helper chunk.
 *
 * Emitted only when something asked for a helper, so a workflow of dplyr one-liners carries
 * none of it. Packages a helper needs are collected here, after the walk, which is why
 * `library` is threaded in rather than closed over at the call site.
 */
function helperChunk(names: Set<string>, library: (pkg: RPackage) => void): Cell[] {
  if (names.size === 0) return []
  const specs = resolveHelpers(names)
  for (const spec of specs) for (const pkg of spec.requires ?? []) library(pkg)

  const lines: string[] = [
    ...rComment(
      'Helpers, generated by Coda. These are the parts of the workflow that have no ' +
        'equivalent in dplyr or neuprintr, written out here so the document stands on its own.',
    ),
    '',
  ]
  specs.forEach((spec, i) => {
    if (i > 0) lines.push('', '')
    lines.push(...spec.source)
  })

  return [{ kind: 'code', label: 'coda-helpers', source: lines }]
}
