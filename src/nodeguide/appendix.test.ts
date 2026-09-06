/**
 * The node guide's static index.
 *
 * This one is worth a test in a way the page around it is not. The rest of the guide is drawn in
 * a browser and fails visibly; the appendix is markup nobody looks at — its whole purpose is to
 * be read by a crawler that never reports back. A node missing from it, or a `<` from a node
 * description closing the surrounding element early, would go unnoticed indefinitely, and the
 * only symptom would be a page that quietly stopped ranking.
 *
 * So: coverage against the real registry, and escaping. Layout is not asserted, on the standing
 * every other page in this directory has — jsdom performs no layout, and the multi-column flow
 * was driven in a real browser at 1440px and 420px.
 */

import { describe, expect, it } from 'vitest'
import { appendixHTML, esc, nodeAnchor } from './appendix'
import { guideData } from './data'
import { SECTIONS } from './sections'

const HTML = appendixHTML()
const DATA = guideData()

describe('coverage', () => {
  it('carries every node, by label and by type', () => {
    for (const n of DATA.nodes) {
      expect(HTML, n.type).toContain(`>${n.type}</code>`)
      expect(HTML, n.type).toContain(`id="${nodeAnchor(n.type)}"`)
    }
    expect(HTML.match(/class="entry"/g)?.length).toBe(DATA.nodes.length)
  })

  /*
   * The paragraph is the reason the section exists. Checking the *prose* is present rather than
   * just the name is the difference between an index and the page's actual substance — an
   * earlier version printed labels only, which is what the grid above already ships.
   */
  it('carries every guide paragraph in full', () => {
    for (const n of DATA.nodes) {
      // Compared on a prefix, since escaping rewrites the rest of a string containing `&`.
      const opening = n.guide.slice(0, 40)
      if (/[&<>"]/.test(opening)) continue
      expect(HTML, n.type).toContain(opening)
    }
  })

  it('groups by the same sections the grid uses, and drops none of them', () => {
    // Through `esc`, because one section title is `Visualise & output`.
    for (const s of SECTIONS) expect(HTML).toContain(`${esc(s.title)}\n`)
    // Every node lands in exactly one section, so the counts have to add up. A category added to
    // `NodeCategory` and not to `SECTIONS` fails here rather than silently vanishing.
    const placed = DATA.nodes.filter((n) => SECTIONS.some((s) => s.cats.includes(n.category)))
    expect(placed.length).toBe(DATA.nodes.length)
  })

  it('says how many nodes it holds, and is right', () => {
    expect(HTML).toContain(`The same ${DATA.nodes.length} nodes`)
  })
})

describe('the demo link', () => {
  /*
   * The reason it is *in* the appendix rather than only in the pane above: this section is the
   * half of the page a crawler and a language model read, and a link they can quote is the only
   * way an openable workflow reaches them at all. Spelled out, forty characters, no payload —
   * see `docs/pages.md` for what the packed alternative would have cost this file.
   */
  it('carries an openable link for every node', () => {
    for (const n of DATA.nodes) {
      expect(n.demo, n.type).toMatch(new RegExp(`^#!demo://${n.type.replace('.', '\\.')}(/|$)`))
      // The page composes the href; the fragment is all the registry knows. See `data.ts`.
      expect(HTML, n.type).toContain(`href="./index.html${n.demo}"`)
    }
  })

  it('names the node in the link text, since the anchor is read on its own', () => {
    const first = DATA.nodes[0]!
    expect(HTML).toContain(`>Open ${esc(first.label)} in a workflow</a>`)
  })
})

describe('anchors', () => {
  it('are unique and usable as a CSS selector', () => {
    const ids = DATA.nodes.map((n) => nodeAnchor(n.type))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^node-[a-zA-Z0-9-]+$/)
  })
})

describe('escaping', () => {
  it('escapes every angle bracket and ampersand that came out of a node definition', () => {
    /*
     * The registry is full of both — `→`, `&` in prose, and `<` in a couple of descriptions.
     * Rather than assert on the current text, which changes, the check is structural: strip the
     * markup this module writes and nothing that could open an element may be left.
     */
    const text = HTML.replace(/<\/?(?:section|h2|h3|h4|p|a|article|code|span|div)[^>]*>/g, '')
    expect(text).not.toMatch(/<[a-zA-Z/]/)
  })

  it('escapes the four characters that matter, and nothing else', () => {
    // Not reachable from the registry today, which is why the guard needs a test rather than a
    // claim about the current text: a node description is prose somebody writes, and the day one
    // contains `a < b` the entry around it closes early with nothing failing.
    expect(esc('a < b & c > d "q"')).toBe('a &lt; b &amp; c &gt; d &quot;q&quot;')
    // The ampersand goes first, or `&lt;` comes back out as `&amp;lt;`.
    expect(esc('&lt;')).toBe('&amp;lt;')
    // Prose keeps its own punctuation: an em dash and an arrow are not markup.
    expect(esc("→ — 'ok'")).toBe("→ — 'ok'")
  })
})
