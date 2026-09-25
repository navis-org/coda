/**
 * The pages rendered in Node at build time and spliced into their HTML: the dataset guide and the
 * changelog.
 *
 * Each page's `render.ts` builds its document body from a table of plain data; this plugin runs
 * it and puts the result where the page's slot marker sits. That leaves the shipped HTML file
 * carrying the page's whole content, which is the property these pages exist for —
 * `docs/seo.md`: a page whose content arrives with the script is a page most crawlers never
 * read.
 *
 * ## Why this is not `vite/nodeGuideData.ts`
 *
 * That plugin runs an SSR server because the node guide's content *is* the node registry — 660 kB
 * of it, unimportable from a static page. Nothing here needs one: each renderer reads plain data,
 * so Vite's ordinary pipeline is not required and a plain dynamic `import()` of the built module
 * would be enough — except that this file is TypeScript in the `tsconfig.node.json` project and
 * the modules it wants are in `tsconfig.app.json`'s. So it borrows the same `ssrLoadModule` route,
 * without the shared module graph that one needs.
 *
 * This was the dataset guide's own plugin until the changelog arrived as a second page of the
 * same shape; a third is a row in `PAGES`. The node guide stays separate, its shared module graph
 * being the part worth keeping apart.
 */

import type { Plugin, ViteDevServer } from 'vite'
import { createServer } from 'vite'

/** A page: the marker its HTML carries, and the module and export that render the body. */
interface RenderedPage {
  slot: string
  entry: string
  render: string
}

const PAGES: readonly RenderedPage[] = [
  { slot: '<!--@dataset-guide-->', entry: '/src/datasetguide/render.ts', render: 'datasetGuideHTML' },
  { slot: '<!--@changelog-->', entry: '/src/changelog/render.ts', render: 'changelogHTML' },
]

export function renderedPages(): Plugin {
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
    name: 'coda:rendered-pages',
    configureServer(devServer) {
      server = devServer
    },
    async closeBundle() {
      await owned?.close()
      owned = undefined
    },
    async transformIndexHtml(html) {
      const page = PAGES.find((p) => html.includes(p.slot))
      if (!page) return undefined
      const mod = await ssr<Record<string, () => string>>(page.entry)
      const render = mod[page.render]
      if (typeof render !== 'function') {
        throw new Error(`${page.entry} has no ${page.render}() to fill ${page.slot}`)
      }
      return html.replace(page.slot, render())
    },
  }
}
