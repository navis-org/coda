#!/usr/bin/env node
/**
 * The Flow Chart, drawn in a real browser.
 * `pnpm probe:flowchart-draw` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * The node is geometry end to end, and jsdom performs no layout: every element reports one
 * constant rect and `measureText` is stubbed at six pixels a character. `flowChartLayout.test.ts`
 * pins the arithmetic over sizes handed in; nothing in the unit suite can say the arithmetic is
 * reached with the numbers a browser produces.
 *
 * The properties below are each a way this could be broken with the whole suite green.
 * `probeReport()` prints the real tally at the end, so no count is written down here —
 * one was, in three files, and all three had drifted by the time anyone looked.
 *
 * 1. **Every box is at least as wide as the text inside it.** The box is sized by a canvas
 *    `measureText` and drawn by `.chart text`, and those are two different code paths reading two
 *    different font strings unless something makes them one. They agree wherever `system-ui`
 *    resolves — which is every machine anybody would test on — and part company exactly where it
 *    does not, leaving labels clipped on somebody else's browser. This is the check that earns
 *    the probe.
 * 2. **No two boxes overlap.** The stacking is arithmetic over measured sizes, so a wrong
 *    measurement shows up here before it shows up anywhere else.
 * 3. **No arrow passes through a box.** The corridors are what `flowChartLayout.ts` exists for,
 *    and a corridor whose width is wrong at real box sizes puts an arrow through a neighbour.
 * 4. **The drawing fits inside the card**, which is one scale factor over the whole thing — the
 *    half `flowChartShape` shifting to the origin is supposed to buy.
 * 5. **Clicking a box selects it**, and the caption says so. The hit area is a `<g>` inside two
 *    nested transforms, which is precisely what jsdom cannot resolve.
 * 6. **A feedback arrow is dashed** wherever the demo graph has one — the one distinction the
 *    drawing makes that is not about position, and a folded box's outline likewise.
 * 7. **The wheel zooms in toward the reader and holds the point under the cursor.** Both halves
 *    were wrong; see the section for what each was.
 * 8. **An arrowhead points along the stroke it ends**, not along the waypoints.
 * 9. **Hovering an arrow highlights it, and only it**, and the highlight goes away again.
 *
 * It runs on the node's own demo link, so it needs no credential and reaches no server.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

/** The viewer's own plot padding, which the scene group sits inside. */
const PAD = 10

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9431,
  profile: '/tmp/coda-probe-flowchart',
  width: 1600,
  height: 1000,
})

/**
 * What the card says about itself.
 *
 * The boxes' rects come from `getBoundingClientRect`, so they are the *rendered* geometry after
 * both transforms rather than the layout's own numbers — which is the whole point: the layout is
 * already asserted headlessly, and what is unknown is whether a browser agrees.
 *
 * A label's width is measured the same way, off the `<text>` element, so property 1 compares the
 * drawn glyphs against the drawn box and neither against the code that placed them.
 */
const READ = `(() => {
  // An *element* rect, where the shared \`RECT\` takes a selector: every box here is one of many
  // matching one selector, so they have to be measured as the elements they are.
  const rect = (el) => {
    if (!el) return { left: 0, top: 0, width: 0, height: 0 }
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  const svg = document.querySelector('.flow-chart')
  if (!svg) return null
  const boxes = [...svg.querySelectorAll('[data-box]')].map((g) => {
    const shape = g.querySelector('rect')
    const text = g.querySelector('text')
    return {
      folded: g.getAttribute('data-folded') !== null,
      label: text?.textContent ?? '',
      box: rect(shape),
      text: rect(text),
      dashed: (shape?.getAttribute('stroke-dasharray') ?? '') !== '',
    }
  })
  const arrows = [...svg.querySelectorAll('[data-arrow]')].map((g) => {
    const path = g.querySelector('path')
    return {
      kind: g.getAttribute('data-arrow'),
      dashed: (path?.getAttribute('stroke-dasharray') ?? '') !== '',
      // Sampled along the rendered path, which is what a reader's eye follows — the interior
      // points of the polyline would only re-state the layout the unit tests already pin.
      points: (() => {
        const out = []
        if (!path || typeof path.getTotalLength !== 'function') return out
        const total = path.getTotalLength()
        if (!(total > 0)) return out
        // The **path's** CTM, not the svg's: the arrows live inside two nested transforms (the
        // plot's padding and the fit/zoom), and the svg's own matrix carries neither — so
        // screen coordinates built from it are off by the pad and wrong by the scale, which is
        // how "no arrow passes through a box" came to be comparing a mis-placed polyline
        // against real box rects and passing because nothing landed anywhere near them.
        const ctm = path.getScreenCTM()
        for (let i = 1; i < 20; i++) {
          const at = path.getPointAtLength((total * i) / 20)
          const p = ctm ? new DOMPoint(at.x, at.y).matrixTransform(ctm) : at
          out.push({ x: p.x, y: p.y })
        }
        return out
      })(),
    }
  })
  // Scoped to *this* viewer's own \`.viewer\`. A demo graph holds several cards and
  // \`document.querySelector('.viewer__caption')\` returns whichever is first in the document —
  // which was a Table's pager, so the selection check read a caption that could never say
  // "selected" and failed for a reason that had nothing to do with the gesture.
  const scene = svg.querySelector('g > g[transform*="scale"]')
  const caption = svg.closest('.viewer')?.querySelector('.viewer__caption')
  return {
    plot: rect(svg),
    // The inner group's transform, which is where zoom and pan live.
    transform: scene?.getAttribute('transform') ?? '',
    boxes,
    arrows,
    caption: caption?.textContent ?? '',
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

await send('Page.navigate', { url: `${url}#!demo://out.flowChart` })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()
await waitFor(`!!document.querySelector('.flow-chart')`, 'a flow chart card')
await waitFor(`(${READ})?.boxes.length > 2`, 'the boxes to be drawn')
await sleep(400)

