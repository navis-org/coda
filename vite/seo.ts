/**
 * Discoverability — canonical URLs, link previews, `robots.txt` and `sitemap.xml`.
 *
 * Coda is four static HTML entries on GitHub Pages, so there is no server and no framework to
 * hang any of this off; the build is the only place that knows all four pages exist. That is the
 * whole design constraint, and it is the same one `vite/goatcounter.ts` works under — hence the
 * same shape, and one rule borrowed wholesale: **the page list is derived from
 * `build.rollupOptions.input`, never written out here.** A fifth entry must not be able to arrive
 * with no canonical tag and no sitemap row, which is precisely the failure nobody would notice.
 *
 * Four decisions worth the paragraph each:
 *
 *  - **Titles and descriptions are read off the page, not kept in a table here.** Every entry
 *    already carries a `<title>` and a `<meta name="description">` that somebody wrote for that
 *    page. A second copy in this file is a second spelling, and the copy that drifts is always
 *    the one nobody sees — `og:description` is invisible until it is wrong in a link preview.
 *    So `transformIndexHtml` parses what is there and re-emits it; a page with neither gets no
 *    Open Graph block rather than a made-up one.
 *
 *  - **`SITE_URL` is a constant with an env override, and it is not gated the way analytics is.**
 *    The gate on `CODA_ANALYTICS` exists because a fork's *readers* would otherwise be reported
 *    to a dashboard its operator never chose — a third party acquires data. Nothing here leaves
 *    the fork: the worst case is that a fork which deploys elsewhere and does not set
 *    `CODA_SITE_URL` tells search engines the canonical copy is at coda.science, which is a
 *    consequence contained entirely within that deployment, and for an unmodified fork is
 *    arguably the right answer anyway. `CODA_SITE_URL` may carry a path (`https://x.github.io/coda`);
 *    note that a `robots.txt` below the host root is ignored by every crawler, so a subpath
 *    deployment gets the tags and the sitemap and nothing from the robots file.
 *
 *  - **`lastmod` comes from git, or it is omitted.** The same rule `ZooIndex.updatedAt` follows,
 *    for a sharper reason: a wall clock would restamp all four pages on every deploy, which tells
 *    a crawler that four documents changed when none did, and a source that lies about `lastmod`
 *    is a source Google stops reading it from. If `git log` returns nothing — a shallow clone, a
 *    tarball — the element is left out. An absent `lastmod` is a fact; a false one is worse than
 *    none. This is why `deploy.yml` checks out with `fetch-depth: 0`.
 *
 *  - **No `changefreq` and no `priority`.** Both have been ignored by Google for years and were
 *    never read by Bing. They are noise in a file whose whole value is that it is trustworthy.
 *
 * See [docs/seo.md](../docs/seo.md) for what is indexable on each page and why the editor and the
 * node guide needed static content adding before any of this was worth doing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * Where the published site lives.
 *
 * Spelled here rather than read from `package.json` because it is a deployment fact, not a
 * package fact — the same string appears in README.md's quickstart. Trailing slashes are
 * stripped so every join below is `${SITE_URL}/…`.
 */
const SITE_URL = (process.env.CODA_SITE_URL ?? 'https://coda.science').replace(/\/+$/, '')

/**
 * The hosted MCP server, which is the one address on this site that is not a page of it.
 *
 * Declared here because `llms.txt` states it: that file exists so a model does not have to
 * fetch a second document to act, and an entry pointing at `mcp.html` without the URL on it
 * would defeat the only thing it is for. That makes two spellings — this one and the page's own
 * markup — so `src/mcppage/mcpPage.test.ts` imports this constant and holds the page to it. It
 * is deliberately *not* spread any wider: the four in-app notes name the page, never the host,
 * because a hostname in a React panel outlives the deployment it names.
 */
export const MCP_ENDPOINT = 'https://flyem.mrc-lmb.cam.ac.uk/coda-mcp/mcp'

/** The social card. 1200×630; regenerate with `pnpm og:card` — see `scripts/og-card.svg`. */
const OG_IMAGE = { path: '/og.png', width: 1200, height: 630 }

/**
 * What each entry is called, and what a crawler should be told it is about.
 *
 * Only the *identity* of a page lives here — its URL and the one-line role it plays in the set.
 * The prose is the page's own; see the header. `sources` is what `lastmod` is asked about, and it
 * is deliberately wider than the entry file: the node guide's text is the node registry, so a new
 * node changes that page even though `nodes.html` is untouched.
 */
