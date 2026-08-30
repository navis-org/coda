/**
 * Local persistence and file I/O.
 *
 * The graph file is the document, so "save" is a download and "open" is a file picker —
 * no server, no accounts. localStorage holds an autosave of the working graph so a
 * refresh doesn't lose work; it is a crash net, not a project store.
 *
 * That crash net is **per tab**, which it was not at first and had to become. `localStorage` is
 * shared by every tab on the origin, so two tabs on two workflows wrote one key and whichever
 * was touched last silently owned both — and since nothing ever re-read it, the loss landed at
 * exactly the moment the feature exists for: a reload. See `tabId` for the mechanism and
 * `pruneSlots` for what bounds it.
 */

import type { CodaGraph } from '../core/graph'
import { deserializeGraph, serializeGraph } from '../core/graph'
import type { EdgeRouting, LayoutOptions } from '../layout/options'
import { DEFAULT_LAYOUT_OPTIONS, EDGE_ROUTINGS, coerceLayoutOptions } from '../layout/options'

const AUTOSAVE_KEY = 'coda.autosave.v1'
/**
 * Where one tab's own autosave goes, and the index over every such slot.
 *
 * Under the same stem as the shared key, with separators chosen so a prefix scan for one
 * cannot match the other: `.tab.` against `.index`. That matters because `pruneSlots` finds
 * slots by scanning for the prefix, and a scan that swept up its own index would drop every
 * slot on the next save.
 */
const SLOT_PREFIX = `${AUTOSAVE_KEY}.tab.`
const SLOT_INDEX_KEY = `${AUTOSAVE_KEY}.index`
/** This tab's identity, in `sessionStorage` rather than `localStorage` — see `tabId`. */
const TAB_KEY = 'coda.tab.v1'
const THEME_KEY = 'coda.theme.v1'
const PANELS_KEY = 'coda.panels.v1'
const AUTORUN_KEY = 'coda.autorun.v1'
const NOTIFY_KEY = 'coda.notify.v1'
const START_PAGE_KEY = 'coda.startPage.v1'
const LAYOUT_KEY = 'coda.layout.v1'
/** When the feedback nudge was last shown or dismissed, so it can wait a week before the next. */
const FEEDBACK_NUDGE_KEY = 'coda.feedbackNudge.v1'

/**
 * How many slots may exist at once, and the total they may occupy between them.
 *
 * Both bounds rather than one, because the two failure shapes are different: six slots of a
 * four-kilobyte example is nothing, and six of a graph carrying a 10,000-neuron Explore
 * selection is most of the origin's budget. `localStorage` is around 5 MB for everything, and
 * the shared key already holds one copy of a graph, so the slots get a fraction of it.
 *
 * Counted in UTF-16 code units, which is both what `String.length` answers and what browsers
 * charge the quota in.
 */
const MAX_SLOTS = 6
const MAX_SLOT_BYTES = 2_000_000

/**
 * `localStorage`, with the failure reported rather than swallowed.
 *
 * Every other accessor in this file swallows, on the rule stated above: losing a *preference*
 * is survivable. The autosave path needs the answer — a slot whose write was refused must not
 * be left in the index claiming bytes that are not there, or the budget drifts until it starts
 * evicting live tabs.
 */
function readLocal(name: string): string | undefined {
  try {
    return localStorage.getItem(name) ?? undefined
  } catch {
    return undefined
  }
}

function writeLocal(name: string, value: string): boolean {
  try {
    localStorage.setItem(name, value)
    return true
  } catch {
    return false
  }
}

function removeLocal(name: string): void {
  try {
    localStorage.removeItem(name)
  } catch {
    /* ignore */
  }
}