const { check, finish } = probeReport()

/** Expand the card, so the drawing is on a surface big enough to aim at. */
await evaluate(`(() => {
  const card = document.querySelector('.flow-chart')?.closest('.coda-node')
  card?.querySelector('[title*="Expand"], [aria-label*="Expand"], .node__btn')?.click()
  return true
})()`)
await sleep(700)

const drawn = await evaluate(READ)
if (!drawn) throw new Error('no flow chart on screen')

const boxes = drawn.boxes
console.log(`  ${boxes.length} boxes, ${drawn.arrows.length} arrows`)
console.log(`  caption: ${drawn.caption.trim().replace(/\s+/g, ' ').slice(0, 110)}`)

// 1. The box holds its own text.
//
// A tolerance of one pixel, because the rect and the text box are rounded independently and a
// sub-pixel disagreement is not a clipped label. Anything larger is: the glyphs are wider than
// the shape drawn round them, which is what two font strings produce.
const clipped = boxes.filter((b) => b.text.width > b.box.width - 1)
const clippedNote = clipped
  .slice(0, 3)
  .map((b) => `${b.label} ${b.text.width.toFixed(1)} in ${b.box.width.toFixed(1)}`)
  .join('; ')
check(
  clipped.length === 0,
  `every box is at least as wide as the text in it${clippedNote ? ` — ${clippedNote}` : ''}`,
)

// 2. Nothing overlaps.
const overlapping = []
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].box
    const b = boxes[j].box
    const gap =
      a.left >= b.left + b.width ||
      b.left >= a.left + a.width ||
      a.top >= b.top + b.height ||
      b.top >= a.top + a.height
    if (!gap) overlapping.push(`${boxes[i].label}/${boxes[j].label}`)
  }
}
check(
  overlapping.length === 0,
  `no two boxes overlap${overlapping.length ? ` — ${overlapping.slice(0, 3).join(', ')}` : ''}`,
)

// 3. No arrow runs through a box.
//
// The two boxes an arrow joins are excluded by geometry rather than by name: a route starts and
// ends *on* a border, so the sampled interior is compared against every box it is not touching,
// with a small inset so a point sitting on an endpoint's edge is not counted as inside it.
const INSET = 2
const through = []
for (const arrow of drawn.arrows) {
  for (const point of arrow.points) {
    for (const b of boxes) {
      const inside =
        point.x > b.box.left + INSET &&
        point.x < b.box.left + b.box.width - INSET &&
        point.y > b.box.top + INSET &&
        point.y < b.box.top + b.box.height - INSET
      if (inside) {
        const depth = Math.min(
          point.x - b.box.left,
          b.box.left + b.box.width - point.x,
          point.y - b.box.top,
          b.box.top + b.box.height - point.y,
        )
        through.push(`${arrow.kind} through ${b.label} by ${depth.toFixed(1)}px`)
      }
    }
  }
}
const throughNote = [...new Set(through)].slice(0, 3).join(', ')
check(
  through.length === 0,
  `no arrow passes through a box${throughNote ? ` — ${throughNote}` : ''}`,
)

