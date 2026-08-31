/**
 * The node guide's static index — every node's prose, in the HTML file itself.
 *
 * ## Why a page that already lists every node needed this
 *
 * `main.ts` renders the whole guide from `virtual:node-guide-data` after load, and what it puts
 * in the tiles is a *label*. The sentence explaining what a node does only enters the DOM when
 * somebody clicks a tile. So the page's actual substance — 49 paragraphs of "what this node
 * takes, what it hands on, when you would reach for it" — was in the shipped HTML nowhere at
 * all, and in the rendered DOM one node at a time.
 *
 * Google renders JavaScript and would eventually have seen the tiles. Nothing else does: not
 * Bing's fast path, not any social unfurler, and not one of the crawlers that feed language
 * models — which for a research tool is now a first-class way of being found at all, since
 * "which browser tool reads neuPrint" gets asked of an assistant as often as of a search box.
 * A crawler that runs no script now reads the masthead, the search bar, an empty grid, and this
 * — which is the page.
 *
 * ## It is real content, not a crawler annexe
 *
 * Rendered visibly at the foot of the page, in the reading order the grid uses, with an anchor
 * per node. Hidden text keyed to a crawler is cloaking and would deserve the penalty it earns;
 * this is the same thing the grid says, laid out to be read straight through, printed, or
 * searched with the browser's own find — which is a form somebody genuinely wants and the grid
 * cannot be.
 *
 * ## This module never reaches the browser
 *
 * It imports `./data`, which imports the whole node registry — 660 kB, and the measurement
 * `data.ts` opens with. `vite/nodeGuideData.ts` calls `appendixHTML()` in Node at build time and
 * splices the result into `nodes.html`, on the same SSR server it already runs the registry dump
 * on. Nothing is committed, so a node added next month appears here with no one touching this
 * file — the property the whole directory is arranged around.
 */

import { guideData, type GuideNode } from './data'
import { CAT_LABEL, SECTIONS } from './sections'

/**
 * HTML escaping for text that came out of a node definition.
 *
 * `main.ts` has its own copy of this, deliberately not shared: that one guards strings on their
 * way into `innerHTML` in a browser, this one guards them on their way into a file. They will
 * never need to diverge, but the day one does, importing this module into the page would cost
 * the 660 kB above.
 *
 * Exported only so `appendix.test.ts` can put a `<` through it. Nothing in the registry carries
 * one today, which is exactly why the guard needs a test of its own rather than a claim about
 * the current text.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A stable, URL-safe anchor for a node type.
 *
 * `out.table` becomes `node-out-table`. Dots are legal in an HTML5 `id` and illegal in a CSS
 * selector without escaping, and an id nobody can write a selector for is one somebody will
 * eventually fix by hand into something that no longer matches the links.
 */
export function nodeAnchor(type: string): string {
  return 'node-' + type.replace(/[^a-zA-Z0-9]+/g, '-')
}

/** `Dataset, Neurons → Table`, or an em dash where a node has no sockets at all. */
function signature(n: GuideNode): string {
  const side = (ports: GuideNode['inputs']): string =>
    ports.map((p) => esc(p.label) + (p.required ? '' : '?')).join(', ')
  if (!n.inputs.length && !n.outputs.length) return ''
  const inputs = side(n.inputs)
  const outputs = side(n.outputs)
  if (!inputs) return `→ ${outputs}`
  if (!outputs) return `${inputs} →`
  return `${inputs} → ${outputs}`
}

function entry(n: GuideNode): string {
  const sig = signature(n)
  /*
   * `description` and `guide` are both printed, and they are not redundant: `nodeGuide.test.ts`
   * fails a node whose `guide` merely repeats its `description`. The first is the one-liner the
   * palette shows, the second is the paragraph written for exactly this surface.
   */
  return `<article class="entry" id="${nodeAnchor(n.type)}">
      <h4 class="entry__name">${esc(n.label)}<code class="entry__type">${esc(n.type)}</code></h4>
      <p class="entry__sig">${sig ? `<span class="entry__ports">${sig}</span>` : ''}<span class="entry__cost">${
        n.cost === 'cheap' ? 'runs live' : 'runs on Run'
      }</span></p>
      ${n.description ? `<p class="entry__desc">${esc(n.description)}</p>` : ''}
      <p class="entry__guide">${esc(n.guide)}</p>
    </article>`
}

/**
 * The whole index, as the markup that replaces `<!--@node-appendix-->` in `nodes.html`.
 *
 * Grouped by `SECTIONS` rather than alphabetically, so it reads in the same order as the grid
 * above it — the pipeline's own order, which is the one thing about the registry a reader is
 * meant to come away with.
 */
export function appendixHTML(): string {
  const { nodes } = guideData()

  const groups = SECTIONS.map((s) => {
    const defs = nodes.filter((n) => s.cats.includes(n.category))
    if (!defs.length) return ''
    const cats = [...new Set(defs.map((n) => CAT_LABEL[n.category]))].join(' · ')
    return `<section class="appendix__group">
      <h3 class="appendix__h">${s.n ? `<span class="appendix__n">${s.n}</span>` : ''}${esc(s.title)}
        <span class="appendix__cats">${esc(cats)}</span></h3>
      <p class="appendix__note">${esc(s.note)}</p>
      <div class="appendix__entries">${defs.map(entry).join('\n      ')}</div>
    </section>`
  }).join('\n    ')

  return `<section class="appendix shell" id="all-nodes" aria-labelledby="all-nodes-h">
    <h2 class="appendix__title" id="all-nodes-h">Every node, in full</h2>
    <p class="appendix__lede">
      The same ${nodes.length} nodes as the grid above, written out in one page — grouped the
      way a pipeline runs, so it can be read straight through or searched with the browser's own
      find. Each entry names what the node takes and hands on, and whether it runs as you type or
      waits for Run.
    </p>
    ${groups}
  </section>`
}
