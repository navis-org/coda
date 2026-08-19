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
import { downloadGraph } from '../export'
import { EXAMPLES } from '../../examples'
import { plural } from '../format'

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
  /** Rendered right-aligned, e.g. "⇧R". */
  shortcut?: string
  disabled?: boolean
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
}

/** Node-insertion items, optionally filtered to those that can accept a dragged type. */
export function buildNodeItems(filter?: {
  type: CodaType
  from: 'source' | 'target'
}): PaletteItem[] {
  const items: PaletteItem[] = []

  for (const { category, defs } of nodeDefsByCategory()) {
    for (const def of defs) {
      let portId: string | undefined
      if (filter) {
        // Dragging from an output needs a compatible input on the new node, and vice versa.
        const ports =
          filter.from === 'source'
            ? (def.inputs ?? []).filter((p) => isAssignable(filter.type, p.type))
            : (def.outputs ?? []).filter((p) => isAssignable(p.type, filter.type))
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
        ...(def.description ? { hint: def.description } : {}),
        nodeType: def.type,
        portId,
      })
    }
  }

  return items
}

/** Commands, in the order they should appear when the query is empty. */
export function buildCommandItems(ctx: CommandContext): PaletteItem[] {
  const { store, fitView } = ctx
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

  const items: PaletteItem[] = [
    {
      id: 'cmd:run-all',
      label: 'Run All',
      action: 'Run',
      hint:
        staleCount > 0
          ? `Evaluate ${plural(staleCount, 'stale node')}`
          : 'Everything is already up to date',
      shortcut: '⇧R',
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
      shortcut: '⌘Z',
      disabled: store.past.length === 0,
      perform: () => store.undo(),
    },
    {
      id: 'cmd:redo',
      label: 'Redo',
      action: 'Edit',
      shortcut: '⇧⌘Z',
      disabled: store.future.length === 0,
      perform: () => store.redo(),
    },
    {
      id: 'cmd:duplicate',
      label: 'Duplicate Selection',
      action: 'Edit',
      shortcut: '⌘D',
      disabled: selection.length === 0,
      perform: () => store.duplicateSelection(),
    },
    {
      id: 'cmd:mute',
      label: selectedNode?.disabled ? 'Unmute Selection' : 'Mute Selection',
      action: 'Edit',
      hint: 'Muted nodes produce nothing and stop their downstream chain',
      shortcut: 'M',
      disabled: selection.length === 0,
      perform: () => store.toggleDisabled(selection),
    },
    {
      id: 'cmd:collapse',
      label: selectedNode?.collapsed ? 'Expand Selection' : 'Collapse Selection',
      action: 'Edit',
      shortcut: 'H',
      disabled: selection.length === 0,
      perform: () => store.toggleCollapsed(selection),
    },
    {
      id: 'cmd:fold-params',
      label: selectedNode?.paramsCollapsed ? 'Show Parameters' : 'Hide Parameters',
      action: 'Edit',
      hint: 'Fold the parameter rows away, leaving the ports, the result and the header',
      disabled: selection.length === 0,
      perform: () => store.toggleParamRows(selection),
    },
    {
      id: 'cmd:delete',
      label: 'Delete Selection',
      action: 'Edit',
      shortcut: '⌫',
      disabled: selection.length === 0,
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
      id: 'cmd:browse-nodes',
      action: 'Add',
      label: 'Browse All Nodes…',
      hint: 'Open the node browser, with previews and category filters',
      shortcut: 'Tab',
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
      hint: 'Zoom to show the whole graph',
      perform: fitView,
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