// 4. Everything is inside the card.
const outside = boxes.filter(
  (b) =>
    b.box.left < drawn.plot.left - 1 ||
    b.box.top < drawn.plot.top - 1 ||
    b.box.left + b.box.width > drawn.plot.left + drawn.plot.width + 1 ||
    b.box.top + b.box.height > drawn.plot.top + drawn.plot.height + 1,
)
// A folded box is the user's own summary rather than a thing in the data, so it is drawn with
// the dashed outline `glyphs.ts` reserves for a selection somebody made.
const foldedBoxes = boxes.filter((b) => b.folded)
if (foldedBoxes.length === 0) {
  console.log('  (no folded box in this graph — the dashed-outline rule is untested here)')
} else {
  check(
    foldedBoxes.every((b) => b.dashed),
    `every folded box is drawn dashed (${foldedBoxes.length} of them)`,
  )
}

check(
  outside.length === 0,
  `the drawing fits inside the card${outside.length ? ` — ${outside.map((b) => b.label).join(', ')}` : ''}`,
)

// 5. A click selects.
const target = boxes.find((b) => !b.folded) ?? boxes[0]
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: Math.round(target.box.left + target.box.width / 2),
  y: Math.round(target.box.top + target.box.height / 2),
  button: 'left',
  clickCount: 1,
})
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: Math.round(target.box.left + target.box.width / 2),
  y: Math.round(target.box.top + target.box.height / 2),
  button: 'left',
  clickCount: 1,
})
await sleep(400)
const after = await evaluate(READ)
check(
  /\b1 selected\b/.test(after?.caption ?? ''),
  `clicking a box selects it and the caption says so — ${(after?.caption ?? '').trim().replace(/\s+/g, ' ').slice(0, 70)}`,
)

// 6. Feedback is dashed, where the demo graph has any.
const feedback = drawn.arrows.filter((a) => a.kind === 'back')
if (feedback.length === 0) {
  console.log('  (no feedback arrow in this graph — the dashed rule is untested here)')
} else {
  check(
    feedback.every((a) => a.dashed),
    `every feedback arrow is dashed (${feedback.length} of them)`,
  )
  check(
    drawn.arrows.filter((a) => a.kind === 'forward').every((a) => !a.dashed),
    'and no feed-forward arrow is',
  )
}

// 7. The wheel zooms in on a scroll toward the reader, and holds the point under the cursor.
//
// Neither half is reachable from jsdom: `useWheelZoom` attaches a native non-passive listener and
// coalesces to an animation frame, and the anchor is arithmetic over a rendered transform. Both
// were wrong — the factor was multiplied where the hook's contract is that above 1 means zoom
// *out*, and the re-centring term was evaluated at the old zoom, so the drawing slid away from
// the pointer as it magnified.
const scaleOf = (t) => {
  const m = /scale\(([-\d.]+)\)/.exec(t)
  return m ? +m[1] : 1
}
const translateOf = (t) => {
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(t)
  return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 }
}

const beforeZoom = await evaluate(READ)
const anchor = {
  x: Math.round(beforeZoom.plot.left + beforeZoom.plot.width / 2),
  y: Math.round(beforeZoom.plot.top + beforeZoom.plot.height / 2),
}
// The drawing point under the cursor before the wheel, in the scene's own units.
const sceneAt = (read) => {
  const scale = scaleOf(read.transform)
  const at = translateOf(read.transform)
  // The group sits inside the PAD-translated one, so the pointer is measured from the plot box.
  const px = anchor.x - read.plot.left - PAD
  const py = anchor.y - read.plot.top - PAD
  return { x: (px - at.x) / scale, y: (py - at.y) / scale }
}
const held = sceneAt(beforeZoom)

await send('Input.dispatchMouseEvent', {
  type: 'mouseWheel',
  x: anchor.x,
  y: anchor.y,
  deltaX: 0,
  // Negative deltaY is a scroll toward the reader, which every other surface treats as zoom in.
  deltaY: -240,
})
await sleep(400)
const afterZoom = await evaluate(READ)

check(
  scaleOf(afterZoom.transform) > scaleOf(beforeZoom.transform),
  `a wheel toward the reader zooms in — ${scaleOf(beforeZoom.transform).toFixed(3)} to ${scaleOf(afterZoom.transform).toFixed(3)}`,
)
const moved = sceneAt(afterZoom)
const drift = Math.hypot(moved.x - held.x, moved.y - held.y)
check(
  drift < 1,
  `and the drawing point under the cursor stays put — drifted ${drift.toFixed(2)} scene units`,
)

