/**
 * The Neuroglancer card's selection, read back out of the frame — in a real browser.
 *
 * jsdom loads no frame, so `neuroglancerViewer.test.tsx` can only hand the viewer a message it
 * made up. What it cannot show is the whole loop: Coda's own `neuroglancer.html` booting inside the
 * card, neuroglancer changing its segment list the way a double-click does, the frame posting its
 * state, the edit landing on the node, `Selected` growing a looked-up row — and the frame *not*
 * being re-navigated when the node hands back the scene it already shows, which is the half that
 * would otherwise rebuild every layer on every double-click.
 *
 * And the other direction: an upstream change reaching the frame **with the pointer inside it**,
 * set in place rather than restored — the same layer object before and after (nothing rebuilt),
 * the camera where it was, and no navigation. Restoring `layers` is what made an update wait for
 * the pointer to leave; jsdom cannot tell a rebuilt layer from a kept one.
 *
 * Reads from neuPrint and writes nothing anywhere. Needs a dev server and a neuPrint token:
 *
 *   pnpm dev --port 5193 &
 *   NEUPRINT_APPLICATION_CREDENTIALS=… pnpm probe:neuroglancer-select -- --url http://localhost:5193/
 *
 * The segment double-clicked in is driven through neuroglancer's own segment set rather than a
 * synthesized double-click on the canvas: which segment sits under a pixel is a fact about the
 * camera and the EM, not about this feature.
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
const datasetType = args.value('--dataset') ?? 'dataset.hemibrain'
const typePattern = args.value('--type') ?? 'LC10.*'
/** A neuron of the dataset that the type search does not return: the one "double-clicked" in. */
const added = args.value('--add') ?? '1196854070'
const PROFILE = '/tmp/coda-probe-neuroglancer-select'
const STORE = `(await import('/src/store/graphStore.ts')).useGraphStore`

const token = readNeuprintToken()
const { send, evaluate, waitFor, screenshot, close, mouseTo, rect, click } = await launchChrome({
  port: 9452,
  profile: PROFILE,
  width: 1400,
  height: 1000,
  args: ['--use-angle=metal', '--enable-gpu'],
})
deleteProfileOnExit(PROFILE, close)
const { check, finish } = probeReport()
const inStore = (body) => evaluate(`(async () => { const S = ${STORE}; ${body} })()`)

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

const { view, find } = await inStore(`
  const { encodeRows } = await import('/src/data/filterRows.ts')
  const st = S.getState()
  st.newGraph()
  const wire = (source, sourceHandle, target, targetHandle) =>
    S.getState().connect({ source, sourceHandle, target, targetHandle })
  const ds = st.addNode(${JSON.stringify(datasetType)}, { x: 0, y: 0 })
  const find = st.addNode('neuron.findNeurons', { x: 420, y: 0 })
  wire(ds, 'dataset', find, 'dataset')
  S.getState().setParam(find, 'filters', encodeRows([{ field: 'type', op: 'matches', values: [${JSON.stringify(typePattern)}] }]))
  S.getState().setParam(find, 'limit', 3)
  const view = st.addNode('out.neuroglancer', { x: 60, y: 380 })
  wire(ds, 'dataset', view, 'dataset')
  wire(find, 'neurons', view, 'neurons')
  await S.getState().runAll()
  return { view, find }
`)

const FRAME = `document.querySelector('.react-flow__node[data-id="${view}"] .ng-frame iframe')`
const selected = () =>
  inStore(`
    const t = S.getState().nodeOutput(${JSON.stringify(view)}, 'selected')
    return t
      ? {
          ids: t.data.neuronId.map(String),
          types: (t.data.type ?? []).map((v) => v ?? null),
          visible: t.data.visible,
        }
      : null
  `)
const edits = () =>
  inStore(`return S.getState().graph.nodes.find((n) => n.id === ${JSON.stringify(view)}).params.selectionEdits ?? []`)

