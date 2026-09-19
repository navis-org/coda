#!/usr/bin/env node
/**
 * The NeuronBridge card, drawn in a real browser against the real bucket.
 * `pnpm probe:neuronbridge` (needs `pnpm dev --port 5193`, or pass `--url`, and a neuPrint token in
 * `NEUPRINT_APPLICATION_CREDENTIALS` for the hemibrain dataset node — the card itself needs none).
 *
 * ## Why this exists
 *
 * The card is a gallery of `<img>`s from two Janelia buckets, and jsdom loads no image and lays out
 * nothing. `neuronBridgeViewer.test.tsx` pins the wiring against recorded JSON; `live.test.ts` HEADs
 * three URLs. Neither can say that a tile actually *draws*, that a 2:1 brain projection fits its
 * frame, or that a card at its default size does not scroll sideways. Each property below is a way
 * this could be broken with every unit test green:
 *
 * 1. **The tiles' thumbnails load** — `naturalWidth > 0` on every image scrolled into view, which is
 *    the only test that the store prefix and the record's path were joined into a URL the bucket
 *    serves *to a page*, not merely to a HEAD request.
 * 2. **Nothing scrolls sideways**, on the card and in the overlay — neither the grid nor the chips.
 * 3. **A tile's line name fits or ellipses**, never spills into its neighbour.
 * 4. **The detail view draws both images it compared**, the EM search image and the LM match.
 * 5. **Paging fetches the next neuron and draws its tiles**, and paging back is served from the
 *    session cache (no second request for the first neuron's match file).
 * 6. **The document is never wider than the viewport** (`docs/ui-shell.md`'s standing property).
 * 7. **A frozen comparison stays put while the tiles scroll** under it, and an unfrozen one scrolls
 *    away with them — the split between `.nbridge__top` and `.nbridge__scroll`, which is layout.
 * 8. **An overlay's layers coincide.** Every layer of a stack reports the same rect, the flipped EM
 *    layer is drawn (visible, loaded) with its scale-bar corner clipped — `clip-path` percentages
 *    are only right if the stack is the image's own shape, which jsdom cannot measure.
 * 9. **Full screen fits the window** with every layer loaded, and Escape closes it without closing
 *    the expanded card under it.
 * 10. **← and → step through lines in full screen**, staying full screen, and each step's image was
 *     already fetched *before* the key was pressed — the preload, which is what makes scanning fast.
 *     Timed from the key to the image drawn, in the one environment where that means anything.
 * 11. **Stepping past the lines on screen reveals the tile** inside the tile list, the next batch
 *     shown as "Show more" would.
 * 12. **☆ Pin in full screen pins the line on screen** — into the node's `pins` param, with the tile
 *     behind showing it — and the card's download menu offers `Pinned matches (CSV)`.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import {
  deleteProfileOnExit,
  handNeuprintToken,
  launchChrome,
  probeArgs,
  probeReport,
  readNeuprintToken,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5193/'
const PROFILE = '/tmp/coda-probe-neuronbridge'
/** Two hemibrain neurons with matches, and one id NeuronBridge has no record of. */
const IDS = ['1734350788', '5813022341', '1']

const STORE = `(await import('/src/store/graphStore.ts')).useGraphStore`

const token = readNeuprintToken()

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9463,
  profile: PROFILE,
  width: 1600,
  height: 1000,
})
const { check, finish } = probeReport()

// The profile holds the token, so it goes on every exit — see `deleteProfileOnExit`.
deleteProfileOnExit(PROFILE, close)

/**
 * Run \`body\` in the page with the store bound to \`S\`. A page-side exception comes back as a
 * value and is thrown here — without that an error building the graph left an empty canvas and a
 * timeout forty seconds later that named the tiles, not the cause.
 */
async function inStore(body) {
  const result = await evaluate(
    `(async () => { try { const S = ${STORE}; return { ok: await (async () => { ${body} })() } } catch (e) { return { error: String(e && e.stack || e) } } })()`,
  )
  if (result?.error) throw new Error(`in the page: ${result.error}`)
  return result?.ok
}

/** Every NeuronBridge request the page has made, from the resource timeline. */
const requests = () =>
  evaluate(
    `performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('neuronbridge-data-prod'))`,
  )

