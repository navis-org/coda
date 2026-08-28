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

import type { CodaGraph, GraphEdge, GraphNode } from './graph'
import {
  ancestors,
  inboundIndex,
  loopRegion,
  loopsIn,
  mayHaveLoops,
  nodesById,
  portKey,
  topoSort,
} from './graph'
import { hashValue } from './hash'
import type { InferenceResult } from './inference'
import { hasErrors, inferGraph } from './inference'
import type {
  EvalContext,
  LoopIteration,
  LoopPlan,
  NodeDefinition,
  ParamValues,
} from './node'
import { findParam, resolveColumn, resolveColumns } from './node'
import { getNodeDef } from './registry'
import { inputPorts, outputPorts } from './ports'
import type { CodaType } from './types'
import type { Value } from './values'
import { datasetIdentity } from './values'
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
  /**
   * This run was started by the editor rather than by a person.
   *
   * Separate from `mode`, and it has to be: auto-run's whole point is that it runs the *full*
   * pass automatically, so `mode` is `'full'` there and the `cost: 'expensive'` deferral never
   * fires. For an ordinary expensive node that is exactly what was asked for. For a loop it is
   * four hundred queries and four hundred files, 700ms after a keystroke — the thing `For Each`
   * is marked expensive to prevent, arriving through the one door that marking does not cover.
   *
   * So loops read this instead of `mode`: **a loop iterates only when somebody asked it to.**
   */
  automatic?: boolean
}

export interface RunSummary {
  executed: string[]
  failed: string[]
  /** Expensive nodes deliberately left stale by an auto pass. */
  deferred: string[]
  /**
   * Every node that ran inside a loop's region, begin nodes included.
   *
   * Here because `executed` is a **set of node ids** and cannot say a node ran four hundred
   * times. Anything that acts on a finished run has to know the difference: a Download inside a
   * loop already wrote its files through `onIteration`, one per element, and would otherwise be
   * handed one more write at the end for the last element — a stray four-hundred-and-first file
   * nobody asked for and nothing explains.
   */
  loopNodes: string[]
  /** Loop passes made this run, across every loop. Zero on a graph with no loop in it. */
  iterations: number
  cancelled: boolean
  durationMs: number
}

/** What one node's turn came to. `aborted` is the only one that ends the walk. */
type NodeVerdict = 'ran' | 'skipped' | 'blocked' | 'failed' | 'aborted'

/** What arrived on a node's input ports, and whether a required one was missing. */
interface GatheredInputs {
  inputs: Record<string, Value | undefined>
  inputKeys: Record<string, string>
  blocked: boolean
}

/**
 * Everything one run carries between its nodes.
 *
 * `keys` and `available` are deliberately **mutable**: a loop advances its index between passes,
 * which re-keys its whole region, so freshness cannot be settled once before the walk. Every
 * other field is fixed for the run.
 */
interface RunPass {
  graph: CodaGraph
  inference: InferenceResult
  nodes: Map<string, GraphNode>
  inbound: Map<string, GraphEdge>
  scope: Set<string>
  summary: RunSummary
  controller: AbortController
  generation: number
  mode: 'auto' | 'full'
  /** See `RunOptions.automatic`. Read by loops, which defer on it whatever the mode says. */
  automatic: boolean
  keys: Map<string, string>
  available: Set<string>
  /**
   * What each loop exit returned on the pass before this one — the accumulator of a fold.
   *
   * Not a cache entry, for `previews`' reason: a half-finished total stored under a provenance
   * key would be the answer *for* that key, so a loop cancelled at element 40 of 300 would leave
   * a Collect claiming to hold all three hundred.
   */
  accumulations: Map<string, Readonly<Record<string, Value>>>
}

/**
 * One loop pass, as the host is told about it.
 *
 * Extends `LoopIteration` rather than restating its three fields: they were copied across one by
 * one at the call site, so adding a field to a pass meant editing two interfaces and a copy, and
 * a missed one is a field that is silently always absent host-side.
 */
export interface IterationInfo extends LoopIteration {
  /** The `For Each` node driving this loop. */
  nodeId: string
  /** The region's other nodes, in the order they just ran. */
  region: readonly string[]
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
  /**
   * What `ctx.warn` said about this result, in the order it was said.
   *
   * Here rather than in `NodeRunInfo` for `fetchedAt`'s reason, and it matters more: a caveat
   * that expired on the next unrelated run would leave the caveated result on screen with
   * nothing beside it. Absent when the node warned about nothing, so the common case allocates
   * nothing.
   */
  warnings?: readonly string[]
}

/** Shared instance for nodes with no recorded state — see `Scheduler.info`. */
const IDLE: NodeRunInfo = Object.freeze({ state: 'idle' })

