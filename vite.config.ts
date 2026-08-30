import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { PluginOption } from 'vite'
// vitest's re-export of defineConfig is the one that types the `test` block.
import { defineConfig } from 'vitest/config'
import { goatCounter } from './vite/goatcounter'
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
 * Proxy for a host named by the page rather than by this file.
 *
 * The rules above are each bound to one target at config time, which is fine while a backend has
 * one server and not once a node can name its own. This forwards `/<prefix>/<encoded-origin>/<path>`
 * to that origin. Two prefixes use it, and they are the two backends whose host is a *setting*:
 *
 *  - `/np/` — neuPrint deployments other than the default, so the Custom neuPrint node's Server
 *    field does something in development. `src/data/neuprint/servers.ts` builds the URLs.
 *  - `/st/` — SeaTable deployments. `cloud.seatable.io` answers a preflight 204 with
 *    `Access-Control-Allow-Origin: *` and needs none of this; **FlyTable sends no
 *    `Access-Control-*` header at all**, for any origin, so a browser blocks the request before
 *    it is sent and reports the opaque `TypeError` that means both "no CORS" and "host is down".
 *    Verified against the live deployment; the same API answers a non-browser client perfectly
 *    with the same token, which is what makes it a browser problem rather than a credential one.
 *    `src/data/annotations/seaTable.ts` builds the URLs.
 *
 * One handler rather than two, because the SSRF guard below is the part that must not be
 * copied — and the header forwarding is already exactly what both need.
 *
 * **It refuses anything but https to a public host.** A dev server that will forward to any URL
 * a page names is a server-side request forgery hole pointed at the developer's own machine and
 * network — localhost dashboards, cloud metadata endpoints. The allowance is deliberately narrow
 * rather than convenient.
 *
 * Note what it does **not** cover: a static deploy serves nothing at these paths, so a
 * deployment without CORS is unreachable there whatever this does. The fix for that is one
 * nginx block on the deployment, which is what Janelia did for `neuprint-test`.
 */
