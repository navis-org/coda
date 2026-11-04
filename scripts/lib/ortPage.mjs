/**
 * A page with ONNX Runtime Web on it, serving a converted model beside it.
 *
 * The half of an ORT probe that is not about the thing being probed — `browserProbe.mjs`'s own
 * split, applied one level in. It is not *in* `browserProbe.mjs` because serving ONNX Runtime is
 * the subject of these probes rather than their plumbing; `pyodideProbe.mjs` is the exact
 * analogue for the Python ones.
 *
 * Extracted when the second caller appeared and had **already dropped both of the comments
 * below** — which is the first stage of the decay `browserProbe.mjs`' own header records ("the
 * second one was written by copying the first; that copy had already diverged"). The reasons are
 * the valuable part, so they live here once.
 */

import { createServer } from 'node:http'
import { createReadStream, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

/**
 * The schema `src/ml/manifest.ts` reads. Duplicated here because a `.mjs` cannot import the TS,
 * and checked against the manifest's own field so a mismatch is a sentence rather than a
 * `TypeError` three lines later — `src/ml` is the authority, this is a mirror.
 */
const MANIFEST_SCHEMA = 2

/**
 * A converted model's manifest, or a sentence saying why this probe cannot read it.
 *
 * Both ORT probes start by reading one and then indexing into `parts` and `files`. An older
 * export has neither — schema 1 carried no `parts` at all — and without this the first `.every`
 * throws `Cannot read properties of undefined`, which names nothing a reader can act on.
 */
export function readModelManifest(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  if (manifest.manifestSchema !== MANIFEST_SCHEMA) {
    console.error(
      `${dir} is manifest schema ${manifest.manifestSchema}, and this probe reads ` +
        `${MANIFEST_SCHEMA}. Re-run the converter on it.`,
    )
    process.exit(2)
  }
  if (!manifest.parts?.length || !Array.isArray(manifest.files)) {
    console.error(`${dir}'s manifest declares no parts or no files`)
    process.exit(2)
  }
  return manifest
}

/**
 * ORT's own directory, served whole.
 *
 * Not just the entry module: it fetches `ort-wasm-simd-threaded.jsep.wasm` beside itself at
 * runtime, and serving only the `.mjs` fails as "no available backend found … both async and sync
 * fetching of the wasm failed" — which reads as a WebGPU problem rather than a missing file.
 */
const ORT_DIST = 'node_modules/onnxruntime-web/dist'

const TYPES = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
  '.html': 'text/html',
}

/**
 * Serve the page, ORT and a model directory from one origin.
 *
 * `node:http` rather than shelling out to `python3 -m http.server`, which this repo has no other
 * reason to require, and `listen(0)` rather than a fixed port, which a previous run or another
 * probe can be holding — invisibly, since the spawned server's output went nowhere.
 *
 * `dirs` maps a URL prefix to a directory; `/` is the model directory by convention. Returns the
 * origin to navigate to and the function that stops it.
 */
export async function serveOrtPage({ title, dirs }) {
  // Stated rather than assumed: without it an unprefixed request throws a `node:path` TypeError
  // from inside the request handler, which kills the probe with a stack naming neither.
  if (!dirs?.['/']) throw new Error("serveOrtPage needs a '/' directory to serve the model from")
  const page = `<!doctype html><meta charset=utf-8><title>${title}</title><body>ready</body>
<script type="module">
import * as ort from './ort/ort.webgpu.bundle.min.mjs'
window.ort = ort
</script>`
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/html' })
      return response.end(page)
    }
    let file = null
    if (path.startsWith('/ort/')) file = resolve(join(ORT_DIST, path.slice('/ort/'.length)))
    else {
      for (const [prefix, dir] of Object.entries(dirs)) {
        if (prefix !== '/' && path.startsWith(prefix)) {
          file = resolve(join(dir, path.slice(prefix.length)))
          break
        }
      }
      file ??= resolve(join(dirs['/'], path))
    }
    // The head is written on `open`, not before: writing 200 and then destroying the socket makes
    // a missing model file arrive in the page as `TypeError: Failed to fetch`, which names neither
    // the path nor a status. A 404 carrying the path is what a probe author needs to see.
    const stream = createReadStream(file)
    stream.on('error', () => {
      response.writeHead(404, { ...headers, 'Content-Type': 'text/plain' })
      response.end(`no such file: ${path}`)
    })
    stream.on('open', () => {
      response.writeHead(200, {
        ...headers,
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      })
      stream.pipe(response)
    })
  })
  await new Promise((ready) => server.listen(0, ready))
  return { base: `http://localhost:${server.address().port}`, stop: () => server.close() }
}

/** The handshake every ORT probe waits on after navigating. */
export const ORT_READY = 'Boolean(window.ort)'
