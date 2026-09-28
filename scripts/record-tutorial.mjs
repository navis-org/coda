/**
 * Record a scripted tutorial to video.
 * `pnpm tutorial <name>` (needs `pnpm dev` running, or pass `--url`), where `<name>` is a
 * file in `tutorials/`. Writes into `tutorials/out/<name>/`, which is gitignored:
 *
 * - `<name>.mp4` — 1920x1080, 30 fps, narration mixed in;
 * - `<name>.srt` — captions, from the same text the voice read;
 * - `chapters.txt` — YouTube chapter lines, to paste into the description;
 * - `timings.json` — when each step started, and where on screen every action pointed, for a
 *   post-production pass that zooms or annotates without anybody measuring anything by hand.
 *
 * Music is a file in `tutorials/music/` (gitignored: most music licences forbid redistributing
 * the file, and this repository is public), named by the tutorial's `music` field or by
 * `--music <file>`; `--music none` leaves it out. It is ducked under the voice — see
 * `lib/tutorialRender.mjs`. `--remix` re-renders the take already on disk with whatever music
 * and `--music-level` (LUFS, -26 by default) are asked for now, without opening a browser.
 *
 * The narration is synthesised **first**, with macOS `say` (`--voice`, `--rate`), so each step
 * knows how long its line runs before anything is recorded; a step then lasts as long as the
 * longer of its line and its actions. That is what removes syncing from the job.
 *
 * Frames come from `Page.startScreencast` on headless Chrome. It sends a frame only when the
 * page changes, each stamped with a wall-clock time, so the frames are laid out on that clock and
 * ffmpeg resamples them to a constant rate. Two things that follow: headless Chrome renders
 * WebGL with SwiftShader, so a tutorial about the 3D viewer wants a headed capture instead; and
 * a native `<select>` popup is never drawn, which is why `choose` sets the value rather than
 * opening one.
 *
 * Headless Chrome also draws no cursor, so one is injected: an overlay following the real
 * dispatched mouse events, with a ripple on each press. It is `pointer-events: none` and is
 * placed by the events the app itself receives, so it cannot point somewhere the click did not
 * land.
 *
 * The page is driven through the store module the app is using, imported from the dev server —
 * `changelog-shots.mjs`' arrangement, and for its reason: an action named here is the action the
 * app runs. So this works against `pnpm dev`, never a build.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  handNeuprintToken,
  launchChrome,
  probeArgs,
  readCaveToken,
  readNeuprintToken,
} from './lib/browserProbe.mjs'
import { renderCards } from './lib/tutorialCards.mjs'
import { clock as fmt, MUSIC_LUFS, renderTake } from './lib/tutorialRender.mjs'

const args = probeArgs()
const name = process.argv.slice(2).find((a) => !a.startsWith('--') && !isFlagValue(a))
if (!name) {
  console.error(
    'Usage: pnpm tutorial <name> [--url http://localhost:5173/] [--voice "Zoe (Premium)"] [--rate 175] [--scale 3]\n' +
      '                            [--music <file>|none] [--music-level -26] [--remix]',
  )
  process.exit(2)
}
const base = args.value('--url') ?? 'http://localhost:5173/'
const voice = args.value('--voice') ?? 'Zoe (Premium)'
const rate = args.value('--rate') ?? '175'
const musicLufs = Number(args.value('--music-level') ?? MUSIC_LUFS)

/**
 * The page is laid out at 1280x720 CSS pixels, which fixes how large the UI reads, and drawn at
 * `--scale` device pixels per CSS pixel: 3 is 3840x2160, 2 is 2560x1440.
 *
 * 4K by default, for two reasons. It is sharp at every size somebody watches at; and YouTube gives
 * a 1440p-or-larger upload its higher-bitrate encode, which is what keeps UI text and thin lines
 * clean even for a viewer watching at 1080p.
 */
const VIEW = { width: 1280, height: 720, dpr: Number(args.value('--scale') ?? 3) }
const FPS = 30
/** Silence between one step's end and the next step's first word, unless it sets `gapBefore`. */
const GAP_S = 0.5
/** Before the first word, and after the last, so the video neither starts nor stops mid-breath. */
const LEAD_IN_S = 0.8
const TAIL_S = 1.8

