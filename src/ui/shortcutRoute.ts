/**
 * Following a shortcut from the address: `?shortcut=<id>`, which a shortcut's generated page
 * redirects to (`vite/shortcutPages.ts`).
 *
 * Called once, before the first render, from the main entry. The parameter is taken back out of
 * the address first, with `replaceState` — the fragment and any other parameter kept — so a reload
 * or a link copied from the bar does not follow it again, and nothing a workflow means depends on
 * it: a shortcut only ever switches packs **on** (`applyShortcut`, which also says so). An id no
 * shortcut has does nothing.
 */

import { applyShortcut } from './packSwitches'

const SHORTCUT_PARAM = 'shortcut'

export function followShortcutParam(): void {
  const params = new URLSearchParams(window.location.search)
  const id = params.get(SHORTCUT_PARAM)
  if (id === null) return
  params.delete(SHORTCUT_PARAM)
  const search = params.toString()
  const { pathname, hash } = window.location
  window.history.replaceState(null, '', `${pathname}${search ? `?${search}` : ''}${hash}`)
  applyShortcut(id)
}
