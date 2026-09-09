#!/usr/bin/env node
/**
 * Where an output port's hover preview lands, at two canvas zooms.
 * `pnpm probe:port-preview` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * Everything about this panel that can be wrong is about layout, and jsdom performs none — it
 * reports one constant rect for every element, applies no transform, and measures every panel at
 * zero height. So the unit suite can say the panel opens, closes and carries the right rows, and
 * cannot say whether it is readable, clipped, or drawn at the pane's scale.
 *
 * Four properties, each a way this could be broken with the whole suite green:
 *
 * 1. **It is not clipped.** `.coda-node` declares `overflow: clip` (that is what makes a socket
 *    sit half in and half out), and the panel hangs off a socket on that very edge. It is
 *    portalled to `document.fullscreenElement ?? document.body`, and `elementFromPoint` at its
 *    own centre is what says the clip does not reach it — a `getBoundingClientRect` is reported
 *    happily for a box some ancestor has cut away entirely.
 * 2. **It is not transformed.** React Flow pans and zooms by writing a `transform` onto
 *    `.react-flow__viewport`, and a transform makes an ancestor the containing block for
 *    `position: fixed`. Measured at two zooms: a panel inside the pane would be *half the size*
 *    at 0.5×, which is 5px type. Its size is content-driven, so the check is that the two
 *    measurements agree — not that either matches a constant.
 * 3. **It opens clear of the card.** The reason the port preview prefers *right* where the
 *    thumbnail preview prefers left (`hoverPlacement`): the card whose output this is lies to
 *    the socket's left. Checked against the card's own right edge.
 * 4. **The socket moving dismisses it.** A canvas pan fires no `scroll` and no event on the
 *    socket at all; the dismissal is a per-frame watch on the rect, and this is the only place
 *    a pane that really moves can exercise it.
 *
 * It runs on `mock.opticlobe`, the synthetic connectome the demo links use, so it needs no
 * credential and reaches no server.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport, PANE_ZOOM, RECT } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const keep = args.keep

const { send, evaluate, waitFor, screenshot, mouseTo, drag, close } = await launchChrome({
  port: 9424,
  profile: '/tmp/coda-probe-port-preview',
  width: 1600,
  height: 1000,
})

const READ_PANEL = `(() => {
  const rect = (${RECT})
  const el = document.querySelector('.port-preview')
  if (!el) return null
  const box = rect('.port-preview')
  const was = el.style.pointerEvents
  el.style.pointerEvents = 'auto'
  const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  el.style.pointerEvents = was
  return {
    box,
    hit: at ? at.tagName.toLowerCase() + (typeof at.className === 'string' && at.className ? '.' + at.className.split(' ')[0] : '') : null,
    host: el.parentElement === document.body ? 'body' : el.parentElement?.className ?? null,
    fields: el.querySelectorAll('.port-preview__field').length,
    values: el.querySelector('.port-preview__table tbody tr')?.querySelectorAll('td').length ?? 0,
    // The property TABLE_BUDGET_PX exists for: the panel counts the columns it drops, so
    // nothing else may be dropping any. A table wider than the box it sits in is CSS cutting one
    // in half underneath a footer that says otherwise.
    overflow: Math.max(0, ...[...el.querySelectorAll('.port-preview__table')].map((t) => t.scrollWidth)) - el.clientWidth + 20,
    fontPx: Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10,
    clipped: Math.max(0, el.scrollHeight - el.clientHeight),
    heads: [...el.querySelectorAll('.port-preview__table th')].map((th) => th.textContent),
    text: (el.textContent ?? '').slice(0, 80),
  }
})()`

/** The Find Neurons card's output socket, and the card it belongs to. */
const SOCKET = `(() => {
  const rect = (${RECT})
  const node = [...document.querySelectorAll('.react-flow__node')].find((n) =>
    n.querySelector('.socket.react-flow__handle-right[data-handleid="neurons"]'),
  )
  if (!node) return null
  const socket = node.querySelector('.socket.react-flow__handle-right[data-handleid="neurons"]')
  const r = socket.getBoundingClientRect()
  const c = node.getBoundingClientRect()
  return {
    socket: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) },
    card: { left: Math.round(c.left), top: Math.round(c.top), width: Math.round(c.width), right: Math.round(c.right) },
  }
})()`

/**
 * Dismiss whatever the launch sequence has put up.
 *
 * A fact about Coda's shell rather than about driving a browser, which is why it is here and not
 * in `lib/browserProbe.mjs` — see that file's note. A `demo://` route stands the sequence down by
 * itself on a first visit, so this is a backstop for a reused profile.
 */
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

