#!/usr/bin/env node
/**
 * Where an Explore row's hover preview lands, on a node card and in the overlay.
 * `pnpm probe:explore-preview` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * The preview was the overlay's alone, on a stated objection: inside a node card it would have
 * `.coda-node`'s clip to escape as well as the list's, from inside React Flow's transformed pane.
 * Every word of that is about layout, and jsdom performs none — it reports one constant rect for
 * every element and applies no transform, so nothing in the suite can tell a preview that lands
 * correctly from one that is clipped away or drawn at the pane's scale.
 *
 * Three properties, and each is a way the card version could be broken while the unit tests pass:
 *
 * 1. **The preview is not clipped.** It is portalled to `document.fullscreenElement ??
 *    document.body`, so `.coda-node`'s `overflow` and `.explore__list`'s cannot reach it. Checked
 *    by `elementFromPoint` at the preview's own centre: if a clip were reaching it, the point
 *    would answer with whatever is behind.
 * 2. **It is not transformed.** React Flow pans and zooms by writing a `transform` onto
 *    `.react-flow__viewport`, and a `transform` makes an ancestor the containing block for
 *    `position: fixed` — which is exactly why the portal matters. Checked by comparing the
 *    preview's measured size against `PREVIEW_SIZE`: inside the pane at 0.5× it would measure 160.
 * 3. **The tile moving dismisses it.** A canvas pan fires no `scroll` and no event of any kind on
 *    the tile; the dismissal is a per-frame watch on the rect, and this is the only place it can
 *    be exercised against a pane that actually moves.
 *
 * It runs on `mock.opticlobe`, the synthetic connectome the demo links use, so it needs no
 * credential and reaches no server: `#!demo://neuron.explore` opens a workflow with the card in
 * it. What that costs is the one thing this cannot check — a real dataset's fine body arrives over
 * the network, and how long the softer stand-in is up for is a fact about the source.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

/** What `NeuronThumbnail` declares. A mismatch here is the finding, not a stale constant. */
const PREVIEW_SIZE = 320
const TILE_COMPACT_PX = 56
const TILE_PX = 76

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9423,
  profile: '/tmp/coda-probe-explore-preview',
  width: 1600,
  height: 1000,
})

/*
 * A real mouse, not a synthetic event: the preview opens on `pointerenter` with
 * `pointerType === 'mouse'`, which is a distinction a dispatched `MouseEvent` does not carry —
 * the same trap the jsdom suite has its own note about. `Input.dispatchMouseEvent` goes in at the
 * browser's own input pipeline, so the pointer really is over the tile and really does leave.
 */
async function moveMouseTo(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
}

async function drag(from, to) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / 6,
      y: from.y + ((to.y - from.y) * i) / 6,
      button: 'left',
      buttons: 1,
    })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
}

const RECT = `(selector) => {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) }
}`

/**
 * The preview as measured, plus what is actually hit-tested at its centre.
 *
 * `elementFromPoint` is the half that says "not clipped": a `getBoundingClientRect` is happily
 * reported for a box some ancestor has cut away entirely, so the rect alone cannot tell a working
 * portal from a broken one — where hit testing walks the same clips painting does.
 *
 * **`pointer-events` has to be lifted for the question to mean anything.** The preview declares
 * `pointer-events: none` so a reader can drive the list underneath it, and that makes
 * `elementFromPoint` answer with whatever is behind — on the first run of this probe, a `td` in
 * another card, which reads exactly like a clip. Lifted and put back, so nothing downstream of
 * here sees a preview that would swallow the pointer.
 */
const READ_PREVIEW = `(() => {
  const rect = (${RECT})
  const el = document.querySelector('.explore-thumb-preview')
  if (!el) return null
  const box = rect('.explore-thumb-preview')
  const was = el.style.pointerEvents
  el.style.pointerEvents = 'auto'
  const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  el.style.pointerEvents = was
  return {
    box,
    hit: at ? at.tagName.toLowerCase() + (typeof at.className === 'string' && at.className ? '.' + at.className.split(' ')[0] : '') : null,
    canvas: rect('.explore-thumb-preview__canvas'),
    host: el.parentElement === document.body ? 'body' : el.parentElement?.className ?? null,
  }
})()`

