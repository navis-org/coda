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
/** Which of this tab's open workflows was on screen — see `loadActiveDocId`. */
const ACTIVE_DOC_KEY = 'coda.doc.v1'
const THEME_KEY = 'coda.theme.v1'
const PANELS_KEY = 'coda.panels.v1'
const AUTORUN_KEY = 'coda.autorun.v1'
const NOTIFY_KEY = 'coda.notify.v1'
const START_PAGE_KEY = 'coda.startPage.v1'
/**
 * The first-run guides dialog: whether it has ever been shown, and which guides were finished.
 *
 * Two keys rather than one object, because the two have nothing to do with each other's
 * lifetime. The first is written once, on the first visit, and never read for anything else;
 * the second grows as guides are completed and outlives the dialog that shows it.
 */
/**
 * Whether the Workflow Wizard writes explanatory notes onto the canvas.
 *
 * On unless somebody has said otherwise, so the key holds only the opt-out — a statement about
 * how this reader likes their canvas rather than about any one workflow, which is why it is
 * remembered at all.
 */
const WIZARD_NOTES_KEY = 'coda.wizardNotes.v1'
/**
 * Whether a generated workflow opens on the dashboard rather than the canvas.
 *
 * Its own key rather than a field beside the notes one, for the reason the two keys next to it
 * are separate: a preference is read once at init and cached, and one key holding two answers
 * means a tab that writes one clobbers the other's in-flight value.
 */
const WIZARD_DASHBOARD_KEY = 'coda.wizardDashboard.v1'
const GUIDES_SEEN_KEY = 'coda.guidesSeen.v1'
const GUIDES_DONE_KEY = 'coda.guidesDone.v1'
const LAYOUT_KEY = 'coda.layout.v1'
/** When the feedback nudge was last shown or dismissed, so it can wait a week before the next. */
const FEEDBACK_NUDGE_KEY = 'coda.feedbackNudge.v1'

/**
 * How many slots may exist at once, and the total they may occupy between them.
 *
 * Both bounds rather than one, because the two failure shapes are different, and the gap between
 * them is four orders of magnitude. An ordinary workflow is **3–6 kB** — the nine the wizard
 * builds measure 2,984 to 6,279 characters — so six of those is nothing. A graph carrying an
 * Explore selection is the other end: a CAVE root id costs ~32 characters of serialised param, so
 * 25,000 of them (`SELECT_ALL_WARN`, which warns rather than capping) is **782 kB in one node**
 * and two such slots are the whole allowance.
 *
 * The origin's budget is **exactly 5 MiB**, measured rather than assumed — 5,242,880, reached
 * within a kilobyte on Chromium, Firefox and WebKit alike. The shared key holds one more copy of
 * the active graph on top of the slots, which is why they get a fraction rather than all of it.
 *
 * Counted in UTF-16 code units, which is what `String.length` answers and what Chromium and
 * Firefox charge. WebKit charges *bytes* and stores Latin-1 in one each, so an ASCII graph gets
 * the same room there and a graph whose names are not Latin-1 gets half. Graph JSON is ASCII
 * apart from what a user types into a name or a note.
 *
 * All of the above: `scripts/probe-autosave-budget.ts` for the graph sizes, and the quota probe
 * written up in [docs/persistence.md](../../docs/persistence.md).
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
 *
 * Exported rather than wrapped, because "which tab am I" has to have exactly one *spelling* as
 * well as one answer — the session store in `session.ts` keys its records by this, and the two
 * are halves of one crash net. A shim is how a symbol acquires a second name.
 */