const { tutorial } = await import(`../tutorials/${name}.ts`)
const OUT = fileURLToPath(new URL(`../tutorials/out/${name}/`, import.meta.url))
const FRAMES = OUT + 'frames/'
const AUDIO = OUT + 'audio/'
const clipFile = (i) => `${AUDIO}${String(i).padStart(2, '0')}.aiff`

// Resolved before anything else runs, so a misspelt name fails in a second rather than after
// a minute of recording.
const MUSIC_DIR = fileURLToPath(new URL('../tutorials/music/', import.meta.url))
const musicName = args.value('--music') ?? tutorial.music
let music
if (musicName && musicName !== 'none') {
  music = existsSync(musicName) ? musicName : MUSIC_DIR + musicName
  if (!existsSync(music)) {
    const have = existsSync(MUSIC_DIR) ? readdirSync(MUSIC_DIR).filter((f) => !f.startsWith('.')) : []
    console.error(`No music file ${musicName}. In tutorials/music/: ${have.length ? have.join(', ') : 'nothing'}.`)
    process.exit(2)
  }
}

if (args.all.includes('--remix')) {
  if (!existsSync(OUT + 'timings.json')) {
    console.error(`No take to remix in ${OUT}. Record one first: pnpm tutorial ${name}`)
    process.exit(2)
  }
  const take = JSON.parse(readFileSync(OUT + 'timings.json', 'utf8'))
  const video = renderTake({
    out: OUT,
    name,
    steps: take.steps,
    clips: take.steps.map((_, i) => clipFile(i)),
    total: take.duration,
    view: take.view,
    fps: FPS,
    music,
    musicLufs,
    cards: await renderCards(OUT, take.view, { topic: tutorial.topic }),
  })
  console.log(`✓ ${video} (remixed${music ? `, music at ${musicLufs} LUFS` : ', no music'})`)
  process.exit(0)
}

// Asked before anything is synthesised: without it, a missing server surfaces a minute later as
// "timed out waiting for the canvas", which reads as a broken page rather than an absent one.
try {
  await fetch(base, { signal: AbortSignal.timeout(3000) })
} catch {
  console.error(`No dev server at ${base}. Start \`pnpm dev\`, or pass --url with the one that is running.`)
  process.exit(2)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
mkdirSync(AUDIO, { recursive: true })

// ---------------------------------------------------------------------------
// Narration, first — its lengths decide the timeline.
// ---------------------------------------------------------------------------

/*
 * A Personal Voice cannot be rendered to a file — `say -o` and the synthesiser's buffer callback
 * both come back empty for one, by Apple's design — so it is spoken live through a loopback device
 * and recorded (`lib/speakLive.swift`, which needs BlackHole 2ch). Every other voice goes through
 * `say`. The live route ignores `--rate`: the synthesiser's own default pace is the voice's.
 */
const live = voice.includes('Personal Voice')
if (live) speakLive(tutorial.steps.map((step, i) => ({ text: step.spoken ?? step.say, file: clipFile(i) })))
const clips = tutorial.steps.map((step, i) => {
  const file = clipFile(i)
  if (!live) execFileSync('say', ['-v', voice, '-r', rate, '-o', file, step.spoken ?? step.say])
  const duration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
      .toString()
      .trim(),
  )
  return { file, duration }
})
console.log(`narration: ${clips.length} lines, ${sum(clips.map((c) => c.duration)).toFixed(1)} s (${voice})`)

/*
 * Outside footage for `clip` steps, cut, cropped, sped up and resampled to the video's own frame
 * rate and size before the browser starts — so a step's frames are ready the instant it begins.
 * PNG, like the browser's, because the concat demuxer wants one codec across the whole list.
 */
