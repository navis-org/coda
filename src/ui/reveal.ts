/**
 * Scroll `container` just enough to show `el`, with a little air, and nothing else.
 *
 * By the container's own scroll position rather than `scrollIntoView`, which also scrolls every
 * ancestor that hides its overflow — the app shell among them — so a list reaching for its own
 * row could shift the page around it.
 */
export function revealIn(container: HTMLElement, el: HTMLElement, axis: 'x' | 'y' = 'y'): void {
  const box = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const air = 6
  if (axis === 'y') {
    if (r.top < box.top) container.scrollTop -= box.top - r.top + air
    else if (r.bottom > box.bottom) container.scrollTop += r.bottom - box.bottom + air
  } else {
    if (r.left < box.left) container.scrollLeft -= box.left - r.left + air
    else if (r.right > box.right) container.scrollLeft += r.right - box.right + air
  }
}
