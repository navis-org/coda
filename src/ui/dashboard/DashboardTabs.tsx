/**
 * The dashboard's tab strip: the pages of one workflow's grid, in the bar where the title was.
 *
 * A tab is a page of the same graph, not a second document — `WorkflowTabs` is the switcher for
 * those, and the two never share a row. What lives here is which page is on screen, and the
 * gestures that change the set: `+` appends, a double-click renames, a right-click offers the
 * rest. Every one of them is live under the lock, for the reason every dashboard action is.
 *
 * **Even one tab is drawn as a tab.** Untitled, it reads "Dashboard" — the title this bar always had — so a
 * dashboard that never grows a second page looks as it did, and the `+` beside it is how anybody
 * finds out there could be one.
 *
 * Arrow keys move along the strip and activate as they go, the ARIA tabs pattern with automatic
 * activation: switching a page is free to undo, so making the reader press Enter as well buys
 * nothing.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { DashboardLayout } from '../../core/dashboard'
import { tabLabel } from '../../core/dashboard'
import { useGraphStore } from '../../store/graphStore'
import { ContextMenu } from '../menu/ContextMenu'
import { RenameInput } from '../RenameInput'
import { revealIn } from '../reveal'

interface MenuState {
  at: { x: number; y: number }
  id: string
}

export function DashboardTabs({
  layout,
  activeId,
}: {
  layout: DashboardLayout
  activeId: string
}) {
  const setDashboardTab = useGraphStore((s) => s.setDashboardTab)
  const addDashboardTab = useGraphStore((s) => s.addDashboardTab)
  const renameDashboardTab = useGraphStore((s) => s.renameDashboardTab)
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<MenuState | undefined>(undefined)
  const listRef = useRef<HTMLDivElement>(null)

  /** A tab's element — by walking the strip rather than a selector: a tab id from a file is any string. */
  const tabElement = (id: string) =>
    [...(listRef.current?.children ?? [])].find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.tabId === id,
    )

  /*
   * The tab on screen is kept in view of the strip. The list scrolls sideways inside itself, so a
   * tab added at the end — or switched to from the palette — would otherwise be active and out of
   * sight, with the strip saying nothing about which page is up. `revealIn` moves the strip alone,
   * where `scrollIntoView` would move the shell around it too.
   */
  useEffect(() => {
    const list = listRef.current
    const tab = tabElement(activeId)
    if (list && tab) revealIn(list, tab, 'x')
  }, [activeId, layout.tabs.length])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = layout.tabs.length - 1
    let to: number
    switch (event.key) {
      case 'Home':
        to = 0
        break
      case 'End':
        to = last
        break
      case 'ArrowRight':
        to = index === last ? 0 : index + 1
        break
      case 'ArrowLeft':
        to = index === 0 ? last : index - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = layout.tabs[to]!
    setDashboardTab(target.id)
    tabElement(target.id)?.focus()
  }

  return (
    <div className="dash-tabs">
      <div className="dash-tabs__list" role="tablist" aria-label="Dashboard tabs" ref={listRef}>
        {layout.tabs.map((tab, index) => {
          const label = tabLabel(layout, tab, index)
          const selected = tab.id === activeId
          if (editing === tab.id) {
            return (
              <RenameInput
                key={tab.id}
                className="dash-tabs__rename"
                label="Tab name"
                placeholder={label}
                initial={tab.title ?? ''}
                onCommit={(title) => renameDashboardTab(tab.id, title)}
                onDone={() => setEditing(undefined)}
              />
            )
          }
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="dash-tabs__tab"
              data-tab-id={tab.id}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={`${label}. Double-click to rename, right-click for more`}
              onClick={() => setDashboardTab(tab.id)}
              onDoubleClick={() => setEditing(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ at: { x: event.clientX, y: event.clientY }, id: tab.id })
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
      {/* Outside the scroller, so a strip of twenty tabs cannot scroll the way to a new one off. */}
      <button
        type="button"
        className="btn btn--ghost btn--icon dash-tabs__add"
        title="Add a tab to this dashboard"
        aria-label="New dashboard tab"
        onClick={() => addDashboardTab()}
      >
        +
      </button>
      {menu && (
        <TabMenu
          menu={menu}
          layout={layout}
          onRename={setEditing}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  )
}

function TabMenu({
  menu,
  layout,
  onRename,
  onClose,
}: {
  menu: MenuState
  layout: DashboardLayout
  onRename: (id: string) => void
  onClose: () => void
}) {
  const index = layout.tabs.findIndex((t) => t.id === menu.id)
  const tab = layout.tabs[index]
  // The tab can go under an open menu — an undo is a keypress away.
  if (!tab) return null
  const store = useGraphStore.getState()
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const only = layout.tabs.length === 1
  const label = tabLabel(layout, tab, index)

  return (
    <ContextMenu portal at={menu.at} onClose={onClose} label={`Tab ${label}`}>
      <div className="context-menu__caption">{label}</div>
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
        title="Add a copy of this tab next to it, with the same cells"
        onClick={act(() => store.duplicateDashboardTab(tab.id))}
      >
        Duplicate
      </button>
      <button
        type="button"
        className="context-menu__item"
        disabled={index === 0}
        onClick={act(() => store.moveDashboardTab(tab.id, index - 1))}
      >
        Move Left
      </button>
      <button
        type="button"
        className="context-menu__item"
        disabled={index === layout.tabs.length - 1}
        onClick={act(() => store.moveDashboardTab(tab.id, index + 1))}
      >
        Move Right
      </button>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item"
        disabled={only}
        title={
          only
            ? 'This is the only tab. Remove its cells instead'
            : 'Delete this tab. Its nodes stay on the canvas'
        }
        onClick={act(() => store.removeDashboardTab(tab.id))}
      >
        Delete Tab
      </button>
    </ContextMenu>
  )
}
