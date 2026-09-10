#!/usr/bin/env node
/**
 * The Explore overlay's editable header, in a real browser.
 * `pnpm probe:explore-columns` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * Every column is now its own grid track — a text column, a figure, and each mark, where the marks
 * used to share one track and a label row laid out on their pitch — and the header is a row of
 * buttons in the same template. Whether a label sits over the values it names is a fact about
 * layout, and jsdom performs none: `explore.test.tsx` can count one header cell per row cell, and
 * that count is equally true of a header sitting a column to the left.
 *
 * Five properties, each a way the change could be wrong while the suite passes:
 *
 * 1. **Every header cell sits over its column**, on the first row and the last, before and after a
 *    column is added — the template is rebuilt from the list, so an added track is a new chance to
 *    disagree.
 * 2. **The editor is on screen and on top.** It is `position: fixed` inside `.overlay__panel`,
 *    which is `overflow: hidden`; a transform on any ancestor would make that the containing block
 *    and the clip would reach it. Hit-tested at its own centre, since a rect is reported for a box
 *    a clip has cut away entirely.
 * 3. **It hangs from the cell that opened it**, not from the pointer or the panel.
 * 4. **Escape closes the editor and leaves the overlay**, which is `.context-menu`'s arrangement
 *    with `ViewerOverlay` and holds only while the editor wears that class.
 * 5. **Nothing in the editor is squeezed under its neighbour.** It is a flex column under a
 *    `max-height`, and once its content outgrows that, every child is allowed to shrink — the
 *    caption (`overflow: hidden`, so its automatic minimum is zero) first, which put the filter
 *    box over the title on fish2's 35-field list. Only the field list may give up height.
 *
 * On `mock.opticlobe` through `#!demo://neuron.explore`, like `probe-explore-preview.mjs`: no
 * credential, no server. The fields merged are the first two the editor marks as numbers.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

const { send, evaluate, waitFor, screenshot, rect, click, close } = await launchChrome({
  port: 9424,
  profile: '/tmp/coda-probe-explore-columns',
  width: 1600,
  height: 1000,
})

/** A real click at an element's centre — the popovers' dismissal listens for a real `pointerdown`. */
async function clickSelector(selector, what) {
  const box = await rect(selector)
  if (!box) throw new Error(`no ${what} (${selector})`)
  await click(box.left + box.width / 2, box.top + box.height / 2)
  return box
}

/**
 * Header cells against a row's cells, track by track, in one page-side read.
 *
 * Grid children from the fourth on — the first three are the checkbox, tile and name block, which
 * the header names with empty spans. The header's last child is the `+`, which no row fills.
 */
const ALIGNMENT = `(() => {
  const panel = document.querySelector('.overlay__panel')
  const head = panel?.querySelector('.explore-head')
  const rows = panel ? [...panel.querySelectorAll('.explore-row')] : []
  if (!head || rows.length === 0) return null
  const cells = [...head.children].slice(3, -1)
  const track = (row) => [...row.children].slice(3)
  const edge = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) } }
  const compare = (row) => cells.map((cell, i) => {
    const value = track(row)[i]
    return { label: cell.textContent, head: edge(cell), value: value ? edge(value) : null }
  })
  return { first: compare(rows[0]), last: compare(rows[rows.length - 1]), rowTracks: track(rows[0]).length }
})()`

const EDITOR = `(() => {
  const el = document.querySelector('.explore-colmenu')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
    width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
    inside: !!at && el.contains(at),
    title: el.getAttribute('aria-label'),
  }
})()`

/** Property 5: the editor's children in order, none overlapping the next, none clipped short. */
const STACKING = `(() => {
  const el = document.querySelector('.explore-colmenu')
  const kids = [...el.children].map((c) => {
    const r = c.getBoundingClientRect()
    return { name: String(c.className || c.tagName).split(' ')[0], top: r.top, bottom: r.bottom, client: c.clientHeight, scroll: c.scrollHeight }
  })
  const overlaps = []
  for (let i = 1; i < kids.length; i++) if (kids[i].top < kids[i - 1].bottom - 0.5) overlaps.push(kids[i - 1].name + ' under ' + kids[i].name)
  const squeezed = kids.filter((k) => k.name !== 'explore-colmenu__fields' && k.client + 1 < k.scroll).map((k) => k.name)
  return { overlaps, squeezed, caption: Math.round(kids[0].bottom - kids[0].top) }
})()`

