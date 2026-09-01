/**
 * Design notes out of everything the site publishes.
 *
 * The entry documents carry their reasoning inline, next to the tag it explains — the convention
 * the rest of this repo follows, and the right one, because a note about why a description is 155
 * characters long is worthless three files away. What nobody checked is that **vite does not strip
 * HTML comments**, so all of it was served. Measured before the fix: `index.html` was 6,225 bytes
 * of which 3,338 — 54% — was comment prose, `overview.html` 3,572, `tutorial.html` 2,450,
 * `nodes.html` 951, `public/404.html` 1,401 of 3,806.
 *
 * Not a payload problem at that size; a first-impression problem, and it was reported as one —
 * somebody fetching the page by hand to judge whether coda.science is a real research tool got a
 * paragraph about title-tag truncation in the first screen of output. The same text is what a
 * text-extracting crawler takes for page content, which is the audience `index.html`'s
 * `<noscript>` block exists to serve properly.
 *
 * **This is a sweep of the output directory, not a `transformIndexHtml` hook, and that is the
 * whole design.** The obvious version — and the first one written here — transforms each page as
 * vite emits it, which covers exactly `build.rollupOptions.input` and therefore silently misses
 * `public/404.html`: it is copied byte-for-byte and no transform ever sees it. That page is the
 * one GitHub Pages serves for every mistyped and every rotted link to the site, so it carries
 * more stranger-traffic per visit than `nodes.html` does, and it was still shipping 37% design
 * notes while the check said four of four pages were clean. A hook keyed to the entry list can
 * only ever state "no *entry* carries design notes"; the invariant worth having is "nothing we
 * publish does", and the only place that is true is the directory about to be uploaded.
 *
 * Two consequences worth knowing. It needs no page list — a fifth entry, or a sixth file dropped
 * into `public/`, is covered by construction, which is the rule `vite/seo.ts` and
 * `vite/goatcounter.ts` state and then approximate with a hand-maintained table. And it runs after
 * every `transformIndexHtml` in the project has had its say, so a plugin registered later cannot
 * route around it by injecting a commented block — a property the hook version bought with
 * `enforce`/`order` juggling and this one gets from being downstream of the whole build.
 *
 * `apply: 'build'` keeps it off `pnpm dev`, so the dev server serves the file as written and what
 * you read in the editor is what you get in the browser. Only the artefact somebody else fetches
 * is stripped.
 *
 * Deliberately **not** a general HTML minifier. Whitespace between tags is load-bearing in text
 * content and the saving does not justify a class of rendering bug; this removes one node type
 * that is unambiguously not content.
 *
 * See [docs/seo.md](../docs/seo.md) for what each page is meant to say to a crawler.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * A `<script>`/`<style>` element whole, or an HTML comment.
 *
 * Order matters: at a given index the element arm is tried first, which is what keeps a `<!--`
 * inside a script from being read as a comment — in there it is characters, not a comment, and
 * cutting to the next `-->` would delete live code and leave a file that still parses. No page
 * has an inline script body of its own today, which is exactly the condition that makes the naive
 * one-arm regex pass review and break silently later; `vite/seo.ts` already injects an inline
 * `ld+json` block, so the case is live rather than hypothetical. A `<script>` *inside* a comment
 * starts later than the comment enclosing it and so loses to it. An unclosed element fails the
 * element arm and falls through to the comment arm, which is the conservative way round.
 */
const SKIP_OR_COMMENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi

/** A description tag at all — `\s+`, so it matches however Prettier has wrapped the attributes. */
const HAS_DESCRIPTION = /<meta\s+name="description"\s+content="/i

/** The same tag as a person greps for it: on one line. See the note in `index.html`. */
const GREPPABLE_DESCRIPTION = /<meta name="description" content="/

export function stripHtmlComments(html: string): string {
  return (
    html
      .replace(SKIP_OR_COMMENT, (match) => (match.startsWith('<!--') ? '' : match))
      // The comment's own indentation outlives it; blank the lines left holding only whitespace,
      // which is what lets the next pass be a plain count of newlines.
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
  )
}

/** Every `.html` file under `dir`, recursively, as absolute paths. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return htmlFiles(path)
    return entry.isFile() && entry.name.endsWith('.html') ? [path] : []
  })
}

export function stripComments(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'coda:strip-html-comments',
    apply: 'build',

    configResolved(resolved) {
      config = resolved
    },

    /**
     * After the bundle is written and `public/` has been copied — the first moment the whole of
     * what gets uploaded exists in one place.
     *
     * The description check rides along rather than living in `vite/seo.ts`, because this is the
     * hook that reads every published page off disk and the rule is about the *artefact*. It is
     * derived, not a list: a page with no description at all — `404.html` — is simply not asked.
     */
    closeBundle() {
      if (config.build.write === false) return
      const outDir = resolve(config.root, config.build.outDir)

      for (const file of htmlFiles(outDir)) {
        const html = readFileSync(file, 'utf8')
        const stripped = stripHtmlComments(html)
        if (stripped !== html) writeFileSync(file, stripped)

        /*
         * Loud, because the silent version is the one that already happened: Prettier wraps a
         * `<meta>` past its print width across four lines, at which point the string
         * `meta name="description"` appears nowhere in the file and the ordinary hand-check —
         * `curl -s <url> | grep 'meta name="description"'` — reports the tag missing on a page
         * that has always had one. Every machine consumer parses HTML and stayed happy, which is
         * why that false negative survived to be reported as a bug. The `<!-- prettier-ignore -->`
         * above each tag is what prevents it; this is what notices when one goes missing.
         */
        if (HAS_DESCRIPTION.test(stripped) && !GREPPABLE_DESCRIPTION.test(stripped)) {
          this.warn(
            `${relative(outDir, file)}: the description tag is wrapped across lines, so ` +
              `\`grep 'meta name="description"'\` cannot find it — restore the ` +
              `\`<!-- prettier-ignore -->\` above it in the source page`,
          )
        }
      }
    },
  }
}
