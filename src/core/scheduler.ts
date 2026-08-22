/**
 * DAG executor implementing Coda's hybrid evaluation model.
 *
 *   cheap nodes      re-run automatically as you edit (auto pass)
 *   expensive nodes  go `stale` and wait for an explicit Run (full pass)
 *
 * Freshness is decided by *provenance keys*, not by data comparison. Every node gets a
 * desired key derived from (type, params, upstream desired keys), computed for the whole
 * graph in topological order without touching any data. A node is fresh iff its cached
 * entry carries its current desired key. This means:
 *
 *   - editing a param upstream invalidates the whole downstream chain instantly,
 *   - undoing that edit makes the old cache entries valid again for free,
 *   - and nothing has to be re-hashed per row.
 */

import type { CodaGraph } from './graph'
import { ancestors, inboundIndex, nodesById, portKey, topoSort } from './graph'
import { hashValue } from './hash'
import type { InferenceResult } from './inference'
import { hasErrors, inferGraph } from './inference'
import type { EvalContext, NodeDefinition, ParamValues } from './node'
import { findParam, resolveColumn, resolveColumns } from './node'
import { getNodeDef } from './registry'
import type { CodaType } from './types'
import { datasetRef } from './types'
import type { Value } from './values'
import type { DataSource } from '../data/source'
import { errorMessage } from './errors'

export type NodeRunState =
  /** Never evaluated, and nothing is asking it to be. */
  | 'idle'
  /** Inputs/params changed; needs an explicit Run (expensive) or the next auto pass. */
  | 'stale'
  /** Currently executing. */
  | 'running'
  /** Cached output is current. */
  | 'ok'
  /** `evaluate` threw, or the node has a blocking type error. */
  | 'error'
  /** Cannot run because something upstream is stale, errored or disabled. */
  | 'blocked'
  /** Muted by the user. */
  | 'disabled'

export interface NodeRunInfo {
  state: NodeRunState
  error?: string
  /** Wall-clock of the last successful evaluation. */
  durationMs?: number
  /** 0..1 while running. */
  progress?: number
  note?: string
}

export interface RunOptions {
  /**
   * 'auto'  — execute only cheap stale nodes; expensive ones are left stale.
   * 'full'  — execute everything stale, expensive included.
   */
  mode: 'auto' | 'full'
  /**
   * Restrict to these nodes plus their ancestors. Used by "run this node" and by the
   * auto pass after a single param edit. Undefined means the whole graph.
   */
  targets?: readonly string[]
}

export interface RunSummary {
  executed: string[]
  failed: string[]
  /** Expensive nodes deliberately left stale by an auto pass. */
  deferred: string[]
  cancelled: boolean
  durationMs: number
}

interface CacheEntry {
  key: string
  outputs: Record<string, Value>
  /**
   * When the oldest data behind these outputs was read from a server, if the node said.
   *
   * Here rather than in `NodeRunInfo` because this is a property of the *result*: it has to
   * survive the result being restored from this very cache, which is precisely when a node does
   * not run and anything recorded in run state would be gone.
   */
  fetchedAt?: number
}

/** Shared instance for nodes with no recorded state — see `Scheduler.info`. */
const IDLE: NodeRunInfo = Object.freeze({ state: 'idle' })

export interface SchedulerHost {
  /** Resolve a DataSource id from a DatasetValue to the live source object. */
  resolveSource(sourceId: string): DataSource
  /** Called whenever node run state changes, so the UI can repaint. Should be cheap. */
  onStateChange?(): void
}

export class Scheduler {
  private cache = new Map<string, CacheEntry>()
  private states = new Map<string, NodeRunInfo>()
  /**
   * Nodes asked to ignore their persistent data cache on the next run they actually execute.
   *
   * Session state, never the document — see `clearNodeCache`. Spent on execution rather than on
   * the run, so a request made against an expensive node survives every cheap pass in between.
   */
  private forceRefresh = new Set<string>()
  private abort: AbortController | undefined
  /** Bumped on every run; results from a superseded run are discarded. */
  private generation = 0
  private inFlight: Promise<RunSummary> | undefined
  private host: SchedulerHost

  constructor(host: SchedulerHost) {
    this.host = host
  }

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  /**
   * Returns a *stable* reference for unknown nodes. React's `useSyncExternalStore`
   * compares snapshots by identity, so allocating `{ state: 'idle' }` per call would
   * make every selector reading this look permanently changed.
   */
  info(nodeId: string): NodeRunInfo {
    return this.states.get(nodeId) ?? IDLE
  }