async function checkStacking(which) {
  const s = await evaluate(STACKING)
  check(
    s.overlaps.length === 0 && s.squeezed.length === 0,
    `${which}: nothing squeezed (caption ${s.caption}px tall)` +
      (s.overlaps.length ? ` — overlapping: ${s.overlaps.join(', ')}` : '') +
      (s.squeezed.length ? ` — clipped: ${s.squeezed.join(', ')}` : ''),
  )
}

// ── Open the overlay on the demo workflow ────────────────────────────────────────────────────
// One navigation, nothing removed from the DOM — `probe-explore-preview.mjs` records why.
await send('Page.navigate', { url: `${url}#!demo://neuron.explore` })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
for (let i = 0; i < 20; i++) {
  const clear = await evaluate(`(() => {
    document.querySelector('.small-screen__actions button')?.click()
    document.querySelector('.start__close')?.click()
    document.querySelector('.overlay__close, .overlay [aria-label="Close"]')?.click()
    return !document.querySelector('.start') && !document.querySelector('.overlay')
  })()`)
  if (clear) break
  await sleep(150)
}
await waitFor(`!!document.querySelector('.explore-thumb-slot')`, 'the Explore card')
await evaluate(`document.querySelector('.explore-thumb-slot').closest('.coda-node').querySelector('[aria-label="Expand output"]').click()`)
await waitFor(`!!document.querySelector('.overlay__panel .explore-head')`, 'the overlay header')
await waitFor(`document.querySelectorAll('.overlay__panel .explore-row').length > 3`, 'the overlay rows')

const { check, finish } = probeReport()

/** Property 1, on both rows. Where a value cell is missing, the row has fewer tracks than labels. */
function checkAligned(when) {
  return evaluate(ALIGNMENT).then((a) => {
    if (!a) throw new Error('no header or rows to compare')
    for (const [which, list] of [['first', a.first], ['last', a.last]]) {
      const off = list.filter((c) => !c.value || Math.abs(c.head.left - c.value.left) > 1 || Math.abs(c.head.width - c.value.width) > 1)
      check(
        off.length === 0,
        `${when}: ${list.length} labels over their ${which} row's cells` +
          (off.length ? ` — off: ${off.map((c) => `${c.label} ${c.head.left}/${c.value?.left ?? 'none'}`).join(', ')}` : ''),
      )
    }
    console.log(`      ${a.first.map((c) => `${c.label}@${c.head.left}+${c.head.width}`).join('  ')}`)
    return a
  })
}

// ── 1. The automatic header ──────────────────────────────────────────────────────────────────
const before = await checkAligned('automatic')

// ── 2. The + opens its menu on screen and on top ─────────────────────────────────────────────
const plus = await clickSelector('.overlay__panel .explore-head__add', 'add button')
await waitFor(`!!document.querySelector('.explore-fieldmenu')`, 'the add menu to open')
const adding = await evaluate(EDITOR)
console.log(`\neditor ${adding.right - adding.left}×${adding.bottom - adding.top} at ${adding.left},${adding.top} (window ${adding.width}×${adding.height}); + at ${plus.left},${plus.bottom}`)
check(
  adding.left >= 0 && adding.top >= 0 && adding.right <= adding.width && adding.bottom <= adding.height,
  'the add menu is wholly inside the window',
)
check(adding.inside, 'hit-tested at its own centre — neither the panel nor the list clips it')
await checkStacking('the add menu')
if (keep) console.log(`      → ${await screenshot('probe-explore-columns-fieldmenu')}`)

// Its column | chip pairs are readable: both halves inside the menu, neither clipped.
const pair = await evaluate(`(() => {
  const menu = document.querySelector('.explore-fieldmenu').getBoundingClientRect()
  const choice = document.querySelector('.explore-place__choice').getBoundingClientRect()
  const [a, b] = [...document.querySelectorAll('.explore-place__choice')][0].children
  return { inside: choice.right <= menu.right - 2, a: a.scrollWidth <= a.clientWidth, b: b.scrollWidth <= b.clientWidth }
})()`)
check(pair.inside && pair.a && pair.b, 'each field’s column | chip pair sits inside the menu, unclipped')