/** The card holding the Explore list, which is not the first `.coda-node` on the canvas. */
const EXPLORE_CARD = `(() => {
  const card = document.querySelector('.explore-thumb-slot')?.closest('.coda-node')
  if (!card) return null
  const r = card.getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) }
})()`

/*
 * One navigation, straight to the demo route, and **nothing is removed from the DOM**. That is
 * worth stating because the obvious shortcut is `probe-mobile.mjs`', which clears the launch
 * sequence with `el.remove()`; it can afford to, never opening an overlay again. Here the ⤢ does,
 * and removing React-owned nodes leaves the reconciler holding a detached container — the click
 * lands, the store flips, and the panel mounts nowhere. That presents as "the expand control was
 * not found".
 *
 * A `demo://` route stands the launch sequence down by itself on a first visit, so the loop below
 * is a backstop for a reused profile rather than the normal path. Note also that a `Page.navigate`
 * differing only in its *fragment* fires a `hashchange` rather than loading a document, and the
 * route is read at boot — so this must be the first navigation, not a hash appended to one.
 */
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
await waitFor(
  `!document.querySelector('.start') && !document.querySelector('.overlay')`,
  'the launch sequence to close',
)
// A drawn tile, which is a mask rasterised from the synthetic connectome rather than a placeholder.
await waitFor(`!!document.querySelector('canvas.explore-thumb')`, 'a thumbnail to draw')

const { check, finish } = probeReport()

/** Hover the first tile, wait past `PREVIEW_DELAY_MS` and the fine build, and read it back. */
async function hoverFirstTile(scope = '') {
  const tile = await evaluate(`(${RECT})(${JSON.stringify(`${scope} .explore-thumb-slot`.trim())})`)
  if (!tile) throw new Error(`no tile under "${scope}"`)
  const x = tile.left + tile.width / 2
  const y = tile.top + tile.height / 2
  // Two moves: the first parks the pointer elsewhere, so a tile the pointer is *already* over
  // still gets a `pointerenter`. One move only worked by luck of where the last one left it.
  await moveMouseTo(x, y - 200)
  await sleep(30)
  await moveMouseTo(x, y)
  await waitFor(
    `!!document.querySelector('.explore-thumb-preview')`,
    `the preview to open over ${JSON.stringify(tile)} — ` +
      `${await evaluate(`(() => { const a = document.elementFromPoint(${x}, ${y}); return a ? a.tagName + '.' + a.className : 'nothing' })()`)} is on top`,
  )
  // Past the fine fetch and the first rock frames, so what is measured is the settled picture.
  await sleep(600)
  return { tile, preview: await evaluate(READ_PREVIEW) }
}

async function leave() {
  await moveMouseTo(4, 990)
  await waitFor(`!document.querySelector('.explore-thumb-preview')`, 'the preview to close')
}

// ── On the card, at the canvas's own zoom ────────────────────────────────────────────────────
const zoom = await evaluate(
  `Number(/scale\\((.*?)\\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '')?.[1] ?? 1)`,
)
const card = await evaluate(EXPLORE_CARD)
const onCard = await hoverFirstTile()
console.log(
  `\ncard  pane zoom ${zoom.toFixed(3)}  card ${card.width}×${card.height} at ${card.left},${card.top}  ` +
    `tile ${onCard.tile.width}×${onCard.tile.height} at ${onCard.tile.left},${onCard.tile.top}`,
)
console.log(
  `      preview ${onCard.preview.box.width}×${onCard.preview.box.height} at ` +
    `${onCard.preview.box.left},${onCard.preview.box.top}  canvas ${onCard.preview.canvas.width}px  hit ${onCard.preview.hit}`,
)
check(
  onCard.preview.canvas.width === PREVIEW_SIZE,
  `drawn at ${PREVIEW_SIZE}, not at the pane's ${(PREVIEW_SIZE * zoom).toFixed(0)} — no transformed ancestor`,
)
check(
  onCard.preview.host === 'body',
  `portalled to the ${onCard.preview.host}, out of the card and out of the list`,
)
check(
  onCard.preview.hit?.startsWith('canvas.explore-thumb-preview'),
  `hit-tested at its own centre (${onCard.preview.hit}) — neither clip reaches a body portal`,
)
/*
 * Against the *canvas*, not the box: `previewPlacement` places `PREVIEW_SIZE` and the element is
 * that plus 6px of padding and a 1px border on each side, so the chrome eats 7 of the 10px gap
 * and the box's border finishes 4px past the tile's left edge while the picture finishes 3px
 * short of it. Worth knowing rather than worth fixing — the same 14px is already in the table
 * `PREVIEW_SIZE` records, which is measured in box edges.
 */
