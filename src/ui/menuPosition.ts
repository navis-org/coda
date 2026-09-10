/**
 * Where a menu opened at a point goes: at the point, pulled back inside the window.
 *
 * `documentElement.clientWidth`, never `window.innerWidth`. On a phone `innerWidth` is the visual
 * viewport at minimum scale, so a panel hanging off the right widens the document, the browser
 * zooms out, and the number grows to include the overflow being measured — `ui-shell.md` records
 * that costing a menu 8px of correction instead of 60. One function because six menus did this by
 * hand and two of them were still reading `innerWidth`.
 *
 * The size is each menu's own estimate rather than a measurement, which is the weakness left: a
 * menu taller than its estimate still overruns the bottom edge. `useMenuFit` measures, for the
 * toolbar's menus, and is where this would go next.
 */
export function menuPosition(
  at: { x: number; y: number },
  size: { width: number; height: number },
  margin = 0,
): { left: number; top: number } {
  const { clientWidth, clientHeight } = document.documentElement
  return {
    left: Math.max(margin, Math.min(at.x, clientWidth - size.width - margin)),
    top: Math.max(margin, Math.min(at.y, clientHeight - size.height - margin)),
  }
}