const footage = tutorial.steps.map((step, i) => {
  if (!step.clip) return undefined
  const { file, from, to, speed = 1, crop } = step.clip
  const [w, h] = [VIEW.width * VIEW.dpr, VIEW.height * VIEW.dpr]
  const filters = [
    ...(crop ? [`crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}`] : []),
    `setpts=(PTS-STARTPTS)/${speed}`,
    `fps=${FPS}`,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ]
  const pattern = `clip${String(i).padStart(2, '0')}-%05d.png`
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(from), '-to', String(to), '-i', file, '-vf', filters.join(','), '-an', FRAMES + pattern])
  const files = readdirSync(FRAMES).filter((f) => f.startsWith(pattern.slice(0, 7))).sort()
  return { files }
})
if (footage.some(Boolean)) console.log(`footage: ${footage.filter(Boolean).length} clips`)

// ---------------------------------------------------------------------------
// The browser and the driver.
// ---------------------------------------------------------------------------

const PROFILE = '/tmp/coda-tutorial-recording'
/*
 * The launch flag, not only the emulated device scale: `Page.startScreencast` captures at the
 * window's own scale and ignores `Emulation.setDeviceMetricsOverride`, so with the override alone
 * every frame arrived at 1280x720 and was upscaled to the video's size — soft, and grainy under
 * the JPEG it was then. Measured: override alone 1280x720, with the flag 3840x2160.
 */
const browser = await launchChrome({
  port: 9483,
  profile: PROFILE,
  ...VIEW,
  args: [`--force-device-scale-factor=${VIEW.dpr}`],
})
const { send, on, evaluate, waitFor } = browser
deleteProfileOnExit(PROFILE, browser.close)

// `APP_MODULE` (browserProbe.mjs): the app's own module instance, not a hot-reload copy.
const STORE = `(await (${APP_MODULE})('/src/store/graphStore.ts')).useGraphStore`
const inPage = (body) =>
  evaluate(`(async () => { const appModule = ${APP_MODULE}; const s = ${STORE}; ${body} })()`)

/** Seconds since recording started, on the same clock the screencast stamps frames with. */
let t0 = 0
/** Every frame of the video, in order: the browser's, footage's, and screenshots. */
const frames = []
/**
 * True while something other than the browser's live picture is on screen — a `clip` step's
 * footage, or the last frame held over a page load — and the browser's frames are dropped.
 */
let showingFootage = false
const now = () => Date.now() / 1000 - t0
/** Every action, where it pointed, and when — `timings.json`'s second half. */
const actions = []
const log = (action, rect, extra = {}) => t0 && actions.push({ t: round(now()), action, rect, ...extra })

/**
 * A target's box on screen, resolved in the page in one evaluation. Cards are found by node type
 * through the store, then by `data-id` under the canvas — `.canvas-area`, because a group peek
 * draws cards with the same ids.
 */
const RESOLVE = `(spec) => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } }
  if (typeof spec === 'string') return box(document.querySelector(spec))
  if ('x' in spec) return { left: spec.x, top: spec.y, width: 0, height: 0 }
  if ('css' in spec && !('node' in spec)) {
    const all = [...document.querySelectorAll(spec.css)]
    // An element whose own text is the given text, or which holds one that is: a result row carries its
    // description beside its name, and the name is what a script knows it by.
    // An exact match first, so a broad selector finds the label itself, not the first container
    // that happens to hold it.
    const exact = (el) => el.textContent.trim() === spec.text
    const holds = (el) => [...el.querySelectorAll('*')].some(exact)
    return box(spec.text === undefined ? all[0] : (all.find(exact) ?? all.find(holds)))
  }
  const nodes = window.__codaStore.getState().graph.nodes.filter((n) => n.type === spec.node)
  const node = nodes[spec.nth ?? 0]
  if (!node) return null
  const card = document.querySelector('.canvas-area .react-flow__node[data-id="' + node.id + '"]')
  if (!card) return null
  if (spec.handle) return box(card.querySelector('.react-flow__handle[data-handleid="' + spec.handle + '"]'))
  return box(card.querySelector(spec.css ?? '.coda-node__header'))
}`

async function locate(target, what = describe(target), tries = 50) {
  const at = typeof target === 'object' && target.at ? target.at : [0.5, 0.5]
  const [dx, dy] = typeof target === 'object' && target.offset ? target.offset : [0, 0]
  for (let i = 0; i < tries; i++) {
    const rect = await evaluate(`(${RESOLVE})(${JSON.stringify(target)})`)
    if (rect) return { rect, x: rect.left + rect.width * at[0] + dx, y: rect.top + rect.height * at[1] + dy }
    await sleep(100)
  }
  throw new Error(`nothing on screen for ${what}`)
}


