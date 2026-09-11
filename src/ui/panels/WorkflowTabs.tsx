/**
 * The workflow switcher — the open documents, in the canvas's top-left corner.
 *
 * A React Flow `<Panel>` rather than a strip above the canvas, for the same reason the minimap is
 * one: it belongs to the graph surface, not to the shell, and the shell's rows are already spoken
 * for by the toolbar above and the status bar below. Top-left is the one corner of the pane that
 * nothing else claims — the controls rail and the minimap are both `bottom-left`, the add button
 * is bottom-right.
 *
 * **Collapsed it is one row, and that row still says which workflow you are in.** A switcher that
 * collapsed to a chevron would make the common case — one document — cost a click to answer "what
 * am I looking at", which the toolbar's name field already answers for free; the point of
 * collapsing is to take the *list* away, not the label.
 *
 * **A right-click opens a menu about one workflow** — the row's, or the active one's from the
 * header. Rename is here rather than left to the toolbar's name field because that field can only
 * reach the document on screen; Download likewise saves a background workflow without switching
 * to it first.
 *
 * Live under the lock, like `MinimapControl` and every dashboard action: the lock is about edits
 * landing on this graph, and looking at a different one is not an edit to this one. See
 * `graphStore`'s `switchDocument` for what a switch does and does not carry.
 */

import { Panel } from '@xyflow/react'
import { useState } from 'react'
import type { MouseEvent } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { downloadGraph } from '../export'
import { ContextMenu } from '../menu/ContextMenu'
import { RenameInput } from '../RenameInput'

/** A chevron that points down when the list is showing and right when it is not. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
      className="wf-tabs__chevron"
      data-open={open ? '' : undefined}
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The row's name as a field. Starts from the *stored* name rather than the row's label, which is
 * `'Untitled'` for a graph nobody named — opening on a word nobody typed would make renaming start
 * with deleting.
 */
function RenameField({ id, onDone }: { id: string; onDone: () => void }) {
  const renameDocument = useGraphStore((s) => s.renameDocument)
  return (
    <RenameInput
      className="wf-tabs__rename"
      label="Workflow name"
      placeholder="Untitled"
      initial={useGraphStore.getState().documentGraph(id)?.meta?.name ?? ''}
      onCommit={(name) => renameDocument(id, name)}
      onDone={onDone}
    />
  )
}

interface MenuState {
  at: { x: number; y: number }
  id: string
}

function WorkflowMenu({
  menu,
  onRename,
  onClose,
}: {
  menu: MenuState
  onRename: (id: string) => void
  onClose: () => void
}) {
  const tab = useGraphStore((s) => s.tabs.find((t) => t.id === menu.id))
  // The document can close under an open menu — a ✕ is a click away from the row it is on.
  if (!tab) return null

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const { duplicateDocument, documentGraph } = useGraphStore.getState()

  /*
   * Portalled because this renders inside a React Flow `<Panel>`, whose `z-index` is a stacking
   * context that would cap the menu's own. The canvas's other menus render outside `<ReactFlow>`.
   */
  return (
    <ContextMenu portal at={menu.at} onClose={onClose} label={`Workflow ${tab.name}`}>
      <div className="context-menu__caption">{tab.name}</div>
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => onRename(tab.id))}
      >
        Rename
      </button>
      <button
        type="button"
        className="context-menu__item"
        title="Open a copy beside this one, with its results"
        onClick={act(() => duplicateDocument(tab.id))}
      >
        Duplicate
      </button>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item"
        title="A file you can share, back up, or open on another machine"
        onClick={act(() => {
          const graph = documentGraph(tab.id)
          if (graph) downloadGraph(graph)
        })}
      >
        Download .coda.json
      </button>
    </ContextMenu>
  )
}

export function WorkflowTabs() {
  /*
   * `tabs` is a stored array rebuilt only when a row's name or the set of documents moves — see
   * `syncTabs`. Selecting it is therefore invariant 7-safe in the way selecting `graph.nodes`
   * would not be; the other three reads are primitives.
   */
  const tabs = useGraphStore((s) => s.tabs)
  const activeId = useGraphStore((s) => s.activeTabId)
  const open = useGraphStore((s) => s.panels.workflows)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const switchDocument = useGraphStore((s) => s.switchDocument)
  const closeDocument = useGraphStore((s) => s.closeDocument)
  const newWorkflow = useGraphStore((s) => s.newWorkflow)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  const active = tabs.find((tab) => tab.id === activeId)

  const openMenu = (id: string) => (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ at: { x: event.clientX, y: event.clientY }, id })
  }

  // The field lives in the list, so renaming from the collapsed header opens it first.
  const startRename = (id: string) => {
    if (!open) togglePanel('workflows')
    setRenaming(id)
  }

  return (
    <Panel position="top-left" className="wf-tabs nodrag nopan">
      <button
        type="button"
        className="wf-tabs__header"
        onClick={() => togglePanel('workflows')}
        onContextMenu={openMenu(activeId)}
        aria-expanded={open}
        title={open ? 'Hide the open workflows' : 'Show the open workflows'}
      >
        <Chevron open={open} />
        {/*
         * The active workflow's name while collapsed, a plain label once the list is showing —
         * where the same name is already a row, and the highlighted one. Repeating it read as
         * two controls for one thing.
         */}
        <span className="wf-tabs__title" data-generic={open ? '' : undefined}>
          {open ? 'Workflows' : (active?.name ?? 'Untitled')}
        </span>
        {tabs.length > 1 && <span className="wf-tabs__count">{tabs.length}</span>}
      </button>

      {open && (
        <>
          <ul className="wf-tabs__list">
            {tabs.map((tab) => (
              <li
                key={tab.id}
                className="wf-tabs__row"
                data-active={tab.id === activeId ? '' : undefined}
                onContextMenu={openMenu(tab.id)}
              >
                {renaming === tab.id ? (
                  <RenameField id={tab.id} onDone={() => setRenaming(null)} />
                ) : (
                  <button
                    type="button"
                    className="wf-tabs__pick"
                    onClick={() => switchDocument(tab.id)}
                    aria-current={tab.id === activeId ? 'true' : undefined}
                    title={tab.name}
                  >
                    {tab.name}
                  </button>
                )}
                {/*
                 * Offered even for the last document, which `closeDocument` answers by putting a
                 * fresh empty one in its place. Hiding the button there would be a control that
                 * disappears at the moment somebody wants "clear this and start over".
                 */}
                <button
                  type="button"
                  className="wf-tabs__close"
                  onClick={() => closeDocument(tab.id)}
                  title={`Close “${tab.name}”`}
                  aria-label={`Close ${tab.name}`}
                >
                  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                    <path
                      d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="wf-tabs__new" onClick={() => newWorkflow()}>
            + New workflow
          </button>
        </>
      )}

      {menu && (
        <WorkflowMenu menu={menu} onRename={startRename} onClose={() => setMenu(null)} />
      )}
    </Panel>
  )
}