function deploymentProxy(): PluginOption {
  const BLOCKED =
    /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i
  /**
   * What each relay prefix forwards, and whether it needs a handshake first.
   *
   * A table rather than a membership list plus `startsWith` branches inside the handler: the
   * header allowlist was a *union* applied to every prefix, so CATMAID's `x-authorization` was
   * being forwarded on neuPrint's and SeaTable's relays too. Each backend's need widening what
   * every other backend forwards is the wrong direction for a thing whose whole job is to be a
   * narrow hole in the dev server.
   */
  const PREFIXES: Record<string, { forward: readonly string[]; csrf?: boolean }> = {
    // neuPrint and SeaTable both authenticate with a plain `Authorization` header.
    '/np/': { forward: ['authorization'] },
    '/st/': { forward: ['authorization'] },
    // CATMAID's token rides on its own header, and an *anonymous* POST needs the CSRF
    // handshake below — which is the only thing here that is more than a forward.
    '/cm/': { forward: ['x-authorization'], csrf: true },
  }

  /*
   * CATMAID's CSRF pair, per origin, for the `/cm/` prefix.
   *
   * This is the one relay here that does more than forward, and the reason is that CATMAID's
   * read endpoints are POST-only behind Django's CSRF: a browser cannot satisfy it, because
   * `Referer` is a forbidden header name and the `csrftoken` cookie is SameSite=Lax. A server
   * can. So one GET to the instance root yields the cookie and the token, and every POST after
   * it carries both plus a same-origin Referer.
   *
   * **The cookie name is per-instance** — `csrftoken_6666cd76f96956469e7be39d750cc7d9`, not
   * `csrftoken` — so it is matched by prefix rather than assumed. See `docs/catmaid_vfb.md`,
   * which is also where the upstream fix that would make this whole block unnecessary is
   * written down.
   */
  const csrf = new Map<string, { cookie: string; token: string }>()

  const csrfFor = async (
    origin: string,
  ): Promise<{ cookie: string; token: string } | undefined> => {
    const held = csrf.get(origin)
    if (held) return held
    try {
      const response = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
      const cookies = response.headers.getSetCookie?.() ?? []
      const found = cookies
        .map((line) => line.split(';')[0] ?? '')
        .find((pair) => pair.startsWith('csrftoken'))
      if (!found) return undefined
      const token = found.slice(found.indexOf('=') + 1)
      const pair = { cookie: found, token }
      csrf.set(origin, pair)
      return pair
    } catch {
      return undefined
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? ''
    const prefix = Object.keys(PREFIXES).find((candidate) => url.startsWith(candidate))
    const rules = prefix ? PREFIXES[prefix] : undefined
    if (!rules) return next()

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
      // Only for the methods that need it: a GET is answered anonymously.
      const needsCsrf = Boolean(rules.csrf) && req.method === 'POST'

      const send = async (pair: { cookie: string; token: string } | undefined) =>
        fetch(`${target.origin}/${rest.join('/')}`, {
          method: req.method ?? 'GET',
          headers: {
            ...(pair
              ? { cookie: pair.cookie, 'x-csrftoken': pair.token, referer: `${target.origin}/` }
              : {}),
            // CATMAID takes its token under this name, and a request carrying one skips CSRF
            // entirely — so a user with a token is relayed unchanged and needs none of the above.
            ...(req.headers['x-authorization']
              ? { 'x-authorization': String(req.headers['x-authorization']) }
              : {}),
            // Only what these APIs need. Forwarding the browser's Host or Origin makes neuPrint
            // answer 400, and SeaTable needs neither.
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

      let upstream = await send(needsCsrf ? await csrfFor(target.origin) : undefined)
      /*
       * One retry with a fresh CSRF pair. Django's anonymous token is stable for a year, so this
       * is not the common path — but a cached pair that has gone stale would otherwise wedge the
       * relay for the life of the dev server, and the symptom (every POST 403s while GETs work)
       * points nowhere near a cache.
       */
      if (needsCsrf && upstream.status === 403) {
        csrf.delete(target.origin)
        upstream = await send(await csrfFor(target.origin))
      }
      res.statusCode = upstream.status
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      res.statusCode = 502
      res.end(JSON.stringify({ error: String(error) }))
    }
  }

  return {
    name: 'coda:named-host-proxy',
    configureServer: (server) => {
      server.middlewares.use(handler)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler)
    },
  }
}

/**
 * Switch off React's development Performance Tracks, in the dev server only.
 *
 * React 19's dev build logs a "Components ⚛" track to Chrome's performance timeline. To label
 * each entry it **deep-diffs the component's old and new props** and serialises them — and for an
 * array of primitives that is `JSON.stringify(value)` with **no length cap**
 * (`addValueToProperties`, `react-dom-client.development.js`). A Coda `TableValue` is an object of
 * one array per column, so handing one to a component costs a full JSON serialisation of the
 * table, twice, on every render where its identity changes.
 *
 * Measured against a real annotation base — 58,340 rows over 60 columns — selecting between two
 * nodes holding one spent **five seconds of CPU and 1.5 GB**, which reads as the tab freezing.
 * `addValueToProperties` and `logComponentRender` were 94% of a heap profile of it.
 *
 * The gate is `console.timeStamp && performance.measure`, evaluated when `react-dom` initialises,
 * so this has to run before any module script — hence `head-prepend` rather than anything in
 * `src/`. **jsdom has no `console.timeStamp`**, which is why none of this is reachable from the
 * test suite and why the whole thing was invisible for four rounds of measurement.
 *
 * `apply: 'serve'`: the production build of `react-dom` contains none of this machinery, so the
 * deployed app never had the problem and nothing needs disabling there.
 *
 * What it costs is React's own track in a performance recording. Set
 * `localStorage['coda.reactTracks'] = '1'` and reload to get it back — worth doing when profiling
 * React itself, and worth undoing before opening a large table again.
 */
function reactTracksOff(): PluginOption {
  return {
    name: 'coda-react-tracks-off',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `try{if(!localStorage.getItem('coda.reactTracks'))console.timeStamp=undefined}catch(e){console.timeStamp=undefined}`,
        },
      ]
    },
  }
}

export default defineConfig({
  plugins: [react(), reactTracksOff(), deploymentProxy(), nodeGuideData(), goatCounter()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Relative base so the built bundle works from a subpath (GitHub Pages) as well as root.
  base: './',
  /*
   * Workers are ES modules, which they have to be: `data/edges/worker.ts` loads its Parquet and
   * Feather decoders through `await import`, and vite's default `iife` format cannot code-split
   * — the build fails outright rather than inlining them. Every `new Worker` in the tree already
   * passes `{ type: 'module' }` (pyodide's engine, the edge importer), so this aligns the build
   * with what the code was already asking for.
   *
   * The alternative was importing the decoders statically in the worker, which builds fine and
   * makes every *CSV* import fetch 70 kB gzipped of Parquet and Arrow it will never call.
   */
  worker: { format: 'es' },

  /*
   * Four entries. `overview.html` is the front door, `tutorial.html` the
   * scroll-through introduction and `nodes.html` the node guide — all three
   * plain TypeScript and CSS, importing nothing from `src/ui` but `theme.css`,
   * so they share the editor's palette without pulling React, sigma or three
   * into documents that draw none of them. Naming all four here is what stops
   * vite treating `index.html` as the only root and silently dropping the
   * others: they build green and 404 in production.
   */
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        overview: fileURLToPath(new URL('./overview.html', import.meta.url)),
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
    // Module-level caches that outlive a test but not a file — see the file's own header.
    setupFiles: ['src/test/setup.ts'],
  },
})
