#!/usr/bin/env node
/**
 * Capture every pack guide's figures. `pnpm guide:shots` (needs `pnpm dev --port 5183`, or pass
 * `--url`; `--only <file>` for one).
 *
 * The shots are `src/packguide/shots.ts`' table, which `render.test.ts` holds to the figures each
 * guide shows. Each opens its example — the link the guide's own Open button follows — in headless
 * Chrome, runs it, expands a node and opens a tab, or fits the canvas, and writes a WebP into
 * `public/guides/<pack>/`. Built like `changelog-shots.mjs`, whose header explains the parts:
 * driven through the store module the app itself uses, so only against `pnpm dev`; a fresh profile
 * each run, so the first visit's dialogs are closed first; captured at `CAPTURE_DENSITY`, which
 * the renderer halves for the image's display size.
 *
 * An example on a published dataset names its `signIn`. The neuPrint token is read from
 * `NEUPRINT_APPLICATION_CREDENTIALS` on this machine, handed to the page once, never printed, and
 * the profile holding it is deleted on exit; without it those shots are skipped with a line saying
 * so. Every request a shot makes is a read.
 *
 * Review the pictures before committing: a capture that ran before its node finished is a picture
 * of a spinner.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { CAPTURE_DENSITY } from '../src/changelog/images.ts'
import { demoFragment } from '../src/data/share/fragment.ts'
import { GUIDE_SHOTS } from '../src/packguide/shots.ts'
import {
  deleteProfileOnExit,
  handNeuprintToken,
  launchChrome,
  probeArgs,
  readNeuprintToken,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const base = args.value('--url') ?? 'http://localhost:5183/'
const only = args.value('--only')

/** After a run and after a view opens: long enough for a canvas to draw. */
const SETTLE_MS = 2000
/** How long one example may take to run, a published dataset's queries included. */
const RUN_LIMIT_MS = 240_000

// A pack's figures go in `public/guides/<pack>/`, the folder its guide reads them from.
const shots = Object.entries(GUIDE_SHOTS).flatMap(([folder, files]) =>
  Object.entries(files)
    .filter(([file]) => !only || file === only)
    .map(([file, shot]) => ({ folder, file, shot })),
)
if (shots.length === 0) {
  console.log(only ? `No guide shot is called ${only}.` : 'No guide shot declared.')
  process.exit(0)
}

const PROFILE = '/tmp/coda-guide-shots'
const { send, evaluate, waitFor, rect, close } = await launchChrome({
  port: 9481,
  profile: PROFILE,
  width: 1440,
  height: 900,
  dpr: CAPTURE_DENSITY,
})
deleteProfileOnExit(PROFILE, close)

const STORE = "(await import('/src/store/graphStore.ts')).useGraphStore"
const inPage = (body) => evaluate(`(async () => { const s = ${STORE}; ${body} })()`)

const signedIn = new Set()
if (
  shots.some((s) => s.shot.signIn === 'neuprint') &&
  process.env.NEUPRINT_APPLICATION_CREDENTIALS
) {
  await send('Page.navigate', { url: base })
  await waitFor('document.querySelector(".react-flow__pane") !== null', 'the canvas')
  await handNeuprintToken(send, readNeuprintToken())
  signedIn.add('neuprint')
}

/** Run until every node has a result: a failure says which node and why. */
async function runToEnd() {
  await inPage('await s.getState().runAll()')
  const read = `const st = s.getState()
    return { busy: st.busy, nodes: st.graph.nodes.map((n) => [n.id, n.type, st.nodeInfo(n.id).state, st.nodeInfo(n.id).error]) }`
  const deadline = Date.now() + RUN_LIMIT_MS
  for (;;) {
    const { busy, nodes } = await inPage(read)
    const broken = nodes.find(([, , state]) => state === 'error')
    if (broken) throw new Error(`${broken[0]} (${broken[1]}) failed: ${broken[3]}`)
    // A note and a description card never run; "idle" there is their finished state.
    const pending = nodes.filter(([, , state]) => state === 'running' || state === 'stale')
    if (!busy && pending.length === 0) return
    if (Date.now() > deadline) throw new Error(`still running: ${pending.map((n) => n[1]).join(', ')}`)
    if (!busy) await inPage('await s.getState().runAll()')
    await sleep(250)
  }
}

/**
 * The box round the elements an in-page expression lists, `pad` px wider on every side and kept
 * inside the window; undefined where the list is empty or holds a miss.
 */
const union = (elements, pad) =>
  evaluate(`(() => {
    const rs = ${elements}.map((e) => e?.getBoundingClientRect())
    if (rs.length === 0 || rs.some((r) => !r)) return undefined
    const left = Math.max(0, Math.min(...rs.map((r) => r.left)) - ${pad})
    const top = Math.max(0, Math.min(...rs.map((r) => r.top)) - ${pad})
    const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + ${pad})
    const bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + ${pad})
    return { left, top, width: right - left, height: bottom - top }
  })()`)

