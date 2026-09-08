#!/usr/bin/env node
/**
 * What the app shell measures on a phone. `pnpm probe:mobile`.
 *
 * ## Why this exists
 *
 * jsdom performs no layout, so nothing in the suite can see the failure this was written for:
 * the toolbar's controls come to more min-content width than a phone's viewport, and without a
 * wrap they overflow. An overflowing row does not clip — it makes the *document* wider than the
 * viewport, and a mobile browser answers that by zooming out far enough to fit it. Everything
 * the reader then sees follows from one number: the page opens at 42% scale, the shell (which is
 * `100dvh`) fills the top 42% of the screen, and the status bar hangs in mid-air above the
 * bottom edge with the body's background under it. It reads as a broken layout and it is an
 * overflowing flex row.
 *
 * A desktop browser at 412px shows none of this. It has an ordinary scrollbar and no minimum
 * scale, so the same document is merely scrollable — which is why the bug was reproducible on a
 * Pixel 7 and "much better behaved" in the responsive-design tools on the same machine.
 *
 * So the measurement has to be taken in a real browser told it is a phone, and the numbers worth
 * watching are `document.scrollWidth` against `documentElement.clientWidth`. Equal is the whole
 * property: **the document must never be wider than the viewport it was given.**
 *
 * ## How
 *
 * Chrome over the DevTools protocol, with no dependency to install — Node 22+ has a global
 * `WebSocket` and `Emulation.setDeviceMetricsOverride` is what makes the difference between a
 * narrow desktop window and a phone. It drives whatever is being served, so run `pnpm dev` (or
 * `pnpm preview`) first, or pass a deployed URL.
 *
 *   pnpm probe:mobile
 *   pnpm probe:mobile -- --url https://…/coda/ --keep
 *
 * `--keep` writes a screenshot per device beside the repo. Exit code is 1 if any device
 * overflows, so this can be a check rather than only a reading.
 *
 * What it does *not* check is anything about touch: a control that fits is not a control a
 * finger can hit, and none of that is visible from here. See docs/ui-shell.md.
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/*
 * Real CSS-pixel viewports, in the two orientations that behave differently — portrait is where
 * the overflow was worst and landscape is where it nearly fits, which is exactly how it was
 * reported. The tablet is the control: it is above `NARROW_QUERY`, so it must keep the whole
 * toolbar rather than folding into `⋯` — measured, it takes two rows there, because 744 is under
 * the row's 973px of min-content width and the wrap is what catches that. Two rows with every
 * control on them is the point: before the wrap, a tablet had them off the right-hand edge.
 */
const DEVICES = [
  { name: 'Pixel 7 portrait', width: 412, height: 915, dpr: 2.625 },
  { name: 'Pixel 7 landscape', width: 915, height: 412, dpr: 2.625 },
  { name: 'iPhone SE portrait', width: 375, height: 667, dpr: 2 },
  { name: 'iPad mini portrait', width: 744, height: 1133, dpr: 2 },
]

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9422

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://localhost:5177/'
const keep = args.includes('--keep')

function valueOf(flag) {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

if (!existsSync(CHROME)) {
  console.error(`No Chrome at ${CHROME}. Set CHROME_PATH.`)
  process.exit(2)
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-first-run',
    '--user-data-dir=/tmp/coda-probe-mobile',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

/** The DevTools page target, once Chrome is listening. */
async function firstPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  throw new Error('Chrome never opened a page target')
}

const page = await firstPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const settle = pending.get(message.id)
  if (settle) {
    pending.delete(message.id)
    settle(message)
  }
}

function send(method, params = {}) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

/** Poll an expression until it answers truthily. Beats a fixed sleep on both ends: a fast
    machine does not wait 3.5s, a slow one is not measured half-built. */
async function waitFor(expression, what) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const failed = reply.result?.exceptionDetails
  if (failed) throw new Error(failed.exception?.description ?? failed.text)
  return reply.result?.result?.value
}

/*
 * Read back in one round trip. `scrollWidth` against `clientWidth` is the property; the rest is
 * what makes a failure diagnosable — the toolbar's own min-content width names the cause, and
 * the list of boxes reaching past the viewport names the control that grew.
 */