/** Put the browser's current picture on the timeline as a frame, for when the screencast is held. */
async function holdScreenshot() {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = `${String(frames.length).padStart(6, '0')}.png`
  writeFileSync(FRAMES + file, Buffer.from(shot.result.data, 'base64'))
  frames.push({ file, t: Date.now() / 1000 })
}

// Off to the lower right, not the centre: the title card is centred over the opening seconds.
const cursor = { x: VIEW.width * 0.72, y: VIEW.height * 0.74 }
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

/**
 * Glide the real mouse, a frame at a time. `buttons` is 1 while a drag holds the button.
 *
 * Paced by the clock, not by a step count: each step is a round trip to the browser as well as a
 * frame's sleep, so counting steps made a 2.6 s drag take four seconds and land after the
 * sentence it was timed against.
 */
async function glide(x, y, { ms, buttons = 0 } = {}) {
  const from = { ...cursor }
  const distance = Math.hypot(x - from.x, y - from.y)
  const duration = ms ?? Math.min(1100, Math.max(350, 250 + distance * 0.7))
  const began = Date.now()
  for (;;) {
    const u = Math.min(1, (Date.now() - began) / duration)
    const eased = ease(u)
    cursor.x = from.x + (x - from.x) * eased
    cursor.y = from.y + (y - from.y) * eased
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cursor.x,
      y: cursor.y,
      button: buttons ? 'left' : 'none',
      buttons,
    })
    if (u === 1) return
    await sleep(16)
  }
}

const mouse = (type, buttons, { button = 'left', modifiers = 0 } = {}) =>
  send('Input.dispatchMouseEvent', {
    type,
    x: cursor.x,
    y: cursor.y,
    button,
    buttons,
    clickCount: 1,
    modifiers,
  })