await send('Page.navigate', { url: `${url}#!demo://neuron.findNeurons` })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()
// A demo auto-runs, and a preview only opens on a port that holds a value.
await waitFor(
  `!!document.querySelector('.socket.react-flow__handle-right[data-handleid="neurons"]')`,
  'a Find Neurons card',
)
await sleep(1500)

const { check, finish } = probeReport()

async function hoverSocket() {
  const found = await evaluate(SOCKET)
  if (!found) throw new Error('no Find Neurons output socket')
  const x = found.socket.left + found.socket.width / 2
  const y = found.socket.top + found.socket.height / 2
  // Two moves: the first parks the pointer elsewhere, so a socket the pointer is already over
  // still gets a `pointerenter`.
  await mouseTo(x, y - 220)
  await sleep(40)
  await mouseTo(x, y)
  await waitFor(`!!document.querySelector('.port-preview')`, 'the panel to open')
  // Past the measure-and-place layout effect.
  await sleep(200)
  return { ...found, panel: await evaluate(READ_PANEL) }
}

async function leave() {
  await mouseTo(6, 990)
  await waitFor(`!document.querySelector('.port-preview')`, 'the panel to close')
}

/**
 * Zoom the pane with the wheel.
 *
 * Not the controls rail: d3-zoom is React Flow's *native* wheel listener, so this is the gesture
 * a reader makes and the one that exercises the transform. The first version clicked
 * `.react-flow__controls-zoomout`, which this build does not render — and it failed silently,
 * reporting the same zoom twice and a "screen scale" check that then proved nothing. Hence the
 * check below that the zoom really moved.
 */
async function zoomOut(pane, steps = 6) {
  for (let i = 0; i < steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: pane.left + pane.width / 2,
      y: pane.top + pane.height / 2,
      deltaX: 0,
      deltaY: 120,
      buttons: 0,
    })
    await sleep(90)
  }
  await sleep(400)
}

// ── At the canvas's opening zoom ─────────────────────────────────────────────────────────────
const zoom1 = await evaluate(PANE_ZOOM)
const first = await hoverSocket()
console.log(
  `\nzoom ${zoom1.toFixed(3)}  card ${first.card.width}w right edge ${first.card.right}  ` +
    `socket at ${first.socket.left},${first.socket.top}`,
)
console.log(
  `      panel ${first.panel.box.width}×${first.panel.box.height} at ${first.panel.box.left},${first.panel.box.top}  ` +
    `${first.panel.fields} fields × ${first.panel.values - 2} value(s)  heads ${JSON.stringify(first.panel.heads)}  ${first.panel.fontPx}px  hit ${first.panel.hit}  ` +
    `table ${first.panel.overflow <= 0 ? `${-first.panel.overflow}px spare` : `${first.panel.overflow}px OVER`}`,
)
console.log(`      “${first.panel.text.replace(/\s+/g, ' ')}…”`)

check(first.panel.host === 'body', `portalled to the ${first.panel.host}, out of the card's clip`)
check(
  first.panel.hit?.startsWith('div.port-preview') ||
    first.panel.hit?.startsWith('table.port-preview') ||
    first.panel.hit?.startsWith('td') ||
    first.panel.hit?.startsWith('tr'),
  `hit-tested at its own centre (${first.panel.hit}) — \`.coda-node\`'s clip does not reach a body portal`,
)
check(
  first.panel.box.left >= first.card.right - first.socket.width,
  `opens clear of the card it belongs to (panel at ${first.panel.box.left}, card ends ${first.card.right})`,
)
check(
  first.panel.fields > 5,
  `draws all ${first.panel.fields} of the table's columns down the panel, ` +
    `with ${first.panel.values - 2} value each`,
)
check(
  first.panel.heads.join() === 'column,type,first row',
  `each of the three named (${first.panel.heads.join(' · ')}), so a pivoted row is not three unlabelled things`,
)
check(
  first.panel.overflow <= 0,
  `no column is clipped — the widest table is ${-first.panel.overflow}px inside the panel, ` +
    `so the "+N more columns" count is the only thing dropping any`,
)
check(
  first.panel.box.right <= 1600 && first.panel.box.bottom <= 1000 && first.panel.box.top >= 0,
  `inside the window (${first.panel.box.left},${first.panel.box.top} → ${first.panel.box.right},${first.panel.box.bottom})`,
)
/*
 * The pivot put the pressure on height, so this is the check that matters now: the panel is
 * `max-height: 70vh` with `overflow: hidden`, and a field list cut by CSS is the same unadmitted
 * truncation the column budget exists to prevent, one axis over.
 */
