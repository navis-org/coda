/**
 * The MCP page's tripwires.
 *
 * The page is a static document — a fifth vite entry, not a route — so nothing in the app fails
 * when it goes stale, and most of what is on it is a fact about the *server*, which lives in
 * another repository and cannot be asserted from here. What is checkable is what the page says
 * about itself, and both of these had a way of going wrong silently:
 *
 *  - a hostname edited in one of the places it appears, leaving a config snippet pointing
 *    somewhere the prose does not — or the page and the `llms.txt` `vite/seo.ts` emits naming
 *    different hosts, and
 *  - the entry script renamed, which builds green.
 *
 * The layout is deliberately not asserted, the standing rule for these documents: the reveal and
 * the mock-ups are exactly what jsdom cannot see, so the page is driven by hand in a browser.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HTML = readFileSync(new URL('../../mcp.html', import.meta.url), 'utf8')

/**
 * The endpoint as `vite/seo.ts` declares it, read out of the source rather than imported.
 *
 * An import would be the obvious thing and TypeScript refuses it: `tsconfig.app.json` includes
 * `src` only, `tsconfig.node.json` the vite half, and nothing may reach across — which is also
 * why no plugin in `vite/` imports a `src` module (`renderedPages.ts`' header argues that
 * boundary at length). A constant in `src/` for the two of them to share would be a module the
 * app never loads, existing only so this line could be an import.
 *
 * So: two files, read as text, held to the same string. Reading `mcp.html` as text is what this
 * whole file does anyway.
 */
const MCP_ENDPOINT = (() => {
  const seo = readFileSync(new URL('../../vite/seo.ts', import.meta.url), 'utf8')
  const found = /MCP_ENDPOINT = '([^']+)'/.exec(seo)?.[1]
  if (!found) throw new Error('no MCP_ENDPOINT in vite/seo.ts — has it been renamed?')
  return found
})()

describe('the MCP page', () => {
  it('names one endpoint, everywhere it names one', () => {
    const urls = [...HTML.matchAll(/https:\/\/[^\s"'<]*\/mcp\b/g)].map((m) => m[0])
    expect(
      urls.length,
      'the endpoint should appear in the prose and in the snippets',
    ).toBeGreaterThanOrEqual(3)
    for (const url of urls) expect(url).toBe(MCP_ENDPOINT)
  })

  /*
   * The entry script, because a rename would build green and serve a page with no reveal and no
   * theme — which reads as a styling bug rather than a missing module.
   */
  it('loads its own entry rather than the app', () => {
    expect(HTML).toContain('src="/src/mcppage/main.ts"')
    expect(HTML).not.toContain('/src/main.tsx')
  })
})
