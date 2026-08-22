/**
 * Will this graph export cleanly, or come out full of TODOs?
 *
 * `canExportNotebook` answers whether an export is worth making at all, and it answers
 * *synchronously* because two surfaces ask it while they are open. This answers the softer
 * question beside it — how much of the graph the walk could not translate — and it cannot be
 * synchronous, because the only honest way to know is to **run the exporter**.
 *
 * That is the whole design decision here, and it was taken over the obvious alternative. A static
 * table of "which node types emit in which language" would answer instantly and live in the main
 * chunk, and it would be a mirror of two registries that nothing type-checks against them — the
 * `NO_EMITTER` shape, which works only because `coverage.test.ts` pins it. Worse, it could not see
 * most of what actually becomes a TODO: a backend an emitter was not written against, an unwired
 * port, an upstream that was itself a TODO, `Paths` with `Collapse types` on. Running the real
 * walk sees all of them by construction and cannot drift.
 *
 * So this is the `peek*` contract the rest of the codebase already uses for facts that arrive
 * late — `peekDatasets`, `peekUploadSchema`, `schemasFor` — with one deliberate difference:
 *
 * - **`peekExportWarnings` starts nothing.** It is a cache read. `buildCommandItems` calls it on
 *   every store change while the palette is open, and a peek that kicked off an export there
 *   would run the walk per change. Same rule, and the same reason, as `peekBases`.
 * - **`requestExportWarnings` is the half that works**, called when a surface opens. It loads the
 *   exporters lazily — which is the whole point of `canExport.ts` being separate, and is
 *   preserved: nothing here is reachable until somebody opens the Save menu or the palette.
 *
 * The answer is keyed on the graph **object**, which the store mints afresh on every commit, so a
 * stale answer is structurally impossible: a changed graph is a cache miss.
 */

import { useSyncExternalStore } from 'react'

import type { CodaGraph } from '../core/graph'
import { channel } from '../data/channel'
import { canExportNotebook } from '../export/canExport'
import type { TodoStep } from '../export/canExport'
import type { ExportLanguage } from '../nodes/lib/datasetFamilies'

/** What a surface says about a graph that exports with gaps in it. */
export interface ExportWarning {
  /** How many steps came out as a TODO. */
  count: number
  /** One line, for a palette hint. */
  short: string
  /** A sentence naming them, for a menu with room to answer back. */
  detail: string
}

/** How many node names a message lists before it stops. */
const NAMED = 3

/** Computed answers for one graph. `null` means "ran, nothing to report". */
interface Entry {
  graph: CodaGraph
  python?: ExportWarning | null
  r?: ExportWarning | null
}

let entry: Entry | undefined
/** Languages already being computed for `entry.graph`, so a second ask does not re-run. */
let running = new Set<ExportLanguage>()

const learned = channel()

/** Fired when an answer lands, so an open surface re-renders. */
export const subscribeExportWarnings = learned.subscribe

/** Test seam; module state outlives a test file otherwise. */
export function resetExportWarnings(): void {
  entry = undefined
  running = new Set()
}

/**
 * What is known about this graph, or undefined while nothing is.
 *
 * Pure: no fetch, no import, no work. See the module note.
 */
export function peekExportWarnings(
  graph: CodaGraph,
  language: ExportLanguage,
): ExportWarning | undefined {
  if (entry?.graph !== graph) return undefined
  return entry[language] ?? undefined
}

/**
 * Work out both answers for this graph, if they are not already known.
 *
 * Called when a surface opens, never from a render that runs on every store change. Returns
 * nothing and never rejects: a warning that cannot be produced has nothing to say, and the
 * surfaces treat "not known yet" and "nothing to report" the same way — which is right, because
 * for the moment before the exporter has loaded they *are* the same.
 */
export function requestExportWarnings(graph: CodaGraph): void {
  if (entry?.graph !== graph) {
    entry = { graph }
    running = new Set()
  }
  for (const language of ['python', 'r'] as const) {
    if (entry[language] !== undefined || running.has(language)) continue
    // A refused export has nothing to warn about — the refusal already says more than a warning
    // could, and running the walk on a graph it will not translate is work for no answer.
    if (canExportNotebook(graph, language)) {
      entry[language] = null
      continue
    }
    running.add(language)
    void compute(graph, language)
  }
}

