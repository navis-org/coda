/**
 * Local persistence and file I/O.
 *
 * The graph file is the document, so "save" is a download and "open" is a file picker —
 * no server, no accounts. localStorage holds an autosave of the working graph so a
 * refresh doesn't lose work; it is a crash net, not a project store.
 */

import type { CodaGraph } from '../core/graph'
import { deserializeGraph, serializeGraph } from '../core/graph'
import type { EdgeRouting, LayoutOptions } from '../layout/options'
import { DEFAULT_LAYOUT_OPTIONS, EDGE_ROUTINGS, coerceLayoutOptions } from '../layout/options'

const AUTOSAVE_KEY = 'coda.autosave.v1'
const THEME_KEY = 'coda.theme.v1'
const PANELS_KEY = 'coda.panels.v1'
const AUTORUN_KEY = 'coda.autorun.v1'
const START_PAGE_KEY = 'coda.startPage.v1'
const LAYOUT_KEY = 'coda.layout.v1'

export function saveAutosave(graph: CodaGraph): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeGraph(graph))
  } catch {
    // Quota or a privacy mode that blocks storage. Losing the autosave is survivable;
    // breaking the editor over it is not.
  }
}

export function loadAutosave(): { graph: CodaGraph; warnings: string[] } | undefined {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (!raw) return undefined
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

export function applyTheme(preference: ThemePreference): void {
  if (preference === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = preference
  try {
    localStorage.setItem(THEME_KEY, preference)
  } catch {
    /* ignore */
  }
}