check(
  onCard.preview.canvas.right <= onCard.tile.left,
  `opens left, the picture clear of the tile by ${onCard.tile.left - onCard.preview.canvas.right}px ` +
    `(box edge ${onCard.preview.box.right - onCard.tile.left}px past it, which is its own chrome)`,
)
check(
  Math.abs(onCard.tile.width / zoom - TILE_COMPACT_PX) < 1.5,
  `the compact tile is ${TILE_COMPACT_PX} unscaled (${onCard.tile.width} at ${zoom.toFixed(3)}×)`,
)

if (keep) console.log(`      → ${await screenshot('probe-explore-preview-card')}`)

// ── The tile moving dismisses it ─────────────────────────────────────────────────────────────
/*
 * Panning the canvas, which is the case the watch exists for: React Flow writes a `transform`, so
 * the tile slides out from under the pointer having fired no `scroll` and no event on itself. The
 * drag starts on the pane well clear of the card, and the preview must be gone by the end of it.
 */
const pane = await evaluate(`(${RECT})('.react-flow__pane')`)
await drag(
  { x: pane.left + pane.width - 40, y: pane.top + pane.height - 40 },
  { x: pane.left + pane.width - 200, y: pane.top + pane.height - 160 },
)
await sleep(120)
const afterPan = await evaluate(`!!document.querySelector('.explore-thumb-preview')`)
check(!afterPan, 'a canvas pan dismisses it, though it fires no scroll and no event on the tile')
await leave()

// ── In the overlay, for the comparison the card version is judged against ────────────────────
const pressed = await evaluate(`(() => {
  const card = document.querySelector('.explore-thumb-slot')?.closest('.coda-node')
  const button = card?.querySelector('[aria-label="Expand output"]')
  button?.click()
  return !!button
})()`)
if (!pressed) console.log('\n(no ⤢ on the Explore card)')
let expanded = false
for (let i = 0; i < 40 && !expanded; i++) {
  expanded = await evaluate(`!!document.querySelector('.overlay__panel .explore-thumb-slot')`)
  if (!expanded) await sleep(100)
}
if (expanded) {
  await waitFor(`!!document.querySelector('.overlay__panel canvas.explore-thumb')`, 'the overlay tiles')
  // Scoped: the card's own tiles are still in the document behind the overlay, and the first in
  // document order is one of those — under a panel the pointer cannot reach.
  const overlay = await hoverFirstTile('.overlay__panel')
  console.log(
    `\noverlay  tile ${overlay.tile.width}×${overlay.tile.height} at ${overlay.tile.left},${overlay.tile.top}  ` +
      `preview ${overlay.preview.box.width}×${overlay.preview.box.height} at ${overlay.preview.box.left},${overlay.preview.box.top}  ` +
      `canvas ${overlay.preview.canvas.width}px  hit ${overlay.preview.hit}`,
  )
  check(
    overlay.preview.canvas.width === onCard.preview.canvas.width,
    `the same picture on both surfaces (${TILE_PX}px tile against ${TILE_COMPACT_PX}px) — only the stand-in differs`,
  )
  if (keep) console.log(`      → ${await screenshot('probe-explore-preview-overlay')}`)
} else {
  console.log('\noverlay  not opened — the expand control was not found; card measurements stand alone')
}

close()
finish('See the note at the top of this file.')
