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
 * Live under the lock, like `MinimapControl` and every dashboard action: the lock is about edits
 * landing on this graph, and looking at a different one is not an edit to this one. See
 * `graphStore`'s `switchDocument` for what a switch does and does not carry.
 */

import { Panel } from '@xyflow/react'

import { useGraphStore } from '../../store/graphStore'

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

  const active = tabs.find((tab) => tab.id === activeId)

  return (
    <Panel position="top-left" className="wf-tabs nodrag nopan">
      <button
        type="button"
        className="wf-tabs__header"
        onClick={() => togglePanel('workflows')}
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
              >
                <button
                  type="button"
                  className="wf-tabs__pick"
                  onClick={() => switchDocument(tab.id)}
                  aria-current={tab.id === activeId ? 'true' : undefined}
                  title={tab.name}
                >
                  {tab.name}
                </button>
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
    </Panel>
  )
}