export function tabId(): string | undefined {
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

/**
 * Which document was on screen, so a reload comes back to it rather than to whichever one the
 * session store happens to list first.
 *
 * In `sessionStorage` beside the tab id and for its three properties — per tab, survives a
 * reload, restored with the tab after a crash — and **synchronous**, which is the whole reason it
 * is not simply a field on the session record. `loadAutosave` gives the boot its graph in the
 * store's initialiser; this gives that graph its *identity* in the same tick, so the document the
 * session store restores around it a moment later slots in beside an id that already exists
 * rather than replacing one that was minted fresh.
 *
 * A duplicated tab copies this along with the tab id, exactly as it copies everything else in
 * `sessionStorage`. That is harmless: session records are keyed by tab *and* document, and
 * `watchTabIdentity` is what moves the tab half apart.
 */
export function loadActiveDocId(): string | undefined {
  try {
    return sessionStorage.getItem(ACTIVE_DOC_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function saveActiveDocId(id: string): void {
  try {
    sessionStorage.setItem(ACTIVE_DOC_KEY, id)
  } catch {
    /* Private mode, or a suite under plain Node. A reload then starts on a fresh id. */
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
 * half. It is **returned**, so the session store can put the same string in IndexedDB without
 * serialising a second time — and, more to the point, so the two copies of a document cannot be
 * two different serialisations of it.
 *
 * **`compact`, unlike every other caller of `serializeGraph`.** The default two-space indentation
 * is 34% of the output (measured on both an ordinary workflow and a 25,000-id selection —
 * `scripts/probe-autosave-budget.ts`) and is worth exactly nothing in a storage slot: everything
 * that reads this goes through `deserializeGraph`, which is `JSON.parse`. The paths where a human
 * reads the file — `Download .coda.json`, the gist, the shelf — stay pretty. What the one function
 * protects is that a format change lands in every path at once, and passing an option to it does
 * not weaken that; byte-identity across paths was never a property anyway, since `serializeGraph`
 * stamps a fresh wall-clock `modifiedAt` on every call.
 */
export function saveAutosave(graph: CodaGraph): string {
  const json = serializeGraph(graph, { compact: true })
  // Quota, or a privacy mode that blocks storage. Losing the autosave is survivable; breaking
  // the editor over it is not.
  writeLocal(AUTOSAVE_KEY, json)

  const id = tabId()
  if (!id) return json

  // Prune *before* writing, or the save that overruns the budget is the one nothing made room
  // for.
  const index = pruneSlots(id, json.length)
  writeLocal(SLOT_INDEX_KEY, JSON.stringify(index))
  if (writeLocal(slotKey(id), json)) return json

  // The slot was refused where the shared key was not — a graph over the remaining quota. Take
  // the claim back rather than leaving the index asserting bytes that do not exist. The shared
  // copy stands, so this tab still has a crash net, just the coarser one.
  delete index[id]
  removeLocal(slotKey(id))
  writeLocal(SLOT_INDEX_KEY, JSON.stringify(index))
  return json
}

/**
 * The graph to open on: this tab's own where it has one, the most recent from any tab if not.
 *
 * The fallback is what keeps the ordinary case working — close the app, come back tomorrow, and
 * the last thing you were doing is still there. It is also the entire degradation path: no
 * `sessionStorage`, an evicted slot, and an autosave written by a build from before slots
 * existed all land on it, and every one of them gets exactly the behaviour this file had then.
 */
export function loadAutosave():
  { graph: CodaGraph; warnings: string[]; fromSlot: boolean } | undefined {
  const id = tabId()
  const own = id ? readLocal(slotKey(id)) : undefined
  const raw = own ?? readLocal(AUTOSAVE_KEY)
  if (!raw) return undefined
  try {
    /*
     * **Which of the two answered is part of the answer**, and it is not bookkeeping.
     *
     * `false` means this tab's own slot was gone — evicted past `MAX_SLOTS`, or never written —
     * and what came back is the most recent graph from *some* tab, which may be somebody else's
     * work. That was a complete answer while a tab held one workflow. It is not one now: the
     * session store may still hold this tab's own copy of the very document being restored, and
     * without this flag the store would boot the right *set* of workflows around a foreign graph
     * standing in for one of them. Measured in a browser with eight tabs open, which is the
     * threshold: `['T0-A', 'T7-B']`, under T0's own document id. See `restoreSession`.
     */
    return { ...deserializeGraph(raw), fromSlot: own !== undefined }
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
   * The full-size viewer's styling sidebar. Unlike the other two this defaults **open**: a
   * full-size viewer is opened deliberately, and the controls are most of the reason to open
   * one — the canvas argument above is about a panel that takes room before anybody has asked
   * for anything, which this does not.
   *
   * **One boolean for both surfaces**, so toggling it in the dock also toggles it in the
   * overlay. That is the intended reading — it is a preference about styling controls, not
   * about a panel — but it is worth knowing before adding a third surface that would want its
   * own answer. What the dock does need is `.viewer-surface .overlay__style`'s width cap: 268px
   * is a fraction of an overlay and most of a dock somebody has dragged narrow.
   */
  style: boolean
  /**
   * The workflow switcher in the canvas's top-left corner.
   *
   * Defaults **open**, unlike the inspector and the minimap, and for `style`'s reason inverted:
   * those two take a column or a corner from the canvas before anybody has asked for anything,
   * where this is a single row naming the workflow you are looking at — and it is the only thing
   * on screen that says a second one can be open at all. Collapsing it is one click, and sticks.
   */
  workflows: boolean
}

export const DEFAULT_PANELS: PanelState = {
  inspector: false,
  minimap: false,
  assistant: false,
  style: true,
  workflows: true,
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
      // Note the inverted test: absent means open for these two, and a build written before
      // the key existed must not read as "the user closed it".
      style: held.style !== false,
      workflows: held.workflows !== false,
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

/*
 * How wide the pinned viewer dock is.
 *
 * **A fraction, not a pixel count**, and that is the only interesting decision here. The dock is
 * a share of the window — "give the scene half the screen and keep the graph in the other half"
 * is the whole request — so a stored 700px is right on the display it was set on and wrong on
 * every other one, most sharply when the same person opens the app on a laptop after setting it
 * on a desktop. A fraction survives that, survives a window resize, and needs no clamping pass
 * against a viewport width nobody has measured yet at load time.
 *
 * It goes in its own key rather than into `PanelState`, which is a record of booleans that
 * `togglePanel` indexes by `keyof` — a number in there would be togglable.
 *
 * **Which node is pinned is deliberately not stored anywhere.** It is a node id, and a node id
 * outlives nothing: the next graph loaded has different ones, so a remembered pin would open the
 * dock on a node that does not exist, or worse, on an unrelated node that happens to share the
 * id. Session state in the store, and no further.
 */
const DOCK_KEY = 'coda.dock.v1'

/**
 * The bounds, and the two are about different things.
 *
 * `DOCK_MAX_FRACTION` protects the *canvas*: past 70% the graph is a strip. `DOCK_MIN_PX`
 * protects the *dock*, and it is in pixels because a viewer plus its 268px styling sidebar does
 * not get more possible on a smaller display — below 360px the panel is a legend and a
 * scrollbar. `DOCK_MIN_FRACTION` is only the backstop for a window whose width nobody has
 * measured yet (a value read back from storage before layout), which is why every caller that
 * *has* a width passes it: a floor the store does not know about is a floor `aria-valuenow`
 * lies about, announcing 20% for a dock the grid is rendering at 25%.
 */
export const DOCK_MIN_FRACTION = 0.2
export const DOCK_MAX_FRACTION = 0.7
export const DOCK_MIN_PX = 360

/**
 * Half the window.
 *
 * The literal shape of the request this was built for — a scene down one side, the graph down
 * the other — and the only default that needs no explanation the first time somebody pins
 * something. The grip is there for anyone who wants a different split.
 */
export const DEFAULT_DOCK_FRACTION = 0.5

/**
 * `totalPx` is the width the fraction will be resolved against, when the caller knows it. Given
 * one, the pixel floor becomes part of the answer, so what is stored is what gets laid out.
 */
export function clampDockFraction(fraction: number, totalPx?: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_DOCK_FRACTION
  const floor =
    totalPx && totalPx > 0
      ? Math.min(DOCK_MAX_FRACTION, Math.max(DOCK_MIN_FRACTION, DOCK_MIN_PX / totalPx))
      : DOCK_MIN_FRACTION
  return Math.min(DOCK_MAX_FRACTION, Math.max(floor, fraction))
}

export function loadDockFraction(): number {
  const raw = readLocal(DOCK_KEY)
  return raw ? clampDockFraction(Number.parseFloat(raw)) : DEFAULT_DOCK_FRACTION
}

/** Clamped by `setDockFraction`, which is the only caller and the only place that can be. */
export function saveDockFraction(fraction: number): void {
  writeLocal(DOCK_KEY, String(fraction))
}

// ---------------------------------------------------------------------------
// Auto-run
// ---------------------------------------------------------------------------

/**
 * Whether every edit re-runs the whole graph.
 *
 * **On by default, and absence is what carries that.** The key is only ever written by the
 * checkbox, so a profile that has never touched it has nothing stored — which is the new-profile
 * case and reads as on. Only an explicit `'false'` turns it off, which is why this cannot be the
 * `=== 'true'` test its neighbours use: that spelling would make a fresh profile and a deliberate
 * opt-out indistinguishable.
 *
 * The cost is real and is invariant 6's: expensive nodes hit a shared production Neo4j, so on
 * means a query per edit (debounced to one per `AUTO_FULL_RUN_DELAY_MS`) rather than one per Run.
 * The checkbox beside Run is the opt-out, and it is remembered.
 */
export function loadAutoRun(): boolean {
  try {
    return localStorage.getItem(AUTORUN_KEY) !== 'false'
  } catch {
    return true
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

// ---------------------------------------------------------------------------
// The Workflow Wizard
// ---------------------------------------------------------------------------

/**
 * Whether generated workflows arrive with their notes.
 *
 * `!== 'false'` rather than `=== 'true'`, the same spelling `loadAutoRun` uses and for the same
 * reason: nothing is stored until the checkbox is touched, so absence has to read as the default
 * rather than as a deliberate no.
 */
export function loadWizardNotes(): boolean {
  return readLocal(WIZARD_NOTES_KEY) !== 'false'
}

export function saveWizardNotes(enabled: boolean): void {
  writeLocal(WIZARD_NOTES_KEY, String(enabled))
}

/**
 * Whether a generated workflow opens into the grid.
 *
 * `=== 'true'` — off until asked for, which is the opposite spelling to the notes above and the
 * opposite default for a reason. A note explains the graph somebody just generated and costs
 * nothing to ignore; the dashboard *replaces the view they are in*, and a first workflow that
 * opened somewhere other than the canvas would be answering a question about the app before the
 * reader had one.
 */
export function loadWizardDashboard(): boolean {
  return readLocal(WIZARD_DASHBOARD_KEY) === 'true'
}

export function saveWizardDashboard(enabled: boolean): void {
  writeLocal(WIZARD_DASHBOARD_KEY, String(enabled))
}

// ---------------------------------------------------------------------------
// The guides dialog
// ---------------------------------------------------------------------------

/**
 * Has the first-run guides dialog ever been on screen?
 *
 * The one thing that makes it a *first-run* dialog: written the moment it is shown, and never
 * cleared. Not "dismissed" and not "all guides done" — either of those would have it come back
 * for somebody who closed it on purpose, which is the whole difference from the start page.
 *
 * Storage disabled reads as never shown, so the dialog appears on every visit instead of never —
 * the same bargain `loadStartPageDismissed` makes, and the same reason: suppressing an
 * introduction for somebody who never asked us to is the worse of the two failures.
 */
export function loadGuidesSeen(): boolean {
  return readLocal(GUIDES_SEEN_KEY) === 'seen'
}

export function saveGuidesSeen(): void {
  writeLocal(GUIDES_SEEN_KEY, 'seen')
}

/**
 * The guides finished to their last step, as the ids `TOURS` uses.
 *
 * Ids rather than a count, so a guide added later starts unticked instead of arriving already
 * marked done. Nothing here validates them against `TOURS`: the dialog iterates the table and
 * asks whether each id is in this list, so an entry left behind by a renamed guide is invisible
 * rather than wrong — and this module has no business importing the tour table to find out.
 *
 * Anything that is not an array of strings reads as none. A corrupt key means unticked
 * checkmarks, which is a cosmetic loss; throwing here would take the store's creation with it.
 */
export function loadGuidesDone(): string[] {
  const raw = readLocal(GUIDES_DONE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function saveGuidesDone(ids: readonly string[]): void {
  writeLocal(GUIDES_DONE_KEY, JSON.stringify(ids))
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
