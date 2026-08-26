/**
 * Everything the command palette can do.
 *
 * Commands and node-insertions live in one flat list so a single fuzzy query reaches both
 * — typing "gr" should offer both "Group By" (a node) and nothing else competing, and
 * typing "cl" should reach "Clear Results". Keeping them in separate palettes would force
 * the user to know which kind of thing they want before they start typing.
 */

import type { CodaType } from '../../core/types'
import { isAssignable } from '../../core/types'
import { isAnnotation, nodeDefsByCategory } from '../../core/registry'
import type { GraphState } from '../../store/graphStore'
import { pickGraphFile } from '../../store/persistence'
import { downloadGraph, downloadNotebook, downloadRmd } from '../export'
import { canExportNotebook } from '../../export/canExport'
import { peekExportWarnings } from '../exportWarnings'
import { appElement, toggleFullscreen } from '../fullscreen'
import { TOURS, startTour } from '../tour/tourState'
import { LOCKED_HINT } from '../lockCopy'
import { EXAMPLES } from '../../examples'
import { plural } from '../format'
import { shortcutKeys } from '../shortcuts'

/**
 * Actions double as the palette's filter prefixes: typing `Add:` narrows the list to node
 * insertions. Keep them single words — they are what the user types.
 */
export const PALETTE_ACTIONS = [
  'Add',
  'Run',
  'Edit',
  'Graph',
  'View',
  'Example',
  'Help',
] as const
export type PaletteAction = (typeof PALETTE_ACTIONS)[number]

export interface PaletteItem {
  id: string
  /** First breadcrumb segment, and the `Action:` prefix that filters to it. */
  action: PaletteAction
  /** Second breadcrumb segment. Node items use their category; most commands omit it. */
  group?: string
  /** The emphasised segment — the thing being named. */
  label: string
  /** Final breadcrumb segment: what it does, or the node's description. */
  hint?: string
  /** Rendered right-aligned, e.g. "⇧R". Comes from `shortcutKeys`, never typed here. */
  shortcut?: string
  disabled?: boolean
  /**
   * Draws the hint as a caution rather than as description.
   *
   * Distinct from `disabled`, which means the row does nothing. This row works; what it is
   * about is merely incomplete, and a reader deciding whether to press it wants to know that
   * before rather than after.
   */
  warn?: boolean
  /** Node items only: the type to insert and the port to auto-connect. */
  nodeType?: string
  portId?: string
  /** Command items only. */
  perform?: () => void
}

/** Composite haystack so "table filter" or "add group" find the right row. */
export function paletteSearchText(item: PaletteItem): string {
  return [item.action, item.group, item.label].filter(Boolean).join(' ')
}

export interface CommandContext {
  store: GraphState
  fitView: () => void
  /** Frames the current selection; does nothing with nothing selected. See `ui/fitView.ts`. */
  fitSelected: () => void
}

/**
 * Node-insertion items, optionally filtered to those that can accept a dragged type.
 *
 * `locked` disables every row rather than dropping them. A palette that answers "find neurons"
 * with nothing at all reads as a broken search — a list of greyed rows saying why reads as the
 * lock, which is what it is.
 */
export function buildNodeItems(
  filter?: {
    type: CodaType
    from: 'source' | 'target'
  },
  locked = false,
): PaletteItem[] {
  const items: PaletteItem[] = []

  for (const { category, defs } of nodeDefsByCategory()) {
    for (const def of defs) {
      let portId: string | undefined
      if (filter) {
        /*
         * Dragging from an output needs a compatible input on the new node, and vice versa.
         *
         * An `any` *output* is excluded from the second case, and the asymmetry is the point.
         * `any` on an input means "I accept whatever you have", which is a real answer to
         * "what could this feed?" — `out.download` genuinely takes anything. `any` on an
         * output means "whatever I was given": a pass-through cannot *originate* a Dataset,
         * so offering it when dragging back from a Dataset socket answers the question with a
         * node that would need the same question asked again behind it.
         */
        const ports =
          filter.from === 'source'
            ? (def.inputs ?? []).filter((p) => isAssignable(filter.type, p.type))
            : (def.outputs ?? []).filter(
                (p) => p.type.kind !== 'any' && isAssignable(p.type, filter.type),
              )
        portId = ports[0]?.id
        if (!portId) continue
      } else {
        portId = (def.outputs ?? [])[0]?.id ?? ''
      }

      items.push({
        id: `node:${def.type}`,
        action: 'Add',
        group: categoryLabel(category),
        label: def.label,
        ...(locked
          ? { hint: LOCKED_HINT, disabled: true }
          : def.description
            ? { hint: def.description }
            : {}),
        nodeType: def.type,
        portId,
      })
    }
  }

  return items
}