/**
 * This tab's id, minted on first use and kept in `sessionStorage`.
 *
 * `sessionStorage` is the whole mechanism, and it is chosen for three properties at once: it is
 * scoped to one tab, it survives a reload, and browsers restore it with the tab after a crash
 * or a "reopen closed tab". That is precisely the set of events the autosave exists for.
 * `localStorage` has none of the first and is why a single key was the problem it was.
 *
 * It is per-tab with one exception, which `watchTabIdentity` exists for: a tab created *from*
 * another one starts with a copy of it.
 *
 * Deliberately **not memoised**. A `sessionStorage` read costs nothing beside the graph
 * serialisation it accompanies, and a module variable holding the id would be a second source
 * of truth that no test could reset without a seam existing for it — so two tabs are simulated
 * by writing the key, which is what a browser does.
 *
 * `undefined` where storage is unavailable: a private mode, or a suite under plain Node. Every
 * caller then falls back to the shared key, which is what this file did before slots existed.
 */
function tabId(): string | undefined {
  try {
    const held = sessionStorage.getItem(TAB_KEY)
    if (held) return held
    const minted = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(TAB_KEY, minted)
    return minted
  } catch {
    return undefined
  }
}

function slotKey(id: string): string {
  return `${SLOT_PREFIX}${id}`
}

/**
 * Take a new identity when another tab turns out to be holding this one's.
 *
 * `sessionStorage` is per tab with one exception, and it is a gesture people actually make:
 * a browsing context created *from* another — Duplicate Tab, or `window.open` — starts with a
 * **copy** of it, this tab's id included. Two tabs then write one slot and clobber each other,
 * which is the whole bug this file exists to fix, surviving in the one case the mechanism
 * cannot see for itself. Measured in Chrome rather than assumed: without this, duplicating a
 * tab and editing the copy left the original reloading onto the copy's graph.
 *
 * The `storage` event closes it with nothing else added, because it fires only in *other*
 * documents on the origin. A tab that sees a write to its own slot has just been told, by the
 * exact act that would have caused the damage, that somebody else is using its id — so it takes
 * a fresh one, and since `tabId` re-reads `sessionStorage` on every call the next save lands in
 * the new slot with no further plumbing. Exactly one tab moves: the other's write is what raised
 * the event, and no tab hears its own writes.
 *
 * A **removal is not a collision**. `pruneSlots` deletes the slots it evicts, and reading that
 * as a duplicate would have every evicted tab churn its identity for no reason.
 *
 * `reclaim` is what makes the move whole, and leaving it out was a real hole rather than a
 * refinement: the event arrives *after* the write that raised it, so by the time a tab learns
 * its id was taken, the copy has already overwritten the slot it was learning about. Re-minting
 * alone leaves the original pointing at an empty slot, falling back to the shared key — which
 * now holds the copy's graph. So the new slot is filled immediately with what this tab is
 * actually holding. It is required rather than optional because a caller that forgot it would
 * get the silent half of the bug back with nothing failing.
 *
 * Never unsubscribed, on the store's own terms: registered once from a module singleton that
 * outlives every component. Registering twice is harmless rather than guarded against — the
 * first listener re-mints, and the second then finds the event is not about its slot any more.
 * There is no cascade either: the write `reclaim` makes lands on a key no other tab claims.
 */
export function watchTabIdentity(reclaim: () => void): void {
  try {
    window.addEventListener('storage', (event) => {
      if (event.newValue === null) return
      const id = tabId()
      if (!id || event.key !== slotKey(id)) return
      try {
        // Minted through `tabId` rather than beside it, so there is one spelling of what an
        // identity looks like.
        sessionStorage.removeItem(TAB_KEY)
        tabId()
      } catch {
        /* ignore */
      }
      reclaim()
    })
  } catch {
    // No `window`: a suite under plain Node. There are no other tabs to collide with either.
  }
}

/** What the index records per slot: how recently that tab wrote, and what it is holding. */
interface SlotRecord {
  at: number
  size: number
}

type SlotIndex = Record<string, SlotRecord>