await waitFor(`!!${FRAME}?.contentWindow?.viewer`, 'neuroglancer to boot in the card', {
  tries: 600,
})
const src = await evaluate(`${FRAME}.getAttribute('src')`)
check(src.includes('neuroglancer.html#!'), "the card opens Coda's own copy of neuroglancer")
const link = await inStore(`return S.getState().nodeOutput(${JSON.stringify(view)}, 'url')?.value`)
check(
  typeof link === 'string' && !link.includes('neuroglancer.html') && !link.includes('localhost'),
  `…while the Link stays the dataset's viewer (${String(link).slice(0, 40)}…)`,
)
// Spelunker's keybindings, which its deployment injects at build time and `keybinds.ts` sets.
const bindings = await evaluate(
  `JSON.stringify(${FRAME}.contentWindow.viewer.inputEventBindings.global.describe())`,
)
check(
  String(bindings).includes('grapheneMergeSegments') &&
    String(bindings).includes('clear-segments'),
  "Spelunker's keybindings are bound (merge on m, clear-segments on Ctrl+Shift+X)",
)
// Long enough for the layers to restore and the opening report to arrive and be ignored.
await sleep(6000)

const before = await selected()
check(before?.ids.length === 3, `Selected starts as the three neurons found (${before?.ids})`)
check((await edits()).length === 0, 'the opening report of the scene is not an edit')
check(
  !(await inStore(`return S.getState().graph.nodes.find((n) => n.id === ${JSON.stringify(view)}).params.view`)),
  'the opening view is not saved: a card nobody has touched writes no view',
)

const layerName = await evaluate(`(() => {
  const v = ${FRAME}.contentWindow.viewer
  const layer = v.layerManager.managedLayers.find((l) => l.layer?.displayState?.segmentationGroupState
    && String(l.name).startsWith(${JSON.stringify(datasetType.replace('dataset.', ''))}))
  return layer?.name ?? null
})()`)
check(Boolean(layerName), `found the dataset's neuron layer (${layerName})`)
const LAYER = `${FRAME}.contentWindow.viewer.layerManager.getLayerByName(${JSON.stringify(layerName)}).layer`
const SEGMENTS = `${LAYER}.displayState.segmentationGroupState.value`

// What a double-click on a neuron does: add it to the layer's visible set.
const srcBefore = await evaluate(`${FRAME}.getAttribute('src')`)
await evaluate(`${SEGMENTS}.visibleSegments.add(${added}n)`)
await sleep(3000)

const stored = await edits()
check(
  JSON.stringify(stored) === JSON.stringify([`+${added}`]),
  `the double-click lands on the node as an edit (${JSON.stringify(stored)})`,
)
const after = await selected()
check(after?.ids.includes(added), `Selected gains the added neuron (${after?.ids})`)
const at = after ? after.ids.indexOf(added) : -1
check(at >= 0 && after.types[at] !== null, `…with its row looked up (type ${after?.types[at]})`)
check(
  (await evaluate(`${FRAME}.getAttribute('src')`)) === srcBefore,
  'the frame is not re-navigated to the scene it already shows',
)

// And out again: the edit is un-done rather than recorded as a removal.
await evaluate(`${SEGMENTS}.visibleSegments.delete(${added}n)`)
await sleep(3000)
check((await edits()).length === 0, 'double-clicking it out again leaves no edit behind')
check((await selected())?.ids.length === 3, 'Selected is back to the three neurons found')

// ── An upstream change, with the pointer inside the frame ──────────────────────────────────────
const box = await rect(`.react-flow__node[data-id="${view}"] .ng-frame`)
await mouseTo(box.left + box.width / 2, box.top + box.height / 2)
await sleep(500)
const CAMERA = `(() => { const v = ${FRAME}.contentWindow.viewer; return JSON.stringify([
  [...v.navigationState.position.value], v.perspectiveNavigationState.zoomFactor.value]) })()`
