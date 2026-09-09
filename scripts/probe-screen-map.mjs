#!/usr/bin/env node
/**
 * Is the Screen Map readable, at three window sizes?
 * `pnpm probe:screen-map` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * `mapLayout.test.ts` asks the placement arithmetic the questions that matter — no two labels
 * overlapping, no label over a control, nothing off the window — and it asks them of rects it
 * invents. Everything between those rects and the screen is unmeasured by it: whether the boxes
 * are round the controls they name, whether a label's *measured* height is the one the placement
 * was given, whether the leader from a label three rows down still reads as belonging to it, and
 * how deep the band of toolbar labels actually gets. jsdom answers none of that — it reports one
 * constant rect for every element and lays out nothing.
 *
 * Five properties, each a way this could be broken with the whole suite green:
 *
 * 1. **Every spot has a box, and each box is on the control it names.** Checked with
 *    `elementFromPoint` at the box's own centre with the overlay's pointer events lifted: a rect
 *    is reported happily for an element some ancestor has clipped away entirely.
 * 2. **No two labels overlap, and no label covers a control.** The same properties the unit test
 *    asserts, over the real geometry — which is the half that can disagree, because the label
 *    heights the placement is told come from a measurement pass and a font fallback moves them.
 * 3. **Nothing hangs off the window.** `documentElement.scrollWidth` against the viewport, which
 *    is `probe-mobile.mjs`' property: a fixed layer wider than the window is what makes a phone
 *    zoom out.
 * 4. **The band has a floor.** How far down the window the toolbar's labels reach, printed rather
 *    than asserted at a number — it is the reading that says whether the spot table has room for
 *    another entry.
 * 5. **A resize re-measures.** The map is placed once, from rects; a window that changes size
 *    under it leaves every leader pointing at where a control used to be.
 * 6. **Hovering a box lights its triple.** The box, the leader and the label are three elements in
 *    three containers, tied together only by `data-spot`, and whether the pointer reaches any of
 *    them at all is `pointer-events` — which jsdom computes no styles for, and whose rule for the
 *    labels collides with the one above it at equal specificity. Driven with a real pointer.
 *
 * It runs on the wizard's synthetic dataset, so it needs no credential and reaches no server.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'

const { send, evaluate, waitFor, screenshot, setDevice, mouseTo, close } = await launchChrome({
  port: 9431,
  profile: '/tmp/coda-probe-screen-map',
  width: 1600,
  height: 1000,
})

/**
 * Everything on the map, plus what is under each box.
 *
 * The overlay is `pointer-events: none` on the stage and `auto` on the scrim, so a hit test at a
 * box's centre would find the scrim every time. Lifted for the duration of the read and put back:
 * what is being asked is whether the *control* is there, which is the thing a box can be wrong
 * about while rendering perfectly.
 */
const READ = `(() => {
  const map = document.querySelector('.smap')
  if (!map) return null
  // The scrim takes clicks and the boxes and labels take hover — all three stand aside for the
  // hit test below, which is asking what the *app* has under each box.
  const lifted = [...map.querySelectorAll('.smap__scrim, .smap__box, .smap__label')]
  const was = lifted.map((el) => el.style.pointerEvents)
  for (const el of lifted) el.style.pointerEvents = 'none'
  const round = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  const boxes = [...map.querySelectorAll('.smap__box')].map((el) => {
    const box = round(el.getBoundingClientRect())
    const at = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2)
    return {
      box,
      spot: el.getAttribute('data-spot'),
      region: el.hasAttribute('data-region'),
      hit: at ? at.tagName.toLowerCase() + (typeof at.className === 'string' && at.className ? '.' + at.className.trim().split(/\\s+/)[0] : '') : null,
    }
  })
  lifted.forEach((el, i) => {
    el.style.pointerEvents = was[i]
  })
  const labels = [...map.querySelectorAll('.smap__label')].map((el) => ({
    ...round(el.getBoundingClientRect()),
    text: el.querySelector('strong')?.textContent ?? '',
    // The one thing the placement is *told* rather than measuring for itself.
    width: Math.round(parseFloat(el.style.width || '0')),
    clipped: Math.max(0, el.scrollHeight - el.clientHeight),
  }))
  const leaders = [...map.querySelectorAll('.smap__leaders polyline')].map((el) =>
    el.getAttribute('points').split(' ').map((p) => p.split(',').map(Number)),
  )
  const panel = map.querySelector('.smap__panel')
  return {
    boxes,
    labels,
    leaders,
    panel: panel ? round(panel.getBoundingClientRect()) : null,
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
    height: window.innerHeight,
  }
})()`

