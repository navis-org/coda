#!/usr/bin/env node
/**
 * The node guide's "Reading a card" figure, measured. `pnpm probe:node-anatomy`.
 *
 * ## Why this exists
 *
 * The section is eighteen labels hand-placed in a fixed px world, with a rectangle round each part
 * and a leader line to it. The rectangles and the leaders are *measured* in the browser from the
 * elements they name (`src/nodeguide/anatomyStage.ts`), which is the whole reason they stay
 * correct — and is also why nothing in the vitest suite can see them: jsdom performs no layout, so
 * every rect there is zero and every leader is a line from nowhere to nowhere.
 *
 * `anatomy.test.ts` pins what a table can pin — that each callout points at a part, that the
 * chrome it draws still says what the card says, that two labels do not share a coordinate. This
 * pins the half that only a real browser knows:
 *
 *   - **the document is never wider than the viewport**, which a hover panel hanging off the right
 *     of the stage quietly breaks at *every* width, because it is `visibility: hidden` rather than
 *     absent and still takes part in layout;
 *   - **every box lands on the part it names**, which is the failure a wrong coordinate space
 *     gives — the boxes are written in the item's coordinates and measured in the stage's, and
 *     that subtraction was wrong first;
 *   - **the wire ends on its two sockets**, since its `d` is generated rather than authored;
 *   - **no two labels overlap once they have wrapped**, the estimate in the unit test being an
 *     estimate;
 *   - **the figure stands down** below the stylesheet's own breakpoint, with the notes visible
 *     rather than hidden — the fallback is what a phone and a crawler get.
 *
 * ## How
 *
 * Chrome over the DevTools protocol against whatever is being served. Needs `pnpm dev --port 5177`
 * — the port the other browser probes ask for, so two of them can share one server — or a `--url`.
 *
 *   pnpm probe:node-anatomy
 *   pnpm probe:node-anatomy -- --url http://localhost:5173/nodes.html
 *   pnpm probe:node-anatomy -- --url https://…/coda/nodes.html --keep
 *
 * `--keep` writes a screenshot of the stage per width. Exit code is 1 if any property fails.
 */

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const URL = args.value('--url') ?? 'http://localhost:5177/nodes.html'

/** Wide enough for the stage, and one width below the stylesheet's own breakpoint. */
const WIDTHS = [1600, 1280, 1100, 1000]

/**
 * Everything read in one page-side evaluation, because the page moves between two of them: the
 * boxes are re-measured on a resize and a rect taken before that frame is a rect of the old
 * layout.
 */
const MEASURE = `(() => {
  const round = (n) => Math.round(n * 10) / 10
  const stage = document.querySelector('.anat__stage')
  const canvas = document.querySelector('.anat__canvas')
  const box = (el) => {
    const r = el.getBoundingClientRect()
    const s = stage.getBoundingClientRect()
    return { x: round(r.left - s.left), y: round(r.top - s.top), w: round(r.width), h: round(r.height) }
  }
  const leads = document.querySelector('.anat__leads')
  const on = getComputedStyle(leads).display !== 'none'
  const items = [...document.querySelectorAll('.anat__item')].map((item) => {
    const id = item.dataset.for
    const target = document.querySelector('[data-anat="' + id + '"]')
    const note = item.querySelector('.anat__note')
    return {
      id,
      label: box(item.querySelector('.anat__label')),
      mark: box(item.querySelector('.anat__box')),
      target: target ? box(target) : null,
      note: box(note),
      noteShown: getComputedStyle(note).visibility !== 'hidden',
    }
  })
  const path = document.querySelector('.anat__wire path')
  const ends = ['from', 'to'].map((end) => box(document.querySelector('[data-wire="' + end + '"]')))
  const d = path.getAttribute('d') || ''
  const nums = d.match(/-?[\\d.]+/g) || []
  return {
    on,
    stage: box(stage),
    canvas: box(canvas),
    canvasEdges: (() => {
      const r = canvas.getBoundingClientRect()
      return { left: round(r.left), right: round(r.right) }
    })(),
    column: (() => {
      /* The node grid's content edges. The grid element is itself the page shell, so its rect
         includes the gutter padding the grid does not draw in: comparing rect widths there is
         comparing a padded box with an unpadded one. */
      const el = document.querySelector('.work')
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        left: round(r.left + parseFloat(style.paddingLeft)),
        right: round(r.right - parseFloat(style.paddingRight)),
      }
    })(),
    docWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    items,
    wire: nums.length >= 8
      ? { x1: Number(nums[0]), y1: Number(nums[1]), x2: Number(nums[6]), y2: Number(nums[7]) }
      : null,
    sockets: ends.map((b) => ({ x: round(b.x + b.w / 2), y: round(b.y + b.h / 2) })),
  }
})()`

const overlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const page = await launchChrome({
  port: 9351,
  profile: '/tmp/coda-node-anatomy-profile',
  width: WIDTHS[0],
  height: 1000,
})
const report = probeReport()

for (const width of WIDTHS) {
  await page.setDevice(width, 1000, 1)
  await page.send('Page.navigate', { url: URL })
  /* The `js` class is claimed by `mountAnatomy`, so this waits for the *module*, not for the
     markup — the boxes are in the static html from the first byte and would let a measurement
     through before anything had measured. */
  await page.waitFor(
    `document.documentElement.classList.contains('js') && !!document.querySelector('.anat__item')`,
    'the anatomy figure',
  )
  // One frame past the measurement pass, which is scheduled on a rAF.
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const m = await page.evaluate(MEASURE)

  console.log(`\n${width}px — ${m.on ? 'stage' : 'list'}`)
  report.check(
    m.docWidth <= m.viewport,
    `the document fits the viewport (${m.docWidth} ≤ ${m.viewport})`,
  )
  /* The figure's canvas is the page's own column, so the section shares the left and right edge
     of the node grid below rather than sitting in a narrower gutter of its own. */
  report.check(
    Math.abs(m.canvasEdges.left - m.column.left) <= 1 &&
      Math.abs(m.canvasEdges.right - m.column.right) <= 1,
    `the canvas shares the node grid's edges (${m.canvasEdges.left}–${m.canvasEdges.right} vs ${m.column.left}–${m.column.right})`,
  )

  if (!m.on) {
    /* The fallback is not a degraded figure, it is the words: every note has to be readable, and
       nothing may be pointing at anything. */
    report.check(
      m.items.every((i) => i.noteShown),
      `all ${m.items.length} notes are visible with the figure stood down`,
    )
    continue
  }

  const off = m.items.filter(
    (i) => i.label.x < -1 || i.label.y < -1 || i.label.x + i.label.w > m.stage.w + 1,
  )
  report.check(off.length === 0, `every label is on the stage${off.length ? `: ${off.map((i) => i.id)}` : ''}`)

  const missed = m.items.filter((i) => !i.target || !overlap(i.mark, i.target))
  report.check(
    missed.length === 0,
    `every box lands on its part${missed.length ? `: ${missed.map((i) => i.id)}` : ''}`,
  )

  const clashes = []
  for (const a of m.items) {
    for (const b of m.items) {
      if (a.id >= b.id) continue
      if (overlap(a.label, b.label)) clashes.push(`${a.id}/${b.id}`)
    }
  }
  report.check(clashes.length === 0, `no two labels overlap${clashes.length ? `: ${clashes}` : ''}`)

  const panels = m.items.filter((i) => i.note.x < -1 || i.note.x + i.note.w > m.stage.w + 1)
  report.check(
    panels.length === 0,
    `every hover panel stays on the stage${panels.length ? `: ${panels.map((i) => i.id)}` : ''}`,
  )

  const near = (a, b) => Math.abs(a - b) <= 1
  report.check(
    m.wire !== null &&
      near(m.wire.x1, m.sockets[0].x) &&
      near(m.wire.y1, m.sockets[0].y) &&
      near(m.wire.x2, m.sockets[1].x) &&
      near(m.wire.y2, m.sockets[1].y),
    'the wire ends on both sockets',
  )

  if (args.keep) {
    console.log(`  ${await page.screenshot(`node-anatomy-${width}`)}`)
  }
}

page.close()
report.finish('Run `pnpm dev --port 5177` first, or pass --url.')
