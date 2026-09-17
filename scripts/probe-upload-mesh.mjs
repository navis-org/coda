#!/usr/bin/env node
/**
 * Upload Mesh, in a browser, with a real file on a real file input.
 *
 * `pnpm probe:upload-mesh` (needs `pnpm dev` on :5177). Four things about this node are outside
 * what jsdom can answer:
 *
 *  1. **A real `FileList` on a real `<input type=file>`.** The component test dispatches a change
 *     event at an input whose `files` it defined itself; only a browser and `DOM.setFileInputFiles`
 *     exercise the path a person's pick actually takes.
 *  2. **The `accept` list has to match the files people pick.** It is extensions rather than media
 *     types, none of the three formats having a registered one, and a dialog handed a type it
 *     does not know hides every file. Nothing in jsdom reads the attribute at all.
 *  3. **The geometry has to reach a WebGL scene.** A mesh with an index past the end, or a bounds
 *     box that does not contain it, draws nothing — and every one of those passes a count.
 *  4. **Units have to move it, by the factor they name.** A thousandfold error is internally
 *     consistent, so a picture cannot show it; the scene's own bounds can.
 *
 * One thing about running it: Vite re-optimises its dependency cache when a *new* module appears,
 * and a dev server that was already up when these files were added serves a half-stale graph — the
 * symptom is React Three Fiber's "Hooks can only be used within the Canvas component!" and a blank
 * page, which looks exactly like a bug in the node. `rm -rf node_modules/.vite` and restart.
 *
 * The file is written here rather than checked in — one tetrahedron, where a fixture would be a
 * second copy of what `meshFile.test.ts` already builds. The graph is built through the store for
 * `probe-viewer3d-switch.mjs`' reason: a demo route's arrangement is not what is being measured.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'

/** A tetrahedron one unit across, so a unit conversion is a factor anybody can check by eye. */
const OBJ = [
  'o TETRA',
  'v 0 0 0',
  'v 1 0 0',
  'v 0 1 0',
  'v 0 0 1',
  'f 1 2 3',
  'f 1 2 4',
  'f 1 3 4',
  'f 2 3 4',
].join('\n')
const objPath = join(mkdtempSync(join(tmpdir(), 'coda-upload-mesh-')), 'TETRA.obj')
writeFileSync(objPath, `${OBJ}\n`)

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9431,
  profile: '/tmp/coda-probe-upload-mesh',
  width: 1500,
  height: 950,
  // Without these headless falls back to SwiftShader, and the 3D card never gets a context —
  // which reads as the geometry not arriving rather than as the browser not having a GPU.
  args: ['--use-angle=metal', '--enable-gpu'],
})

const STORE = `(await import('/src/store/graphStore.ts')).useGraphStore`
const inStore = (body) => evaluate(`(async () => { const S = ${STORE}; ${body} })()`)

/**
 * Dismiss whatever the launch sequence has put up.
 *
 * A fact about Coda's shell rather than about driving a browser, which is why it is here and not
 * in `lib/browserProbe.mjs` — see that file's note.
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

/** Put a real file on the card's `<input type=file>`, which is the only gesture that exists. */
async function pickFile(path) {
  // `send` resolves the whole DevTools reply, so the payload is under `.result` — and `DOM` has
  // to be enabled before `getDocument` hands back a node id `querySelector` will accept.
  await send('DOM.enable')
  const doc = await send('DOM.getDocument', { depth: -1 })
  const found = await send('DOM.querySelector', {
    nodeId: doc.result?.root?.nodeId,
    selector: 'input.upload-body__file',
  })
  const nodeId = found.result?.nodeId
  if (!nodeId) throw new Error(`no file input on the Upload Mesh card: ${JSON.stringify(found)}`)
  await send('DOM.setFileInputFiles', { nodeId, files: [path] })
}

await send('Page.navigate', { url })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')
await clearLaunch()

const ids = await inStore(`
  const st = S.getState()
  st.newGraph()
  const up = st.addNode('core.uploadMesh', { x: 0, y: 0 })
  const view = st.addNode('out.viewer3d', { x: 460, y: 0 })
  S.getState().connect({ source: up, sourceHandle: 'meshes', target: view, targetHandle: 'volumes' })
  return { up, view }
`)
await waitFor(`!!document.querySelector('input.upload-body__file')`, 'the Upload Mesh card')

const { check, finish } = probeReport()

// ── The picker offers the three formats, by extension ────────────────────────────────────────
const accept = await evaluate(
  `document.querySelector('input.upload-body__file').getAttribute('accept')`,
)
check(accept === '.obj,.stl,.ply', `the picker accepts the three extensions ("${accept}")`)
check(
  await evaluate(`document.querySelector('input.upload-body__file').multiple`),
  'and takes several at once, a region set being a directory',
)

// ── A real file goes in, through a real FileList ─────────────────────────────────────────────
await pickFile(objPath)
await waitFor(
  `/TETRA\\.obj/.test(document.querySelector('.upload-body__status')?.textContent ?? '')`,
  'the card to name the file it read',
)
const status = await evaluate(`document.querySelector('.upload-body__status').textContent`)
check(/1 mesh\b/.test(status), `the card counts what it read ("${status.trim()}")`)
check(/4 triangles/.test(status), 'and its triangles, off the file rather than assumed')

/** The value on the node's output port, which is where a scale error is visible at all. */
const bounds = () =>
  inStore(`
    const value = S.getState().nodeOutput(${JSON.stringify(ids.up)}, 'meshes')
    if (!value) return null
    return { items: value.items.length, units: value.units, max: value.bounds.max[0] }
  `)

// ── The geometry reaches a WebGL scene ───────────────────────────────────────────────────────
// Run explicitly rather than relying on auto-run: whether it is on is a stored preference, so a
// probe that waited for it would pass or fail on whatever the last session left behind.
await inStore(`await S.getState().runAll(); return true`)

const asNanometres = await bounds()
check(
  asNanometres?.items === 1 && asNanometres.units === 'nm',
  `one mesh on the wire, in nm (${JSON.stringify(asNanometres)})`,
)
check(
  Math.abs((asNanometres?.max ?? 0) - 1) < 1e-6,
  'a nanometre file arrives exactly as the file wrote it',
)

const CANVAS = `.react-flow__node[data-id=${JSON.stringify(ids.view)}] .viewer3d-canvas canvas`
await waitFor(`!!document.querySelector(${JSON.stringify(CANVAS)})`, 'the 3D card to draw')
const scene = await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(CANVAS)})
  const caption = document.querySelector('.react-flow__node[data-id=${ids.view}] .viewer__caption')
  return { w: el.width, h: el.height, caption: caption?.textContent ?? '' }
})()`)
check(scene.w > 0 && scene.h > 0, `a 3D canvas is drawn (${scene.w}×${scene.h})`)
check(/volume|region|mesh/i.test(scene.caption), `the scene says what is in it ("${scene.caption}")`)
await screenshot('coda-upload-mesh')

// ── Units move it, by the factor they name ───────────────────────────────────────────────────
await inStore(`S.getState().setParam(${JSON.stringify(ids.up)}, 'units', 'um'); return true`)
await inStore(`await S.getState().runAll(); return true`)
await sleep(500)
const asMicrons = await bounds()
check(
  Math.abs((asMicrons?.max ?? 0) - 1000) < 1e-3,
  `microns scale by a thousand (${JSON.stringify(asMicrons)})`,
)

await close()
finish()
