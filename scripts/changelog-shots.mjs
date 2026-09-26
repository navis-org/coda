#!/usr/bin/env node
/**
 * Capture every changelog image that declares how to make it.
 * `pnpm changelog:shots` (needs `pnpm dev --port 5183`, or pass `--url`; `--only <file>` for one).
 *
 * Each `ChangelogImage.capture` in `src/changelog/entries.ts` says what to do to its feature's
 * demo — the link **Open example** opens; this opens it in headless Chrome, runs it, does that,
 * and writes a WebP into `public/changelog/`. Run through `vite-node` rather than `node` so it can import the entries
 * straight from the TypeScript table, which is the one list — a second list of shots here is the
 * copy that would drift.
 *
 * The page is driven through the store's own module, imported into the page from the dev server,
 * which is the same module instance the app is using: an action named in a capture is the action
 * the app runs. So this only works against `pnpm dev`, never a build.
 *
 * A fresh browser profile each run is a first visit, so What's New does not put itself up and the
 * guides dialog does; both are closed before anything is captured, and the feedback nudge is
 * hidden, being on a timer. Demos run on the synthetic dataset and reach no server — except one
 * curated on a published dataset (`wizard/curated.ts`), whose `capture.signIn` names the
 * credential it needs. That is read from this machine
 * (`readCaveToken`: `CAVE_TOKEN`, or caveclient's `~/.cloudvolume/secrets/cave-secret.json`),
 * handed to the page once per run before any workflow opens, never printed; the profile holding
 * it is deleted on exit, and a shot whose credential is missing is skipped with a line saying so.
 *
 * Shots are taken at `CAPTURE_DENSITY` and cropped to the open dialog, which is
 * what makes a viewer's panel read at the size a changelog card draws it. Review them before
 * committing: a capture that ran before its node finished is a picture of a spinner.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { CHANGELOG } from '../src/changelog/entries.ts'
import { demoFragment } from '../src/data/share/fragment.ts'
import { CAPTURE_DENSITY, depictsCard, thumbFile } from '../src/changelog/images.ts'
import {
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  readCaveToken,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const base = args.value('--url') ?? 'http://localhost:5183/'
const only = args.value('--only')
const OUT = fileURLToPath(new URL('../public/changelog/', import.meta.url))

/** After `runAll` resolves and after a viewer or dialog opens: long enough for a canvas to draw. */
const SETTLE_MS = 1500
/** The What's New card's thumbnail slot is 72 CSS px wide; this is that at the capture density. */
const THUMB_WIDTH = 72 * CAPTURE_DENSITY

// A capture of the What's New card shows other entries' thumbnails, so it runs after everything
// else — or it pictures the thumbnails this run has not taken yet as broken (`depictsCard`).
const shots = CHANGELOG.flatMap((e) => e.features ?? [])
  .filter((f) => f.image?.capture && (!only || f.image.file === only))
  .map((f) => ({ file: f.image.file, capture: f.image.capture, feature: f }))
  .sort((a, b) => Number(depictsCard(a.capture)) - Number(depictsCard(b.capture)))

