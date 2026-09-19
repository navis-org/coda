#!/usr/bin/env node
/**
 * Shift-dragging a rectangle on a Heatmap, in a real browser.
 * `pnpm probe:heatmap-select` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * The whole feature is a pointer gesture over a canvas, and jsdom has neither. It performs no
 * layout — every element reports one constant rect — so the spec the plot is built from is
 * degenerate there, `linesInRect` has no real geometry to convert, and nothing in the unit suite
 * can say the box a hand drew names the lines under it. `heatmapPlot.test.ts` pins the
 * arithmetic; this pins that the arithmetic is reached with the numbers a browser produces.
 *
 * Eleven properties, each a way this could be broken with the whole suite green:
 *
 * 1. **A shift-drag selects what it covered**, and **only** what it covered. The second half is
 *    the bug this was rewritten for: the selection was stored as the labels under the box, and
 *    the Labels tab exists to put one name on many lines — so a box round one row of a cell type
 *    took every row of that type. Checked by counting the selected rows against the rows the box
 *    actually spans, on a card whose labels repeat.
 * 2. **A bare drag does not.** Bare drag pans, which is `ScatterViewer`'s division and React
 *    Flow's — a viewer that read the press without the modifier would select on every pan, and a
 *    pan is the frequent gesture.
 * 3. **The bands land on the rows they cover.** The band geometry and the label placement are two
 *    derivations from one spec, and only a browser lays either of them out.
 * 4. **The marquee is visible during the drag** and gone after. It is an overlay outside the
 *    canvas repaint, so it can be positioned wrongly or left behind with nothing failing.
 * 5. **A shift-click with no drag clears.** The click/drag split, where the slop lives.
 * 6. **Alt-shift-drag adds rather than replacing**, and the two blocks stay two bands.
 * 7. **Shift+⌘-drag adds too**, the chord that replaced ⌫ as the way to build a selection up.
 * 8. **Shift+⌘-click takes exactly one cell**, with no drag in it — the gesture that cannot be
 *    performed at all if a press is only read as the start of a box.
 * 9. **The strip carries the fit button and nothing else.** ⌫ was removed; ⤢ resets the zoom and
 *    is the only thing there.
 * 10. **A card can be selected on**, which is the gate that moved. React Flow's pane claims a
 *    shift-press anywhere inside it and stops propagation in the *capture* phase, so this is
 *    testable nowhere else at all — in jsdom there is no pane, and the class that opts out of it
 *    (`nokey`) is a string until a real React Flow reads it.
 * 11. **and does not move the canvas's own node selection while doing it.** `nodrag` filters the
 *    drag; the node's selection rides on the `click`, which fires anyway — so before the guard
 *    one shift+⌘-click took a cell *and* selected the card, and cell-by-cell selecting piled up
 *    cards the next Delete would have removed. Measured 0 → 1, then 0 → 0.
 *
 * It runs on `mock.opticlobe`, the synthetic connectome the demo links use, so it needs no
 * credential and reaches no server.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport, RECT } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

/**
 * CDP's modifier bitmask. `META` is bit 4 whatever the host OS is, and it is what `⌘` sends —
 * `CTRL` (2) would do as well for `addsToSelection`, which takes either, but on macOS Chrome
 * turns a ctrl-press into a context menu before our handler sees a left button.
 */
const ALT = 1
const META = 4
const SHIFT = 8

const { send, evaluate, waitFor, screenshot, drag, dragHold, close } = await launchChrome({
  port: 9427,
  profile: '/tmp/coda-probe-heatmap-select',
  width: 1600,
  height: 1000,
})

/**
 * What the card says about itself: the plot box, the row labels it is drawing and where, the
 * bands, and the caption's count.
 *
 * The labels come out of the overlay's `<text>` rather than out of the matrix, because the
 * question is whether the gesture caught the lines a *reader* would have said it caught.
 */