  /** Cached outputs of a node, if fresh or stale-but-present. Viewers read this. */
  outputs(nodeId: string): Record<string, Value> | undefined {
    return this.cache.get(nodeId)?.outputs
  }

  output(nodeId: string, portId: string): Value | undefined {
    return this.cache.get(nodeId)?.outputs[portId]
  }

  get busy(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * Recompute state labels from the graph without executing anything. Call after every
   * graph mutation so badges update immediately: fresh nodes stay 'ok', everything whose
   * key moved flips to 'stale' or 'blocked'.
   */
  refreshStates(graph: CodaGraph, inference?: InferenceResult): void {
    const inf = inference ?? inferGraph(graph)
    const { order, cyclic } = topoSort(graph)
    const keys = this.desiredKeys(graph, inf, order)
    const nodes = nodesById(graph)
    const inbound = inboundIndex(graph)
    const fresh = new Set<string>()

    for (const nodeId of order) {
      const node = nodes.get(nodeId)!
      /*
       * An annotation is not in the dataflow, so it gets no state at all — not even 'idle'.
       * Labelling one would be the whole problem: with no cache entry it can never be fresh,
       * so it would sit permanently 'stale', counted by the toolbar badge and re-offered by
       * every Run, for a card holding a paragraph of prose.
       */
      if (getNodeDef(node.type)?.annotation) continue
      if (node.disabled) {
        this.setState(nodeId, { state: 'disabled' })
        continue
      }
      if (hasErrors(inf, nodeId)) {
        const first = inf.nodes[nodeId]?.issues.find((i) => i.severity === 'error')
        this.setState(nodeId, { state: 'error', error: first?.message ?? 'Invalid node' })
        continue
      }
      const cached = this.cache.get(nodeId)
      const isFresh = cached !== undefined && cached.key === keys.get(nodeId)
      if (isFresh) {
        fresh.add(nodeId)
        const prev = this.states.get(nodeId)
        this.setState(nodeId, {
          state: 'ok',
          ...(prev?.durationMs !== undefined ? { durationMs: prev.durationMs } : {}),
        })
        continue
      }
      // Not fresh. Blocked if any required input cannot be supplied.
      const def = getNodeDef(node.type)
      const upstreamReady = (def?.inputs ?? []).every((port) => {
        if (port.required === false) return true
        const edge = inbound.get(portKey(nodeId, port.id))
        return edge ? fresh.has(edge.source) : false
      })
      this.setState(nodeId, { state: upstreamReady ? 'stale' : 'blocked' })
    }

    for (const nodeId of cyclic) {
      this.setState(nodeId, { state: 'error', error: 'Node is part of a cycle' })
    }

    this.pruneCache(graph)
    this.host.onStateChange?.()
  }

  /** Drop cached results, e.g. after switching datasets or on user request. */
  invalidateAll(): void {
    this.cache.clear()
    this.states.clear()
    this.forceRefresh.clear()
    this.host.onStateChange?.()
  }

  invalidateNode(graph: CodaGraph, nodeId: string): void {
    this.cache.delete(nodeId)
    for (const id of descendantsOf(graph, nodeId)) this.cache.delete(id)
    this.refreshStates(graph)
  }

  /**
   * Ask a node to ignore its persistent data cache the next time it runs, and drop the results
   * that came from it.
   *
   * Two layers, and only the first is `invalidateNode`'s. Dropping the *result* makes the node
   * run again; it does not make the run reach the network, because `evaluate` fetches through
   * `loadCachedTable`, whose IndexedDB entry is keyed by what was fetched rather than by the
   * graph and is kept for a month. So "Invalidate" cleared the card and the re-run came back
   * instantly with the same bytes — a control that looked like it had worked.
   *
   * The flag is held here rather than in the document because it is a fact about *this session*:
   * it must not be saved, must not travel to whoever you send the file to, and must not take part
   * in the provenance key. It survives until the node actually executes, so asking for it on an
   * expensive node and then running the cheap pass does not quietly spend it.
   */
  clearNodeCache(graph: CodaGraph, nodeId: string): void {
    this.forceRefresh.add(nodeId)
    this.invalidateNode(graph, nodeId)
  }

  cancel(): void {
    this.abort?.abort()
  }

  /**
   * When the data behind a node's current result was read from a server, if it said.
   *
   * A primitive, so a selector over it is stable by identity (invariant 7). `undefined` means the
   * node did not report — it has no data cache, or it has not run — which is the same absence to
   * every caller and prints as nothing.
   */
  fetchedAt(nodeId: string): number | undefined {
    return this.cache.get(nodeId)?.fetchedAt
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Single-flight: a new run aborts the one in progress and waits for it to unwind
   * before starting, so node states never interleave between two passes.
   */
  async run(graph: CodaGraph, options: RunOptions): Promise<RunSummary> {
    if (this.inFlight) {
      this.abort?.abort()
      try {
        await this.inFlight
      } catch {
        /* superseded run's failure is not ours to report */
      }
    }
    const promise = this.execute(graph, options)
    this.inFlight = promise
    try {
      return await promise
    } finally {
      if (this.inFlight === promise) this.inFlight = undefined
    }
  }

  private async execute(graph: CodaGraph, options: RunOptions): Promise<RunSummary> {
    const started = performance.now()
    const generation = ++this.generation
    const controller = new AbortController()
    this.abort = controller

    const inference = inferGraph(graph)
    const { order } = topoSort(graph)
    const keys = this.desiredKeys(graph, inference, order)
    const nodes = nodesById(graph)
    const inbound = inboundIndex(graph)

    const scope = this.resolveScope(graph, order, options.targets)

    const summary: RunSummary = {
      executed: [],
      failed: [],
      deferred: [],
      cancelled: false,
      durationMs: 0,
    }

    /** Node ids whose outputs are usable this pass. */
    const available = new Set<string>()
    for (const nodeId of order) {
      const cached = this.cache.get(nodeId)
      if (cached && cached.key === keys.get(nodeId)) available.add(nodeId)
    }

    for (const nodeId of order) {
      if (controller.signal.aborted) {
        summary.cancelled = true
        break
      }
      if (!scope.has(nodeId)) continue

      const node = nodes.get(nodeId)!
      const def = getNodeDef(node.type)
      if (!def) {
        this.setState(nodeId, { state: 'error', error: `Unknown node type "${node.type}"` })
        summary.failed.push(nodeId)
        continue
      }
      // Never evaluated, so it is neither executed nor deferred — it is simply not work.
      if (def.annotation) continue
      if (node.disabled) {
        this.setState(nodeId, { state: 'disabled' })
        continue
      }
      if (hasErrors(inference, nodeId)) {
        const first = inference.nodes[nodeId]?.issues.find((i) => i.severity === 'error')
        this.setState(nodeId, { state: 'error', error: first?.message ?? 'Invalid node' })
        summary.failed.push(nodeId)
        continue
      }
      if (available.has(nodeId)) {
        this.setState(nodeId, { state: 'ok', ...pick(this.states.get(nodeId), 'durationMs') })
        continue
      }

      // Gather inputs; bail out if any required upstream is unavailable.
      const inputs: Record<string, Value | undefined> = {}
      /*
       * The provenance of what arrived on each port, spelled exactly as `desiredKeys` spells it
       * — same string, so a node publishing one as an identity cannot disagree with the key the
       * scheduler used to decide it should run.
       */
      const inputKeys: Record<string, string> = {}
      let blocked = false
      for (const port of def.inputs ?? []) {
        const edge = inbound.get(portKey(nodeId, port.id))
        if (!edge) {
          if (port.required !== false) blocked = true
          continue
        }
        /*
         * A reference names a node; it does not consume its output. So it never blocks — the
         * source may be *downstream* of this node and quite unable to run first, which is the
         * arrangement references exist to allow — and the value handed over is built from the
         * inferred type rather than read from a run that may never have happened.
         */
        if (port.reference) {
          const type = inference.nodes[nodeId]?.inputs[port.id]
          const value = referenceValue(type)
          if (value) inputs[port.id] = value
          inputKeys[port.id] = `ref:${hashValue(type ?? null)}`
          continue
        }
        if (!available.has(edge.source)) {
          blocked = true
          continue
        }
        inputs[port.id] = this.cache.get(edge.source)?.outputs[edge.sourceHandle]
        inputKeys[port.id] = upstreamKey(keys, edge.source, edge.sourceHandle)
      }
      if (blocked) {
        this.setState(nodeId, { state: 'blocked' })
        continue
      }

      // The hybrid rule: defer expensive work unless this is a full run.
      if (options.mode === 'auto' && def.cost === 'expensive') {
        this.setState(nodeId, { state: 'stale' })
        summary.deferred.push(nodeId)
        continue
      }

      this.setState(nodeId, { state: 'running', progress: 0 })
      const nodeStarted = performance.now()
      try {
        const inputTypes = inference.nodes[nodeId]?.inputs ?? {}
        // Spent here rather than at the top of the run: a node that was deferred by the cheap
        // pass has not had its chance to honour the request yet.
        const refresh = this.forceRefresh.delete(nodeId)
        // Collected per execution rather than on the context object, so a node cannot read back
        // what it reported and nothing survives into the next run.
        let fetchedAt: number | undefined
        const ctx = this.makeEvalContext(
          def,
          node.params,
          inputs,
          inputKeys,
          inputTypes,
          controller.signal,
          nodeId,
          refresh,
          (at) => {
            // Oldest wins: a node making several fetches is only as fresh as its stalest one.
            fetchedAt = fetchedAt === undefined ? at : Math.min(fetchedAt, at)
          },
        )
        const outputs = await def.evaluate(ctx)

        if (generation !== this.generation) {
          // A newer run took over while we awaited; drop the result silently.
          summary.cancelled = true
          break
        }
        if (controller.signal.aborted) {
          summary.cancelled = true
          this.setState(nodeId, { state: 'stale' })
          break
        }

        this.cache.set(nodeId, {
          key: keys.get(nodeId)!,
          outputs,
          ...(fetchedAt === undefined ? {} : { fetchedAt }),
        })
        available.add(nodeId)
        summary.executed.push(nodeId)
        this.setState(nodeId, {
          state: 'ok',
          durationMs: performance.now() - nodeStarted,
        })
      } catch (err) {
        if (controller.signal.aborted) {
          summary.cancelled = true
          this.setState(nodeId, { state: 'stale' })
          break
        }
        this.cache.delete(nodeId)
        summary.failed.push(nodeId)
        this.setState(nodeId, {
          state: 'error',
          error: errorMessage(err),
        })
      }
    }

    // Anything in scope we never reached is blocked by an upstream failure.
    for (const nodeId of scope) {
      if (available.has(nodeId)) continue
      const state = this.info(nodeId).state
      if (state === 'running') this.setState(nodeId, { state: 'stale' })
    }

    summary.durationMs = performance.now() - started
    if (this.abort === controller) this.abort = undefined
    this.host.onStateChange?.()
    return summary
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Provenance key per node, in topological order. Params are normalised through the
   * node's own param resolution so that a column param falling back to "first column"
   * produces the same key as explicitly selecting that column — otherwise the cache
   * would miss every time the UI auto-filled a picker.
   *
   * The inference and the order are passed in rather than recomputed. Both callers already
   * hold them, and the pass this used to run for itself was taken *without* `observedSchemas`
   * — so it could disagree with the one taken a microsecond earlier, and silently key a node
   * off a type the rest of the app had already improved on.
   */
  private desiredKeys(
    graph: CodaGraph,
    inference: InferenceResult,
    order: readonly string[],
  ): Map<string, string> {
    const keys = new Map<string, string>()
    const nodes = nodesById(graph)
    const inbound = inboundIndex(graph)

    for (const nodeId of order) {
      const node = nodes.get(nodeId)!
      const def = getNodeDef(node.type)
      const inputTypes = inference.nodes[nodeId]?.inputs ?? {}
      const upstream: Array<[string, string | null]> = []
      for (const port of def?.inputs ?? []) {
        const edge = inbound.get(portKey(nodeId, port.id))
        /*
         * A reference contributes the *type* it resolved to rather than the upstream node's key,
         * and it has to: that node is excluded from the order, so its key may not be computed
         * yet — `keys.get` would answer `'unresolved'` and this node would re-run forever.
         *
         * It is also the more honest key. A dataset's identity is what a reference reads, so
         * changing its version re-keys this node and changing its *annotations* does not — which
         * is right, because this node never sees them.
         */
        if (edge && port.reference) {
          upstream.push([port.id, `ref:${hashValue(inference.nodes[nodeId]?.inputs[port.id] ?? null)}`])
          continue
        }
        upstream.push([
          port.id,
          edge ? upstreamKey(keys, edge.source, edge.sourceHandle) : null,
        ])
      }
      keys.set(
        nodeId,
        hashValue({
          type: node.type,
          params: def ? normalizeParams(def, node.params, inputTypes) : node.params,
          disabled: !!node.disabled,
          upstream,
        }),
      )
    }
    // Cyclic nodes never execute; give them an unmatchable key.
    for (const node of graph.nodes) if (!keys.has(node.id)) keys.set(node.id, 'cyclic')
    return keys
  }

  private resolveScope(
    graph: CodaGraph,
    order: readonly string[],
    targets: readonly string[] | undefined,
  ): Set<string> {
    if (!targets) return new Set(order)
    const scope = new Set<string>()
    for (const id of targets) {
      scope.add(id)
      for (const dep of ancestors(graph, id)) scope.add(dep)
    }
    return scope
  }

  private makeEvalContext(
    def: NodeDefinition,
    params: ParamValues,
    inputs: Record<string, Value | undefined>,
    inputKeys: Record<string, string>,
    inputTypes: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    nodeId: string,
    refresh: boolean,
    reportFetched: (at: number) => void,
  ): EvalContext {
    const types = inputTypes as Record<string, never>
    return {
      params,
      refresh,
      reportFetched,
      input: (portId) => inputs[portId],
      inputKey: (portId) => inputKeys[portId],
      column: (paramId) => {
        const p = findParam(def, paramId)
        return p && p.kind === 'column' ? resolveColumn(p, params, types) : undefined
      },
      columns: (paramId) => {
        const p = findParam(def, paramId)
        return p && p.kind === 'columns' ? resolveColumns(p, params, types) : []
      },
      resolveSource: (sourceId) => this.host.resolveSource(sourceId),
      signal,
      progress: (fraction, note) => {
        this.setState(nodeId, {
          state: 'running',
          progress: Math.max(0, Math.min(1, fraction)),
          ...(note ? { note } : {}),
        })
        this.host.onStateChange?.()
      },
    }
  }

  private setState(nodeId: string, info: NodeRunInfo): void {
    this.states.set(nodeId, info)
  }

  private pruneCache(graph: CodaGraph): void {
    const alive = new Set(graph.nodes.map((n) => n.id))
    for (const id of [...this.cache.keys()]) if (!alive.has(id)) this.cache.delete(id)
    for (const id of [...this.states.keys()]) if (!alive.has(id)) this.states.delete(id)
    // A deleted node's pending request would otherwise be spent by whatever reused its id.
    for (const id of [...this.forceRefresh]) if (!alive.has(id)) this.forceRefresh.delete(id)
  }
}

/**
 * The value a `reference` port hands to `evaluate`: an identity, with no data behind it.
 *
 * Built from the inferred type rather than read from a run, because the node being referenced may
 * be *downstream* and may never have run — which is the arrangement references exist to allow.
 * Only a dataset today, and deliberately so: synthesising a value from a type is defensible
 * exactly because a dataset's identity *is* its type, and there is no second kind asking.
 *
 * No `annotations`, and that absence is correct rather than a limitation — a node reading a
 * reference is usually the one about to supply them.
 */
function referenceValue(type: CodaType | undefined): Value | undefined {
  const ref = datasetRef(type)
  if (!ref?.datasetId || !ref.sourceId) return undefined
  return {
    kind: 'dataset',
    sourceId: ref.sourceId,
    datasetId: ref.datasetId,
    label: ref.datasetId,
  }
}

/**
 * How one port's upstream is named in a provenance key.
 *
 * One spelling, because two consumers depend on it meaning the same thing: `desiredKeys` folds
 * it into the hash that decides whether a node re-runs, and `ctx.inputKey` hands it to a node
 * that publishes it as the identity of what arrived. If those parted company, a value would
 * claim an identity the scheduler had never keyed anything by — and nothing would say so.
 */
function upstreamKey(keys: Map<string, string>, source: string, handle: string): string {
  return `${keys.get(source) ?? 'unresolved'}:${handle}`
}

/**
 * Reduce params to the ones that can change a node's *output*, resolved to their effective
 * values. Two exclusions, both deliberate:
 *
 *  - hidden params (`visibleIf` false) — a stale value behind a switched-off branch must
 *    not keep a node dirty;
 *  - presentational params — colour scales and page sizes would otherwise invalidate the
 *    node and its whole downstream chain on every fiddle.
 *
 * Column params are resolved so that "unset" and "explicitly set to the column the
 * resolver would have picked" produce the same key.
 */
function normalizeParams(
  def: NodeDefinition,
  params: ParamValues,
  inputTypes: Readonly<Record<string, unknown>>,
): ParamValues {
  const types = inputTypes as Record<string, never>
  const out: ParamValues = {}
  for (const p of def.params ?? []) {
    if (p.presentational) continue
    if (p.visibleIf && !p.visibleIf(params)) continue
    if (p.kind === 'column') out[p.id] = resolveColumn(p, params, types) ?? ''
    else if (p.kind === 'columns') out[p.id] = resolveColumns(p, params, types)
    else out[p.id] = params[p.id] ?? p.default
  }
  return out
}

function descendantsOf(graph: CodaGraph, nodeId: string): Set<string> {
  const out = new Set<string>()
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    for (const e of graph.edges) {
      if (e.source !== id || out.has(e.target)) continue
      out.add(e.target)
      stack.push(e.target)
    }
  }
  return out
}

function pick<T extends object, K extends keyof T>(obj: T | undefined, key: K): Partial<T> {
  return obj && obj[key] !== undefined ? ({ [key]: obj[key] } as Partial<T>) : {}
}