function readSlotIndex(): SlotIndex {
  const raw = readLocal(SLOT_INDEX_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: SlotIndex = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const held = value as Partial<SlotRecord> | null
      if (typeof held?.at === 'number' && typeof held.size === 'number') {
        out[id] = { at: held.at, size: held.size }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Every slot actually in storage, whatever the index believes about them. */
function storedSlotIds(): string[] {
  const ids: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(SLOT_PREFIX)) ids.push(key.slice(SLOT_PREFIX.length))
    }
  } catch {
    /* ignore */
  }
  return ids
}

/**
 * Decide which slots survive this save, delete the rest, and answer the new index.
 *
 * Ranked by how recently each tab wrote, so what goes is the least recently active — a closed
 * tab far more often than a live one. **A live tab that loses its slot falls back to the shared
 * key**, which is what every tab did before slots existed, and that is the whole reason a slot
 * is an *override* of the shared key rather than a replacement for it: getting this eviction
 * wrong costs the old behaviour rather than the work.
 *
 * The caller's own slot is never dropped and is charged first, so a graph larger than the whole
 * budget evicts everything else and is still attempted rather than refused.
 *
 * Slots are enumerated from **storage**, not from the index, so one the index has lost track of
 * is still bounded by the budget instead of leaking until somebody clears the origin. Such a
 * slot is measured and ranked last rather than dropped on sight: a corrupt index would
 * otherwise be a reason to throw away work that is perfectly readable.
 */
function pruneSlots(mine: string, mySize: number): SlotIndex {
  const index = readSlotIndex()
  const kept: SlotIndex = { [mine]: { at: Date.now(), size: mySize } }
  let count = 1
  let bytes = mySize

  const others = storedSlotIds()
    .filter((id) => id !== mine)
    .map((id) => ({
      id,
      record: index[id] ?? { at: 0, size: readLocal(slotKey(id))?.length ?? 0 },
    }))
    .sort((a, b) => b.record.at - a.record.at)

  for (const { id, record } of others) {
    if (count < MAX_SLOTS && bytes + record.size <= MAX_SLOT_BYTES) {
      kept[id] = record
      count += 1
      bytes += record.size
    } else {
      removeLocal(slotKey(id))
    }
  }
  return kept
}

/**
 * Write the working graph where a reload of *this tab* will find it.
 *
 * Two copies answering two different questions. The shared key is "the most recent graph from
 * any tab", which is what a genuinely new tab — or the app reopened after everything was closed
 * — starts on, and it is the only thing this function used to write. The slot is "what this tab
 * was working on", and it is what lets two tabs on two workflows both survive a reload instead
 * of the last one touched silently owning both.
 *
 * The serialisation happens once and the string is written twice; it is by far the expensive
 * half.
 */
export function saveAutosave(graph: CodaGraph): void {
  const json = serializeGraph(graph)
  // Quota, or a privacy mode that blocks storage. Losing the autosave is survivable; breaking
  // the editor over it is not.
  writeLocal(AUTOSAVE_KEY, json)

  const id = tabId()
  if (!id) return

  // Prune *before* writing, or the save that overruns the budget is the one nothing made room
  // for.
  const index = pruneSlots(id, json.length)
  writeLocal(SLOT_INDEX_KEY, JSON.stringify(index))
  if (writeLocal(slotKey(id), json)) return

  // The slot was refused where the shared key was not — a graph over the remaining quota. Take
  // the claim back rather than leaving the index asserting bytes that do not exist. The shared
  // copy stands, so this tab still has a crash net, just the coarser one.
  delete index[id]
  removeLocal(slotKey(id))
  writeLocal(SLOT_INDEX_KEY, JSON.stringify(index))
}

/**
 * The graph to open on: this tab's own where it has one, the most recent from any tab if not.
 *
 * The fallback is what keeps the ordinary case working — close the app, come back tomorrow, and
 * the last thing you were doing is still there. It is also the entire degradation path: no
 * `sessionStorage`, an evicted slot, and an autosave written by a build from before slots
 * existed all land on it, and every one of them gets exactly the behaviour this file had then.
 */