check(
  first.panel.clipped === 0,
  `no field is clipped — the panel is ${first.panel.box.height}px against a 700px ceiling`,
)
if (keep) console.log(`      → ${await screenshot('probe-port-preview-zoom1')}`)
await leave()

// ── Zoomed out, which is where a transformed ancestor would show ─────────────────────────────
const paneBox = await evaluate(`(${RECT})('.react-flow__pane')`)
await zoomOut(paneBox)
const zoom2 = await evaluate(PANE_ZOOM)
const small = await hoverSocket()
console.log(
  `\nzoom ${zoom2.toFixed(3)}  socket at ${small.socket.left},${small.socket.top}  ` +
    `panel ${small.panel.box.width}×${small.panel.box.height} at ${small.panel.box.left},${small.panel.box.top}  ${small.panel.fontPx}px`,
)
check(
  zoom2 < zoom1 - 0.05,
  `the pane really did zoom (${zoom1.toFixed(3)} → ${zoom2.toFixed(3)}), or the next check proves nothing`,
)
check(
  small.panel.fontPx === first.panel.fontPx && small.panel.box.width === first.panel.box.width,
  `drawn at screen scale at both zooms (${first.panel.box.width}px / ${first.panel.fontPx}px type), ` +
    `not the pane's ${(first.panel.box.width * (zoom2 / zoom1)).toFixed(0)}px`,
)
if (keep) console.log(`      → ${await screenshot('probe-port-preview-zoom-out')}`)

// ── The socket moving dismisses it ───────────────────────────────────────────────────────────
const pane = await evaluate(`(${RECT})('.react-flow__pane')`)
await drag(
  { x: pane.left + pane.width - 60, y: pane.top + pane.height - 60 },
  { x: pane.left + pane.width - 240, y: pane.top + pane.height - 180 },
)
await sleep(160)
const afterPan = await evaluate(`!!document.querySelector('.port-preview')`)
check(!afterPan, 'a canvas pan dismisses it, though it fires no scroll and no event on the socket')

// ── A network, which is the tallest thing this panel can draw ────────────────────────────────
/*
 * Two captioned tables in one panel — a network's nodes and its edges have separate schemas, and
 * a preview showing one of them would show the wrong one about half the time. Worth a second
 * navigation because it is also the worst case for height, and `max-height: 70vh` with a clip is
 * the only thing standing between that and a panel taller than the window.
 */
/*
 * Through `about:blank` first: a `Page.navigate` differing only in its *fragment* fires a
 * `hashchange` rather than loading a document, and the demo route is read at boot. Without this
 * the second measurement is silently the first graph again — which presented as "no network
 * output on this demo".
 */
await send('Page.navigate', { url: 'about:blank' })
await sleep(200)
await send('Page.navigate', { url: `${url}#!demo://out.network` })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount again')
await clearLaunch()
await sleep(2500)
const netSocket = await evaluate(`(() => {
  // By socket style rather than by port id: a network leaves several node types under several
  // names, and socketStyle is the one place that says which shape carries one.
  const s = document.querySelector('.socket.react-flow__handle-right[data-family="matrix"][data-shape="hex"]')
  if (!s) return null
  const r = s.getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
})()`)
if (!netSocket) {
  console.log('\nnetwork  no network output on this demo — the two-table case stands unmeasured')
} else {
  await mouseTo(netSocket.left + netSocket.width / 2, netSocket.top - 220)
  await sleep(40)
  await mouseTo(netSocket.left + netSocket.width / 2, netSocket.top + netSocket.height / 2)
  await waitFor(`!!document.querySelector('.port-preview')`, 'the network panel to open')
  await sleep(250)
  const net = await evaluate(READ_PANEL)
  const captions = await evaluate(
    `[...document.querySelectorAll('.port-preview__caption')].map((c) => c.textContent)`,
  )
  console.log(
    `\nnetwork  panel ${net.box.width}×${net.box.height} at ${net.box.left},${net.box.top}  ` +
      `captions ${JSON.stringify(captions)}  table ${net.overflow <= 0 ? `${-net.overflow}px spare` : `${net.overflow}px OVER`}`,
  )
  check(
    captions.join(',') === 'Nodes,Edges',
    `both of a network's tables, each named (${captions.join(', ')})`,
  )
  check(
    net.box.bottom <= 1000 && net.box.top >= 0,
    `the tallest case still fits the window (${net.box.height}px against 1000)`,
  )
  check(net.overflow <= 0, `neither table is clipped across (${-net.overflow}px spare)`)
  check(net.clipped === 0, `nor down it — two schemas stacked, ${net.box.height}px of them`)
  if (keep) console.log(`      → ${await screenshot('probe-port-preview-network')}`)
}

close()
finish('See the note at the top of this file.')