const READ = `(() => {
  const rect = (${RECT})
  const plot = document.querySelector('.heatmap-plot')
  if (!plot) return null
  const box = plot.getBoundingClientRect()
  const svg = plot.querySelector('.heatmap-overlay')
  const rowTicks = [...(svg?.querySelectorAll('text') ?? [])]
    .filter((t) => t.getAttribute('text-anchor') === 'end')
    .map((t) => ({ label: t.textContent, y: box.top + Number(t.getAttribute('y')) }))
  // The **core** layer alone: a band is drawn twice, a light core over a dark casing, so
  // '.heatmap-band rect' counts every band twice and every count below would double.
  const bands = [...plot.querySelectorAll('.heatmap-band__core rect')].map((r) => ({
    axis: r.getAttribute('data-axis'),
    x: box.left + Number(r.getAttribute('x')),
    y: box.top + Number(r.getAttribute('y')),
    width: Number(r.getAttribute('width')),
    height: Number(r.getAttribute('height')),
  }))
  const note = [...document.querySelectorAll('.viewer__caption .viewer__note')]
    .map((n) => n.textContent ?? '')
    .find((t) => t.includes('selected'))
  const strip = document.querySelector('.network-strip--bottom')
  return {
    strip: {
      clear: !!strip?.querySelector('[aria-label="Clear selection"]'),
      fit: !!strip?.querySelector('[aria-label="Fit to view"]'),
      buttons: strip ? strip.querySelectorAll('button').length : 0,
    },
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    rowTicks,
    bands,
    note: note ?? null,
    // The count above is only comparable with the drawn labels while every line has one.
    thinned: [...document.querySelectorAll('.viewer__caption .viewer__note')].some((n) =>
      (n.textContent ?? '').includes('thinned'),
    ),
    marquee: !!plot.querySelector('.chart-gesture rect'),
    // React Flow's own node selection, which a gesture the card consumed must not also move.
    nodesSelected: document.querySelectorAll('.react-flow__node.selected').length,
  }
})()`

/** Dismiss whatever the launch sequence has put up — `probe-port-preview.mjs`'s note applies. */
async function clearLaunch() {
  for (let i = 0; i < 20; i++) {
    const clear = await evaluate(`(() => {
      document.querySelector('.small-screen__actions button')?.click()
      document.querySelector('.start__close')?.click()
      document.querySelector('.overlay__close, .overlay [aria-label="Close"]')?.click()
      return !document.querySelector('.start') && !document.querySelector('.overlay')
    })()`)
    if (clear) return
    await sleep(150)
  }
  throw new Error('the launch sequence did not close')
}

await send('Page.navigate', { url: `${url}#!demo://out.heatmap` })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()
await waitFor(`!!document.querySelector('.heatmap-plot canvas')`, 'a heatmap card')
// The demo auto-runs; the cells and the gutters arrive with the result.
await waitFor(`(${READ})?.rowTicks.length > 2`, 'the row labels to be drawn')
await sleep(400)

const { check, finish } = probeReport()

/** Expand the card, so the gesture is on a plot big enough to aim at. */
await evaluate(`(() => {
  const card = document.querySelector('.heatmap-plot')?.closest('.coda-node')
  card?.querySelector('[title*="Expand"], [aria-label*="Expand"], .node__btn')?.click()
  return true
})()`)
await sleep(600)

const before = await evaluate(READ)
if (!before) throw new Error('no heatmap plot')

/** A box over the top-left quarter of the plot, inset so it cannot start in a gutter. */
const quarter = (r) => ({
  from: { x: r.box.left + r.box.width * 0.35, y: r.box.top + r.box.height * 0.2 },
  to: { x: r.box.left + r.box.width * 0.6, y: r.box.top + r.box.height * 0.45 },
})

// --- 1. a shift-drag selects ------------------------------------------------
const { from, to } = quarter(before)
await drag(from, to, SHIFT)
await sleep(500)
const picked = await evaluate(READ)
const counts = /(\d+) × (\d+) selected/.exec(picked.note ?? '')
check(!!counts, `a shift-drag selects the lines it covered — ${picked.note}`)
check(
  picked.bands.some((b) => b.axis === 'rows') && picked.bands.some((b) => b.axis === 'columns'),
  `and draws a band on each axis — ${picked.bands.map((b) => b.axis).join(', ')}`,
)

/*
 * **And only what it covered**, which is the half the rewrite was for. Counted against the row
 * *labels* the card drew inside the box: a selection resolved by name takes every line sharing
 * one, so on any card whose labels repeat the count runs ahead of the geometry. This demo's
 * labels happen to be unique, so what this pins here is the geometry itself — an off-by-one at
 * the box's edge, or a fold mapping the wrong lines. The repeat semantics are pinned where a
 * matrix with two rows of one name can be built to order: `heatmap.test.ts`, and
 * `probe:helpers` / `probe:r-helpers` for the two documents.
 */
