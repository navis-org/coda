/**
 * The Dataset Guide, rendered to HTML at build time.
 *
 * ## Why there is no client renderer
 *
 * The node guide draws its grid in the browser and splices a static index in at build time,
 * because it has a search box and 102 tiles to filter. This page has a dozen cards, no filter
 * and no state, so the split would buy nothing — and the half that matters is the static half.
 * `docs/seo.md`'s rule: a page whose content arrives with the script is a page most crawlers
 * never read, and "which fly connectome should I use" is a question asked of a search box and of
 * a language model in roughly equal measure. Both get the whole document here.
 *
 * So this module renders everything and `main.ts` beside it carries the stylesheet and the
 * stored-theme read, which is the entire client script.
 *
 * ## It never reaches the browser
 *
 * `vite/datasetGuideData.ts` calls `datasetGuideHTML()` in Node during the build and splices the
 * result into `datasets.html` in place of `<!--@dataset-guide-->`. That is the same arrangement
 * `src/nodeguide/appendix.ts` uses, minus the reason that one needs an SSR server: nothing here
 * imports the node registry. `datasets.ts` is plain data with one type-only import, and
 * `ui/glyphs.ts` is drawing data with no runtime imports at all — so this module would in fact
 * be affordable in the browser. It runs in Node because of the paragraph above, not because it
 * has to.
 *
 * Escaping is this module's own, for `appendix.ts`' reason: it guards strings on their way into
 * a file rather than into `innerHTML`, and the two never need to diverge but sharing them would
 * couple two entries for four lines.
 */

import {
  CLADES,
  DATASET_GUIDE,
  ELSEWHERE,
  EXCLUDED,
  TIERS,
  type Citation,
  type DatasetGuideEntry,
  type ElsewhereEntry,
  type Repository,
  type Tier,
} from './datasets'
import { DATASET_GLYPHS, GLYPH_STROKE_WIDTH, SPECIMEN_VIEWBOX, glyphMarkup } from '../ui/glyphs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A stable, URL-safe anchor. The family key with its dot flattened. */
export function anchor(key: string): string {
  return `ds-${key.replace(/[^a-z0-9]+/gi, '-')}`
}

/**
 * The inline markdown `DatasetGuideEntry.about` is allowed to use.
 *
 * Four constructs — link, bold, italic, code — and deliberately not `ui/markdown.ts`, which
 * parses to blocks a React component renders and would have to be paired with a second renderer
 * here. What it does share is the rule that matters: **an href is either `http`/`https` or a
 * `./` path on this site, and nothing else is linked at all** — so a URL typed wrong renders as
 * text rather than as a scheme a browser might act on. The relative arm is what lets a note
 * point at the editor (`./index.html#!demo://…`), which is the same address the cards' own
 * buttons carry; it cannot smuggle a scheme past the rule, because a leading `./` is the whole
 * of what it accepts.
 *
 * An off-site link opens in a new tab and an on-site one does not, which is the convention every
 * other document here follows.
 *
 * Escaping runs first and the constructs are matched over escaped text, so a `<` inside a link
 * label cannot reopen a tag.
 */
export function inline(md: string): string {
  return esc(md)
    .replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|\.\/)[^)\s]+)\)/g,
      (_m, text: string, href: string) => {
        const away = href.startsWith('.') ? '' : ' target="_blank" rel="noreferrer noopener"'
        return `<a href="${href}"${away}>${text}</a>`
      },
    )
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
}

/** Blank-line-separated paragraphs, each run through `inline`. */
function paragraphs(md: string): string {
  return md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inline(p)}</p>`)
    .join('\n')
}

/**
 * The specimen silhouette, at the size a card wants it.
 *
 * `DATASET_GLYPHS` rather than `glyphShapes`: this is a page about *datasets*, so it wants the
 * silhouette itself rather than the node's 24px glyph with a category mark on it. The stroke
 * width is restored explicitly for `specimenShapes`' reason — scaling a silhouette scales its
 * stroke, and `glyphs.test.ts` pins that rule for the app's own renderers.
 */
function silhouette(entry: DatasetGuideEntry, size: number): string {
  const shapes = DATASET_GLYPHS[entry.glyph]
  return `<svg class="ds__art" width="${size}" height="${Math.round(size * 0.885)}"
    viewBox="${SPECIMEN_VIEWBOX}" fill="none" stroke="currentColor"
    stroke-width="${GLYPH_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${glyphMarkup(shapes)}</svg>`
}

/** Where the editor is from here. `base` is `'./'`, like every other cross-page link. */
const appHref = (fragment: string): string => `./index.html${fragment}`

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * The comparison table.
 *
 * Above the cards because it is the only view on this page that answers "how do these differ"
 * in one glance, which is the question somebody arriving from the wizard's *Don't know which
 * dataset to use?* actually has. Every row links to its card.
 *
 * Its own `overflow-x` container: seven columns do not fit a phone, and per CLAUDE.md a table
 * is one of the three things allowed to be wider than the body.
 */