/**
 * What is lit right now, by spot id, and whether everything else really did recede.
 *
 * `getComputedStyle` for the dimming rather than the attribute: the attribute only says what the
 * markup intended, and the rule that acts on it sits below one it overrides at equal specificity.
 * Reading the resolved opacity is what makes this a check on the cascade and not on the JSX.
 */
const READ_HOT = `(() => {
  const map = document.querySelector('.smap')
  const opacity = (el) => parseFloat(getComputedStyle(el).opacity)
  const hot = [...map.querySelectorAll('[data-hot]')]
  return {
    hovering: map.hasAttribute('data-hover'),
    lit: hot.map((el) => ({
      kind: el.tagName.toLowerCase() === 'polyline' ? 'leader' : el.className.replace('smap__', ''),
      spot: el.getAttribute('data-spot'),
    })),
    litOpacity: Math.min(1, ...hot.map(opacity)),
    restDimmed: [...map.querySelectorAll('.smap__label:not([data-hot])')].every((el) => opacity(el) < 0.5),
  }
})()`

/**
 * Dismiss whatever the launch sequence has put up. Coda's shell, not the browser's.
 *
 * A copy of `probe-port-preview.mjs`'s, deliberately: `lib/browserProbe.mjs` keeps app-specific
 * selectors out, on the argument that a shared version is a second place for a class rename to
 * break a probe nobody is running. Two copies is where that trade starts to turn — if a third
 * arrives, move it.
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

const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const { check, finish } = probeReport()

await send('Page.navigate', { url })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()

/**
 * Open the map the way a reader does: `? ▸ Guides ▸ Screen Map`.
 *
 * Three clicks rather than one call into the store, and the store is not exposed to a page
 * anyway. It buys something: the route is the one thing here a unit test genuinely cannot see —
 * `TOURS` is read by four surfaces and this is one of them, so a fourth guide that never reached
 * the menu would fail here rather than being noticed by somebody looking for it.
 *
 * The submenu opens on `pointerenter` as well as on a click, and a click is what a headless
 * probe can do reliably — see `submenuPlacement` for why hover is a toggle inline and not
 * otherwise.
 */
async function openMap() {
  await evaluate(`document.querySelector('[data-tour="help"] > button').click()`)
  await waitFor(`!!document.querySelector('.dropdown__panel')`, 'the ? menu')
  await evaluate(`(() => {
    const parent = [...document.querySelectorAll('.dropdown__item--parent')]
      .find((el) => el.querySelector('strong')?.textContent === 'Guides')
    if (!parent) throw new Error('no Guides submenu')
    parent.click()
  })()`)
  await sleep(120)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.dropdown__item')]
      .find((el) => el.querySelector('strong')?.textContent === 'Screen Map')
    if (!row) throw new Error('no Screen Map row')
    row.click()
  })()`)
  /*
   * Wait for the *placement*, not for a duration. A label is rendered `visibility: hidden` at the
   * top-left for the measuring commit, so "a label exists" is true one commit too early — asking
   * whether one has been placed is the signal, where `sleep(250)` was a guess that the second
   * commit had landed.
   */
  await waitFor(
    `[...document.querySelectorAll('.smap__label')].some((el) => el.style.visibility !== 'hidden')`,
    'the labels to be placed',
  )
  return evaluate(READ)
}

async function closeMap() {
  await evaluate(`document.querySelector('.smap__panel button').click()`)
  await waitFor(`!document.querySelector('.smap')`, 'the map to close')
}

/** Every property but the resize, at one window size. */
function assess(map, where) {
  check(map.boxes.length >= 14, `${where}: ${map.boxes.length} boxes drawn`)
  check(map.labels.length === map.boxes.length, `${where}: a label for every box`)

  const missed = map.boxes.filter((entry) => !entry.hit)
  check(missed.length === 0, `${where}: every box is over something (${missed.length} over nothing)`)

  const overlaps = []
  for (let i = 0; i < map.labels.length; i++) {
    for (let j = i + 1; j < map.labels.length; j++) {
      if (hits(map.labels[i], map.labels[j])) overlaps.push(`${map.labels[i].text}/${map.labels[j].text}`)
    }
  }
  check(overlaps.length === 0, `${where}: no two labels overlap${overlaps.length ? ` — ${overlaps.join(', ')}` : ''}`)

  const covered = []
  for (const label of map.labels) {
    for (const entry of map.boxes) {
      if (!entry.region && hits(label, entry.box)) covered.push(`${label.text} over ${entry.hit}`)
    }
    if (map.panel && hits(label, map.panel)) covered.push(`${label.text} over the panel`)
  }
  check(covered.length === 0, `${where}: no label covers a control${covered.length ? ` — ${covered.join(', ')}` : ''}`)

  const off = map.labels.filter(
    (label) => label.x < 0 || label.y < 0 || label.x + label.w > map.view || label.y + label.h > map.height,
  )
  check(off.length === 0, `${where}: every label is on screen (${off.map((l) => l.text).join(', ') || 'all'})`)
  check(map.doc <= map.view, `${where}: the document is ${map.doc}px against a ${map.view}px viewport`)

  const clipped = map.labels.filter((label) => label.clipped > 0)
  check(clipped.length === 0, `${where}: no label's sentence is cut off`)

  // A leader has to finish on its own label — the elbow is easy to turn the wrong way, and it
  // looks plausible for every label that did not have to move.
  const strayed = map.leaders.filter((points) => {
    const end = points[points.length - 1]
    return !map.labels.some(
      (label) =>
        end[0] >= label.x - 2 && end[0] <= label.x + label.w + 2 && end[1] >= label.y - 2 && end[1] <= label.y + label.h + 2,
    )
  })
  check(strayed.length === 0, `${where}: every leader lands on a label`)

  const band = Math.max(...map.labels.map((label) => label.y + label.h))
  const deepest = Math.max(0, ...map.labels.filter((l) => l.y < map.height / 2).map((l) => l.y + l.h))
  console.log(
    `  ${where}: labels reach ${band}px of ${map.height}; the toolbar's band ends at ${deepest}px`,
  )
}