// ── Boot and token ─────────────────────────────────────────────────────────────────────────────

await send('Page.navigate', { url })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
for (let i = 0; i < 30; i++) {
  const clear = await evaluate(`(() => {
    document.querySelector('.small-screen__actions button')?.click()
    document.querySelector('.start__close')?.click()
    document.querySelector('.overlay__close, .overlay [aria-label="Close"]')?.click()
    return !document.querySelector('.start') && !document.querySelector('.overlay')
  })()`)
  if (clear) break
  await sleep(150)
}
await handNeuprintToken(send, token)

// A dev server loads hundreds of modules, which fills Chrome's 250-entry resource-timing buffer
// long before the bucket is asked anything — and a full buffer drops entries silently, which read
// as "paging fetched nothing" the first time this ran.
await evaluate(`performance.setResourceTimingBufferSize(100000); performance.clearResourceTimings()`)

// ── The graph: hemibrain → (ids) → NeuronBridge ────────────────────────────────────────────────

const NB = await inStore(`
  const st = S.getState()
  st.newGraph()
  const wire = (source, sourceHandle, target, targetHandle) =>
    S.getState().connect({ source, sourceHandle, target, targetHandle })
  const ds = st.addNode('dataset.hemibrain', { x: 0, y: 0 })
  const ids = st.addNode('neuron.inputIds', { x: 0, y: 360 })
  // \`addNode\` wires a lone dataset in by itself, and Input IDs then looks the ids up and drops
  // the one hemibrain does not have — the very id this probe needs NeuronBridge to be asked about.
  S.getState().deleteEdges(S.getState().graph.edges.filter((e) => e.target === ids).map((e) => e.id))
  S.getState().setParam(ids, 'ids', ${JSON.stringify(IDS.join('\n'))})
  const nb = st.addNode('out.neuronbridge', { x: 420, y: 0 })
  wire(ds, 'dataset', nb, 'dataset')
  wire(ids, 'neurons', nb, 'neurons')
  await S.getState().runAll()
  return nb
`)
const CARD = `.react-flow__node[data-id="${NB}"]`

const tilesReady = (scope) =>
  `(() => { const n = document.querySelectorAll('${scope} .nbridge__tile'); return n.length > 0 })()`

try {
  await waitFor(tilesReady(CARD), 'tiles on the card', 60_000)
} catch (error) {
  const text = await evaluate(
    `(document.querySelector('${CARD}')?.textContent ?? '(no card)').replace(/\\s+/g, ' ').slice(0, 400)`,
  )
  console.error(`No tiles. Card text: ${text}`)
  console.error(`Screenshot: ${await screenshot('probe-neuronbridge-no-tiles')}`)
  throw error
}

/**
 * The layout properties of whatever surface `scope` names, read in one evaluation. Images are
 * scrolled into view first, since `loading="lazy"` leaves an off-screen one unrequested — which is
 * the feature, and would read as a broken image here.
 */
async function layout(scope) {
  await evaluate(`(async () => {
    const scroll = document.querySelector('${scope} .nbridge__scroll')
    if (!scroll) return
    scroll.scrollTop = 0
  })()`)
  await sleep(2500)
  return evaluate(`(() => {
    const root = document.querySelector('${scope} .nbridge')
    const body = root?.querySelector('.nbridge__body')
    const view = body?.getBoundingClientRect()
    const imgs = [...(root?.querySelectorAll('.nbridge__tile img') ?? [])].filter((img) => {
      const r = img.getBoundingClientRect()
      return view && r.bottom > view.top && r.top < view.bottom
    })
    const spill = [...(root?.querySelectorAll('.nbridge__tile') ?? [])].filter((tile) => {
      const name = tile.querySelector('.nbridge__line')
      if (!name) return false
      const t = tile.getBoundingClientRect()
      const n = name.getBoundingClientRect()
      return n.right > t.right + 0.5
    }).length
    return {
      tiles: root?.querySelectorAll('.nbridge__tile').length ?? 0,
      visible: imgs.length,
      loaded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      broken: imgs.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.src).slice(0, 3),
      sideways: (() => {
        const scroll = root?.querySelector('.nbridge__scroll')
        return body && scroll ? Math.max(body.scrollWidth - body.clientWidth, scroll.scrollWidth - scroll.clientWidth) : -1
      })(),
      controls: (() => { const c = root?.querySelector('.nbridge__controls'); return c ? c.scrollWidth - c.clientWidth : 0 })(),
      spill,
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      header: root?.querySelector('.profile__name')?.textContent ?? '',
    }
  })()`)
}

