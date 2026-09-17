/**
 * What actually stops a full-resolution neuron being drawn — and what does not.
 *
 * A user asked why Coda showed nothing for two aedes neurons that neuroglancer draws happily. The
 * answer was in their console: **Firefox refuses a draw call asking for more than 30,000,000
 * index values** (`webgl.max-vert-ids-per-draw`), and 13.1 M triangles is 39.4 M of them. It is a
 * limit on one *draw*, not on a mesh — which is exactly why neuroglancer is fine, drawing each of
 * the ~471 supervoxel fragments separately where Coda merges them.
 *
 *   pnpm probe:mesh-upload
 *
 * This measures the half that is checkable from a script: that the memory is **not** the problem,
 * which is what the first diagnosis of this bug claimed. 627 MB uploads either way. The refusal
 * itself is Firefox's and this runs Chrome, so `meshPicking.test.ts` is where the split is pinned
 * against the number; what is here is the evidence that the number is the whole story.
 *
 * Real GPU, not SwiftShader: `--use-angle=metal --enable-gpu`, the flags `docs/viewers.md`
 * records for the ambient-occlusion measurement and for the same reason.
 */

import { launchChrome, probeReport } from './lib/browserProbe.mjs'

const PORT = 9251
const PROFILE = '/tmp/coda-mesh-upload-profile'

/** The measured shape of the two neurons in the workflow that drew nothing. */
const NEURONS = [
  { verts: 6_600_000, tris: 13_143_221 },
  { verts: 6_500_000, tris: 12_935_560 },
]

/** Firefox's cap, which is the thing being demonstrated as reachable. */
const FIREFOX_MAX_INDICES = 30_000_000

const SCRIPT = `((neurons) => {
  const canvas = document.createElement('canvas')
  canvas.width = 640; canvas.height = 480
  document.body.appendChild(canvas)
  const gl = canvas.getContext('webgl2')
  if (!gl) return { error: 'no webgl2' }
  const out = { renderer: '', one: null, many: null }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'

  /*
   * One error check per batch, not per buffer. getError is a synchronous round trip to the
   * driver: called after each of the 2,826 allocations the fragmented case makes, it turned a
   * two-second probe into one that had not finished in fifteen minutes. The failure a probe is
   * looking for is "did any of these fail", which one check at the end answers.
   */
  const upload = (chunks) => {
    const buffers = []
    let bytes = 0
    while (gl.getError() !== gl.NO_ERROR) {
      /* Drain anything an earlier pass left, so this pass reports only its own. */
    }
    for (const { verts, tris } of chunks) {
      for (const [target, size] of [
        [gl.ARRAY_BUFFER, verts * 3 * 4],
        [gl.ARRAY_BUFFER, verts * 3 * 4],
        [gl.ELEMENT_ARRAY_BUFFER, tris * 3 * 4],
      ]) {
        const b = gl.createBuffer()
        gl.bindBuffer(target, b)
        gl.bufferData(target, size, gl.STATIC_DRAW)
        buffers.push(b)
        bytes += size
      }
    }
    const err = gl.getError()
    for (const b of buffers) gl.deleteBuffer(b)
    return { ok: err === gl.NO_ERROR, at: bytes, err, buffers: buffers.length }
  }

  out.one = upload(neurons)
  const frags = []
  for (const n of neurons) {
    for (let i = 0; i < 471; i++) {
      frags.push({ verts: Math.ceil(n.verts / 471), tris: Math.ceil(n.tris / 471) })
    }
  }
  out.many = upload(frags)
  return out
})(${JSON.stringify(NEURONS)})`

const page = await launchChrome({
  port: PORT,
  profile: PROFILE,
  args: ['--use-angle=metal', '--enable-gpu'],
})
const value = await page.evaluate(SCRIPT)

console.error(`GPU: ${value.renderer}`)
const say = (label, x) =>
  console.error(
    `${label.padEnd(26)} ${x?.ok ? 'OK' : `FAILED on ${x?.what} (gl error 0x${(x?.err ?? 0).toString(16)})`}` +
      `  ${((x?.at ?? 0) / 1e6).toFixed(0)} MB`,
  )
say('one buffer set per neuron', value.one)
say('471 fragments per neuron', value.many)
for (const n of NEURONS) {
  console.error(
    `${n.tris.toLocaleString().padStart(12)} triangles = ` +
      `${(n.tris * 3).toLocaleString()} indices — ` +
      `${n.tris * 3 > FIREFOX_MAX_INDICES ? 'past' : 'within'} Firefox's ${FIREFOX_MAX_INDICES.toLocaleString()}`,
  )
}

const report = probeReport()
report.check(value.one?.ok === true, 'a full-resolution neuron pair uploads as one buffer set each')
report.check(value.many?.ok === true, 'the same geometry uploads as per-fragment buffers')
report.check(
  NEURONS.every((n) => n.tris * 3 > FIREFOX_MAX_INDICES),
  'and both neurons are past the per-draw index cap, which is what actually stopped them',
)
report.finish('Memory was never the limit; the draw call was.')