/**
 * Small numbers as words, because a sentence is where they are going.
 *
 * Exists so the count below is `DATASET_GUIDE.length` rather than a numeral somebody has to
 * remember — which is exactly what went stale the first time a dataset left the list. Past the
 * table it falls back to digits; there will not be forty.
 */
const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]

export const numberWord = (n: number): string => WORDS[n] ?? String(n)

/**
 * The specimen tabs over the comparison table, and the CSS that makes them work.
 *
 * ## No JavaScript, which is the constraint rather than a flourish
 *
 * This page has no client renderer (see the header), so a tab strip cannot be a click handler
 * without giving one back. It is a radio group instead: the inputs are real and visually hidden,
 * each label is a `for=` pill, and a `:has()` rule on the section hides the rows of every other
 * clade. Keyboard support, focus and the accessible role are the browser's own, and the default
 * is **All** — so the no-CSS and no-JS view is the whole table, which is also what a crawler
 * reads.
 *
 * `:has()` rather than a stamped attribute, inverting `editor.css`' rule on purpose: that rule
 * exists where something in React *can* stamp an attribute, and nothing here can. The sibling
 * combinator would also work and is supported further back, at the cost of putting the inputs
 * outside the group they belong to — which would leave the radios with no accessible group name.
 * `@supports` below withdraws the strip where `:has()` is missing, since a tab that does nothing
 * is worse than no tab.
 *
 * ## The rules are generated
 *
 * One rule per clade, built from `CLADES`, so a clade added to that table arrives with a tab and
 * a working filter and no edit here or in `datasetguide.css`. Hand-written they would be the
 * fourth place a clade id is spelled, and the one nothing would catch.
 */
function tabsHTML(counts: ReadonlyMap<string, number>): string {
  const used = CLADES.filter((c) => (counts.get(c.id) ?? 0) > 0)
  /* One tab is not a filter, it is a label for the only thing there. */
  if (used.length < 2) return ''

  const pill = (id: string, label: string, n: number, checked: boolean): string =>
    `<input type="radio" name="clade" id="clade-${esc(id)}" class="tabs__input"${
      checked ? ' checked' : ''
    } />
     <label class="tabs__label" for="clade-${esc(id)}">${esc(label)}
       <span class="tabs__n">${n}</span>
     </label>`

  const rules = used
    .map(
      (c) =>
        `.compare:has(#clade-${c.id}:checked) .compare__table tbody tr:not([data-clade='${c.id}'])` +
        `{display:none}`,
    )
    .join('\n')

  return `<style>
${rules}
@supports not selector(:has(*)) { .tabs { display: none } }
</style>
<div class="tabs" role="radiogroup" aria-label="Filter the table by specimen">
  ${pill('all', 'All', DATASET_GUIDE.length, true)}
  ${used.map((c) => pill(c.id, c.label, counts.get(c.id) ?? 0, false)).join('\n  ')}
</div>`
}

function compareHTML(): string {
  const head = [
    'Dataset',
    'Specimen',
    'Region',
    'Neurons',
    'Completeness',
    'EM resolution',
    'Year',
  ]
  const rows = DATASET_GUIDE.map((d) => {
    const cells = [
      `<a href="#${anchor(d.key)}">${esc(d.label)}</a>`,
      esc(d.specs.specimen),
      esc(d.specs.region),
      esc(d.specs.neurons),
      esc(d.specs.completeness),
      esc(d.specs.resolution),
      esc(d.specs.released),
    ]
    return `<tr data-backend="${esc(d.backend)}" data-tier="${esc(d.tier)}" data-clade="${esc(d.clade)}">
      ${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}
    </tr>`
  }).join('\n')

  /*
   * A family left out of the list says so here rather than nowhere. Only the excluded entries
   * carrying a `footnote` are drawn — see `ExcludedEntry` for why that field is optional.
   */
  const notes = EXCLUDED.filter((e) => e.footnote)
    .map((e) => `<p class="compare__foot">${inline(e.footnote!)}</p>`)
    .join('\n')

  const counts = new Map<string, number>()
  for (const d of DATASET_GUIDE) counts.set(d.clade, (counts.get(d.clade) ?? 0) + 1)

  return `<section class="shell compare" id="compare" aria-labelledby="compare-h">
    <h2 id="compare-h">At a glance</h2>
    <p class="compare__note">
      A quick overview of the ${numberWord(DATASET_GUIDE.length)} preconfigured datasets. Click
      on the names to see details.
    </p>
    ${tabsHTML(counts)}
    <div class="compare__scroll">
      <table class="compare__table">
        <thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${notes}
  </section>`
}

function listHTML(items: readonly string[], kind: 'strength' | 'caveat'): string {
  if (!items.length) return ''
  const label = kind === 'strength' ? 'Pros' : 'Cons'
  return `<div class="judge judge--${kind}">
    <h4>${label}</h4>
    <ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>
  </div>`
}

function repoHTML(r: Repository): string {
  const name = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">${esc(r.name)}</a>`
    : esc(r.name)
  const coda = r.inCoda
    ? `<span class="repo__coda">Opens in Coda as ${esc(r.inCoda)}</span>`
    : ''
  const note = r.note ? `<span class="repo__note">${inline(r.note)}</span>` : ''
  return `<li class="repo"${r.inCoda ? ' data-coda="1"' : ''}>
    <span class="repo__name">${name}</span>${coda}${note}
  </li>`
}