interface Page {
  /** Path under `SITE_URL`. The editor is the site root, not `/index.html`. */
  url: string
  /**
   * Where this page sits in the order somebody should meet them.
   *
   * Stated rather than derived. It was the URL's *length* before `llms.txt` existed, which put
   * the pages in an order nobody chose and happened not to matter — a sitemap's order means
   * nothing to a crawler. `llms.txt` is read as a list by something deciding what to open, so
   * the order is content there, and a fifth page must not be able to land in the middle of it
   * by being short.
   */
  order: number
  /** Paths `git log` is asked about, in the repo's own spelling. */
  sources: readonly string[]
  /** schema.org type for the page's JSON-LD block. */
  schema: 'SoftwareApplication' | 'WebPage'
}

const PAGES: Record<string, Page> = {
  'index.html': {
    url: '/',
    order: 0,
    sources: ['index.html', 'src/'],
    schema: 'SoftwareApplication',
  },
  'overview.html': {
    url: '/overview.html',
    order: 1,
    sources: ['overview.html', 'src/overview/'],
    schema: 'WebPage',
  },
  'tutorial.html': {
    url: '/tutorial.html',
    order: 2,
    sources: ['tutorial.html', 'src/tutorial/'],
    schema: 'WebPage',
  },
  'nodes.html': {
    url: '/nodes.html',
    order: 3,
    sources: ['nodes.html', 'src/nodeguide/', 'src/nodes/'],
    schema: 'WebPage',
  },
  /*
   * `sources` is wider than the entry file for the node guide's reason: this page's text lives
   * in `src/datasetguide/datasets.ts`, so an edited dataset entry changes the document even
   * though `datasets.html` is untouched.
   */
  'datasets.html': {
    url: '/datasets.html',
    order: 4,
    sources: ['datasets.html', 'src/datasetguide/'],
    schema: 'WebPage',
  },
  /*
   * The MCP server's page. `src/mcp/` is *not* in `sources`: that directory is
   * the contract the server imports, and a change to it moves what the server
   * can do rather than what this document says about it — a `lastmod` off it
   * would report the page as edited on every deploy that touched an export.
   */
  'mcp.html': {
    url: '/mcp.html',
    order: 5,
    sources: ['mcp.html', 'src/mcppage/'],
    schema: 'WebPage',
  },
  /*
   * Last: nobody should meet the changelog before the pages that explain what it is changing.
   * `sources` is the directory for the dataset guide's reason — an entry is edited in
   * `src/changelog/entries.ts`, and the images it names live in `public/changelog/`.
   */
  'changelog.html': {
    url: '/changelog.html',
    order: 6,
    sources: ['changelog.html', 'src/changelog/', 'public/changelog/'],
    schema: 'WebPage',
  },
}

/** Absolute URL for a site-relative path. */
function abs(path: string): string {
  return path === '/' ? `${SITE_URL}/` : SITE_URL + path
}

/**
 * The committer date of the newest commit touching any of `paths`, as `YYYY-MM-DD`.
 *
 * Returns undefined rather than throwing or guessing: a shallow clone answers with an empty
 * string, and `git` may not be on PATH at all. See the header on why that is left blank.
 */
function lastCommitDate(paths: readonly string[]): string | undefined {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...paths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined
  } catch {
    return undefined
  }
}

/** Minimal XML text escaping. URLs here are ours, but a `&` in one is still not valid XML. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The page's own `<title>` and description, un-escaped back into text.
 *
 * Entity handling is deliberately the four the pages actually use rather than a general HTML
 * decoder: `overview.html` writes `&mdash;` and `&#8209;` in headings, and an Open Graph title
 * reading "Coda &mdash; Feature Overview" in a link preview is the kind of wrong that ships.
 */
function decode(s: string): string {
  return s
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&#8209;/g, '‑')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function pageText(html: string): { title?: string; description?: string } {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const description = /<meta\s+name="description"\s+content="([\s\S]*?)"/i.exec(html)?.[1]
  return {
    ...(title ? { title: decode(title) } : {}),
    ...(description ? { description: decode(description) } : {}),
  }
}