await evaluate(`${LAYER}.__codaKept = true`)
// Somebody moves the camera, which an update must not undo.
await evaluate(`${FRAME}.contentWindow.viewer.perspectiveNavigationState.zoomBy(0.5)`)
await sleep(500)
const camera = await evaluate(CAMERA)
const srcInside = await evaluate(`${FRAME}.getAttribute('src')`)

await inStore(`
  S.getState().setParam(${JSON.stringify(find)}, 'limit', 5)
  await S.getState().runAll()
`)
await sleep(2000)

const shownNow = await evaluate(
  `${SEGMENTS}.visibleSegments.size`,
)
check(shownNow === 5, `the upstream change reaches the frame with the pointer inside (${shownNow} shown)`)
check(
  (await evaluate(`${LAYER}.__codaKept === true`)) === true,
  '…set in place: the same layer object, nothing rebuilt',
)
check((await evaluate(CAMERA)) === camera, '…and the camera where somebody left it')
check((await evaluate(`${FRAME}.getAttribute('src')`)) === srcInside, '…with no navigation at all')
check((await edits()).length === 0, '…and no edit read into it')
check((await selected())?.ids.length === 5, 'Selected follows the input to five neurons')

// Colours take the same road: a data-driven encoding is a map of stated colours on that layer.
await inStore(`
  S.getState().setParam(${JSON.stringify(view)}, 'segmentColorMode', 'categorical')
  await S.getState().runAll()
`)
await sleep(2000)
const coloured = await evaluate(
  `${LAYER}.displayState.segmentationColorGroupState.value.segmentStatedColors.size`,
)
check(coloured === 5, `a colour change is set in place too (${coloured} stated colours)`)
check(
  (await evaluate(`${LAYER}.__codaKept === true`)) === true &&
    (await evaluate(`${FRAME}.getAttribute('src')`)) === srcInside,
  '…on the same layer, with no navigation',
)

// ── A double-click the card has not seen, overtaken by an update it computed before ────────────
// The frame reports 250 ms after a change settles; an update the card sends inside that window was
// computed without the double-click, and set in place it used to take the neuron back out with
// nothing recorded. Back to the scene's own colours here: no fetch, so the update is immediate.
await evaluate(`${SEGMENTS}.visibleSegments.add(${added}n)`)
await inStore(`
  S.getState().setParam(${JSON.stringify(view)}, 'segmentColorMode', 'default')
  await S.getState().runAll()
`)
await sleep(3000)
const raced = await edits()
check(
  JSON.stringify(raced) === JSON.stringify([`+${added}`]) &&
    (await evaluate(`${SEGMENTS}.visibleSegments.has(${added}n)`)) === true,
  `a double-click overtaken by an update survives it and lands as an edit (${JSON.stringify(raced)})`,
)
// Out again, so the hidden-neuron half below starts from the five the input names.
await evaluate(`${SEGMENTS}.visibleSegments.delete(${added}n)`)
await sleep(3000)

// ── Hidden neurons: removed by default (above), kept and marked under `stay in Selected` ─────────
await inStore(`
  S.getState().setParam(${JSON.stringify(view)}, 'hiddenNeurons', 'keep')
  await S.getState().runAll()
`)
await sleep(1500)
const target = (await selected())?.ids[0]
await evaluate(`${SEGMENTS}.visibleSegments.delete(${target}n)`)
await sleep(3000)
check(
  JSON.stringify(await edits()) === JSON.stringify([`~${target}`]),
  `a neuron hidden in the viewer is noted as hidden, not removed (${JSON.stringify(await edits())})`,
)
const marked = await selected()
const at2 = marked.ids.indexOf(String(target))
check(
  marked.ids.length === 5 && marked.visible?.[at2] === false && marked.visible.filter(Boolean).length === 4,
  'Selected keeps it, with visible = false',
)
check(
  (await evaluate(`${SEGMENTS}.selectedSegments.has(${target}n)`)) ===
    true,
  '…and its chip stays in the frame, hidden',
)