const MEASURE = `(() => {
  const root = document.documentElement
  const px = (n) => Math.round(n)
  const box = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { w: px(rect.width), h: px(rect.height), top: px(rect.top), scrollW: el.scrollWidth }
  }
  /*
   * Counted rather than divided out of the height, which only holds while a row is the height
   * somebody assumed — and counted by **x**, not by y: the children are different heights and
   * centred, so within one row their tops all differ. A wrapping row fills left to right, so a
   * child that starts further left than the one before it began a new row.
   */
  const bar = document.querySelector('.toolbar')
  const laid = bar
    ? [...bar.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0)
    : []
  const rows = laid.reduce(
    (n, r, i) => (i > 0 && r.left <= laid[i - 1].left ? n + 1 : n),
    laid.length > 0 ? 1 : 0,
  )
  const past = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.right > root.clientWidth + 1
    })
    .slice(0, 8)
    .map((el) => {
      const name = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
      return el.tagName.toLowerCase() + (name ? '.' + name : '') +
        ' right=' + Math.round(el.getBoundingClientRect().right)
    })
  return {
    docW: root.scrollWidth,
    viewW: root.clientWidth,
    viewH: root.clientHeight,
    narrow: !!document.querySelector('.app[data-narrow]'),
    toolbar: box('.toolbar'),
    rows,
    status: box('.statusbar'),
    canvas: box('.canvas-area'),
    past,
  }
})()`

await send('Page.enable')
await send('Runtime.enable')

let failures = 0
for (const device of DEVICES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.dpr,
    mobile: device.width < 744,
    screenWidth: device.width,
    screenHeight: device.height,
  })
  await send('Page.navigate', { url })
  await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
  /*
   * Past the small-screen notice and the first-run guides dialog — neither is the subject, and
   * the notice is opaque, so a screenshot taken in front of it says nothing about the shell.
   * Clicked rather than pre-seeded in `localStorage`, so this measures what a reader who pressed
   * "Open it anyway" actually gets.
   */
  await evaluate(`(() => {
    document.querySelector('.small-screen__actions button')?.click()
    return true
  })()`)
  await waitFor(`!document.querySelector('.small-screen')`, 'the notice to go')
  await evaluate(`(() => {
    for (const el of document.querySelectorAll('.overlay')) el.remove()
    return true
  })()`)
  await waitFor(`document.querySelectorAll('.overlay').length === 0`, 'the dialogs to go')

  const m = await evaluate(MEASURE)
  const overflows = m.docW > m.viewW
  if (overflows) failures++
  console.log(
    `${overflows ? '✗' : '✓'} ${device.name.padEnd(20)} ` +
      `document ${String(m.docW).padStart(4)} / viewport ${String(m.viewW).padStart(4)}  ` +
      `toolbar ${String(m.toolbar?.h ?? 0).padStart(3)}px (${m.rows} row${m.rows === 1 ? '' : 's'}, ` +
      `min-content ${m.toolbar?.scrollW ?? 0})  ` +
      `canvas ${m.canvas?.h ?? 0}px  ` +
      `status at ${m.status?.top ?? 0} of ${m.viewH}  ` +
      `${m.narrow ? 'narrow' : 'wide'}`,
  )
  /*
   * Only on a failure, and that is not tidiness: an element reaching past the viewport is
   * perfectly ordinary inside a scroller — the start page's card deck is `overflow-x: auto` and
   * every card past the third is legitimately out there. The list means something only when the
   * *document* grew, which is the line above.
   */
  if (overflows && m.past.length > 0) console.log(`    past the edge: ${m.past.join(', ')}`)

  if (keep) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    // Into the temp dir, not the working directory — this is run from the repo root, and a
    // handful of untracked PNGs there is the kind of thing that gets committed by accident.
    const file = join(tmpdir(), `probe-mobile-${device.name.replace(/\s+/g, '-').toLowerCase()}.png`)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`    → ${file}`)
  }
}

ws.close()
chrome.kill()

if (failures > 0) {
  console.error(
    `\n${failures} device(s) laid out wider than the viewport. A mobile browser answers that by ` +
      `zooming out to fit, which is what puts the status bar in mid-air — see the note at the ` +
      `top of this file.`,
  )
  process.exit(1)
}