//
// Against the rows the box **touches**, not the tick centres strictly inside it: `linesInRect`
// takes every line the rectangle overlaps, so a row whose centre is just outside but whose band
// is not is genuinely selected. Counting centres reported 10 against 9 — the probe's arithmetic
// rather than the code's, and the kind of near-miss that invites a tolerance where what is
// wanted is the right rule. The pitch comes off the ticks themselves, which are evenly spaced
// while nothing is thinned.
const ys = picked.rowTicks.map((t) => t.y).sort((a, b) => a - b)
const pitch = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 0
const spanned = ys.filter((y) => y + pitch / 2 > from.y && y - pitch / 2 < to.y).length
check(
  counts !== null && !picked.thinned && pitch > 0 && Number(counts[1]) === spanned,
  `and only what it covered — ${counts?.[1]} rows selected against ${spanned} touched${picked.thinned ? ', labels thinned' : ''}`,
)

// --- 3. the bands are where the labels are ----------------------------------
// A row tick inside the dragged band must sit inside a drawn band, and one well outside it must
// not: the two are derived separately from the same spec, and only a browser lays either out.
//
// **By `data-axis`, never by shape.** A column band spans the plot's whole height, so every row
// tick on the card falls inside one — read that way this check passes on a heatmap where the row
// bands are drawn in entirely the wrong place, which is what it did first.
const inside = picked.rowTicks.filter((t) => t.y > from.y && t.y < to.y)
const rowBands = picked.bands.filter((b) => b.axis === 'rows')
const covered = (y) => rowBands.some((b) => y >= b.y - 1 && y <= b.y + b.height + 1)
check(
  inside.length > 0 && inside.every((t) => covered(t.y)),
  `every row label inside the box is inside a band — ${inside.filter((t) => covered(t.y)).length}/${inside.length}`,
)
const outside = picked.rowTicks.filter((t) => t.y < from.y - 20 || t.y > to.y + 20)
check(
  outside.length > 0 && !outside.some((t) => covered(t.y)),
  `and no row label outside it is — ${outside.filter((t) => covered(t.y)).length} of ${outside.length} wrongly banded`,
)

// --- 4. the marquee -----------------------------------------------------------
const release = await dragHold(from, to, SHIFT)
await sleep(120)
const mid = await evaluate(READ)
check(mid.marquee === true, `the marquee is drawn while the box is being dragged — ${mid.marquee}`)
await release()
await sleep(300)
const after = await evaluate(READ)
check(after.marquee === false, `and gone once the pointer is up — ${after.marquee}`)

// --- 2. a bare drag does not select ------------------------------------------
const wasNote = after.note
await drag(
  { x: after.box.left + after.box.width * 0.2, y: after.box.top + after.box.height * 0.7 },
  { x: after.box.left + after.box.width * 0.5, y: after.box.top + after.box.height * 0.8 },
)
await sleep(400)
const panned = await evaluate(READ)
check(panned.note === wasNote, `a bare drag leaves the selection alone — ${wasNote} → ${panned.note}`)

// --- 5. a shift-click clears --------------------------------------------------
const spot = { x: after.box.left + after.box.width * 0.5, y: after.box.top + after.box.height * 0.5 }
await drag(spot, spot, SHIFT)
await sleep(400)
const cleared = await evaluate(READ)
check(
  cleared.note === null && cleared.bands.length === 0,
  `a shift-click with no drag clears — ${cleared.note}, ${cleared.bands.length} bands`,
)

// --- 6. alt-shift-drag adds ---------------------------------------------------
const base = await evaluate(READ)
const first = {
  from: { x: base.box.left + base.box.width * 0.4, y: base.box.top + base.box.height * 0.15 },
  to: { x: base.box.left + base.box.width * 0.6, y: base.box.top + base.box.height * 0.3 },
}
await drag(first.from, first.to, SHIFT)
await sleep(400)
const one = await evaluate(READ)
const oneCount = Number(/(\d+) × \d+ selected/.exec(one.note ?? '')?.[1] ?? 0)

// A second block well clear of the first, so "added" and "replaced" cannot look the same.
const second = {
  from: { x: base.box.left + base.box.width * 0.4, y: base.box.top + base.box.height * 0.65 },
  to: { x: base.box.left + base.box.width * 0.6, y: base.box.top + base.box.height * 0.8 },
}
await drag(second.from, second.to, SHIFT | ALT)
await sleep(400)
const two = await evaluate(READ)
const twoCount = Number(/(\d+) × \d+ selected/.exec(two.note ?? '')?.[1] ?? 0)
check(
  oneCount > 0 && twoCount > oneCount,
  `alt-shift-drag adds rather than replacing — ${oneCount} then ${twoCount} rows`,
)
// Two blocks with a gap between them is the case the run merging exists for, and the only way
// to tell an added selection from a replaced one in the drawing.
check(
  two.bands.filter((b) => b.axis === 'rows').length === 2,
  `and the two blocks stay two bands — ${two.bands.filter((b) => b.axis === 'rows').length}`,
)