// The merge editor is one step further, behind "Combine…".
await clickSelector('.explore-fieldmenu__combine', 'combine button')
await waitFor(
  `!!document.querySelector('.explore-colmenu[aria-label="Add a column"]')`,
  'the combine editor to open',
)

// Tick the first two numbers, choose the donut, add.
const merged = await evaluate(`(() => {
  const numbers = [...document.querySelectorAll('.explore-colmenu__field')]
    .filter((row) => row.querySelector('.explore-colmenu__kind')?.textContent === '#')
    .slice(0, 2)
  const names = numbers.map((row) => row.querySelector('.explore-colmenu__name').textContent)
  for (const row of numbers) row.querySelector('input').click()
  return names
})()`)
await sleep(50)
await evaluate(`[...document.querySelectorAll('.explore-colmenu__render')].find((l) => l.textContent.trim() === 'Donut').querySelector('input').click()`)
await sleep(50)
await clickSelector('.explore-colmenu__apply', 'apply button')
await waitFor(`!document.querySelector('.explore-colmenu')`, 'the editor to close on Add')
const label = merged.join('/')
const heads = await evaluate(`[...document.querySelectorAll('.overlay__panel .explore-head__cell')].map((c) => c.textContent)`)
check(heads.at(-1) === label, `the merged column ${label} is the header's last`)
const ring = await evaluate(`(() => {
  const row = document.querySelector('.overlay__panel .explore-row')
  const cell = [...row.children].at(-1)
  return cell?.tagName.toLowerCase() === 'svg' ? cell.querySelectorAll('circle').length : 0
})()`)
check(ring === 2, `and every row draws it as a ring of ${ring} segments`)

// ── 1 again, on the template the list rebuilt ────────────────────────────────────────────────
const after = await checkAligned('after adding')
check(after.first.length === before.first.length + 1, 'one more track than before')
if (keep) console.log(`      → ${await screenshot('probe-explore-columns-added')}`)

// ── 3. A header cell's editor hangs from that cell ───────────────────────────────────────────
const target = await evaluate(`(() => {
  const cells = [...document.querySelectorAll('.overlay__panel .explore-head__cell')]
  const i = cells.findIndex((c) => c.classList.contains('explore-head__cell--stat'))
  return i
})()`)
const cell = await clickSelector(`.overlay__panel .explore-head > :nth-child(${4 + target})`, 'a figure header')
await waitFor(`!!document.querySelector('.explore-colmenu')`, 'the column editor to open')
const editing = await evaluate(EDITOR)
console.log(`\n${editing.title}: cell ${cell.left},${cell.bottom} → editor ${editing.left},${editing.top}`)
check(
  editing.top >= cell.bottom && editing.top - cell.bottom <= 8,
  `opens just below the cell it names (${editing.top - cell.bottom}px)`,
)
check(
  Math.abs(editing.left - cell.left) <= 1 || editing.right <= editing.width - 4,
  `at the cell's left edge (${editing.left} against ${cell.left}), or clamped inside the window`,
)
check(editing.inside, 'and on top')
await checkStacking('a column editor with every section showing')
/*
 * The mock publishes six fields and fish2 about thirty-five, so the mock's editor fits under its
 * cap and cannot show the squeeze. What a long list does is make the content taller than the cap,
 * and capping the open editor lower does exactly that on any dataset.
 */
await evaluate(`document.querySelector('.explore-colmenu').style.maxHeight = '300px'`)
await sleep(50)
await checkStacking('the same editor capped at 300px, as a long field list leaves it')
if (keep) console.log(`      → ${await screenshot('probe-explore-columns-editor')}`)

// ── 4. Escape closes the editor and not the overlay ──────────────────────────────────────────
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
await sleep(150)
const state = await evaluate(`({ editor: !!document.querySelector('.explore-colmenu'), overlay: !!document.querySelector('.overlay__panel') })`)
check(!state.editor && state.overlay, `Escape closes the editor (${state.editor ? 'still open' : 'closed'}) and leaves the overlay (${state.overlay ? 'open' : 'closed'})`)

close()
finish('See the note at the top of this file.')