// ── The saved view: a reopened workflow, or a share link, opens where it was left ──────────────
const pastBefore = await inStore(`return S.getState().past.length`)
await evaluate(`${FRAME}.contentWindow.viewer.layout.restoreState('xy-3d')`)
await evaluate(`${FRAME}.contentWindow.viewer.perspectiveNavigationState.zoomBy(0.25)`)
await sleep(2500)
const savedText = await inStore(
  `return S.getState().graph.nodes.find((n) => n.id === ${JSON.stringify(view)}).params.view`,
)
const savedView = savedText ? JSON.parse(savedText) : undefined
check(
  savedView?.view?.layout === 'xy-3d' && typeof savedView?.view?.projectionScale === 'number',
  `the frame's layout and camera are saved on the node (${String(savedText).slice(0, 60)}…)`,
)
check(
  (await inStore(`return S.getState().past.length`)) === pastBefore,
  '…as no undo step',
)

// The file, written and read back into a document of its own — what a share link does too.
await inStore(`
  const g = await import('/src/core/graph.ts')
  const read = g.deserializeGraph(g.serializeGraph(S.getState().graph))
  S.getState().loadGraph(read.graph)
  await S.getState().runAll()
`)
await waitFor(`!!${FRAME}?.contentWindow?.viewer`, 'neuroglancer in the reopened workflow', {
  tries: 600,
})
await sleep(5000)
const reopened = await evaluate(`(() => {
  const v = ${FRAME}.contentWindow.viewer
  return JSON.stringify({ layout: v.layout.toJSON(), scale: v.perspectiveNavigationState.zoomFactor.value })
})()`)
const opened = JSON.parse(reopened)
check(
  opened.layout === 'xy-3d' && Math.abs(opened.scale - savedView?.view?.projectionScale) < 1e-6 * opened.scale,
  `the reopened workflow opens at the same spot (${reopened})`,
)

// ── The dashboard's ⌥1–9, with keyboard focus inside the frame ──────────────────────────────────
// Before Coda's frame handed them back, a key pressed in the frame never reached Coda's document:
// clicking into the scene and pressing ⌥2 switched no tab, and toggled a layer's picking instead.
const tabs = await inStore(`
  const { dashboardOf } = await import('/src/core/dashboard.ts')
  const st = S.getState()
  st.addToDashboard([${JSON.stringify(view)}])
  st.addDashboardTab([])
  const all = dashboardOf(S.getState().graph).tabs.map((t) => t.id)
  S.getState().setDashboardTab(all[0])
  S.getState().setDashboardOpen(true)
  return all
`)
const CELL_FRAME = `document.querySelector('.ng-frame iframe')`
await waitFor(`!!${CELL_FRAME}?.contentWindow?.viewer`, 'neuroglancer in the dashboard cell', {
  tries: 600,
})
await sleep(4000)
const cell = await evaluate(`(() => { const r = ${CELL_FRAME}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
await click(cell.x, cell.y)
await sleep(500)
check(
  (await evaluate(`${CELL_FRAME}.contentDocument.hasFocus()`)) === true,
  'keyboard focus is inside the frame',
)
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', {
    type,
    modifiers: 1, // Alt
    code: 'Digit2',
    key: '™',
    windowsVirtualKeyCode: 50,
  })
}
await sleep(500)
const active = await inStore(`
  const { activeTab } = await import('/src/core/dashboard.ts')
  return activeTab(S.getState().graph).id
`)
check(tabs.length === 2 && active === tabs[1], `⌥2 pressed in the frame switches the dashboard tab (${active})`)
await inStore(`S.getState().setDashboardOpen(false)`)

console.log(`  → ${await screenshot('probe-neuroglancer-select')}`)
finish()
process.exit(0)