// --- 7. shift+⌘-drag adds as well ---------------------------------------------
// The chord the ⌫ button's removal leans on: `addsToSelection` takes Alt *or* Shift+⌘/Ctrl, and
// a third block clear of the other two is the only way to see "added" rather than "replaced".
const third = {
  from: { x: base.box.left + base.box.width * 0.4, y: base.box.top + base.box.height * 0.4 },
  to: { x: base.box.left + base.box.width * 0.6, y: base.box.top + base.box.height * 0.5 },
}
await drag(third.from, third.to, SHIFT | META)
await sleep(400)
const three = await evaluate(READ)
const threeCount = Number(/(\d+) × \d+ selected/.exec(three.note ?? '')?.[1] ?? 0)
check(
  threeCount > twoCount,
  `shift+⌘-drag adds rather than replacing — ${twoCount} then ${threeCount} rows`,
)
check(
  three.bands.filter((b) => b.axis === 'rows').length === 3,
  `and the three blocks stay three bands — ${three.bands.filter((b) => b.axis === 'rows').length}`,
)

// --- 8. shift+⌘-click takes one cell ------------------------------------------
// Cleared first, so "1 × 1" is unambiguous: a press with no drag in it is a rectangle covering
// one cell, and the count is the whole assertion. Against an empty selection, because adding one
// cell to three blocks is a number nothing on screen would let a reader check.
const spot2 = {
  x: base.box.left + base.box.width * 0.55,
  y: base.box.top + base.box.height * 0.45,
}
await drag(spot2, spot2, SHIFT)
await sleep(300)
await drag(spot2, spot2, SHIFT | META)
await sleep(400)
const oneCell = await evaluate(READ)
check(
  oneCell.note === '1 × 1 selected',
  `shift+⌘-click with no drag takes exactly the cell under it — ${oneCell.note}`,
)

// --- 9. the strip is the fit button and nothing else --------------------------
check(
  oneCell.strip.fit && !oneCell.strip.clear && oneCell.strip.buttons === 1,
  `the strip carries ⤢ alone — ${JSON.stringify(oneCell.strip)}`,
)

// --- 10. and all of it works on the card --------------------------------------
/*
 * The gate that moved, and the one thing here that is *only* observable in a browser running the
 * real React Flow: with `selectionKeyCode="Shift"` its pane claims a shift-press anywhere inside
 * it, takes the pointer capture and stops propagation in the capture phase — before the card's
 * own handler. `nokey` on the plot is the library's opt-out, and it is a string in a className
 * until something reads it. jsdom has no pane to be wrong about.
 */
// Escape, which is how the expanded view closes — its header carries guides, style and help
// and no close button at all, so there is nothing to click.
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}
await waitFor(`!document.querySelector('.overlay')`, 'the expanded view to close')
await sleep(500)
const card = await evaluate(READ)
const cardSpot = {
  x: card.box.left + card.box.width * 0.5,
  y: card.box.top + card.box.height * 0.5,
}
await drag(cardSpot, cardSpot, SHIFT)
await sleep(300)
await drag(cardSpot, cardSpot, SHIFT | META)
await sleep(400)
const onCard = await evaluate(READ)
check(
  onCard.note === '1 × 1 selected',
  `a card takes the gesture React Flow's pane used to swallow — ${onCard.note}`,
)
check(
  onCard.bands.filter((b) => b.axis === 'rows').length === 1,
  `and draws the band for it — ${onCard.bands.filter((b) => b.axis === 'rows').length} row bands`,
)
/*
 * And does not *also* move the canvas's own node selection, which is the half the gate change
 * introduced and nothing in jsdom has a React Flow to see: `nodrag` filters the drag, where the
 * node's selection rides on the `click` — so one shift+⌘-click took a cell and left the card
 * selected, and building a selection cell by cell piled up cards the next Delete would remove.
 * Measured 0 → 1 before the `onClick` guard, 0 → 0 after.
 */
check(
  card.nodesSelected === 0 && onCard.nodesSelected === 0,
  `and leaves the canvas's node selection alone — ${card.nodesSelected} → ${onCard.nodesSelected}`,
)

// A bare name: `screenshot` writes `${name}.png` into the temp dir and never the repo root.
if (keep) console.log(await screenshot('coda-heatmap-select'))
close()
finish()
