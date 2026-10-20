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
 * same shape; a third is an entry in `PAGES`, and a marker may carry an argument, so every pack's
 * guide shares the same two. The node guide stays separate, its shared module graph being the part
 * worth keeping apart.
 *
 * The body is put in by a replacer function, never as a replacement string: a `$'` in rendered
 * text would otherwise splice the rest of the page in after it.
 */

import type { Plugin, ViteDevServer } from 'vite'
import { createServer } from 'vite'

/**
 * The markers a page carries, `<!--@name-->` or `<!--@name:arg-->`, by name: the module and export
 * that render each, handed the argument where the marker has one — a pack guide's pack id.
 */
const PAGES: Readonly<Record<string, { entry: string; render: string }>> = {
  'dataset-guide': { entry: '/src/datasetguide/render.ts', render: 'datasetGuideHTML' },
  changelog: { entry: '/src/changelog/render.ts', render: 'changelogHTML' },
  // A pack's guide fills two, the masthead's title and lead and the page's body, each naming the
  // pack: every pack's guide is these two.
  'pack-guide-head': { entry: '/src/packguide/render.ts', render: 'packGuideHeadHTML' },
  'pack-guide': { entry: '/src/packguide/render.ts', render: 'packGuideHTML' },
}

/** One grammar for every marker: a name, and an optional argument after a colon. */
const MARKER = /<!--@([\w-]+)(?::([\w-]+))?-->/g

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
      const names = new Set([...html.matchAll(MARKER)].map((m) => m[1]!).filter((n) => n in PAGES))
      if (names.size === 0) return undefined
      // Loaded first, since a replacer cannot wait: each named export, once.
      const renders = new Map<string, (arg?: string) => string>()
      for (const name of names) {
        const { entry, render } = PAGES[name]!
        const fn = (await ssr<Record<string, unknown>>(entry))[render]
        if (typeof fn !== 'function') throw new Error(`${entry} has no ${render}() to fill @${name}`)
        renders.set(name, fn as (arg?: string) => string)
      }
      return html.replace(MARKER, (marker, name: string, arg?: string) => {
        const render = renders.get(name)
        return render ? render(arg) : marker
      })
    },
  }
}