let failed = 0
for (const { folder, file, shot } of shots) {
  try {
    if (shot.signIn && !signedIn.has(shot.signIn)) {
      console.log(`- ${file}: skipped, no ${shot.signIn} credential on this machine`)
      continue
    }
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
    await send('Page.navigate', { url: base + (shot.demo ? demoFragment(shot.demo) : '') })
    await waitFor('document.querySelector(".react-flow__pane") !== null', 'the canvas')
    if (shot.demo) {
      const type = JSON.stringify(shot.demo)
      await waitFor(
        `(async () => ${STORE}.getState().graph.nodes.some((n) => n.type === ${type}))()`,
        `a ${shot.demo} node`,
      )
    }
    await inPage(`
      s.getState().closeStartPage()
      s.getState().closeGuides()
      const style = document.createElement('style')
      // The canvas's own furniture, so a picture of a workflow is the workflow.
      style.textContent = '.feedback-nudge, .wf-tabs, .react-flow__controls, .fab-menu, .react-flow__minimap { display: none !important }'
      document.head.append(style)
    `)
    for (const pack of shot.switchOn ?? []) {
      await evaluate(
        `(async () => (await import('/src/ui/packSwitches.ts')).switchPack(${JSON.stringify(pack)}, true))()`,
      )
    }
    if (shot.cards) {
      // A row of fresh cards, unwired, each a card's width and a gap apart.
      await inPage(`
        s.getState().newGraph();
        ${JSON.stringify(shot.cards)}.forEach((type, i) => s.getState().addNode(type, { x: i * 360, y: 0 }))
      `)
    }
    if (shot.keep) {
      // The workflow as a step of the guide has built it: every other card taken off.
      await inPage(`
        const keep = new Set(${JSON.stringify(shot.keep)})
        s.getState().deleteNodes(s.getState().graph.nodes.filter((n) => !keep.has(n.id)).map((n) => n.id))
      `)
    }
    for (const p of shot.params ?? []) {
      await inPage(`
        const n = s.getState().graph.nodes.find((n) => n.type === ${JSON.stringify(p.type)})
        if (!n) throw new Error('no ${p.type} node in the workflow')
        s.getState().setParam(n.id, ${JSON.stringify(p.param)}, ${JSON.stringify(p.value)})
      `)
    }
    if (shot.demo) await runToEnd()
    await sleep(SETTLE_MS)

    let selector
    if (shot.open) {
      await inPage(`s.getState()[${JSON.stringify(shot.open)}]()`)
      selector = '[role="dialog"]'
      await waitFor(`!!document.querySelector('${selector}')`, selector)
    } else if (shot.canvas) {
      await inPage('s.getState().requestFitView()')
      selector = '.canvas-area .react-flow__node'
    } else {
      await inPage(`
        const n = s.getState().graph.nodes.find((n) => n.type === ${JSON.stringify(shot.expand)})
        if (!n) throw new Error('no ${shot.expand} node in the workflow')
        s.getState().expandNode(n.id)
      `)
      selector = '[role="dialog"]'
      await waitFor(`!!document.querySelector('${selector}')`, selector)
      // Each tab by its label, in order: one beside the drawing and one among the settings, say.
      for (const tab of [shot.tab ?? []].flat()) {
        const name = JSON.stringify(tab)
        const tabs = `[...document.querySelectorAll('[role="dialog"] [role="tab"]')]`
        await waitFor(`${tabs}.some((t) => t.textContent.trim() === ${name})`, `the ${tab} tab`)
        await evaluate(`${tabs}.find((t) => t.textContent.trim() === ${name}).click()`)
      }
      if (shot.range) {
        // A slider can have no range until its view has loaded (Playback's, a re-run): wait for one.
        const { label, at } = shot.range
        const RANGE = `[role="dialog"] input[type="range"][aria-label=${JSON.stringify(label)}]`
        await waitFor(`Number(document.querySelector('${RANGE}')?.max) > 0`, `the ${label} slider`)
        await evaluate(`(() => {
          const input = document.querySelector('${RANGE}')
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set.call(input, String(Math.round(Number(input.max) * ${at})))
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
      }
    }
    await sleep(SETTLE_MS * 2)

    // A workflow is every card on the canvas, with a margin; a crop is its elements together;
    // anything else is its one element.
    // A crop's elements brought into view first: a dialog's row may be below its fold.
    if (shot.crop) {
      await evaluate(`document.querySelector('${selector} ' + ${JSON.stringify(shot.crop[0])})?.scrollIntoView({ block: 'center' })`)
      await sleep(300)
    }
    const box = shot.canvas
      ? await union(`[...document.querySelectorAll('${selector}')]`, 24)
      : shot.crop
? await union(
          `${JSON.stringify(shot.crop)}.map((c) => document.querySelector('${selector} ' + c))`,
          0,
        )
        : await rect(selector)
    if (!box) throw new Error(`nothing matches ${selector}`)
    const out = fileURLToPath(new URL(`../public/guides/${folder}/`, import.meta.url))
    mkdirSync(out, { recursive: true })
    const taken = await send('Page.captureScreenshot', {
      format: 'webp',
      quality: 82,
      clip: { x: box.left, y: box.top, width: box.width, height: box.height, scale: 1 },
    })
    writeFileSync(out + file, Buffer.from(taken.result.data, 'base64'))
    console.log(`✓ ${folder}/${file}`)
  } catch (error) {
    failed++
    console.error(`✗ ${file}: ${error.message}`)
  }
}

await close()
process.exit(failed ? 1 : 0)
