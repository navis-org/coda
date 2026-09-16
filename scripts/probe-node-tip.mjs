#!/usr/bin/env node
/**
 * Where the node browser's hover tip lands, and the two ways it goes away.
 * `pnpm probe:node-tip` (needs `pnpm dev --port 5183`, or pass `--url`; `--width` to re-measure).
 *
 * ## Why this exists
 *
 * The tip's content is a string off the registry and the unit suite reads it. Everything else
 * about it is layout, and jsdom performs none — one constant rect per element, every panel
 * measured at zero height. Four properties, each of which can be broken with the whole suite
 * green:
 *
 * 1. **It is not clipped.** The browser is a `.overlay__panel`, which is `overflow: hidden`, and
 *    `.node-browser__list` scrolls — which clips *both* axes. That is what the portal is for, and
 *    `elementFromPoint` at the tip's own centre is the only thing that says so: a rect is reported
 *    happily for a box an ancestor has cut away entirely.
 * 2. **It clears the row's words.** The reason it prefers *right* (`hoverPlacement`): what the
 *    reader is comparing against is this row's name and description and the rows either side, all
 *    of them inside the modal. Measured against the row's own left edge, at three widths, because
 *    the modal caps at 1080px and the gutter beyond it is what the preference spends — 1600 leaves
 *    it whole in the gutter, 1180 and 820 clamp it back over the meta column, which is the trade
 *    `hoverPlacement` argues for against a flip.
 * 3. **A scroll takes it away.** The dismissal is a per-frame watch on the anchor's rect, not a
 *    `scroll` listener, and this is the only place a list that really scrolls can exercise it.
 * 4. **The pointer is mouse.** A dispatched `MouseEvent` carries no `pointerType`, and the gesture
 *    is mouse-only on purpose, so the pointer has to go in at the browser's input pipeline.
 *
 * It opens no dataset and reaches no server: the browser lists the registry.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport, RECT } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5183/'
const width = Number(args.value('--width') ?? 1600)
const height = 1000

/** How much of the row's left end must stay uncovered: the thumbnail, the name, the description. */
const WORDS_PX = 360

const { send, evaluate, waitFor, screenshot, mouseTo, close } = await launchChrome({
  port: 9431,
  profile: '/tmp/coda-probe-node-tip',
  width,
  height,
})
const report = probeReport()

const READ = `(() => {
  const rect = (${RECT})
  const el = document.querySelector('.node-guide-tip')
  if (!el) return null
  const box = rect('.node-guide-tip')
  // The panel is \`pointer-events: none\`, so it has to be given the pointer back for one hit test.
  const was = el.style.pointerEvents
  el.style.pointerEvents = 'auto'
  const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  el.style.pointerEvents = was
  return {
    box,
    hit: at ? at.tagName.toLowerCase() + (typeof at.className === 'string' && at.className ? '.' + at.className.split(' ')[0] : '') : null,
    host: el.parentElement === document.body ? 'body' : el.parentElement?.className ?? null,
    overflow: Math.max(0, el.scrollWidth - el.clientWidth) + Math.max(0, el.scrollHeight - el.clientHeight),
    fontPx: Math.round(parseFloat(getComputedStyle(el.querySelector('.node-guide-tip__text')).fontSize) * 10) / 10,
    name: el.querySelector('.node-guide-tip__name')?.textContent,
  }
})()`

/**
 * Dismiss whatever the launch sequence has put up.
 *
 * A fact about Coda's shell rather than about driving a browser — see `lib/browserProbe.mjs`.
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

async function key(k) {
  const init = { key: k, code: k, windowsVirtualKeyCode: k === 'Tab' ? 9 : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...init })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...init })
}

await send('Page.navigate', { url })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()
await key('Tab')
await waitFor(`!!document.querySelector('.node-browser')`, 'the node browser to open')

/** A row a few down the list, so the tip is placed against a row with neighbours either side. */
const row = await evaluate(`(() => {
  const rect = (${RECT})
  const pick = [...document.querySelectorAll('.node-row')][4]
  pick.setAttribute('data-probe', '1')
  return { box: rect('.node-row[data-probe="1"]'), name: pick.querySelector('.node-row__name')?.textContent }
})()`)
console.log(`window ${width}×${height} · row "${row.name}" at ${row.box.left}, ${row.box.width} wide`)

const cx = row.box.left + row.box.width / 2
const cy = row.box.top + row.box.height / 2
// Arriving from a neighbouring point, so the gesture is a real crossing and then a rest.
await mouseTo(cx - 40, cy)
await mouseTo(cx, cy)
await sleep(600)

const tip = await evaluate(READ)
report.check(!!tip, 'a rest on a row opens the tip')
if (tip) {
  console.log(`tip "${tip.name}" at ${tip.box.left}, ${tip.box.width}×${tip.box.height}`)
  report.check(tip.host === 'body', `portalled out of the modal (host: ${tip.host})`)
  report.check(
    (tip.hit ?? '').includes('node-guide-tip') || tip.hit === 'div.hover-panel',
    `not clipped by the modal or the list (hit: ${tip.hit})`,
  )
  report.check(tip.overflow === 0, `the guide is not cut off (${tip.overflow}px over)`)
  report.check(tip.fontPx >= 11, `readable at screen scale (${tip.fontPx}px)`)
  report.check(
    tip.box.left + tip.box.width <= width - 4 && tip.box.top >= 0 && tip.box.top + tip.box.height <= height,
    'inside the window on both axes',
  )
  report.check(
    tip.box.left >= row.box.left + WORDS_PX,
    `clear of the row's name and description (tip at ${tip.box.left}, row at ${row.box.left})`,
  )
}
await screenshot(`coda-node-tip-${width}`)

await evaluate(`document.querySelector('.node-browser__list').scrollTop += 120`)
await sleep(200)
report.check((await evaluate(READ)) === null, 'scrolling the list takes it away')

await mouseTo(cx, cy)
await sleep(600)
report.check((await evaluate(READ)) !== null, 'a second rest opens it again')
await mouseTo(cx, row.box.top - 60)
await sleep(200)
report.check((await evaluate(READ)) === null, 'leaving the row takes it away')

if (!args.keep) close()
report.finish('Run with --keep to leave the browser open.')