export interface SchedulerHost {
  /** Resolve a DataSource id from a DatasetValue to the live source object. */
  resolveSource(sourceId: string): DataSource
  /** Called whenever node run state changes, so the UI can repaint. Should be cheap. */
  onStateChange?(): void
  /**
   * Called when a running node publishes or drops a partial result.
   *
   * Separate from `onStateChange` because the two ask different questions of the UI. A state
   * change moves a badge, and a card subscribes to it through its *own* node's state; a preview
   * changes what is on somebody *else's* card — the 3D viewer draws from its inputs, so the node
   * whose value moved is not the node that has to repaint. Nothing about the publishing node's
   * state changed, so a host listening only to `onStateChange` would compute the same answer and
   * never re-render.
   *
   * Also cheaper: `onStateChange` re-walks the graph for observed schemas, which a partial
   * geometry value cannot have changed, and this fires four times a second during a fetch.
   */
  onPreview?(): void
  /**
   * Called after every pass of a `For Each`, and **awaited** before the next one starts.
   *
   * The seam a loop's side effects come through, and it has to be a moment rather than a report
   * for two reasons that are separately sufficient. `RunSummary.executed` is a set of node ids,
   * so a Download that ran four hundred times is in it once; and a chart or a 3D scene is
   * captured off a **live canvas**, which means React has to have committed this element's
   * geometry before anything reads pixels — a thing only the host can wait for.
   *
   * Awaited, so a host that writes a file or waits a frame actually holds the loop up rather
   * than racing the next pass. A throw is recorded against the element and the loop continues:
   * one unwritable file is not a reason to abandon the other three hundred and ninety-nine.
   */
  onIteration?(info: IterationInfo): Promise<void> | void
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
  /**
   * Partial outputs a still-running node has published through `ctx.publish`.
   *
   * Deliberately *not* a `CacheEntry`. A cache entry is keyed by provenance and is the answer
   * for that key (invariant 4); a preview is a half-finished value that happens to be worth
   * drawing. Storing one as the other is how a run cancelled at body 40 of 300 would leave a
   * scene that looks complete and that nothing would ever re-fetch — the entry's key would
   * match, so no later run would even be scheduled.
   *
   * Read *before* the cache by `output`/`outputs`, because while a node is running the preview
   * is the newer truth and whatever the cache holds belongs to a key that has already moved.
   * Dropped when the node settles, which is what makes that precedence safe to state so simply.
   */
  private previews = new Map<string, Record<string, Value>>()
  /**
   * Warnings raised by the node currently executing, before there is a cache entry to hold them.
   *
   * The point of `ctx.warn` is that it is heard *while* the work runs — "4,000 skeletons is
   * about four minutes" is only useful next to a Cancel button — and the entry that keeps it
   * afterwards does not exist until the node returns. So: copied into the entry on success and
   * dropped either way, since a failed run's caveat would sit under an error message explaining
   * something else.
   */
  private liveWarnings = new Map<string, string[]>()
  /**
   * Which element each `For Each` is currently on.
   *
   * **Session state that takes part in the provenance key**, which is the unusual combination
   * and the whole design. In the key because that is what makes a loop work at all: advancing
   * it re-keys the begin node, invariant 4 carries that to every descendant, and the region
   * re-runs without the scheduler knowing anything about what is in it.
   *
   * Out of the document because a param would make four hundred passes four hundred undo steps,
   * four hundred autosaves and an `index: 399` in the file you shared — a number that means
   * nothing to whoever opens it. It is `refreshParam`'s nonce with the same job and none of the
   * cost, and it is why running a loop leaves the graph byte-identical.
   *
   * Cleared per loop at the top of every run, so Run means "iterate", not "carry on from 411".
   */
  private loopIndex = new Map<string, number>()
  /**
   * Loops that reached their last element, as opposed to stopping part way.
   *
   * **The index alone cannot answer this**, and that is the bug it was written for. Cancel a
   * four-element loop after the second: the region's cache entries all answer the key for the
   * pass that completed, and `loopIndex` sits at 1 — so "is every region result still current?"
   * says yes, the next Run settles the loop untouched, and elements three and four are silently
   * never processed. Freshness is a fact about a *pass*; finishing is a fact about the loop, and
   * nothing in the key can carry it.
   *
   * Session state beside `loopIndex` and dropped with it, for the same reasons.
   */
  private loopDone = new Set<string>()
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
    return this.previews.get(nodeId) ?? this.cache.get(nodeId)?.outputs
  }

  /** One statement of the preview-before-cache rule, so the two cannot come to disagree. */
  output(nodeId: string, portId: string): Value | undefined {
    return this.outputs(nodeId)?.[portId]
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
      const upstreamReady = (def ? inputPorts(def, node.params) : []).every((port) => {
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
    this.loopIndex.clear()
    this.loopDone.clear()
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

  /**
   * What this node said through `ctx.warn` about the result it is holding, as one string.
   *
   * Joined rather than handed over as the array, so the snapshot is a primitive and a selector
   * over it is stable by value (invariant 7) — the same trick `error` gets for free by being a
   * string already. The live map wins over the entry: while a node runs, what it has just said
   * is newer than whatever its last result came with.
   */
  warning(nodeId: string): string | undefined {
    const live = this.liveWarnings.get(nodeId)
    const held = live ?? this.cache.get(nodeId)?.warnings
    return held && held.length > 0 ? held.join(' ') : undefined
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

  /**
   * Everything one run carries, so the node-level step can be shared by the ordinary walk and
   * by the loop driver without either re-deriving it.
   *
   * `keys` and `available` are **mutable**, and that is the whole reason this is an object
   * rather than a closure. A loop advances its index between passes, which re-keys every node
   * in its region (invariant 4), so both have to be recomputed inside the run rather than
   * settled before it.
   */
  private async execute(graph: CodaGraph, options: RunOptions): Promise<RunSummary> {
    const started = performance.now()
    const generation = ++this.generation
    const controller = new AbortController()
    this.abort = controller

    const inference = inferGraph(graph)
    const { order } = topoSort(graph)
    const nodes = nodesById(graph)
    const inbound = inboundIndex(graph)
    const scope = this.resolveScope(graph, order, options.targets)

    const summary: RunSummary = {
      executed: [],
      failed: [],
      deferred: [],
      loopNodes: [],
      iterations: 0,
      cancelled: false,
      durationMs: 0,
    }

    const loops = loopsIn(graph).filter((l) => scope.has(l.beginId))

    const pass: RunPass = {
      graph,
      inference,
      nodes,
      inbound,
      scope,
      summary,
      controller,
      generation,
      mode: options.mode,
      automatic: options.automatic === true,
      keys: this.desiredKeys(graph, inference, order),
      available: new Set<string>(),
      accumulations: new Map<string, Record<string, Value>>(),
    }
    this.markAvailable(pass, order)

    for (const id of loops.flatMap((l) => [...l.region])) {
      if (scope.has(id) && !summary.loopNodes.includes(id)) summary.loopNodes.push(id)
    }

    const verdict = await this.runNodes(pass, scope, order, loops)
    if (verdict === 'aborted') summary.cancelled = true

    // Anything in scope we never reached is blocked by an upstream failure.
    for (const nodeId of scope) {
      if (pass.available.has(nodeId)) continue
      const state = this.info(nodeId).state
      if (state === 'running') this.setState(nodeId, { state: 'stale' })
    }

    summary.durationMs = performance.now() - started
    if (this.abort === controller) this.abort = undefined
    this.host.onStateChange?.()
    return summary
  }

  /**
   * Run these nodes in order, giving a loop its whole region when its turn comes.
   *
   * Shared by the top-level walk and by **each pass of a loop**, which is the only way a loop
   * inside a loop can work: `runLoop` dispatched its region through `executeNode`, which never
   * re-enters here, so an inner `For Each` ran exactly once per outer pass and read the outer
   * loop's index as its own. Nesting was documented as falling out of the ordering rule; it did
   * not, because there was only one place that knew the rule.
   *
   * **A loop is executed at the position of the last node of its region**, not at its begin
   * node. Every ancestor of every region node precedes that position in the topological order,
   * so by the time the loop runs, everything it reads from outside itself is in hand. Triggering
   * at the begin node instead runs a region node before a second, unrelated branch feeding it
   * has been reached — a real ordering bug, and one that only shows up on graphs where the loop
   * body takes an input from beside the loop rather than through it.
   */
  private async runNodes(
    pass: RunPass,
    ids: Set<string>,
    order: readonly string[],
    loops: ReadonlyArray<{ beginId: string; region: Set<string> }>,
    iteration?: LoopIteration,
  ): Promise<NodeVerdict> {
    const claimed = new Set<string>()
    const triggers = new Map<string, { beginId: string; region: Set<string> }>()
    for (const loop of loops) {
      if (!ids.has(loop.beginId)) continue
      // Outermost first (`loopsIn` sorts by size), so an inner loop's begin node is already
      // spoken for here and its region runs inside the outer loop's passes rather than beside
      // them — where this same function will plan it again, one level down.
      if (claimed.has(loop.beginId)) continue
      const owned = new Set([...loop.region].filter((id) => ids.has(id) && !claimed.has(id)))
      for (const id of owned) claimed.add(id)
      let last: string | undefined
      for (const id of order) if (owned.has(id)) last = id
      if (last !== undefined) triggers.set(last, { beginId: loop.beginId, region: owned })
    }

    /*
     * Reported back rather than read off `pass.summary.failed`, which dedups by node id — so a
     * body failing on pass 1 and again on pass 2 would move that array's length once and the
     * loop would count one failed element instead of two.
     */
    let failed = false
    for (const nodeId of order) {
      if (pass.controller.signal.aborted) return 'aborted'
      if (!ids.has(nodeId)) continue

      const trigger = triggers.get(nodeId)
      if (trigger) {
        const verdict = await this.runLoop(pass, trigger.beginId, trigger.region, order, loops)
        if (verdict === 'aborted') return 'aborted'
        if (verdict === 'failed') failed = true
        continue
      }
      // Claimed by a loop whose turn has not come yet — it runs inside that loop's passes.
      if (claimed.has(nodeId)) continue

      const verdict = await this.executeNode(pass, nodeId, iteration)
      if (verdict === 'aborted') return 'aborted'
      if (verdict === 'failed') failed = true
    }
    return failed ? 'failed' : 'ran'
  }

  /**
   * Run one loop: its begin node and its region, once per element.
   *
   * Nothing here re-implements execution. Each pass advances `loopIndex`, recomputes the keys
   * for the whole graph and re-derives which region results are still usable — and then the
   * ordinary `executeNode` runs the region, because from a region node's point of view a new
   * pass is indistinguishable from an upstream param having changed. That is invariant 4 doing
   * the work: the index is in the begin node's key, so every descendant's key moves with it.
   *
   * **A failing element does not end the loop.** Four hundred neurons with one unreadable
   * skeleton is three hundred and ninety-nine files worth having, and abandoning them is the
   * refusal `docs/limits.md` argues against. The failures are counted and said out loud on the
   * card afterwards, which is the difference between continuing and hiding.
   */
  private async runLoop(
    pass: RunPass,
    beginId: string,
    region: Set<string>,
    order: readonly string[],
    loops: ReadonlyArray<{ beginId: string; region: Set<string> }>,
  ): Promise<NodeVerdict> {
    const node = this.nodeOf(pass, beginId)
    const def = getNodeDef(node.type)
    if (!def?.loopPlan) return this.executeNode(pass, beginId)

    /*
     * **A loop that has already run is not re-run**, and that is `out.download`'s contract
     * rather than a new one: "a run in which nothing upstream changed does not re-execute this
     * node, so pressing Run twice writes one file". The index is left where the last loop
     * finished precisely so this question can be asked — every region result still answers its
     * current key, so there is nothing to do.
     *
     * The alternative, resetting to element 0 on every run, was tried and is worse in a way that
     * only shows up in use: the badge reads `ok` while Run still does four hundred queries, and
     * with auto-run on, *any* edit anywhere in the graph re-runs the whole loop and re-writes
     * every file. Re-running a settled loop is what Invalidate Results and the card's own button
     * are for — a deliberate gesture, as it has to be when the effect is four hundred files.
     *
     * **`loopDone` is half the question and it has to be**: freshness describes a *pass*, and a
     * loop cancelled at element two leaves a region whose every entry answers its current key.
     * Without it, the next Run settles that loop and elements three and four are never run.
     */
    const runnable = [...region].filter((id) => {
      const member = this.nodeOf(pass, id)
      // Neither of these ever becomes `available`, so counting them would mean a loop with a
      // disabled node in it could never settle — and would therefore re-run on every single Run.
      return !member.disabled && !getNodeDef(member.type)?.annotation
    })
    if (
      this.loopDone.has(beginId) &&
      runnable.length > 0 &&
      runnable.every((id) => pass.available.has(id))
    ) {
      for (const id of runnable) {
        this.setState(id, { state: 'ok', ...pick(this.states.get(id), 'durationMs') })
      }
      return 'skipped'
    }

    /*
     * **A loop iterates only when somebody asked it to**, and this is where that is decided.
     *
     * Two doors, and for a long time only one was watched. `For Each` is `expensive` so the
     * 180ms cheap pass after every keystroke defers it — and deferring has to mean deferring the
     * *loop*, since iterating four hundred times to defer each pass's expensive nodes one by one
     * is four hundred passes of pure overhead, and any cheap node in the region would really run
     * four hundred times per keystroke.
     *
     * The other door is **auto-run**, which schedules `runFull` — `mode: 'full'` — so the cost
     * check above it never fired. Any upstream edit re-iterated the whole loop 700ms later,
     * which is precisely the scenario the `expensive` marking is documented to prevent. Hence
     * `automatic`: it says who started the run, which is the question actually being asked.
     */
    if (pass.automatic || (pass.mode === 'auto' && def.cost === 'expensive')) {
      for (const id of region) {
        if (this.info(id).state === 'ok' && pass.available.has(id)) continue
        this.setState(id, { state: id === beginId ? 'stale' : 'blocked' })
      }
      pass.summary.deferred.push(beginId)
      return 'skipped'
    }

    if (node.disabled) {
      for (const id of region) this.setState(id, { state: id === beginId ? 'disabled' : 'blocked' })
      return 'skipped'
    }

    // The plan is asked once, from the begin node's own inputs, before anything iterates. It
    // must not throw — a collection that cannot be counted is a validation problem, and one
    // that counts zero is a real answer meaning "the region does not run".
    const gathered = this.gatherInputs(pass, beginId, def)
    if (gathered.blocked) {
      this.setState(beginId, { state: 'blocked' })
      return 'blocked'
    }
    let plan: LoopPlan
    try {
      plan = def.loopPlan(
        this.makeEvalContext({ pass, nodeId: beginId, def, gathered, refresh: false }),
      )
    } catch (err) {
      this.cache.delete(beginId)
      pass.summary.failed.push(beginId)
      this.setState(beginId, { state: 'error', error: errorMessage(err) })
      return 'failed'
    }

    const count = Math.max(0, Math.floor(plan.count))
    const inner = new Set(order.filter((id) => region.has(id) && id !== beginId))
    // Anything nested inside this region, so a pass plans its own loops one level down.
    const nested = loops.filter((l) => l.beginId !== beginId && inner.has(l.beginId))
    // Something moved, so this is a fresh loop and it starts at the first element. Left where
    // the last one finished, a re-run after an upstream edit would resume mid-collection.
    this.loopIndex.delete(beginId)
    // Not finished until it is. Cleared here rather than on the way out, so a loop abandoned by
    // an abort — which returns from inside the pass loop — cannot leave the flag from last time.
    this.loopDone.delete(beginId)
    // A second loop in the same run must not fold onto the first one's accumulator.
    pass.accumulations.clear()
    const failures: string[] = []

    this.setState(beginId, {
      state: 'running',
      progress: 0,
      note: count === 0 ? 'nothing to iterate' : `0 / ${formatCount(count)}`,
    })
    this.host.onStateChange?.()

    /*
     * **A collection with nothing in it still runs the region once, on nothing.**
     *
     * Zero is a real answer — an upstream filter that matched nothing — and the tempting reading,
     * "no passes, so nothing to do", is what left every node in the region holding the *previous*
     * run's results with an `ok` badge over them. `output(loop, 'item')` went on returning last
     * time's neuron, and a 3D viewer went on drawing it, with nothing anywhere saying the
     * collection was now empty.
     *
     * So the region executes exactly once with an out-of-range index, which makes the begin node
     * emit `emptyElement` and every node below it compute honestly on nothing. What does *not*
     * happen is `onIteration`: no element was iterated, so no file is written and no picture is
     * captured. That is the whole distinction between "ran on an empty collection" and "ran once".
     */
    if (count === 0) {
      const empty: LoopIteration = { index: 0, count: 0, label: '', size: 0 }
      const begun = await this.executeNode(pass, beginId, empty)
      if (begun === 'aborted') return 'aborted'
      if ((await this.runNodes(pass, inner, order, nested, empty)) === 'aborted') return 'aborted'
      if (this.cache.has(beginId)) {
        this.setState(beginId, { state: 'ok' })
        this.loopDone.add(beginId)
      }
      pass.accumulations.clear()
      this.host.onStateChange?.()
      return this.cache.has(beginId) ? 'ran' : 'failed'
    }

    for (let index = 0; index < count; index++) {
      if (this.abandoned(pass, beginId)) return 'aborted'

      const iteration: LoopIteration = {
        index,
        count,
        label: plan.label(index),
        size: plan.size(index),
      }
      this.loopIndex.set(beginId, index)
      pass.keys = this.desiredKeys(pass.graph, pass.inference, order, pass)
      // Only the region's freshness can have moved; everything else keeps the verdict the top
      // of the run gave it, which is what stops a loop re-running the graph around it.
      this.markAvailable(pass, region)

      const begun = await this.executeNode(pass, beginId, iteration)
      if (begun === 'aborted') return 'aborted'
      this.setState(beginId, {
        state: 'running',
        progress: index / count,
        note: `${formatCount(index + 1)} / ${formatCount(count)}${iteration.label ? ` · ${iteration.label}` : ''}`,
      })
      this.host.onStateChange?.()
      if (begun !== 'ran' && begun !== 'skipped') {
        failures.push(iteration.label || `element ${index + 1}`)
        continue
      }

      const body = await this.runNodes(pass, inner, order, nested, iteration)
      if (body === 'aborted') return 'aborted'
      if (body === 'failed') failures.push(iteration.label || `element ${index + 1}`)

      /*
       * The side effects of one pass happen here, awaited, and that is the point of the hook.
       * `RunSummary.executed` is a set of node ids, so a Download that ran four hundred times
       * appears in it once and would write one file; and a PNG is read off a live canvas, which
       * needs React to have committed this element's geometry before anything captures it.
       * Neither is expressible after the run, so the host is given the moment instead.
       */
      pass.summary.iterations++
      try {
        await this.host.onIteration?.({ ...iteration, nodeId: beginId, region: [...inner] })
      } catch (err) {
        failures.push(errorMessage(err))
      }
    }

    if (this.abandoned(pass, beginId)) return 'aborted'

    /*
     * Written onto the entry rather than raised through `ctx.warn`, because the begin node's
     * entry was already sealed at the last pass and the thing worth reporting is a property of
     * the *loop* rather than of any one element. Same channel the card reads either way.
     */
    if (failures.length > 0) {
      const said = `${formatCount(failures.length)} of ${formatCount(count)} failed: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? ' …' : ''}`
      const entry = this.cache.get(beginId)
      if (entry) {
        this.cache.set(beginId, { ...entry, warnings: [...(entry.warnings ?? []), said] })
      } else {
        /*
         * No entry to hang it on, because the begin node itself threw on the last pass and its
         * entry was dropped. Guarding on the entry alone discarded the whole report, so a loop
         * where every element failed read as clean beside one error message about the last.
         *
         * `liveWarnings` is the other half of the channel `warning()` already reads, and nothing
         * clears it until this node next executes — which is exactly the lifetime wanted.
         */
        this.liveWarnings.set(beginId, [said])
      }
    }

    /*
     * The begin node settles as an ordinary `ok`, and its cache entry is the *last* element —
     * which is honest and is exactly `Select One`'s answer to the same question. What the loop
     * produced is in the files it wrote and in whatever a Collect accumulated, not on this port.
     */
    /*
     * `ok` only if the begin node actually holds a result. It can fail on the last pass — a
     * source that went away mid-loop — and its `error` state was being overwritten here, leaving
     * a green card with no cached output behind it and the error nowhere on screen.
     */
    if (this.cache.has(beginId)) {
      this.setState(beginId, { state: 'ok' })
      this.loopDone.add(beginId)
    }
    pass.accumulations.clear()
    this.host.onStateChange?.()
    return this.cache.has(beginId) ? 'ran' : 'failed'
  }

  /**
   * Whether this run has been superseded or cancelled, recording it if so.
   *
   * One spelling, because the loop asks twice — before each pass and after the last — and the
   * two were written out verbatim. Two copies is how the cancel semantics come to differ between
   * "gave up part way" and "finished and then was cancelled", which are the same thing here.
   */
  private abandoned(pass: RunPass, beginId: string): boolean {
    if (!pass.controller.signal.aborted) return false
    pass.summary.cancelled = true
    this.setState(beginId, { state: 'stale' })
    return true
  }

  /** Which of these nodes' cached results still answer their current key. */
  private markAvailable(pass: RunPass, ids: Iterable<string>): void {
    for (const nodeId of ids) {
      const cached = this.cache.get(nodeId)
      if (cached && cached.key === pass.keys.get(nodeId)) pass.available.add(nodeId)
      else pass.available.delete(nodeId)
    }
  }

  private nodeOf(pass: RunPass, nodeId: string): GraphNode {
    return pass.nodes.get(nodeId)!
  }

  /**
   * Collect the values and provenance on a node's input ports.
   *
   * Lifted out of `execute` unchanged so the loop driver can ask the same question a pass
   * later without a second spelling of the reference rule — which is exactly the sort of
   * duplication `upstreamKey`'s own note was written about.
   */
  private gatherInputs(pass: RunPass, nodeId: string, def: NodeDefinition): GatheredInputs {
    const inputs: Record<string, Value | undefined> = {}
    const inputKeys: Record<string, string> = {}
    let blocked = false
    for (const port of inputPorts(def, this.nodeOf(pass, nodeId).params)) {
      const edge = pass.inbound.get(portKey(nodeId, port.id))
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
        const type = pass.inference.nodes[nodeId]?.inputs[port.id]
        inputs[port.id] = datasetIdentity(type)
        inputKeys[port.id] = referenceKey(type)
        continue
      }
      if (!pass.available.has(edge.source)) {
        blocked = true
        continue
      }
      inputs[port.id] = this.cache.get(edge.source)?.outputs[edge.sourceHandle]
      inputKeys[port.id] = upstreamKey(pass.keys, edge.source, edge.sourceHandle)
    }
    return { inputs, inputKeys, blocked }
  }

  /**
   * One node, once. The whole of what a run does, per node — and therefore the whole of what a
   * loop does per element, since a new pass is indistinguishable from an upstream edit.
   */
  private async executeNode(
    pass: RunPass,
    nodeId: string,
    iteration?: LoopIteration,
  ): Promise<NodeVerdict> {
    const node = this.nodeOf(pass, nodeId)
    const def = getNodeDef(node.type)
    if (!def) {
      this.setState(nodeId, { state: 'error', error: `Unknown node type "${node.type}"` })
      pass.summary.failed.push(nodeId)
      return 'failed'
    }
    // Never evaluated, so it is neither executed nor deferred — it is simply not work.
    if (def.annotation) return 'skipped'
    if (node.disabled) {
      this.setState(nodeId, { state: 'disabled' })
      return 'skipped'
    }
    if (hasErrors(pass.inference, nodeId)) {
      const first = pass.inference.nodes[nodeId]?.issues.find((i) => i.severity === 'error')
      this.setState(nodeId, { state: 'error', error: first?.message ?? 'Invalid node' })
      pass.summary.failed.push(nodeId)
      return 'failed'
    }
    /*
     * A cache hit answers for the key, and for a **loop exit mid-pass it must not** — the fold's
     * other input is the previous pass's result, which is not in the key and cannot be. A
     * `Collect` whose entry happens to match this pass's key would be skipped, `pass.accumulations`
     * would never be fed, and the next pass would start the total again from scratch: the loop
     * finishes holding the tail of its own elements, with every node reading `ok`.
     *
     * It happens whenever a loop is re-run over ground it has covered — cancel at element two,
     * press Run, and pass two hits the entry pass two left behind.
     */
    const foldingHere = iteration !== undefined && def.loop === 'end'
    if (pass.available.has(nodeId) && !foldingHere) {
      this.setState(nodeId, { state: 'ok', ...pick(this.states.get(nodeId), 'durationMs') })
      return 'skipped'
    }

    const gathered = this.gatherInputs(pass, nodeId, def)
    if (gathered.blocked) {
      this.setState(nodeId, { state: 'blocked' })
      return 'blocked'
    }

    // The hybrid rule: defer expensive work unless this is a full run.
    if (pass.mode === 'auto' && def.cost === 'expensive') {
      this.setState(nodeId, { state: 'stale' })
      pass.summary.deferred.push(nodeId)
      return 'skipped'
    }

    this.setState(nodeId, { state: 'running', progress: 0 })
    const nodeStarted = performance.now()
    try {
      // Spent here rather than at the top of the run: a node that was deferred by the cheap
      // pass has not had its chance to honour the request yet. Inside a loop that means the
      // first pass, which is the one that would reach the network anyway.
      const refresh = this.forceRefresh.delete(nodeId)
      // Collected per execution rather than on the context object, so a node cannot read back
      // what it reported and nothing survives into the next run.
      let fetchedAt: number | undefined
      /*
       * The exception to that: warnings are visible while the node runs, which is the whole
       * point of raising them before the expensive part, so they live in a map the UI reads.
       *
       * Cleared here as well as in the `finally`, which is not redundant: `warn` is handed to
       * fetches that keep unwinding after a run is superseded, so a late call can repopulate
       * the map *after* the finally has run. Without this, that stray would shadow the cache
       * entry — the newer, real answer — for as long as the node existed.
       */
      this.liveWarnings.delete(nodeId)
      const ctx = this.makeEvalContext({
        pass,
        nodeId,
        def,
        gathered,
        refresh,
        iteration,
        // No `def.loop === 'end'` guard: the only writer of this map already gates on it, so a
        // second test here would imply the map can hold a node that it never does.
        accumulated: pass.accumulations.get(nodeId),
        onFetched: (at) => {
          // Oldest wins: a node making several fetches is only as fresh as its stalest one.
          fetchedAt = fetchedAt === undefined ? at : Math.min(fetchedAt, at)
        },
      })
      const outputs = await def.evaluate(ctx)

      if (pass.generation !== this.generation) {
        // A newer run took over while we awaited; drop the result silently.
        pass.summary.cancelled = true
        return 'aborted'
      }
      if (pass.controller.signal.aborted) {
        pass.summary.cancelled = true
        this.setState(nodeId, { state: 'stale' })
        return 'aborted'
      }

      const warnings = this.liveWarnings.get(nodeId)
      this.cache.set(nodeId, {
        key: pass.keys.get(nodeId)!,
        outputs,
        ...(fetchedAt === undefined ? {} : { fetchedAt }),
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
      })
      /*
       * A loop exit is a fold, so what it just returned is the accumulator the next pass folds
       * into. Held here rather than in the cache because it is not an answer to a key — it is
       * a half-finished total, and storing one under a provenance key is the mistake
       * `previews` exists to avoid.
       */
      if (def.loop === 'end' && iteration) pass.accumulations.set(nodeId, outputs)
      pass.available.add(nodeId)
      if (!pass.summary.executed.includes(nodeId)) pass.summary.executed.push(nodeId)
      this.setState(nodeId, {
        state: 'ok',
        durationMs: performance.now() - nodeStarted,
      })
      return 'ran'
    } catch (err) {
      if (pass.controller.signal.aborted) {
        pass.summary.cancelled = true
        this.setState(nodeId, { state: 'stale' })
        return 'aborted'
      }
      this.cache.delete(nodeId)
      if (!pass.summary.failed.includes(nodeId)) pass.summary.failed.push(nodeId)
      this.setState(nodeId, {
        state: 'error',
        error: errorMessage(err),
      })
      return 'failed'
    } finally {
      /*
       * The preview dies with the run that made it, however that run ended.
       *
       * On success the real outputs are already in the cache and the preview is the same
       * value one publish out of date. On an error or a cancel there is no result to show, and
       * a partial scene left standing beside a `stale` badge is the "looks complete but isn't"
       * failure this whole mechanism is arranged to avoid — the geometry is still in
       * `geometryCache`, so the next run redraws it at once anyway.
       */
      // Announced, not just deleted: on an error or a cancel nothing else will move, and a
      // card drawing from this node's port would otherwise keep the dropped partial on screen.
      if (this.previews.delete(nodeId)) this.host.onPreview?.()
      // The entry above took a copy on success; on a failure or a cancel there is nothing to
      // caveat, and the error is the only thing worth reading.
      this.liveWarnings.delete(nodeId)
    }
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
    /*
     * The two indexes, when the caller already holds them. A loop recomputes the keys once per
     * pass, and rebuilding a node map and an edge map per pass allocates `O(N+E)` entries four
     * hundred times over for two structures the run has had in hand since it started.
     */
    indexes?: { nodes: Map<string, GraphNode>; inbound: Map<string, GraphEdge> },
  ): Map<string, string> {
    const keys = new Map<string, string>()
    const nodes = indexes?.nodes ?? nodesById(graph)
    const inbound = indexes?.inbound ?? inboundIndex(graph)

    for (const nodeId of order) {
      const node = nodes.get(nodeId)!
      const def = getNodeDef(node.type)
      const inputTypes = inference.nodes[nodeId]?.inputs ?? {}
      const upstream: Array<[string, string | null]> = []
      for (const port of def ? inputPorts(def, node.params) : []) {
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
          upstream.push([port.id, referenceKey(inputTypes[port.id])])
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
          /*
           * The loop's element, for a `For Each` and for nothing else. It is the one thing in
           * this hash that is not read from the document, and it is here rather than in the
           * params for the reason `loopIndex` records: a pass is not an edit. Absent on every
           * other node, so no graph without a loop hashes anything extra.
           */
          ...(this.loopIndex.has(nodeId) ? { iteration: this.loopIndex.get(nodeId) } : {}),
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
    /*
     * A loop's region is **downstream** of it, so "run this node" on a `For Each` would otherwise
     * scope to the loop and its ancestors and iterate over a region that is not in scope — a
     * progress bar counting to four hundred with nothing behind it. Pulled in whole, along with
     * each region node's own ancestors, since a body reading a second branch needs that branch.
     *
     * Asked only when the graph could hold a loop at all, so the ordinary "run this node" pays
     * a `Set` lookup per node and nothing else.
     */
    if (mayHaveLoops(graph.nodes)) {
      const nodes = nodesById(graph)
      for (const id of [...scope]) {
        if (getNodeDef(nodes.get(id)?.type ?? '')?.loop !== 'begin') continue
        for (const member of loopRegion(graph, id)) {
          scope.add(member)
          for (const dep of ancestors(graph, member)) scope.add(dep)
        }
      }
    }
    return scope
  }

  /**
   * Build the context one `evaluate` sees.
   *
   * Takes an options object rather than a positional list: it had grown to eleven arguments,
   * five of which were callbacks of the same shape, and the loop added two more. A transposed
   * pair of `(nodeId, refresh)` there is a bug nothing type-checks.
   */
  private makeEvalContext(opts: {
    pass: RunPass
    nodeId: string
    def: NodeDefinition
    gathered: GatheredInputs
    refresh: boolean
    iteration?: LoopIteration | undefined
    accumulated?: Readonly<Record<string, Value>> | undefined
    onFetched?: (at: number) => void
  }): EvalContext {
    const { pass, nodeId, def, gathered, refresh } = opts
    const params = this.nodeOf(pass, nodeId).params
    const types = (pass.inference.nodes[nodeId]?.inputs ?? {}) as Record<string, never>
    return {
      params,
      refresh,
      iteration: opts.iteration,
      accumulated: opts.accumulated,
      reportFetched: (at) => opts.onFetched?.(at),
      warn: (message) => {
        const said = this.liveWarnings.get(nodeId) ?? []
        // Deduped, so a warning raised inside a per-item loop says its piece once.
        if (said.includes(message)) return
        said.push(message)
        this.liveWarnings.set(nodeId, said)
        this.host.onStateChange?.()
      },
      publish: (partial) => {
        /*
         * Checked here rather than left to the caller: `publish` is handed to a fetch that
         * is already unwinding when a run is superseded, and the last few bodies in flight
         * land after that. Dropping them silently is the whole point — the newer run owns
         * the screen from the moment it starts.
         */
        if (pass.generation !== this.generation || pass.controller.signal.aborted) return
        this.previews.set(nodeId, partial)
        this.host.onPreview?.()
      },
      input: (portId) => gathered.inputs[portId],
      inputKey: (portId) => gathered.inputKeys[portId],
      inputPorts: () => inputPorts(def, params),
      outputPorts: () => outputPorts(def, params),
      column: (paramId) => {
        const p = findParam(def, paramId)
        return p && p.kind === 'column' ? resolveColumn(p, params, types) : undefined
      },
      columns: (paramId) => {
        const p = findParam(def, paramId)
        return p && p.kind === 'columns' ? resolveColumns(p, params, types) : []
      },
      resolveSource: (sourceId) => this.host.resolveSource(sourceId),
      signal: pass.controller.signal,
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
    for (const held of [this.cache, this.previews, this.states, this.liveWarnings]) {
      for (const id of [...held.keys()]) if (!alive.has(id)) held.delete(id)
    }
    // A deleted node's pending request would otherwise be spent by whatever reused its id.
    for (const id of [...this.forceRefresh]) if (!alive.has(id)) this.forceRefresh.delete(id)
    // Same reason, and it matters more: a stranded index would still be folded into whatever
    // node took the id, keying it off a loop that no longer exists.
    for (const id of [...this.loopIndex.keys()]) if (!alive.has(id)) this.loopIndex.delete(id)
    for (const id of [...this.loopDone]) if (!alive.has(id)) this.loopDone.delete(id)
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
 * How a `reference` port's upstream is named — the resolved *type*, not the source node's key.
 *
 * It has to be the type: the referenced node is excluded from the order, so its key may not be
 * computed when this is read, and `keys.get` would answer `'unresolved'` forever. It is also the
 * better key, since a dataset's identity is all a reference reads.
 *
 * One spelling, for `upstreamKey`'s reason and in the same two consumers — `desiredKeys` folds it
 * into the hash that decides whether a node re-runs, and `ctx.inputKey` hands it to the node as
 * the identity of what arrived. Written out twice, they drift into a node that either re-runs
 * forever or never invalidates, with nothing type-checking the pair.
 */
function referenceKey(type: CodaType | undefined): string {
  return `ref:${hashValue(type ?? null)}`
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

/**
 * A count, grouped, for a progress line and a warning that both read as prose.
 *
 * Local rather than `ui/format.ts`'s `formatNumber`: `src/core` is headless and must not reach
 * into the UI layer, and what is wanted here is the one rule (group thousands) rather than that
 * module's whole ladder of unit- and dtype-aware cases.
 */
function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function pick<T extends object, K extends keyof T>(obj: T | undefined, key: K): Partial<T> {
  return obj && obj[key] !== undefined ? ({ [key]: obj[key] } as Partial<T>) : {}
}
