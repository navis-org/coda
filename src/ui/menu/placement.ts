/**
 * Where a popup goes — a menu at a point, a toolbar panel under its trigger, a flyout beside its
 * row.
 *
 * Collected from two places: `menuPosition.ts`, which the context menus and the palette clamped
 * against, and the placement half of the menu code `Toolbar.tsx` carried although nothing about
 * it was the toolbar's. The rules are `ui-shell.md`'s: measure against
 * `documentElement.clientWidth`, nudge a top-level panel rather than flip it, and open a flyout
 * right, else left, else under its row.
 */

import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * The window a popup is kept inside: `documentElement.clientWidth`, never `window.innerWidth`.
 *
 * On a phone `innerWidth` is the visual viewport at minimum scale, so a panel hanging off the right
 * widens the document, the browser zooms out, and the number grows to include the overflow being
 * measured — `ui-shell.md` records that costing a menu 8px of correction instead of 60. It also
 * counts a scrollbar as room. One function because six menus did this by hand and two of them were
 * still reading `innerWidth` — and then both hover previews did too.
 */
export function layoutViewport(): { width: number; height: number } {
  const { clientWidth, clientHeight } = document.documentElement
  return { width: clientWidth, height: clientHeight }
}

/**
 * Where a menu opened at a point goes: at the point, pulled back inside `layoutViewport`.
 *
 * `size` is a measurement wherever there is a box to measure — `ContextMenu` reads its own before
 * paint. The palette still hands in its CSS size.
 */
export function menuPosition(
  at: { x: number; y: number },
  size: { width: number; height: number },
  margin = 0,
): { left: number; top: number } {
  const { width, height } = layoutViewport()
  return {
    left: Math.max(margin, Math.min(at.x, width - size.width - margin)),
    top: Math.max(margin, Math.min(at.y, height - size.height - margin)),
  }
}

/** The margin the toolbar's menus keep from the window's edge: one number, panels and flyouts. */
const MENU_GUTTER = 8

export interface MenuFit {
  /** The panel's own width — content-driven above `min-width`, so it has to be measured. */
  width: number
  rowLeft: number
  rowRight: number
  viewport: number
}

/**
 * How far to shift a top-level menu's panel so it stays inside the window, in px from where it
 * would otherwise open — which is its trigger's left edge.
 *
 * A *shift*, not a flip, and the difference is the bug this replaced. Anchoring to the trigger's
 * right edge instead is only a second fixed position, so a panel that fits neither is placed at
 * whichever edge was asked about last: `Save` opened at **-110** on a 412px screen, 110px off the
 * left, where staying put would have been 52px off the right. But a menu panel is 260–315px and
 * a phone is 375–412 — it *fits*, just not aligned to either edge of a trigger two thirds of the
 * way along the row. So the answer is neither edge: put it where it fits and leave it alone
 * wherever it already does, which is every window wide enough to have never had the problem.
 *
 * Pure, and exported, because it is the half a suite with no layout can pin: jsdom measures
 * nothing, so the rects have to be handed in.
 */
export function menuShift(fit: MenuFit | undefined): number {
  if (!fit) return 0
  // The furthest left it may start and still clear the far gutter — floored at the near one, so
  // a panel wider than the window overflows to the right rather than off the left, where a
  // scroll cannot reach it.
  const rightmost = Math.max(MENU_GUTTER, fit.viewport - MENU_GUTTER - fit.width)
  const wanted = Math.min(Math.max(fit.rowLeft, MENU_GUTTER), rightmost)
  return Math.round(wanted - fit.rowLeft)
}

export type FlyoutPlacement = 'right' | 'left' | 'inline'

/**
 * Where a submenu's flyout goes: right of its row, else left of it, else **under** it.
 *
 * Exported, and pure, because it is the part worth pinning and the part a test with no layout
 * can reach — jsdom measures nothing, so the numbers have to be handed in. `submenuPlacement`
 * is the whole of the geometry; the component only supplies rects.
 *
 * The third answer is what this grew. A panel is `min-width: 260px`, so a row plus a flyout is
 * 520px, and on a 412px viewport neither side fits — asked as a flip ("does the right fit? no,
 * then left") that is a choice between two impossible positions, and it picked the worse:
 * `New ▸ neuPrint` opened at **-229**, where not flipping would have been 135 past the right.
 * Two answers went wrong at 744 on a tablet as well, where the right side misses by 9px and the
 * left by 27 — so this was never a phone rule, and a breakpoint would not have caught it. Both
 * measured in a browser.
 *
 * `narrow` short-circuits ahead of the measurement rather than beside it: no shell that narrow
 * can seat a 260px panel beside a 260px one, and answering before the first render is what keeps
 * a flyout from being painted at the wrong place and corrected.
 */
export function submenuPlacement(fit: MenuFit | undefined, narrow: boolean): FlyoutPlacement {
  if (narrow) return 'inline'
  // Not measured yet: the flyout has to be somewhere to be measured, and right is where it
  // belongs whenever there is room. `useLayoutEffect` corrects it before paint.
  if (!fit) return 'right'
  if (fit.rowRight + fit.width <= fit.viewport - MENU_GUTTER) return 'right'
  if (fit.rowLeft - fit.width >= MENU_GUTTER) return 'left'
  return 'inline'
}

/**
 * The numbers a menu needs to decide where to open, measured from real rects once it is open.
 *
 * Measuring rather than deciding at a breakpoint, because what matters is where *this* menu
 * ended up — which depends on how wide the workflow's name rendered — and how wide its panel
 * turned out. In a `useLayoutEffect`, so a correction lands before paint rather than as a flash.
 *
 * It answers with numbers rather than a placement because the two callers ask different
 * questions of them: a top-level panel hangs *from* an edge of its trigger, a flyout opens
 * *beside* the row, and only one of the two has an inline fallback. Those decisions sit at the
 * call sites; what is shared, and was written out twice before, is this.
 */
export function useMenuFit(
  ref: RefObject<HTMLDivElement | null>,
  open: boolean,
  panelSelector: string,
): MenuFit | undefined {
  const [fit, setFit] = useState<MenuFit | undefined>(undefined)

  useLayoutEffect(() => {
    if (!open) return
    const row = ref.current?.getBoundingClientRect()
    const panel = ref.current?.querySelector(panelSelector)?.getBoundingClientRect()
    if (!row || !panel) return
    setFit({
      width: panel.width,
      rowLeft: row.left,
      rowRight: row.right,
      // `layoutViewport`, never `window.innerWidth` — its note is the bug that made the first
      // version of this shift a panel by 8px instead of 60.
      viewport: layoutViewport().width,
    })
  }, [open, ref, panelSelector])

  return fit
}
