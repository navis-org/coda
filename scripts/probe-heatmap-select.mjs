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
 * Seven properties, each a way this could be broken with the whole suite green:
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
 * 7. **The ⌫ button clears**, and is disabled with nothing selected.
 *
 * It runs on `mock.opticlobe`, the synthetic connectome the demo links use, so it needs no
 * credential and reaches no server.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport, RECT } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

/** CDP's modifier bitmask. */
const ALT = 1
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
  const bands = [...plot.querySelectorAll('.heatmap-band rect')].map((r) => ({
    axis: r.getAttribute('data-axis'),
    x: box.left + Number(r.getAttribute('x')),
    y: box.top + Number(r.getAttribute('y')),
    width: Number(r.getAttribute('width')),
    height: Number(r.getAttribute('height')),
  }))
  const note = [...document.querySelectorAll('.viewer__caption .viewer__note')]
    .map((n) => n.textContent ?? '')
    .find((t) => t.includes('selected'))
  const clearBtn = document.querySelector('.network-strip--bottom [aria-label="Clear selection"]')
  return {
    clear: clearBtn ? { present: true, disabled: clearBtn.disabled } : { present: false },
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    rowTicks,
    bands,
    note: note ?? null,
    // The count above is only comparable with the drawn labels while every line has one.
    thinned: [...document.querySelectorAll('.viewer__caption .viewer__note')].some((n) =>
      (n.textContent ?? '').includes('thinned'),
    ),
    marquee: !!plot.querySelector('.chart-gesture rect'),
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

// --- 7. the ⌫ button ----------------------------------------------------------
check(
  two.clear.present && two.clear.disabled === false,
  `the clear button is live with a selection — ${JSON.stringify(two.clear)}`,
)
await evaluate(
  `document.querySelector('.network-strip--bottom [aria-label="Clear selection"]').click()`,
)
await sleep(400)
const done = await evaluate(READ)
check(
  done.note === null && done.bands.length === 0 && done.clear.disabled === true,
  `and clears everything, then goes dim — ${done.note}, ${done.bands.length} bands, disabled ${done.clear.disabled}`,
)

if (keep) await screenshot('/tmp/coda-heatmap-select.png')
close()
finish()
