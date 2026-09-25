/**
 * A page per shortcut, generated from `SHORTCUTS` — `coda.science/cortex` is `cortex/index.html`.
 *
 * The site is static, and GitHub Pages answers a path it has no file for with `404.html`, so the
 * main entry never runs at `/cortex`: each shortcut needs a file of its own at its path. That file
 * only redirects, to the app as `?shortcut=<id>`, which the main entry follows
 * (`src/ui/shortcutRoute.ts`). See `docs/packs.md`, "Shortcuts", for why this rather than a
 * second HTML entry or a branch in `404.html`.
 *
 * **Generated, not copied into `public/`.** A hand-copied page per shortcut is a second list: a
 * shortcut added without one falls silently through to the 404, and one removed leaves a live page
 * redirecting to a parameter nothing follows. Emitted from the list, the two cannot disagree.
 *
 * Build only: the dev server falls back to the app for any path, so `/cortex` there proves
 * nothing either way — open `/?shortcut=cortex` instead.
 */

import type { Plugin } from 'vite'

import { SHORTCUTS } from '../src/packs/shortcuts'

/**
 * The page for one shortcut. Relative, so it works from a subpath (`base` is `./`; Pages serves it
 * at `/<id>/`, whose `../` is the root). `replace`, so Back does not land here and bounce forward.
 * The fragment travels, so `/<id>#!<share link>` opens that workflow with the packs on. `noindex`:
 * a redirect is not a page to rank.
 */
export function shortcutPage(id: string): string {
  const target = `../?shortcut=${encodeURIComponent(id)}`
  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Coda</title>
    <script>
      location.replace(${JSON.stringify(target)} + location.hash)
    </script>
  </head>
  <body>
    <p><a href="${target}">Open Coda</a></p>
  </body>
</html>
`
}

export function shortcutPages(): Plugin {
  return {
    name: 'coda-shortcut-pages',
    apply: 'build',
    generateBundle() {
      for (const { id } of SHORTCUTS) {
        this.emitFile({ type: 'asset', fileName: `${id}/index.html`, source: shortcutPage(id) })
      }
    },
  }
}