export function loadAutosave(): { graph: CodaGraph; warnings: string[] } | undefined {
  const id = tabId()
  const raw = (id ? readLocal(slotKey(id)) : undefined) ?? readLocal(AUTOSAVE_KEY)
  if (!raw) return undefined
  try {
    return deserializeGraph(raw)
  } catch {
    return undefined
  }
}

/** Slug suitable for a filename, derived from the graph name. */

export async function pickGraphFile(): Promise<
  { graph: CodaGraph; warnings: string[] } | undefined
> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.coda.json,application/json'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(undefined)
        return
      }
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        try {
          resolve(deserializeGraph(String(reader.result)))
        } catch (err) {
          resolve({
            graph: { version: 1, nodes: [], edges: [] },
            warnings: [`Could not open ${file.name}: ${(err as Error).message}`],
          })
        }
      })
      reader.readAsText(file)
    })
    input.click()
  })
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark'

export function loadTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  return 'dark'
}

// ---------------------------------------------------------------------------
// Panel visibility
// ---------------------------------------------------------------------------

/**
 * Which optional panels are open.
 *
 * Both default to **closed**: the canvas is the thing, and an inspector that opens by default
 * takes 320px from it before anyone has selected a node — where it has nothing to show. Each is
 * one click (or `I`) away, and the choice sticks, so anyone who wants them open pays once.
 */
export interface PanelState {
  inspector: boolean
  minimap: boolean
  /**
   * The assistant drawer. Closed by default, like the other two on the canvas: it takes a
   * strip of height before anyone has asked it anything, and the graph is the thing.
   *
   * Only whether it is *open* is remembered. The conversation itself is not persisted at all
   * — see `assistantChat.ts`.
   */
  assistant: boolean
  /**
   * The expanded viewer's styling sidebar. Unlike the other two this defaults **open**: it
   * lives inside a modal nobody opens by accident, and the controls are most of the reason
   * to open it. The canvas argument above does not apply — there is no canvas in there.
   */
  style: boolean
}

export const DEFAULT_PANELS: PanelState = {
  inspector: false,
  minimap: false,
  assistant: false,
  style: true,
}

export function loadPanels(): PanelState {
  try {
    const raw = localStorage.getItem(PANELS_KEY)
    if (!raw) return DEFAULT_PANELS
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PANELS
    const held = parsed as Partial<Record<keyof PanelState, unknown>>
    return {
      inspector: held.inspector === true,
      minimap: held.minimap === true,
      assistant: held.assistant === true,
      // Note the inverted test: absent means open for this one, and a build written before
      // the key existed must not read as "the user closed it".
      style: held.style !== false,
    }
  } catch {
    // Storage disabled, or a value written by an older build. Closed is the safe answer.
    return DEFAULT_PANELS
  }
}

export function savePanels(panels: PanelState): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Auto-run
// ---------------------------------------------------------------------------

/**
 * Whether every edit re-runs the whole graph.
 *
 * **Off by default, and that is a safety default rather than a taste one.** Expensive nodes hit a
 * shared production Neo4j, and the hybrid evaluation model exists precisely so a reactive editor
 * does not fire a query per keystroke. Turning this on opts out of that; it is the user's call to
 * make per session, and it is remembered.
 */
