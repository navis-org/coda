/**
 * GoatCounter — the visitor counter on the published site.
 *
 * Coda is a static bundle on GitHub Pages, so there are no server logs to read: a beacon from
 * the page is the only route to knowing whether anybody opens this thing. GoatCounter was picked
 * because it is the one that answers that without acquiring anything about the person — no
 * cookie, no `localStorage`, no tracker id, and no stored IP or full User-Agent. See
 * [docs/analytics.md](../docs/analytics.md) for what it does keep and why the dashboard is
 * public.
 *
 * Four decisions here, each of which is silent when wrong:
 *
 *  - **`apply: 'build'`**, so `pnpm dev` never counts. `pnpm preview` serves a real build and
 *    would, except that `count.js` refuses `localhost`, the private IPv4 ranges and `file:`
 *    on its own — so the fallback is theirs, not ours, and holds even if this gate moves.
 *
 *  - **Gated on `CODA_ANALYTICS`**, which only [deploy.yml](../.github/workflows/deploy.yml)
 *    sets. This is a public repository with a permissive licence: anybody can build and host
 *    it. Without the gate a fork's traffic lands silently in *our* dashboard — polluting the
 *    numbers, and, far worse, reporting that fork's readers to a third party its operator never
 *    chose. An unset variable is the only safe default for everyone who is not us.
 *
 *  - **The path is pinned, never derived from the address bar.** GoatCounter's default is
 *    `location.pathname + location.search`. The fragment is excluded, and a Coda share link
 *    carries the entire workflow in the fragment (`#!gh://…`, or the packed graph) — so nothing
 *    leaks *today*. That is a property of how sharing currently happens, not a guarantee about
 *    it: the day a query parameter appears anywhere, its contents would become analytics data
 *    with nothing on screen to say so. Sending a literal per entry closes that off in advance,
 *    and is also base-independent — Pages serves from `/coda/`, and a pinned `/overview` reads
 *    the same on the dashboard wherever the site is mounted.
 *
 *  - **Settings go on `window.goatcounter`, not `data-goatcounter-settings`.** The attribute
 *    takes JSON, and vite serialises tag attributes into double quotes without escaping the
 *    ones inside — the attribute form builds a broken tag. `count.js` opens with
 *    `window.goatcounter = window.goatcounter || {}` and merges the data attribute *over* it,
 *    so setting the global first is both documented and unclobbered.
 */

import { basename } from 'node:path'
import type { Plugin } from 'vite'

/** The site's own endpoint. One instance; the dashboard behind it is public. */
const ENDPOINT = 'https://coda-science.goatcounter.com/count'

/**
 * GoatCounter's hosted `count.js`, ~3.3 kB gzipped.
 *
 * Upstream publishes this protocol-relative (`//gc.zgo.at/count.js`); spelled out as `https:`
 * here because the only pages this is injected into are served over it, and a
 * protocol-relative URL is a legacy affordance for a mixed-scheme world that no longer exists.
 *
 * Vendoring the file into `public/` would remove the only third-party script the site executes,
 * at the cost of a minified blob in the repo that never picks up an upstream fix. Not taken —
 * but it is a one-line change here if that trade ever looks different.
 */
const SCRIPT = 'https://gc.zgo.at/count.js'

/**
 * What one entry is called on the dashboard.
 *
 * Derived from the file rather than looked up in a table, so a fifth entry cannot be added to
 * `build.rollupOptions.input` and silently arrive unlabelled — or, worse, fall back to the
 * default path and start reporting whatever the address bar holds. `index.html` is the editor;
 * calling it `/` on a dashboard that also lists `/overview` invites reading it as a total.
 */
function pinnedPath(file: string): string {
  const name = basename(file).replace(/\.html$/, '')
  return name === 'index' ? '/editor' : `/${name}`
}

export function goatCounter(): Plugin {
  const enabled = Boolean(process.env.CODA_ANALYTICS)
  return {
    name: 'coda-goatcounter',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      if (!enabled) return
      const path = pinnedPath(ctx.path || ctx.filename)
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.goatcounter=${JSON.stringify({ path })}`,
        },
        {
          tag: 'script',
          injectTo: 'head',
          attrs: { 'data-goatcounter': ENDPOINT, async: true, src: SCRIPT },
        },
      ]
    },
  }
}