export function seo(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'coda:seo',

    configResolved(resolved) {
      config = resolved
    },

    /**
     * Per-page head tags.
     *
     * Runs in dev as well as in build, so the tags can be read off `pnpm dev` rather than only
     * off a deployed artifact — unlike the analytics tag, nothing here has a cost when it fires
     * somewhere it will not be read.
     */
    transformIndexHtml(html, ctx) {
      const file = basename(ctx.path || ctx.filename)
      const page = PAGES[file]
      if (!page) return
      const { title, description } = pageText(html)
      if (!title) return

      const url = abs(page.url)
      const image = abs(OG_IMAGE.path)

      /*
       * `summary_large_image` rather than `summary`: the card is a 1200×630 landscape image, and
       * the small card would centre-crop it to a square, which cuts the wordmark in half.
       */
      const meta: Array<[string, string]> = [
        ['og:type', 'website'],
        ['og:site_name', 'Coda'],
        ['og:locale', 'en'],
        ['og:url', url],
        ['og:title', title],
        ['og:image', image],
        ['og:image:type', 'image/png'],
        ['og:image:width', String(OG_IMAGE.width)],
        ['og:image:height', String(OG_IMAGE.height)],
        ['og:image:alt', 'Coda — a node-graph editor for connectome data analysis'],
        ['twitter:card', 'summary_large_image'],
        ['twitter:title', title],
        ['twitter:image', image],
      ]
      if (description) {
        meta.push(['og:description', description], ['twitter:description', description])
      }

      /*
       * The editor is the application; the other three are pages about it. Both blocks name the
       * same `@id` for the app, so a crawler reading all four resolves them to one entity rather
       * than to four unrelated documents that happen to share a domain.
       */
      const appId = `${abs('/')}#coda`
      const jsonLd =
        page.schema === 'SoftwareApplication'
          ? {
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              '@id': appId,
              name: 'Coda',
              alternateName: 'Connectome Data Analysis',
              url: abs('/'),
              ...(description ? { description } : {}),
              applicationCategory: 'ScientificApplication',
              applicationSubCategory: 'Connectomics',
              operatingSystem: 'Any (web browser)',
              browserRequirements: 'Requires JavaScript and WebGL.',
              image,
              license: 'https://opensource.org/licenses/MIT',
              isAccessibleForFree: true,
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
              softwareHelp: [abs('/overview.html'), abs('/tutorial.html'), abs('/nodes.html')],
              codeRepository: 'https://github.com/navis-org/coda',
              keywords:
                'connectomics, connectome, neuroscience, neuPrint, CAVE, CATMAID, FlyWire, hemibrain, MANC, neuron morphology, synaptic connectivity, node editor, data analysis',
            }
          : {
              '@context': 'https://schema.org',
              '@type': 'WebPage',
              '@id': url,
              url,
              name: title,
              ...(description ? { description } : {}),
              inLanguage: 'en',
              about: { '@id': appId },
              isPartOf: { '@type': 'WebSite', name: 'Coda', url: abs('/') },
            }

      return [
        { tag: 'link', injectTo: 'head' as const, attrs: { rel: 'canonical', href: url } },
        ...meta.map(([property, content]) => ({
          tag: 'meta',
          injectTo: 'head' as const,
          // Open Graph is `property`, Twitter's own namespace is `name`. Most consumers accept
          // either; a few of the older unfurlers accept only the one the spec names.
          attrs: property.startsWith('og:')
            ? { property, content }
            : { name: property, content },
        })),
        {
          tag: 'script',
          injectTo: 'head' as const,
          attrs: { type: 'application/ld+json' },
          // `</script>` cannot appear inside a script element, entity-encoded or not; none of
          // the strings above contain one today, and this is what keeps that true tomorrow.
          children: JSON.stringify(jsonLd).replace(/<\//g, '<\\/'),
        },
      ]
    },

    /**
     * `sitemap.xml`, `robots.txt` and `llms.txt`, emitted rather than committed to `public/`.
     *
     * All three name `SITE_URL`, and a static file in `public/` would be a second place to write
     * it — the thing the whole file is arranged to avoid. Emitting also means each list *is* the
     * build's entry list, so they cannot disagree with it or with each other.
     */
    generateBundle() {
      /*
       * All three shapes rollup accepts, because the sitemap's whole claim is that it is the
       * build's entry list — narrowing to the object form this config happens to use would make
       * that claim true by coincidence rather than by construction.
       */
      const entries = config.build.rollupOptions.input ?? []
      const files = (
        typeof entries === 'string'
          ? [entries]
          : Array.isArray(entries)
            ? entries
            : Object.values(entries)
      ).map((e) => basename(e))

      const rows = files
        .map((file) => ({ file, page: PAGES[file] }))
        .filter((r): r is { file: string; page: Page } => Boolean(r.page))
        // The editor first, then the documents in the order they are meant to be read.
        .sort((a, b) => a.page.order - b.page.order)

      const missing = files.filter((f) => !PAGES[f])
      if (missing.length) {
        // Loud, because the silent version is a page that simply never gets indexed.
        this.warn(`no SEO entry for ${missing.join(', ')} — add it to PAGES in vite/seo.ts`)
      }

      const urls = rows
        .map(({ page }) => {
          const mod = lastCommitDate(page.sources)
          return [
            '  <url>',
            `    <loc>${xml(abs(page.url))}</loc>`,
            ...(mod ? [`    <lastmod>${mod}</lastmod>`] : []),
            '  </url>',
          ].join('\n')
        })
        .join('\n')

      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
      })

      /*
       * Everything is allowed, including the crawlers that feed language models.
       *
       * That is a decision rather than a default. Coda is a research tool whose whole problem is
       * that the people it would help do not know it exists, and "which browser tool reads
       * neuPrint" is now as often asked of an assistant as of a search box. An assistant can only
       * name it if something was allowed to read these pages. There is nothing here to protect:
       * four public documents in a public, MIT-licensed repository, and no user content — a
       * workflow lives in the URL fragment, which no crawler ever sees. See docs/seo.md.
       */
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `# Coda — https://github.com/navis-org/coda
#
# Everything is public and everything is welcome, search engines and AI crawlers alike.
# See docs/seo.md for why that is a decision rather than a default.
User-agent: *
Allow: /

Sitemap: ${abs('/sitemap.xml')}
`,
      })

      /*
       * `llms.txt` — the same list again, for the reader that arrives without a browser.
       *
       * The convention (llmstxt.org) is a markdown file at the root: a name, a one-line summary
       * in a blockquote, then sections of links with a sentence each. Support for it is uneven
       * and it may come to nothing; it costs one emitted file derived from what is already here,
       * which is the whole reason to try it. It is **not** a second sitemap — a crawler has that
       * one — but the thing a sitemap cannot be: a page that says what the links *are*, in the
       * order somebody should read them, and states the one fact that is actionable without
       * reading any of them.
       *
       * That fact is the MCP endpoint, and it is why this file is worth more here than on most
       * sites: a model asked to build a Coda workflow can do it, and the only thing standing
       * between it and that is knowing an address. Sending it to `mcp.html` to find one would be
       * a second fetch for a single line.
       *
       * Titles and descriptions come off each page's own markup, read from disk rather than
       * from `transformIndexHtml`'s cache: this hook's order against that one is vite's business
       * and not a thing to depend on, and the parse is the same `pageText` either way.
       */
      const entry = ({ file, page }: { file: string; page: Page }) => {
        const { title, description } = pageText(readFileSync(join(config.root, file), 'utf8'))
        return `- [${title ?? file}](${abs(page.url)})${description ? `: ${description}` : ''}`
      }

      this.emitFile({
        type: 'asset',
        fileName: 'llms.txt',
        source: `# Coda — connectome data analysis

> A browser-based node-graph editor for connectome data. Query neuPrint, CAVE, CATMAID and
> precomputed Neuroglancer sources, wire up the analysis, and see each step's result where it
> sits. Nothing to install, no account, and every workflow exports as Python or R.

An AI client can build a Coda workflow directly, through the project's MCP server:

\`${MCP_ENDPOINT}\`

Add it as a remote MCP server (streamable HTTP, no sign-in), ask for a pipeline in plain
language, and it hands back a link that opens the finished workflow in a browser. It authors
and checks workflows; it does not run them, and it reads no data.

## Pages

${rows.map(entry).join('\n')}

## Source

- [navis-org/coda](https://github.com/navis-org/coda): the editor itself. MIT licensed.
- [navis-org/coda-mcp](https://github.com/navis-org/coda-mcp): the MCP server above.
`,
      })
    },
  }
}