export function loadAutoRun(): boolean {
  try {
    return localStorage.getItem(AUTORUN_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveAutoRun(enabled: boolean): void {
  try {
    localStorage.setItem(AUTORUN_KEY, String(enabled))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Run notifications
// ---------------------------------------------------------------------------

/**
 * The user's half of "notify me when a run finishes" — the browser's permission is the other
 * half and outranks it, so this is not on its own an answer about whether anything will appear.
 * `bellState` in `ui/notify.ts` combines the two, and records why it has to.
 *
 * Off by default because it cannot be anything else: permission is only askable from a user
 * gesture. Remembered so that somebody who turned it on is not asked again next session.
 */
export function loadNotifyRuns(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveNotifyRuns(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, String(enabled))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Automatic layout
// ---------------------------------------------------------------------------

/**
 * Layout preferences, and whether auto-layout mode is on.
 *
 * Per-user rather than per-document: how you like a graph arranged is a working preference, and
 * writing it into the `.coda.json` would mean a file you were sent silently re-arranging itself
 * to somebody else's taste. Both halves live under one key because they are one setting from the
 * bubble's point of view.
 *
 * `auto` is stored, but note that `loadGraph` clears it — opening a file is the one thing that
 * turns the mode off, since the positions in it are somebody's decision.
 */
export interface LayoutPrefs {
  auto: boolean
  options: LayoutOptions
  /**
   * How wires are drawn. Under the same key as the rest because it is one setting from the
   * rail's point of view, and per-user for the same reason `options` is: how you like a graph
   * drawn is a working preference, and writing it into the `.coda.json` would have a file you
   * were sent silently restyle itself to somebody else's taste.
   */
  edgeRouting: EdgeRouting
}

/**
 * `curved` throughout, which is what the editor drew before routing existed.
 *
 * Absent means curved, so a preference written before this key existed is not read as somebody
 * having chosen a routing — the same call `loadPanels` makes about the style sidebar, inverted
 * because there the useful default is the one an older file cannot have asked for.
 */
const DEFAULT_EDGE_ROUTING: EdgeRouting = 'curved'

function coerceEdgeRouting(raw: unknown): EdgeRouting {
  return typeof raw === 'string' && (EDGE_ROUTINGS as readonly string[]).includes(raw)
    ? (raw as EdgeRouting)
    : DEFAULT_EDGE_ROUTING
}

export function loadLayoutPrefs(): LayoutPrefs {
  const fallback: LayoutPrefs = {
    auto: false,
    options: DEFAULT_LAYOUT_OPTIONS,
    edgeRouting: DEFAULT_EDGE_ROUTING,
  }
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    const held = (parsed ?? {}) as Record<string, unknown>
    return {
      auto: held.auto === true,
      options: coerceLayoutOptions(held.options),
      edgeRouting: coerceEdgeRouting(held.edgeRouting),
    }
  } catch {
    // Storage disabled, or a value from an older build. Off with stock options is the answer
    // that cannot surprise anyone.
    return fallback
  }
}

export function saveLayoutPrefs(prefs: LayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

/**
 * Whether the start page has been dismissed for good.
 *
 * Separate from *closing* it, which is the ordinary way out and says nothing about the next
 * visit — only the checkbox writes this. Stored as a word rather than `true` so the key reads
 * for itself in devtools.
 */
export function loadStartPageDismissed(): boolean {
  try {
    return localStorage.getItem(START_PAGE_KEY) === 'dismissed'
  } catch {
    // Storage disabled. Showing the start page again is the harmless failure; suppressing it
    // for someone who never asked is not.
    return false
  }
}

export function saveStartPageDismissed(dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(START_PAGE_KEY, 'dismissed')
    else localStorage.removeItem(START_PAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * When the feedback nudge last showed itself or was dismissed, as epoch milliseconds.
 *
 * `undefined` means "never" rather than 0 — a graph opened for the first time in 1970 is not a
 * real case, but a falsy sentinel that reads as "show it" on every load if storage is disabled
 * would be, since the alternative there is `undefined` too, and the two would be indistinguishable.
 */
export function loadFeedbackNudgeAt(): number | undefined {
  const raw = readLocal(FEEDBACK_NUDGE_KEY)
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) ? value : undefined
}

export function saveFeedbackNudgeAt(at: number): void {
  writeLocal(FEEDBACK_NUDGE_KEY, String(at))
}

export function applyTheme(preference: ThemePreference): void {
  if (preference === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = preference
  try {
    localStorage.setItem(THEME_KEY, preference)
  } catch {
    /* ignore */
  }
}