// 8. An arrowhead points along the stroke it ends, not along the waypoints.
//
// With right-angle routing the drawn path turns before the box, so a head aimed down the raw
// polyline points past its own target. Checked by walking the rendered path to its end.
const headAim = await evaluate(`(() => {
  const svg = document.querySelector('.flow-chart')
  const out = []
  for (const g of svg.querySelectorAll('[data-arrow]')) {
    const paths = [...g.querySelectorAll('path')]
    const stroke = paths[0]
    const head = paths.find((p) => (p.getAttribute('transform') || '').indexOf('rotate') >= 0)
    if (!stroke || !head || typeof stroke.getTotalLength !== 'function') continue
    const total = stroke.getTotalLength()
    if (!(total > 2)) continue
    const end = stroke.getPointAtLength(total)
    const just = stroke.getPointAtLength(total - 2)
    out.push({
      kind: g.getAttribute('data-arrow'),
      transform: head.getAttribute('transform') || '',
      endX: end.x, endY: end.y, justX: just.x, justY: just.y,
    })
  }
  return out
})()`)

/*
 * Parsed in Node, not in the page. A regex written inside the `evaluate` template literal has
 * its backslashes eaten before the browser ever sees it — `\\d` becomes `d` — so the pattern
 * silently matches nothing and the check passes over an empty list. It did exactly that, and
 * "0 checked" in the output is what gave it away.
 */
const rotateOf = (t) => {
  const m = /rotate\(([-\d.]+)\)/.exec(t)
  return m ? +m[1] : undefined
}
const offBy = []
for (const h of headAim) {
  const strokeAngle = (Math.atan2(h.endY - h.justY, h.endX - h.justX) * 180) / Math.PI
  const aimed = rotateOf(h.transform)
  if (aimed === undefined) continue
  // Smallest angular distance between the two headings, in degrees.
  const delta = (((aimed - strokeAngle + 180) % 360) + 360) % 360 - 180
  offBy.push({ kind: h.kind, off: Math.abs(delta) })
}
const worst = offBy.length ? Math.max(...offBy.map((h) => h.off)) : Infinity
check(
  offBy.length > 0 && worst <= 8,
  `every arrowhead points along its own stroke (${offBy.length} checked, worst ${worst.toFixed(1)} deg off)`,
)

// 9. Hovering an arrow highlights it, and only it.
//
// The emphasis is a separate path drawn over the arrow layer, so what has to be checked is that
// it appears on a pointer rest, traces the *same* geometry as the arrow under the pointer, and
// goes away again — none of which jsdom can see, since it has no layout for the hit area and no
// pointer.
// Fit first, so the coordinates below are the ones the earlier checks measured. The plot rect
// itself is the `.flow-chart` svg's and neither the zoom nor the fit moves it, so `drawn.plot`
// still describes it.
await evaluate(`(() => {
  document.querySelector('.network-strip--bottom button')?.click()
  return true
})()`)
await sleep(300)

const longest = await evaluate(`(() => {
  const svg = document.querySelector('.flow-chart')
  // The longest arrow, whose midpoint is the least likely to be under a box or another arrow.
  let best = null
  for (const g of svg.querySelectorAll('[data-arrow]')) {
    const path = g.querySelector('path')
    if (!path || typeof path.getTotalLength !== 'function') continue
    const total = path.getTotalLength()
    if (!best || total > best.total) {
      const mid = path.getPointAtLength(total / 2)
      const ctm = path.getScreenCTM()
      const p = ctm ? new DOMPoint(mid.x, mid.y).matrixTransform(ctm) : mid
      best = { total, x: p.x, y: p.y, d: path.getAttribute('d') }
    }
  }
  return best
})()`)

/** How many paths are drawn over the arrow layer, and what they trace. */
const EMPHASIS = `(() => {
  const svg = document.querySelector('.flow-chart')
  // The emphasis group is the one with no \`data-arrow\` and \`pointer-events: none\`.
  const groups = [...svg.querySelectorAll('g > g')]
  const marks = []
  for (const g of groups) {
    if (g.getAttribute('data-arrow') !== null) continue
    if (g.getAttribute('pointer-events') !== 'none') continue
    for (const p of g.querySelectorAll('path')) marks.push(p.getAttribute('d') || '')
  }
  return marks
})()`

check((await evaluate(EMPHASIS)).length === 0, 'nothing is emphasised before the pointer arrives')

await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(longest.x),
  y: Math.round(longest.y),
})
await sleep(350)
const hovered = await evaluate(EMPHASIS)
check(
  hovered.length > 0,
  `hovering an arrow draws an emphasis (${hovered.length} mark${hovered.length === 1 ? '' : 's'})`,
)
check(
  hovered.includes(longest.d),
  'and it traces exactly the arrow under the pointer, not a second geometry',
)

// Away again — onto the card's empty margin, which is inside the plot and over nothing.
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(drawn.plot.left + 6),
  y: Math.round(drawn.plot.top + 6),
})
await sleep(350)
check((await evaluate(EMPHASIS)).length === 0, 'and it goes away when the pointer leaves')

const shot = await screenshot('coda-flowchart')
console.log(`  screenshot: ${shot}`)

if (!keep) await close()
finish()
