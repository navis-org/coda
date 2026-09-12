/**
 * The Dataset Guide, rendered in Node at build time and spliced into `datasets.html`.
 *
 * `src/datasetguide/render.ts` builds the whole document body from `src/datasetguide/datasets.ts`;
 * this plugin runs it and puts the result where `<!--@dataset-guide-->` sits. That leaves the
 * shipped HTML file carrying every dataset's prose, specs, repositories and citations, which is
 * the property the page exists for — `docs/seo.md`: a page whose content arrives with the script
 * is a page most crawlers never read, and this one is meant to be found by somebody asking which
 * connectome to use.
 *
 * ## Why this is not `vite/nodeGuideData.ts`
 *
 * That plugin runs an SSR server because the node guide's content *is* the node registry — 660 kB
 * of it, unimportable from a static page. Nothing here needs one: `datasets.ts` is plain data
 * behind a type-only import and `ui/glyphs.ts` has no runtime imports at all, so Vite's ordinary
 * pipeline is not required and a plain dynamic `import()` of the built module would be enough —
 * except that this file is TypeScript in the `tsconfig.node.json` project and the module it wants
 * is in `tsconfig.app.json`'s. So it borrows the same `ssrLoadModule` route, without the shared
 * module graph that one needs.
 *
 * If a third build-time-rendered page ever arrives, these two plugins are the pair to merge —
 * the SSR server creation is the whole of what they share, and it is worth about forty lines.
 */

import type { Plugin, ViteDevServer } from 'vite'
import { createServer } from 'vite'

const ENTRY = '/src/datasetguide/render.ts'

/** The marker `datasets.html` carries where the rendered body goes. */
const SLOT = '<!--@dataset-guide-->'

export function datasetGuideData(): Plugin {
  let server: ViteDevServer | undefined
  let owned: ViteDevServer | undefined

  async function ssr<T>(entry: string): Promise<T> {
    if (server) return (await server.ssrLoadModule(entry)) as T
    owned ??= await createServer({
      configFile: false,
      logLevel: 'error',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    })
    return (await owned.ssrLoadModule(entry)) as T
  }

  return {
    name: 'coda:dataset-guide-data',
    configureServer(devServer) {
      server = devServer
    },
    async closeBundle() {
      await owned?.close()
      owned = undefined
    },
    async transformIndexHtml(html) {
      if (!html.includes(SLOT)) return undefined
      const mod = await ssr<{ datasetGuideHTML: () => string }>(ENTRY)
      return html.replace(SLOT, mod.datasetGuideHTML())
    },
  }
}