for (const [w, h, name] of [
  [1600, 1000, '1600×1000'],
  [1280, 800, '1280×800'],
  [1024, 720, '1024×720'],
]) {
  await setDevice(w, h)
  await sleep(200)
  const map = await openMap()
  assess(map, name)
  console.log(`  ${name}: ${await screenshot(`screen-map-${w}`)}`)
  await closeMap()
}

/*
 * The resize. The map measures once, in a layout effect; a window that changes size under it
 * leaves every box where a control used to be, and the only symptom is a figure that looks like
 * it was drawn for a different screen.
 */
await setDevice(1600, 1000)
await sleep(200)
await openMap()
await setDevice(1180, 900)
await sleep(500)
const resized = await evaluate(READ)
assess(resized, 'after a resize')
const stale = resized.boxes.filter((entry) => entry.box.x + entry.box.w > resized.view + 2)
check(stale.length === 0, `after a resize: no box is still drawn off the new window (${stale.length})`)
await closeMap()

/*
 * The hover, with a real pointer. Everything about it that can be wrong is a fact about the
 * browser: whether `pointer-events` reaches the box at all (the labels' own rule sets it to
 * `none` at the same specificity, three blocks below), whether the box is on top of the scrim
 * where the pointer lands, and whether the rest actually dims.
 */
await setDevice(1600, 1000)
await sleep(200)
const hoverMap = await openMap()

// A control with all three parts — a box, a leader and a label. Not a region: those are lit from
// their label, since a box the size of the window would mean the pointer is always on something.
const target = hoverMap.boxes.find((entry) => entry.spot === 'run')
check(Boolean(target), `hover: the Run box carries its spot id`)
if (target) {
  await mouseTo(target.box.x + target.box.w / 2, target.box.y + target.box.h / 2)
  await sleep(160)
  const lit = await evaluate(READ_HOT)
  check(lit.hovering, 'hover: the pointer reaches the box through the scrim')
  check(
    lit.lit.length === 3 && lit.lit.every((part) => part.spot === 'run'),
    `hover: the box, the leader and the label light together (${lit.lit.map((p) => p.kind).join(', ') || 'nothing'})`,
  )
  check(lit.litOpacity === 1, `hover: the lit triple stays at full strength (${lit.litOpacity})`)
  check(lit.restDimmed, 'hover: every other label recedes')

  // And a label is the other end of the same leader — which is the only way into a region.
  await mouseTo(6, 6)
  await sleep(160)
  const away = await evaluate(READ_HOT)
  check(!away.hovering && away.lit.length === 0, 'hover: leaving puts everything back')
}
await closeMap()

finish('Run `pnpm dev --port 5177` first if the shell never mounted.')
await close()
