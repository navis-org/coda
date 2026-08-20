import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { PluginOption } from 'vite'
// vitest's re-export of defineConfig is the one that types the `test` block.
import { defineConfig } from 'vitest/config'
import { nodeGuideData } from './vite/nodeGuideData'

/**
 * Where neuPrint lives. Override with NEUPRINT_HOST to point at another deployment.
 */
const NEUPRINT_HOST = process.env.NEUPRINT_HOST ?? 'https://neuprint.janelia.org'

/**
 * The version the start page shows.
 *
 * Read from package.json here rather than imported in app code: a JSON import would land the
 * whole manifest in the bundle, and `define` substitutes a literal at build time. An alpha that
 * cannot say which alpha it is makes every bug report ambiguous.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

/*
 * A fallback route to neuPrint, not the only one any more.
 *
 * neuPrint historically sent no CORS headers on any response and answered its OPTIONS
 * preflight with 401 before CORS middleware would run, so a browser could not call it
 * directly from any origin, token or not. Janelia has since fixed that on
 * `neuprint-test.janelia.org`; the public deployment has not got it yet. So the app tries a
 * deployment directly first and falls back to this path — see `client.ts`, which does the
 * trying, and `servers.ts`, which decides the order.
 *
 * This only exists while a vite server is running. A build served by anything else has no
 * fallback: against a CORS-enabled deployment it needs none, and against the public one it
 * needs a proxy of its own, named in Connections → Base URL.
 */
const NEUPRINT_PROXY = {
  '/neuprint': {
    target: NEUPRINT_HOST,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/neuprint/, ''),
  },
  /*
   * Fallback for mesh buckets that refuse cross-origin reads. Most do not need it —
   * `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe` all send
   * `Access-Control-Allow-Origin: *`, so those are fetched directly and work in a static
   * deploy. `flyem-male-cns` sends no CORS headers at all, and this is how it is reached.
   * `src/data/precomputed/transport.ts` decides per host which route to use.
   */
  /*
   * Neuroglancer itself, served same-origin.
   *
   * Not for CORS — it frames perfectly well cross-origin, and the *link* the node emits stays
   * an absolute public URL that opens anywhere. This is about being able to *read* the embed's
   * live state: the only way to change the selected segments without discarding the layers,
   * visibility and camera the user has set up is to read their current state, splice ours into
   * it, and write it back. `location.hash` is readable only same-origin.
   *
   * Without this rule the embed still works; it just falls back to replacing the layer list on
   * every update. `src/data/neuroglancer/scene.ts` owns the mapping and the fallback.
   */
  '/ng': {
    target: 'https://neuroglancer-demo.appspot.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/ng/, '') || '/',
  },
  '/gcs': {
    target: 'https://storage.googleapis.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/gcs/, ''),
  },
}

/**
 * Proxy for neuPrint deployments other than the default one.
 *
 * The `/neuprint` rule above is bound to a single target at config time, which is fine while
 * there is one server but not once a node can name its own. This forwards
 * `/np/<encoded-deployment>/<path>` to that deployment, so the Custom neuPrint node's Server
 * field does something in development. `src/data/neuprint/servers.ts` builds the URLs.
 *
 * **It refuses anything but https to a public host.** A dev server that will forward to any URL
 * a page names is a server-side request forgery hole pointed at the developer's own machine and
 * network — localhost dashboards, cloud metadata endpoints. The allowance is deliberately narrow
 * rather than convenient.
 */
function deploymentProxy(): PluginOption {
  const BLOCKED =
    /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? ''
    if (!url.startsWith('/np/')) return next()

    const [, , encoded = '', ...rest] = url.split('/')
    let target: URL
    try {
      target = new URL(decodeURIComponent(encoded))
    } catch {
      res.statusCode = 400
      return res.end('{"error":"unreadable deployment"}')
    }
    if (target.protocol !== 'https:' || BLOCKED.test(target.hostname)) {
      res.statusCode = 403
      return res.end('{"error":"only https to a public host is proxied"}')
    }

    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => resolve(Buffer.concat(chunks)))
          })

    try {
      const upstream = await fetch(`${target.origin}/${rest.join('/')}`, {
        method: req.method ?? 'GET',
        headers: {
          // Only what neuPrint needs. Forwarding the browser's Host or Origin makes it 400.
          ...(req.headers.authorization
            ? { authorization: String(req.headers.authorization) }
            : {}),
          ...(req.headers['content-type']
            ? { 'content-type': String(req.headers['content-type']) }
            : {}),
          accept: 'application/json',
        },
        ...(body && body.length ? { body } : {}),
      })
      res.statusCode = upstream.status
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      res.statusCode = 502
      res.end(JSON.stringify({ error: String(error) }))
    }
  }

  return {
    name: 'coda:neuprint-deployment-proxy',
    configureServer: (server) => {
      server.middlewares.use(handler)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), deploymentProxy(), nodeGuideData()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Relative base so the built bundle works from a subpath (GitHub Pages) as well as root.
  base: './',
  /*
   * Three entries. `tutorial.html` is the scroll-through introduction and
   * `nodes.html` the node guide — both plain TypeScript and CSS, importing
   * nothing from `src/ui` but `theme.css`, so they share the editor's palette
   * without pulling React, sigma or three into documents that draw none of
   * them. Naming all three here is what stops vite treating `index.html` as the
   * only root and silently dropping the others: they build green and 404 in
   * production.
   */
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        tutorial: fileURLToPath(new URL('./tutorial.html', import.meta.url)),
        nodes: fileURLToPath(new URL('./nodes.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Applied to `pnpm dev` *and* `pnpm preview` — they take separate proxy config, and a
  // preview server without it 404s every neuPrint request with an empty body.
  server: { proxy: NEUPRINT_PROXY },
  preview: { proxy: NEUPRINT_PROXY },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