// ── 1–3, 6 on the card ─────────────────────────────────────────────────────────────────────────

{
  const card = await layout(CARD)
  console.log(`card: ${card.tiles} tiles, ${card.loaded}/${card.visible} visible images loaded, header "${card.header}"`)
  check(card.visible > 0 && card.loaded === card.visible, `every visible thumbnail on the card loads (${card.loaded}/${card.visible})${card.broken.length ? ` — broken: ${card.broken.join(', ')}` : ''}`)
  check(card.sideways <= 0 && card.controls <= 0, `the card does not scroll sideways (grid ${card.sideways}px, chips ${card.controls}px)`)
  check(card.spill === 0, `no line name spills out of its tile (${card.spill})`)
  check(card.doc <= 0, `the document is no wider than the viewport (${card.doc}px over)`)
  console.log(`screenshot: ${await screenshot('probe-neuronbridge-card')}`)
}

// ── The overlay: 1–4 again at full size ────────────────────────────────────────────────────────

await inStore(`S.getState().expandNode(${JSON.stringify(NB)})`)
const OVERLAY = '.overlay'
await waitFor(tilesReady(OVERLAY), 'tiles in the overlay', 30_000)
{
  const big = await layout(OVERLAY)
  console.log(`overlay: ${big.tiles} tiles, ${big.loaded}/${big.visible} visible images loaded`)
  check(big.visible > 0 && big.loaded === big.visible, `every visible thumbnail in the overlay loads (${big.loaded}/${big.visible})`)
  check(big.sideways <= 0 && big.controls <= 0, `the overlay does not scroll sideways (${big.sideways}px, ${big.controls}px)`)
  check(big.spill === 0, `no line name spills out of its tile in the overlay (${big.spill})`)

  await evaluate(`document.querySelector('${OVERLAY} .nbridge__thumb')?.click()`)
  await sleep(3000)
  const detail = await evaluate(`(() => {
    const d = document.querySelector('${OVERLAY} .nbridge__detail')
    const imgs = [...(d?.querySelectorAll('img') ?? [])]
    return { images: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }
  })()`)
  check(detail.images === 2 && detail.loaded === 2, `the detail view draws both images it compared (${detail.loaded}/${detail.images})`)
  console.log(`screenshot: ${await screenshot('probe-neuronbridge-overlay')}`)

  // ── 7: frozen vs scrolling ──
  const detailTop = () => evaluate(`document.querySelector('${OVERLAY} .nbridge__detail')?.getBoundingClientRect().top ?? null`)
  const tileTop = () => evaluate(`document.querySelector('${OVERLAY} .nbridge__grid .nbridge__tile')?.getBoundingClientRect().top ?? null`)
  const scrollBy = (dy) => evaluate(`(() => { const s = document.querySelector('${OVERLAY} .nbridge__scroll'); s.scrollTop += ${dy}; return s.scrollTop })()`)
  {
    const [d0, t0] = [await detailTop(), await tileTop()]
    const moved = await scrollBy(300)
    await sleep(200)
    const [d1, t1] = [await detailTop(), await tileTop()]
    check(moved > 0 && d1 === d0 && t1 < t0, `a frozen comparison stays put while the tiles scroll (detail ${d0}→${d1}, tile ${Math.round(t0)}→${Math.round(t1)}, scrolled ${moved}px)`)
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__freeze input')?.click()`)
    await sleep(300)
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__scroll').scrollTop = 0`)
    const u0 = await detailTop()
    await scrollBy(200)
    await sleep(200)
    const u1 = await detailTop()
    check(u1 < u0, `unfrozen, the comparison scrolls away with the tiles (${Math.round(u0)}→${Math.round(u1)})`)
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__freeze input')?.click()`)
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__scroll').scrollTop = 0`)
    await sleep(300)
  }

  // ── 8: overlay layers coincide ──
  /** Every stack in `scope`: its layers' rects, and each layer's load, visibility and clip. */
  const stacks = (scope) => evaluate(`[...document.querySelectorAll('${scope} .nbridge__stack')].map((stack) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round).join(',') }
    const layers = [...stack.querySelectorAll('img')]
    return {
      box: r(stack),
      rects: layers.map(r),
      loaded: layers.map((i) => i.complete && i.naturalWidth > 0),
      flipped: layers.map((i) => i.dataset.flip === 'true'),
      hidden: layers.map((i) => getComputedStyle(i).visibility === 'hidden'),
      clipped: layers.map((i) => getComputedStyle(i).clipPath !== 'none'),
      blend: layers.map((i) => getComputedStyle(i).mixBlendMode),
      ratio: Number(getComputedStyle(stack).getPropertyValue('--nb-ratio')),
      natural: layers[0] ? [layers[0].naturalWidth, layers[0].naturalHeight] : null,
    }
  })`)
  await evaluate(`[...document.querySelectorAll('${OVERLAY} .nbridge__compare button')].find((b) => b.textContent === 'Overlay')?.click()`)
  await sleep(300)
  await evaluate(`[...document.querySelectorAll('${OVERLAY} .nbridge__compare button')].find((b) => b.textContent === 'Hit + line')?.click()`)
  await sleep(3500)
  {
    const [stack] = await stacks(`${OVERLAY} .nbridge__detail`)
    console.log(`overlay stack: ${JSON.stringify(stack)}`)
    check(!!stack && stack.rects.length === 3 && stack.rects.every((r) => r === stack.rects[0]) && stack.rects[0] === stack.box, `an overlay's three layers coincide with their stack (${stack?.rects.join(' | ')})`)
    check(!!stack && stack.loaded.every(Boolean), `every overlay layer loads (${stack?.loaded})`)
    const em = stack?.flipped.findIndex(Boolean) ?? -1
    check(em >= 0 && !stack.hidden[em] && stack.clipped[em] && stack.blend[em] === 'lighten', `the mirrored EM layer is drawn flipped, visible, corner-clipped and lightened`)
    check(!!stack?.natural && Math.abs(stack.ratio - stack.natural[0] / stack.natural[1]) < 1e-6, `the stack is the image's own shape (${stack?.ratio} for ${stack?.natural})`)
    console.log(`screenshot: ${await screenshot('probe-neuronbridge-overlay-mode')}`)
  }

  // ── 9: full screen ──
  await evaluate(`document.querySelector('${OVERLAY} .nbridge__open')?.click()`)
  await waitFor(`!!document.querySelector('.nbridge-full')`, 'the full-screen view')
  await sleep(3000)
  {
    const view = await evaluate(`(() => {
      const s = document.querySelector('.nbridge-full .nbridge__stack').getBoundingClientRect()
      return { w: innerWidth, h: innerHeight, left: s.left, top: s.top, right: s.right, bottom: s.bottom, width: s.width }
    })()`)
    const [stack] = await stacks('.nbridge-full')
    check(view.left >= 0 && view.top >= 0 && view.right <= view.w && view.bottom <= view.h && view.width > 900, `full screen fits the window and uses it (${Math.round(view.width)}px wide in ${view.w})`)
    check(!!stack && stack.loaded.every(Boolean) && stack.rects.every((r) => r === stack.rects[0]), `every full-screen layer loads and they coincide`)
    console.log(`screenshot: ${await screenshot('probe-neuronbridge-fullscreen')}`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)
    const after = await evaluate(`({ full: !!document.querySelector('.nbridge-full'), overlay: !!document.querySelector('${OVERLAY} .nbridge') })`)
    check(!after.full && after.overlay, `Escape closes full screen and leaves the expanded card open`)
  }
  // Back to the defaults, so paging below is measured as a reader would page.
  await evaluate(`[...document.querySelectorAll('${OVERLAY} .nbridge__compare button')].find((b) => b.textContent === 'Side by side')?.click()`)
  await evaluate(`[...document.querySelectorAll('${OVERLAY} .nbridge__compare button')].find((b) => b.textContent === 'Hit')?.click()`)
  await sleep(1500)

  // ── 10: stepping through lines in full screen ──
  const key = async (name) => {
    const code = name === 'ArrowRight' ? 39 : 37
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
  }
  await evaluate(`document.querySelectorAll('${OVERLAY} .nbridge__detail .nbridge__open')[1]?.click()`)
  await waitFor(`!!document.querySelector('.nbridge-full')`, 'the full-screen LM view')
  await sleep(1500)
  {
    const caption = () => evaluate(`document.querySelector('.nbridge-full [role="dialog"]')?.getAttribute('aria-label') ?? ''`)
    const steps = []
    for (let i = 0; i < 4; i++) {
      const before = await caption()
      await evaluate(`window.__nbPress = performance.now()`)
      await key('ArrowRight')
      // Drawn: the caption moved on and every layer of the new stack has loaded.
      await waitFor(
        `(() => { const d = document.querySelector('.nbridge-full [role="dialog"]'); if (!d || d.getAttribute('aria-label') === ${JSON.stringify(before)}) return false
          const imgs = [...d.querySelectorAll('.nbridge__stack img')]; return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0) })()`,
        'the next line drawn',
        15_000,
      )
      steps.push(await evaluate(`(() => {
        const imgs = [...document.querySelectorAll('.nbridge-full .nbridge__stack img')]
        const early = imgs.every((img) => {
          const entry = performance.getEntriesByName(img.currentSrc || img.src)[0]
          return entry !== undefined && entry.startTime < window.__nbPress
        })
        return { caption: document.querySelector('.nbridge-full [role="dialog"]').getAttribute('aria-label'), ms: Math.round(performance.now() - window.__nbPress), early }
      })()`))
      await sleep(900)
    }
    for (const step of steps) console.log(`  step → ${step.caption}: drawn ${step.ms} ms after the key, fetched ahead: ${step.early}`)
    check(new Set(steps.map((s) => s.caption)).size === steps.length && steps.every((s) => /^LM /.test(s.caption)), `→ steps to a new line each time, keeping the LM image full screen`)
    check(steps.every((s) => s.early), `every step's image was fetched before its key was pressed (the preload)`)
    const worst = Math.max(...steps.map((s) => s.ms))
    check(worst < 250, `each step is drawn within 250 ms of the key (worst ${worst} ms)`)
    await key('ArrowLeft')
    await sleep(500)
    const back = await caption()
    check(back === steps[steps.length - 2].caption, `← steps back to the previous line`)
    console.log(`screenshot: ${await screenshot('probe-neuronbridge-stepped')}`)

    // ── 12: pinning from full screen ──
    const onScreen = (await caption()).match(/^LM (\S+)/)?.[1]
    await evaluate(`document.querySelector('.nbridge-full .nbridge__pin')?.click()`)
    await sleep(400)
    const pinned = await inStore(`
      const node = S.getState().graph.nodes.find((n) => n.id === ${JSON.stringify(NB)})
      return (node.params.pins ?? []).map((e) => JSON.parse(e).line)
    `)
    const state = await evaluate(`({
      button: document.querySelector('.nbridge-full .nbridge__pin')?.getAttribute('aria-pressed'),
      tile: document.querySelector('${OVERLAY} .nbridge__tile[data-selected] .nbridge__star')?.getAttribute('aria-pressed'),
    })`)
    check(pinned.length === 1 && pinned[0] === onScreen && state.button === 'true' && state.tile === 'true', `☆ Pin in full screen pins ${onScreen} into the node, and the tile behind shows it (${JSON.stringify({ pinned, ...state })})`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)
  }

  {
    await evaluate(`document.querySelector('${OVERLAY} .viewer-actions button[aria-label="Download"]')?.click()`)
    await sleep(300)
    const rows = await evaluate(`[...document.querySelectorAll('${OVERLAY} .viewer-actions [role="menuitem"], ${OVERLAY} .viewer-actions li, ${OVERLAY} .viewer-actions button')].map((b) => b.textContent.trim())`)
    check(rows.includes('Pinned matches (CSV).csv'), `the card's download menu offers "Pinned matches (CSV)", naming a .csv (${rows.join(' | ')})`)
    // The viewer clips (`overflow: hidden`), so a menu hanging off either side is cut off.
    const fit = await evaluate(`(() => {
      const card = document.querySelector('${OVERLAY} .nbridge').getBoundingClientRect()
      const menu = document.querySelector('${OVERLAY} .viewer-actions__menu')?.getBoundingClientRect()
      return menu && { left: menu.left - card.left, right: card.right - menu.right, top: menu.top - card.top }
    })()`)
    check(!!fit && fit.left >= 0 && fit.right >= 0 && fit.top >= 0, `the download menu opens inside the card, not clipped at its edge (${JSON.stringify(fit)})`)
    await evaluate(`document.querySelector('${OVERLAY} .viewer-actions button[aria-label="Download"]')?.click()`)
    await sleep(200)
  }

  // ── 11: stepping past the lines on screen ──
  {
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__detail')?.focus()`)
    const shownBefore = await evaluate(`document.querySelectorAll('${OVERLAY} .nbridge__tile[data-line]').length`)
    for (let i = 0; i < 30; i++) await key('ArrowRight')
    await sleep(800)
    const after = await evaluate(`(() => {
      const scroll = document.querySelector('${OVERLAY} .nbridge__scroll').getBoundingClientRect()
      const tile = document.querySelector('${OVERLAY} .nbridge__tile[data-selected]')
      const r = tile?.getBoundingClientRect()
      return {
        shown: document.querySelectorAll('${OVERLAY} .nbridge__tile[data-line]').length,
        index: [...document.querySelectorAll('${OVERLAY} .nbridge__tile[data-line]')].indexOf(tile),
        inside: !!r && r.top >= scroll.top - 1 && r.bottom <= scroll.bottom + 1,
        position: document.querySelector('${OVERLAY} .nbridge__detail .nbridge__stepper .profile__position')?.textContent,
      }
    })()`)
    console.log(`  after 30 steps: ${JSON.stringify(after)} (${shownBefore} lines shown before)`)
    check(after.shown > shownBefore && after.index >= shownBefore, `stepping past the lines on screen shows the next batch (${shownBefore} → ${after.shown})`)
    check(after.inside, `the tile stepped to is scrolled into view in the tile list`)
    // Back to the first line, so paging below starts where a reader would.
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__detail .nbridge__close')?.click()`)
    await evaluate(`document.querySelector('${OVERLAY} .nbridge__scroll').scrollTop = 0`)
    await sleep(300)
  }

  // ── 5: paging ──
  const before = (await requests()).filter((n) => n.includes('/cdsresults/'))
  await evaluate(`document.querySelector('${OVERLAY} .profile__page-btn[aria-label="Next neuron"]')?.click()`)
  await waitFor(
    `(() => { const n = document.querySelector('${OVERLAY} .profile__id')?.textContent; return n === '${IDS[1]}' && document.querySelectorAll('${OVERLAY} .nbridge__tile').length > 0 })()`,
    'the second neuron’s tiles',
    30_000,
  )
  const second = (await requests()).filter((n) => n.includes('/cdsresults/'))
  check(second.length === before.length + 1, `paging fetched the next neuron’s match file (${before.length} → ${second.length})`)
  await evaluate(`document.querySelector('${OVERLAY} .profile__page-btn[aria-label="Previous neuron"]')?.click()`)
  await waitFor(
    `document.querySelector('${OVERLAY} .profile__id')?.textContent === '${IDS[0]}' && document.querySelectorAll('${OVERLAY} .nbridge__tile').length > 0`,
    'the first neuron again',
    10_000,
  )
  const back = (await requests()).filter((n) => n.includes('/cdsresults/'))
  check(back.length === second.length, `paging back was served from the session cache (${second.length} → ${back.length})`)

  await evaluate(`document.querySelector('${OVERLAY} .profile__page-btn[aria-label="Next neuron"]')?.click()`)
  await sleep(300)
  await evaluate(`document.querySelector('${OVERLAY} .profile__page-btn[aria-label="Next neuron"]')?.click()`)
  await waitFor(
    `/no record of this neuron/.test(document.querySelector('${OVERLAY} .nbridge')?.textContent ?? '')`,
    'the no-record sentence for an unindexed id',
    15_000,
  )
  check(true, 'an id NeuronBridge never indexed reads as "no record", not as an error')
}

// Closing Chrome is what lets Node exit: its socket keeps the event loop alive otherwise, and the
// run sat there finished for five minutes before this line existed. The `exit` handler still
// deletes the profile, which holds the token.
close()
finish()
process.exit(0)