/** A key held around a click: CDP's modifier bit, and the key event that goes with it. */
const MODIFIERS = {
  Meta: { bit: 4, code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  Shift: { bit: 8, code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
}

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

const driver = {
  inPage,

  async moveTo(target, options) {
    const { rect, x, y } = await locate(target)
    log('move', rect)
    await glide(x, y, options)
  },

  async hover(target, ms) {
    await driver.moveTo(target)
    await sleep(ms)
  },

  async click(target, { holding } = {}) {
    const { rect, x, y } = await locate(target)
    log('click', rect)
    await glide(x, y)
    await sleep(120)
    /*
     * A real key-down around the press, not only the modifier bit on it: React Flow reads its
     * multi-select key through a key-press listener of its own, so a click carrying the Meta bit
     * alone replaced the selection instead of adding to it.
     */
    const held = holding ? MODIFIERS[holding] : undefined
    const modifiers = held ? held.bit : 0
    const keyEvent = held && { key: holding, code: held.code, windowsVirtualKeyCode: held.windowsVirtualKeyCode }
    if (held) await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent, modifiers })
    await mouse('mousePressed', 1, { modifiers })
    await sleep(70)
    await mouse('mouseReleased', 0, { modifiers })
    if (held) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent })
    await sleep(150)
  },

  async clickOpensTab(target) {
    const { rect, x, y } = await locate(target)
    log('click', rect)
    await glide(x, y)
    await sleep(120)
    await evaluate('window.__tutorialCursor.press()')
    await sleep(300)
  },

  async rightClick(target) {
    const { rect, x, y } = await locate(target)
    log('rightClick', rect)
    await glide(x, y)
    await sleep(120)
    await mouse('mousePressed', 2, { button: 'right' })
    await sleep(70)
    await mouse('mouseReleased', 0, { button: 'right' })
    await sleep(200)
  },

  async clickIf(target) {
    try {
      await locate(target, undefined, 5)
    } catch {
      return false
    }
    await driver.click(target)
    return true
  },

  async drag(from, to, { approach, dwell = 150, ...options } = {}) {
    const start = await locate(from)
    await glide(start.x, start.y, approach ? { ms: approach } : {})
    await sleep(dwell)
    await mouse('mousePressed', 1)
    await sleep(120)
    // Resolved after the press: a socket drag draws a line, and a card drag may scroll nothing,
    // but a target should always be read off the screen as it is when the gesture is under way.
    const end = await locate(to)
    log('drag', start.rect, { to: end.rect })
    await glide(end.x, end.y, { buttons: 1, ...options })
    await sleep(150)
    await mouse('mouseReleased', 0)
    await sleep(200)
  },

  async placeRightOf(type, anchor, { gap = 90, dy = 0 } = {}) {
    // World units: the anchor's position plus its width (offsetWidth is pre-transform), and the
    // pane's zoom to turn that difference into the screen distance to drag.
    const plan = await inPage(`
      const nodes = s.getState().graph.nodes
      const find = (t) => nodes.find((n) => n.type === t)
      const a = find(${JSON.stringify(anchor)}), n = find(${JSON.stringify(type)})
      if (!a || !n) throw new Error('placeRightOf: no ${type} or no ${anchor} on the canvas')
      const el = (id) => document.querySelector('.canvas-area .react-flow__node[data-id="' + id + '"]')
      const zoom = Number(/scale\\((.*?)\\)/.exec(document.querySelector('.react-flow__viewport').style.transform)[1])
      const target = { x: a.position.x + el(a.id).offsetWidth + ${gap}, y: a.position.y + ${dy} }
      return { dx: (target.x - n.position.x) * zoom, dy: (target.y - n.position.y) * zoom }
    `)
    // Grab the header near its left end, clear of the title (a double-click there renames) and of
    // the buttons at the right.
    const grab = await locate({ node: type, at: [0.08, 0.5] })
    await driver.drag({ node: type, at: [0.08, 0.5] }, { x: grab.x + plan.dx, y: grab.y + plan.dy }, { ms: 900 })
  },

  async choose(target, value) {
    const { rect, x, y } = await locate(target)
    log('choose', rect, { value })
    await glide(x, y)
    await sleep(120)
    await evaluate(`window.__tutorialCursor.press()`)
    await sleep(350)
    await evaluate(`(() => {
      const r = ${JSON.stringify(rect)}
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('select')
      if (!el) throw new Error('choose: no <select> at ${describe(target).replaceAll("'", '')}')
      if (![...el.options].some((o) => o.value === ${JSON.stringify(value)})) {
        throw new Error('choose: no option ' + ${JSON.stringify(value)} + ' among ' + [...el.options].map((o) => o.value).join(', '))
      }
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await sleep(200)
  },

  async type(target, text, { enter = false } = {}) {
    await driver.click(target)
    log('type', undefined, { text })
    for (const ch of text) {
      await send('Input.insertText', { text: ch })
      await sleep(85)
    }
    if (enter) {
      await sleep(250)
      await driver.press('Enter')
    }
  },

  async press(key) {
    const k = KEYS[key]
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...k })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...k })
  },

  waitFor: (expression, what) => waitFor(expression, what, { tries: 300 }),

  async waitForResult(type) {
    const deadline = Date.now() + 60_000
    for (;;) {
      const info = await inPage(`
        const st = s.getState()
        const n = st.graph.nodes.find((n) => n.type === ${JSON.stringify(type)})
        return n ? st.nodeInfo(n.id) : null
      `)
      if (info?.state === 'ok') return
      if (info?.state === 'error') throw new Error(`${type} failed: ${info.error}`)
      if (Date.now() > deadline) throw new Error(`${type} had no result after a minute`)
      await sleep(100)
    }
  },

  frameAll: (maxZoom = 1) => driver.frame(null, maxZoom),

  async waitSettled() {
    const deadline = Date.now() + 90_000
    for (;;) {
      const states = await inPage(`
        const st = s.getState()
        return st.graph.nodes.map((n) => [n.type, st.nodeInfo(n.id).state, st.nodeInfo(n.id).error])
      `)
      if (!states.some(([, state]) => ['running', 'stale', 'blocked'].includes(state))) {
        for (const [type, state, error] of states) {
          if (state === 'error') console.warn(`  ! ${type} ended in an error: ${error}`)
        }
        return
      }
      if (Date.now() > deadline) throw new Error('cards still running after a minute and a half')
      await sleep(200)
    }
  },

  async frame(types, maxZoom = 1) {
    await inPage(`
      const types = ${JSON.stringify(types)}
      const ids = s.getState().graph.nodes.filter((n) => types === null || types.includes(n.type)).map((n) => n.id)
      ;(await appModule('/src/ui/tour/steps.ts')).frameNodes(ids, ${maxZoom})
    `)
    // Until the viewport stops moving: the fit is animated.
    let last = ''
    for (let i = 0; i < 40; i++) {
      await sleep(80)
      const transform = await evaluate(`document.querySelector('.react-flow__viewport').style.transform`)
      if (transform === last) break
      last = transform
    }
    // `frameNodes` frames by selecting, and a selection draws outlines and resize handles that
    // mean nothing to somebody watching.
    await inPage('s.getState().setSelection([])')
    log('frame', undefined, { types })
  },

  pause: (ms) => sleep(ms),

  async scrollTo(target) {
    const { rect } = await locate(target)
    log('scroll', rect)
    /*
     * Filmed by screenshot, one per step, with the screencast held: its frames during a scroll
     * arrived before the newly exposed part of the page was drawn — a heading twice, paragraphs
     * over their own copies — smooth or stepped alike. A screenshot is taken of a finished frame.
     */
    const from = await evaluate('window.scrollY')
    const by = Math.round(rect.top + rect.height / 2 - VIEW.height / 2)
    const steps = 16
    showingFootage = true
    for (let k = 1; k <= steps; k++) {
      await evaluate(`window.scrollTo(0, ${Math.round(from + by * ease(k / steps))})`)
      await sleep(30)
      await holdScreenshot()
    }
    await sleep(300)
    await holdScreenshot()
    showingFootage = false
  },
}

// ---------------------------------------------------------------------------
// The page: a first visit, with the launch sequence and the nudges out of the way.
// ---------------------------------------------------------------------------

const CURSOR = `(() => {
  if (window.__tutorialCursor) return
  const style = document.createElement('style')
  style.textContent = \`
    .feedback-nudge { display: none !important }
    #tutorial-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      width: 26px; height: 26px; transform: translate(-100px, -100px); }
    #tutorial-cursor svg { display: block; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.5)); transition: transform 90ms ease-out; transform-origin: 3px 3px; }
    #tutorial-cursor.down svg { transform: scale(0.86); }
    .tutorial-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px;
      margin: -17px 0 0 -17px; border-radius: 50%; border: 2.5px solid rgb(255 255 255 / 0.9);
      box-shadow: 0 0 0 1.5px rgb(0 0 0 / 0.35); animation: tutorial-ripple 480ms ease-out forwards; }
    @keyframes tutorial-ripple { from { transform: scale(0.35); opacity: 1 } to { transform: scale(1.35); opacity: 0 } }
  \`
  document.head.append(style)
  const el = document.createElement('div')
  el.id = 'tutorial-cursor'
  el.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.4 L17.5 14.4 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  document.body.append(el)
  let x = -100, y = -100
  const place = () => { el.style.transform = 'translate(' + (x - 3) + 'px, ' + (y - 2) + 'px)' }
  const ripple = () => {
    const r = document.createElement('div')
    r.className = 'tutorial-ripple'
    r.style.left = x + 'px'
    r.style.top = y + 'px'
    document.body.append(r)
    setTimeout(() => r.remove(), 600)
  }
  // Capture phase on window: first to hear the event, before anything in the app can stop it.
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place() }, true)
  addEventListener('mousedown', (e) => { x = e.clientX; y = e.clientY; place(); el.classList.add('down'); ripple() }, true)
  addEventListener('mouseup', () => el.classList.remove('down'), true)
  window.__tutorialCursor = { press: () => { ripple(); el.classList.add('down'); setTimeout(() => el.classList.remove('down'), 140) } }
})()`

/**
 * Load a page and make it ready to film: the app's launch sequence closed and the store exposed
 * for `RESOLVE`, and the drawn cursor injected — on every load, the page being new each time. A
 * page that is not the app (`mcp.html`) gets the cursor alone.
 */
async function openPage(path = '') {
  /*
   * Off camera while it loads: the last frame before holds until the new page is ready. Filmed,
   * a navigation is a black frame (the blank page below) and then the page *unstyled* — in the dev
   * server a stylesheet arrives by script after the first paint, so for one frame the MCP page was
   * white serif text under an icon drawn the width of the screen.
   */
  const filming = t0 > 0 && !showingFootage
  if (filming) showingFootage = true
  // Through a blank page: a URL that differs only in its `#` is a same-document jump, and the
  // app reads its link when it loads — so a workflow link opened from the canvas changed nothing.
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(150)
  await send('Page.navigate', { url: base + path })
  const app = !/\.html(?:[?#]|$)/.test(path)
  if (app) {
    await waitFor('document.querySelector(".react-flow__pane") !== null', 'the canvas')
    await inPage(`
      window.__codaStore = s
      s.getState().closeStartPage()
      s.getState().closeGuides()
    `)
  } else {
    // Loaded is not styled: wait for the page's own background, which only its stylesheet sets.
    await waitFor(
      `document.readyState === "complete" && getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"`,
      path,
    )
  }
  await evaluate(CURSOR)
  await glide(cursor.x, cursor.y, { ms: 50 })
  if (filming) {
    await sleep(250)
    await holdScreenshot()
    showingFootage = false
  }
}
driver.navigate = openPage

await openPage()
/*
 * The shared helpers, which pass the token as a DevTools argument rather than in the evaluated
 * source, and never print it. `deleteProfileOnExit` removes the profile that stores it.
 */
if (tutorial.signIn === 'neuprint') await handNeuprintToken(send, readNeuprintToken())
if (tutorial.signIn === 'cave') {
  const token = readCaveToken()
  if (!token) throw new Error('no CAVE token: set CAVE_TOKEN, or sign in with caveclient once')
  if (!(await handCaveToken(send, token))) throw new Error('the page did not take the CAVE token')
}
await tutorial.setup(driver)
await glide(cursor.x, cursor.y, { ms: 50 })
await sleep(600)

// ---------------------------------------------------------------------------
// Record.
// ---------------------------------------------------------------------------

on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  if (showingFootage) {
    send('Page.screencastFrameAck', { sessionId })
    return
  }
  const file = `${String(frames.length).padStart(6, '0')}.png`
  writeFileSync(FRAMES + file, Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  send('Page.screencastFrameAck', { sessionId })
})

t0 = Date.now() / 1000
await send('Page.startScreencast', {
  // Lossless: a JPEG frame's ringing round UI text is the grain, and it survives the encode.
  format: 'png',
  maxWidth: VIEW.width * VIEW.dpr,
  maxHeight: VIEW.height * VIEW.dpr,
  everyNthFrame: 1,
})
await sleep(LEAD_IN_S * 1000)

// A tutorial that opens on footage opens on it from the first frame, lead-in included, rather
// than on the canvas it cuts away from 0.8 s later.
if (footage[0]) {
  showingFootage = true
  frames.length = 0
  frames.push({ file: footage[0].files[0], t: t0 })
}

const marks = []
let failed
/** When the previous step's line and actions had both finished. */
let previousEnd
for (const [i, step] of tutorial.steps.entries()) {
  if (previousEnd !== undefined) {
    await sleep(Math.max(0, previousEnd + (step.gapBefore ?? GAP_S) - now()) * 1000)
  }
  const start = now()
  const clip = clips[i]
  marks.push({ start: round(start), audio: round(clip.duration), say: step.say, chapter: step.chapter })
  console.log(`${fmt(start)}  ${step.say.slice(0, 72)}${step.say.length > 72 ? '…' : ''}`)
  // Footage goes on the timeline at once; the browser's own frames are dropped until it ends.
  const shown = footage[i]
  if (shown) {
    showingFootage = true
    shown.files.forEach((file, k) => frames.push({ file, t: t0 + start + k / FPS }))
  }
  try {
    await sleep((step.lead ?? 0.4) * 1000)
    await step.do?.(driver)
  } catch (error) {
    failed = error
    console.error(`✗ step ${i + 1}: ${error.message}`)
    break
  }
  previousEnd = Math.max(start + clip.duration, now(), shown ? start + shown.files.length / FPS : 0)
  // Back to the browser only when the next step is not footage too: returning between two clips
  // put one frame of the canvas on screen in the pause between them — a flicker of the wrong app.
  if (shown && !footage[i + 1]) {
    await sleep(Math.max(0, previousEnd - now()) * 1000)
    // The browser only sends a frame when its page changes, so the footage's last frame would
    // otherwise stand until something moved. A screenshot is the browser's picture as of now.
    await holdScreenshot()
    showingFootage = false
  }
}
await sleep(Math.max(0, previousEnd - now()) * 1000)
await sleep(TAIL_S * 1000)
const total = now()
await send('Page.stopScreencast')
await sleep(200)
browser.close()

if (failed) {
  console.error(`Stopped at ${fmt(total)}; frames and audio are in ${OUT} for a look.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Render: frames on their own clock, narration placed at each step's start.
// ---------------------------------------------------------------------------

// A frame lasts until the next one arrives; the page sends none while nothing changes.
const concat = ['ffconcat version 1.0']
frames.forEach((frame, i) => {
  const from = i === 0 ? 0 : frame.t - t0
  const until = i + 1 < frames.length ? frames[i + 1].t - t0 : total
  concat.push(`file 'frames/${frame.file}'`, `duration ${Math.max(0.001, until - from).toFixed(4)}`)
})
// The concat demuxer drops the last entry's duration unless the file is listed once more.
concat.push(`file 'frames/${frames.at(-1).file}'`)
writeFileSync(OUT + 'frames.txt', concat.join('\n') + '\n')

// Written before the render, so a take whose encode fails can still be remixed.
writeFileSync(
  OUT + 'timings.json',
  JSON.stringify({ title: tutorial.title, view: VIEW, duration: round(total), steps: marks, actions }, null, 2) + '\n',
)
const video = renderTake({
  out: OUT,
  name,
  steps: marks,
  clips: clips.map((c) => c.file),
  total,
  view: VIEW,
  fps: FPS,
  music,
  musicLufs,
  cards: await renderCards(OUT, VIEW, { topic: tutorial.topic }),
})
console.log(`✓ ${video} (${fmt(total)}, ${frames.length} frames captured${music ? ', with music' : ''})`)

// ---------------------------------------------------------------------------

function describe(target) {
  return typeof target === 'string' ? target : JSON.stringify(target)
}

function isFlagValue(arg) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(arg)
  return i > 0 && argv[i - 1].startsWith('--')
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0)
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

/**
 * Speak every line with a Personal Voice through the loopback, then trim each recording to its
 * speech. The helper is compiled once into `node_modules/.cache` and again whenever its source
 * changes. While it runs, the Mac's sound output is BlackHole: nothing is audible, and the helper
 * restores the previous device on every exit.
 */
function speakLive(lines) {
  const source = fileURLToPath(new URL('./lib/speakLive.swift', import.meta.url))
  const cache = fileURLToPath(new URL('../node_modules/.cache/coda-tutorial/', import.meta.url))
  const binary = cache + 'speakLive'
  mkdirSync(cache, { recursive: true })
  if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    execFileSync('swiftc', ['-O', '-suppress-warnings', source, '-o', binary], { stdio: ['ignore', 'ignore', 'inherit'] })
  }
  const raw = lines.map((line) => ({ text: line.text, file: line.file.replace(/\.aiff$/, '.raw.wav') }))
  writeFileSync(AUDIO + 'lines.json', JSON.stringify(raw))
  console.log(`speaking ${lines.length} lines live with ${voice} (sound output is BlackHole meanwhile)`)
  execFileSync(binary, [voice, AUDIO + 'lines.json'], { stdio: ['ignore', 'ignore', 'inherit'] })
  // The recording's own lead-in and tail, off both ends: the timeline wants the speech, and the
  // gaps between steps are the recorder's to set.
  const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05'
  lines.forEach((line, i) => {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw[i].file, '-af', `${trim},areverse,${trim},areverse`, line.file])
    rmSync(raw[i].file)
  })
}