async function compute(graph: CodaGraph, language: ExportLanguage): Promise<void> {
  let todos: TodoStep[] = []
  try {
    todos = await runWalk(graph, language)
  } catch {
    // Swallowed. This is an advisory about an export nobody has asked for yet; a failure to
    // produce it must not surface as an error, and pressing the export itself will report
    // whatever went wrong in the place somebody can act on it.
  }
  running.delete(language)
  // A newer graph may have arrived while the exporter was loading; it owns the cache now.
  if (entry?.graph !== graph) return
  entry[language] = describe(todos, language)
  announce()
}

async function runWalk(graph: CodaGraph, language: ExportLanguage): Promise<TodoStep[]> {
  if (language === 'python') {
    const { exportNotebook } = await import('../export/python/exporter')
    const result = exportNotebook(graph)
    return result.ok ? result.todos : []
  }
  const { exportRmd } = await import('../export/r/exporter')
  const result = exportRmd(graph)
  return result.ok ? result.todos : []
}

/**
 * The message, or null where there is nothing to say.
 *
 * **It names the root causes and counts the cascade**, which is the one distinction worth
 * drawing. A TODO binds nothing, so everything downstream of one is a TODO too — and telling
 * somebody that their Table node "has no notebook equivalent" when the Table is perfectly
 * translatable and the Explore in front of it is not sends them to look at the wrong card. That
 * is the walk's own unwired-versus-blocked split, carried out to the surface.
 *
 * It deliberately does not say *why* each root is untranslated. Those reasons are genuinely
 * different — no emitter, a foreign backend, an unwired port — and every one of them is already
 * stated in the document itself, beside the step it is about.
 */
function describe(todos: readonly TodoStep[], language: ExportLanguage): ExportWarning | null {
  if (todos.length === 0) return null
  const what = language === 'python' ? 'notebook' : 'document'
  const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`

  /*
   * A muted node also binds nothing, so a graph can carry blocked steps with no untranslated
   * root at all. Naming the blocked ones is then the only true thing left to say.
   */
  const roots = todos.filter((t) => !t.blocked)
  const named = (roots.length > 0 ? roots : todos).map((t) => `“${t.label}”`)
  const shown = named.slice(0, NAMED)
  const over = named.length - shown.length
  // `"a"`, `"a" and "b"`, `"a", "b" and 2 more` — the walk's own `quoted` shape, since this
  // sentence is read beside the messages that walk produces.
  const tail = over > 0 ? `${over} more` : shown.pop()
  const listed = shown.length > 0 ? `${shown.join(', ')} and ${tail}` : String(tail)
  const have = named.length === 1 ? 'has' : 'have'

  const blocked = roots.length > 0 ? todos.length - roots.length : 0
  const cascade =
    blocked > 0 ? `, so ${named.length === 1 ? 'it' : 'they'} and ${steps(blocked)} after ` +
      `${named.length === 1 ? 'it' : 'them'} will be left as TODO comments` : ''

  return {
    count: todos.length,
    short: `${steps(todos.length)} will be left as TODO`,
    detail:
      `${listed} ${have} no ${what} equivalent${cascade}` +
      `${cascade ? '' : ` and will be left as ${todos.length === 1 ? 'a TODO comment' : 'TODO comments'}`}. ` +
      `The rest of the graph exports normally.`,
  }
}

/**
 * A revision that changes when an answer lands.
 *
 * A **number**, not the answer: `useSyncExternalStore` compares snapshots by identity, so a
 * selector minting an object would loop (invariant 7). Surfaces read the revision to re-render
 * and then call `peekExportWarnings` for the value.
 *
 * Bumped here rather than by a listener on the same channel, which would work only while this
 * module's own subscription happened to be registered before React's.
 */
let revision = 0

function announce(): void {
  revision += 1
  learned.notify()
}

/** Re-renders a surface when an answer lands. The value is a cursor, not the answer. */
export function useExportWarnings(): number {
  return useSyncExternalStore(subscribeExportWarnings, () => revision)
}