if (shots.length === 0) {
  console.log(only ? `No capture declares ${only}.` : 'No capture declared.')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const PROFILE = '/tmp/coda-changelog-shots'
const { send, evaluate, waitFor, rect, close } = await launchChrome({
  port: 9479,
  profile: PROFILE,
  width: 1440,
  height: 900,
  dpr: CAPTURE_DENSITY,
})

// The profile may come to hold a credential, so it never outlives the run.
deleteProfileOnExit(PROFILE, close)

const STORE = "(await import('/src/store/graphStore.ts')).useGraphStore"
const inPage = (body) => evaluate(`(async () => { const s = ${STORE}; ${body} })()`)

/*
 * Each credential a capture names, handed over once, before any workflow opens — or its first run
 * is an auth failure rather than a picture. It is kept in the profile's storage for the run. The
 * app has to be loaded to take it; each shot below then loads its own link fresh.
 */
const signedIn = new Set()
for (const kind of new Set(shots.flatMap((s) => (s.capture.signIn ? [s.capture.signIn] : [])))) {
  const token = kind === 'cave' ? readCaveToken() : undefined
  if (!token) continue
  await send('Page.navigate', { url: base })
  await waitFor('document.querySelector(".react-flow__pane") !== null', 'the canvas')
  if (await handCaveToken(send, token)) signedIn.add(kind)
}

let failed = 0
for (const { file, capture, feature } of shots) {
  try {
    if (capture.signIn && !signedIn.has(capture.signIn)) {
      console.log(`- ${file}: skipped, no ${capture.signIn} credential on this machine`)
      continue
    }
    // A page load, not a hash change: the app reads its link when it loads.
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
    // The link the feature's own button opens, so the picture is of that workflow.
    await send('Page.navigate', { url: base + (feature.demo ? demoFragment(feature.demo) : '') })
    // The pane rather than a node: a capture with no demo opens on the first visit's canvas.
    await waitFor('document.querySelector(".react-flow__pane") !== null', 'the canvas')
    // The link's workflow can land after the pane, over the first visit's own: wait for the node
    // the picture is of.
    if (capture.expand) {
      const type = JSON.stringify(capture.expand)
      await waitFor(
        `(async () => ${STORE}.getState().graph.nodes.some((n) => n.type === ${type}))()`,
        `a ${capture.expand} node`,
      )
    }
    await inPage(`
      s.getState().closeStartPage()
      s.getState().closeGuides()
      const style = document.createElement('style')
      style.textContent = '.feedback-nudge { display: none !important }'
      document.head.append(style)
    `)
    for (const p of capture.params ?? []) {
      await inPage(`
        const n = s.getState().graph.nodes.find((n) => n.type === ${JSON.stringify(p.type)})
        if (!n) throw new Error('no ${p.type} node in the workflow')
        s.getState().setParam(n.id, ${JSON.stringify(p.param)}, ${JSON.stringify(p.value)})
      `)
    }
    await inPage('await s.getState().runAll()')
    /*
     * Until the node the picture is of has a result — a capture before then is a picture of "No
     * result yet". A failure anywhere says which node and why. A node left stale once the store is
     * idle is run again, *awaited*: a run started on a timer would abort the one in flight
     * (`Scheduler.run`), and a query slower than the timer would then never finish.
     */
    if (capture.expand) {
      const read = `const st = s.getState()
        return { busy: st.busy, nodes: st.graph.nodes.map((n) => [n.id, n.type, st.nodeInfo(n.id).state, st.nodeInfo(n.id).error]) }`
      const deadline = Date.now() + 120_000
      for (;;) {
        const { busy, nodes } = await inPage(read)
        const target = nodes.find(([, type]) => type === capture.expand)
        if (target?.[2] === 'ok') break
        const broken = nodes.find(([, , state]) => state === 'error')
        if (broken) throw new Error(`${broken[0]} (${broken[1]}) failed: ${broken[3]}`)
        if (Date.now() > deadline) throw new Error(`${capture.expand} had no result after two minutes`)
        // Idle and still not there: run again, awaited. A node that stays blocked would otherwise
        // be asked back to back until the deadline.
        if (!busy) await inPage('await s.getState().runAll()')
        await sleep(100)
      }
    }
    await sleep(SETTLE_MS)
    if (capture.expand) {
      await inPage(`
        const n = s.getState().graph.nodes.find((n) => n.type === ${JSON.stringify(capture.expand)})
        if (!n) throw new Error('no ${capture.expand} node in the workflow')
        s.getState().expandNode(n.id)
      `)
    }
    if (capture.open) await inPage(`s.getState()[${JSON.stringify(capture.open)}]()`)
    // An expanded viewer and every dialog here — the What's New card included — are a `dialog`.
    const DIALOG = '[role="dialog"]'
    if (capture.expand || capture.open) await waitFor(`!!document.querySelector('${DIALOG}')`, DIALOG)
    await sleep(SETTLE_MS)

    const box = await rect(DIALOG)
    const area = box && { x: box.left, y: box.top, width: box.width, height: box.height }
    const take = async (name, scale) => {
      const shot = await send('Page.captureScreenshot', {
        format: 'webp',
        quality: 82,
        ...(area ? { clip: { ...area, scale } } : {}),
      })
      writeFileSync(OUT + name, Buffer.from(shot.result.data, 'base64'))
    }
    await take(file, 1)
    // What the card draws: the same frame at thumbnail size, a few kB instead of a full capture.
    if (!depictsCard(capture) && area) {
      await take(thumbFile(file), THUMB_WIDTH / (area.width * CAPTURE_DENSITY))
    }
    console.log(`✓ ${file}`)
  } catch (error) {
    failed++
    console.error(`✗ ${file}: ${error.message}`)
  }
}

await close()
process.exit(failed ? 1 : 0)