/**
 * One citation.
 *
 * `required` draws a mark rather than reordering, because the list is already ordered and a
 * reader who skims takes the first line. FlyWire's three cannot be told apart by position.
 */
function citeHTML(c: Citation): string {
  const text = c.url
    ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer noopener">${esc(c.text)}</a>`
    : `${esc(c.text)} <span class="cite__todo">(reference needed)</span>`
  const req = c.required ? '<span class="cite__req" title="Cite this one">must cite</span>' : ''
  return `<li class="cite">${text} <span class="cite__what">&mdash; ${esc(c.what)}</span>${req}</li>`
}

function cardHTML(d: DatasetGuideEntry): string {
  const toolkits = d.toolkits?.length
    ? `<div class="ds__block ds__block--kits">
        <h3>Working with it outside Coda</h3>
        <ul class="kits">${d.toolkits
          .map(
            (t) =>
              `<li><a href="${esc(t.url)}" target="_blank" rel="noreferrer noopener">${esc(
                t.name,
              )}</a><span class="kits__lang">${esc(t.language)}</span></li>`,
          )
          .join('')}</ul>
      </div>`
    : ''

  const cites = d.citations.length
    ? `<div class="ds__block ds__block--cite">
        <h3>How to cite it</h3>
        <ul class="cites">${d.citations.map(citeHTML).join('')}</ul>
      </div>`
    : `<div class="ds__block ds__block--cite">
        <h3>How to cite it</h3>
        <p class="ds__none">Nothing to cite &mdash; it is generated, not measured.</p>
      </div>`

  const rather = d.ratherThan ? `<p class="ds__rather">${inline(d.ratherThan)}</p>` : ''

  const specs: Array<[string, string]> = [
    ['Specimen', d.specs.specimen],
    ['Region', d.specs.region],
    ['Neurons', d.specs.neurons],
    ['Completeness', d.specs.completeness],
    ['EM resolution', d.specs.resolution],
    ['Published', d.specs.released],
  ]

  return `<article class="ds" id="${anchor(d.key)}" data-backend="${esc(d.backend)}">
    <header class="ds__head">
      <div class="ds__mark">${silhouette(d, 64)}</div>
      <div class="ds__title">
        <h3>${esc(d.label)}</h3>
        <p class="ds__tagline">${inline(d.tagline)}</p>
      </div>
    </header>

    <dl class="ds__specs">
      ${specs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>

    <div class="ds__about">${paragraphs(d.about)}</div>

    <div class="ds__judge">
      ${listHTML(d.strengths, 'strength')}
      ${listHTML(d.caveats, 'caveat')}
    </div>

    <div class="ds__block ds__block--repos">
      <h3>Where it lives</h3>
      <ul class="repos">${d.repositories.map(repoHTML).join('')}</ul>
    </div>

    ${cites}
    ${toolkits}

    <footer class="ds__foot">
      ${rather}
      <a class="openflow" href="${esc(appHref(`#!demo://dataset.${d.key}`))}">
        Open it in a workflow
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" y1="12" x2="19" y2="12" /><polyline points="13,6 19,12 13,18" />
        </svg>
      </a>
    </footer>
  </article>`
}

function tierHTML(tier: Tier): string {
  const def = TIERS.find((t) => t.id === tier)
  if (!def) return ''
  const members = DATASET_GUIDE.filter((d) => d.tier === tier)
  if (!members.length) return ''
  return `<section class="shell tier" id="tier-${esc(tier)}" aria-labelledby="tier-${esc(tier)}-h">
    <header class="tier__head">
      <h2 id="tier-${esc(tier)}-h">${esc(def.title)}</h2>
      <p>${inline(def.note)}</p>
    </header>
    <div class="tier__cards">${members.map(cardHTML).join('\n')}</div>
  </section>`
}

function elsewhereHTML(e: ElsewhereEntry): string {
  return `<li class="else">
    <h3>${esc(e.label)}</h3>
    <p>${inline(e.what)}</p>
    <p class="else__via"><strong>In Coda:</strong> ${inline(e.via)}</p>
    <ul class="else__where">${e.where
      .map(
        (w) =>
          `<li><a href="${esc(w.url)}" target="_blank" rel="noreferrer noopener">${esc(
            w.name,
          )}</a></li>`,
      )
      .join('')}</ul>
  </li>`
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function datasetGuideHTML(): string {
  return `${compareHTML()}
${TIERS.map((t) => tierHTML(t.id)).join('\n')}
<section class="shell elsewhere" id="elsewhere" aria-labelledby="elsewhere-h">
  <header class="tier__head">
    <h2 id="elsewhere-h">What else is out there</h2>
    <p>
      Connectomes with no node of their own here. Most are still reachable &mdash; the three
      custom dataset nodes take a deployment and a name, and the Neuroglancer Source node takes a
      precomputed bucket.
    </p>
  </header>
  <ul class="elses">${ELSEWHERE.map(elsewhereHTML).join('\n')}</ul>
</section>`
}