/** Commands, in the order they should appear when the query is empty. */
export function buildCommandItems(ctx: CommandContext): PaletteItem[] {
  const { store, fitView, fitSelected } = ctx
  const selection = store.selection
  const single = selection.length === 1 ? selection[0] : undefined
  const staleCount = store.graph.nodes.filter((n) => store.needsRun(n.id)).length
  const selectedNode = single ? store.graph.nodes.find((n) => n.id === single) : undefined
  /*
   * A text note is selectable like any node, and none of the evaluation commands mean anything
   * for it. `disabled` flags on this list are honest about live state everywhere else; leaving
   * "Run Selected Node" lit for a paragraph of prose would be the one place they are not.
   */
  const annotated = selectedNode !== undefined && isAnnotation(selectedNode.type)
  const computable = single !== undefined && !annotated
  /*
   * Asked once per format, up front. `buildCommandItems` runs on every store change, so this
   * deliberately comes from `canExport` rather than from the exporter — importing the latter to
   * answer a question about a menu row would put every emitter in the main chunk.
   *
   * Two answers rather than one: the exporters no longer cover the same backends, so a FlyWire
   * graph offers the notebook and refuses the R document.
   */
  const notebookRefusal = canExportNotebook(store.graph, 'python')
  const rmdRefusal = canExportNotebook(store.graph, 'r')
  /*
   * The softer question beside the refusal: how much of the graph the walk cannot translate.
   * Only the peek is called here — it is a cache read, where the *request* runs the real
   * exporter and is made once, from the palette opening. This function runs on every store
   * change while the palette is open.
   */
  const notebookWarning = peekExportWarnings(store.graph, 'python')
  const rmdWarning = peekExportWarnings(store.graph, 'r')
  /*
   * The lock, on every row it covers — nothing that moves a card, restructures the graph or
   * moves the viewport. Deliberately *not* on Run, Clear Results, Mute, Collapse, Expand,
   * Open/Save/Share or the exports: none of those is a canvas edit, and a lock that quietly
   * stopped a run would be a different feature. `GraphState.locked` has the full list.
   */
  const locked = store.locked

  const items: PaletteItem[] = [
    {
      id: 'cmd:run-all',
      label: 'Run All',
      action: 'Run',
      hint:
        staleCount > 0
          ? `Evaluate ${plural(staleCount, 'stale node')}`
          : 'Everything is already up to date',
      shortcut: shortcutKeys('run-all'),
      disabled: staleCount === 0 || store.busy,
      perform: () => void store.runAll(),
    },
    {
      id: 'cmd:run-selected',
      label: 'Run Selected Node',
      action: 'Run',
      hint: annotated
        ? 'A text note is never evaluated'
        : single
          ? 'Evaluate this node and whatever it needs'
          : 'Select a single node first',
      disabled: !computable || store.busy,
      perform: () => {
        if (single) void store.runNode(single)
      },
    },
    {
      id: 'cmd:cancel',
      label: 'Cancel Run',
      action: 'Run',
      hint: 'Abort the run in progress',
      disabled: !store.busy,
      perform: () => store.cancelRun(),
    },
    {
      id: 'cmd:clear-results',
      label: 'Clear Results',
      action: 'Run',
      hint: 'Drop every cached result so the next run re-fetches from scratch',
      disabled: store.busy,
      perform: () => store.clearResults(),
    },

    {
      id: 'cmd:undo',
      label: 'Undo',
      action: 'Edit',
      shortcut: shortcutKeys('undo'),
      ...(locked ? { hint: LOCKED_HINT } : {}),
      disabled: locked || store.past.length === 0,
      perform: () => store.undo(),
    },
    {
      id: 'cmd:redo',
      label: 'Redo',
      action: 'Edit',
      shortcut: shortcutKeys('redo'),
      ...(locked ? { hint: LOCKED_HINT } : {}),
      disabled: locked || store.future.length === 0,
      perform: () => store.redo(),
    },
    {
      id: 'cmd:duplicate',
      label: 'Duplicate Selection',
      action: 'Edit',
      shortcut: shortcutKeys('duplicate'),
      ...(locked ? { hint: LOCKED_HINT } : {}),
      disabled: locked || selection.length === 0,
      perform: () => store.duplicateSelection(),
    },
    {
      id: 'cmd:mute',
      label: selectedNode?.disabled ? 'Unmute Selection' : 'Mute Selection',
      action: 'Edit',
      hint: 'Muted nodes produce nothing and stop their downstream chain',
      shortcut: shortcutKeys('mute'),
      disabled: selection.length === 0,
      perform: () => store.toggleDisabled(selection),
    },
    {
      id: 'cmd:collapse',
      label: selectedNode?.collapsed ? 'Expand Selection' : 'Collapse Selection',
      action: 'Edit',
      shortcut: shortcutKeys('collapse'),
      disabled: selection.length === 0,
      perform: () => store.toggleCollapsed(selection),
    },
    {
      id: 'cmd:fold-params',
      label: selectedNode?.paramsCollapsed
        ? 'Show Parameters & Ports'
        : 'Hide Parameters & Ports',
      action: 'Edit',
      hint: 'Fold the parameter and port rows away, leaving the header, the body and the result',
      disabled: selection.length === 0,
      perform: () => store.toggleParamRows(selection),
    },
    {
      id: 'cmd:delete',
      label: 'Delete Selection',
      action: 'Edit',
      shortcut: shortcutKeys('delete'),
      ...(locked ? { hint: LOCKED_HINT } : {}),
      disabled: locked || selection.length === 0,
      perform: () => store.deleteNodes(selection),
    },

    {
      id: 'cmd:new',
      label: 'New Graph',
      action: 'Graph',
      hint: 'Start from an empty canvas',
      perform: () => store.newGraph(),
    },
    {
      id: 'cmd:open',
      label: 'Open Graph…',
      action: 'Graph',
      hint: 'Load a .coda.json file',
      perform: () => {
        void pickGraphFile().then((result) => {
          if (result) store.loadGraph(result.graph, result.warnings)
        })
      },
    },
    {
      id: 'cmd:save',
      label: 'Save Graph',
      action: 'Graph',
      hint: 'Download this graph as .coda.json',
      perform: () => downloadGraph(store.graph),
    },
    {
      id: 'cmd:share',
      label: 'Share Workflow…',
      action: 'Graph',
      /*
       * Never disabled, unlike the two exports below it. An empty canvas is a perfectly
       * shareable graph — somebody sending a colleague a blank workspace on a particular
       * dataset is a real thing to do — and the dialog says what a link does not carry rather
       * than refusing to make one.
       */
      hint: 'Make a link that opens this graph — in the link itself, or via a gist',
      perform: () => store.requestShare(),
    },
    {
      id: 'cmd:export-notebook',
      label: 'Export as Jupyter Notebook',
      action: 'Graph',
      /*
       * The refusal lands in `disabled` and the hint rather than in a message after the click,
       * which is the one real difference from the same item in the Save menu. A menu has room
       * to answer back; the palette closes on pick, so a lit row that did nothing would be the
       * one place these flags stop being honest about live state — and on a bundled example,
       * which is every synthetic graph anyone starts from, it is the *usual* state rather than
       * an edge case.
       */
      hint: notebookRefusal
        ? `${notebookRefusal.reason} — ${notebookRefusal.fix}`
        : (notebookWarning?.short ??
          'Download this graph as a Jupyter notebook (neuprint-python, pandas, navis)'),
      disabled: notebookRefusal !== undefined,
      warn: notebookRefusal === undefined && notebookWarning !== undefined,
      perform: () => void downloadNotebook(store.graph, { appVersion: __APP_VERSION__ }),
    },
    {
      id: 'cmd:export-rmd',
      label: 'Export as R Markdown',
      action: 'Graph',
      hint: rmdRefusal
        ? `${rmdRefusal.reason} — ${rmdRefusal.fix}`
        : (rmdWarning?.short ?? 'Download this graph as an .Rmd (neuprintr, dplyr, nat)'),
      disabled: rmdRefusal !== undefined,
      warn: rmdRefusal === undefined && rmdWarning !== undefined,
      perform: () => void downloadRmd(store.graph, { appVersion: __APP_VERSION__ }),
    },

    {
      id: 'cmd:browse-nodes',
      action: 'Add',
      label: 'Browse All Nodes…',
      hint: locked ? LOCKED_HINT : 'Open the node browser, with previews and category filters',
      disabled: locked,
      shortcut: shortcutKeys('browse-nodes'),
      perform: () => store.requestNodeBrowser(),
    },
    {
      id: 'cmd:expand',
      action: 'View',
      label: 'Expand Selected Output',
      hint: annotated
        ? 'A text note has no result to open'
        : single
          ? 'Open this result full size'
          : 'Select a single node first',
      disabled: !computable,
      perform: () => {
        if (single) store.expandNode(single)
      },
    },
    {
      id: 'cmd:fit',
      label: 'Fit View',
      action: 'View',
      hint: locked ? LOCKED_HINT : 'Zoom to show the whole graph',
      /*
       * `§` sits on whichever of these two rows it would actually run right now: the key frames
       * the selection when there is one and the whole graph when there is not, so a badge that
       * stayed put would be advertising the wrong fit half the time. The list is rebuilt on every
       * store change, which is what lets a shortcut move like this — the same thing that keeps
       * the `disabled` flags honest.
       */
      ...(selection.length === 0 ? { shortcut: shortcutKeys('fit') } : {}),
      disabled: locked,
      perform: fitView,
    },
    {
      id: 'cmd:fit-selected',
      label: 'Fit Selected',
      action: 'View',
      hint: locked
        ? LOCKED_HINT
        : selection.length
          ? 'Zoom to show what is selected'
          : 'Select a node first',
      ...(selection.length > 0 ? { shortcut: shortcutKeys('fit') } : {}),
      disabled: locked || selection.length === 0,
      perform: fitSelected,
    },
    {
      /*
       * A toggle, so one row that says which way it goes rather than a pair. Under `View`
       * beside the fits: what it is chiefly about is the canvas staying where you put it.
       */
      id: 'cmd:lock',
      label: locked ? 'Unlock Canvas' : 'Lock Canvas',
      action: 'View',
      hint: locked
        ? 'Let the canvas pan, zoom, drag and rewire again'
        : 'Freeze the view, the cards and the wiring — params and Run carry on',
      perform: () => store.toggleLocked(),
    },
    {
      id: 'cmd:fullscreen',
      action: 'View',
      label: 'Toggle Fullscreen',
      hint: "Fill the screen, hiding the browser's own tabs and address bar",
      shortcut: shortcutKeys('fullscreen'),
      // No `disabled` state to compute: whether the browser will grant it is not knowable
      // until it is asked, and a command greyed out on a guess is worse than one refused.
      perform: () => void toggleFullscreen(appElement()),
    },
    {
      id: 'cmd:theme-dark',
      action: 'View',
      group: 'Theme',
      label: 'Dark',
      disabled: store.theme === 'dark',
      perform: () => store.setTheme('dark'),
    },
    {
      id: 'cmd:theme-light',
      action: 'View',
      group: 'Theme',
      label: 'Light',
      disabled: store.theme === 'light',
      perform: () => store.setTheme('light'),
    },
    {
      id: 'cmd:theme-system',
      action: 'View',
      group: 'Theme',
      label: 'Follow System',
      disabled: store.theme === 'system',
      perform: () => store.setTheme('system'),
    },
  ]

  items.push(
    /*
     * Above Welcome and Shortcuts, on the same reasoning as their place in the `?` menu: of
     * everything under Help these are the only entries that answer "which button do I press",
     * and the palette is often the first thing somebody who is lost reaches for. Labels and
     * blurbs come from `TOURS` so this surface cannot drift from the other two.
     */
    ...TOURS.map((tour) => ({
      id: `cmd:tour:${tour.id}`,
      action: 'Help' as const,
      label: tour.label,
      hint: tour.blurb,
      perform: () => {
        void startTour(tour.id)
      },
    })),
    {
      id: 'cmd:shortcuts',
      action: 'Help',
      label: 'Keyboard Shortcuts',
      hint: 'Every key and canvas gesture, on one card',
      perform: () => store.requestShortcuts(),
    },
    {
      id: 'cmd:welcome',
      action: 'Help',
      label: 'Welcome to Coda',
      hint: 'The start page: what this is, and a few places to begin',
      disabled: store.startPageOpen,
      perform: () => store.openStartPage(),
    },
    {
      id: 'cmd:report-issue',
      action: 'Help',
      label: 'Report an Issue on GitHub',
      hint: 'Bugs and feature requests, in the open',
      perform: () => {
        window.open('https://github.com/navis-org/coda/issues', '_blank', 'noreferrer,noopener')
      },
    },
    {
      id: 'cmd:docs',
      action: 'Help',
      label: 'Documentation',
      hint: 'The docs folder in the repository',
      perform: () => {
        window.open(
          'https://github.com/navis-org/coda/tree/main/docs',
          '_blank',
          'noreferrer,noopener',
        )
      },
    },
  )

  items.push({
    id: 'zoo:browse',
    label: 'Browse Community Workflows',
    action: 'Example',
    hint: 'Search the Coda Zoo — workflows shared by other people.',
    perform: () => store.openZoo(),
  })

  for (const example of EXAMPLES) {
    items.push({
      id: `example:${example.id}`,
      label: example.name,
      action: 'Example',
      hint: example.summary,
      perform: () => store.loadExample(example.id),
    })
  }

  return items
}

function categoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}
