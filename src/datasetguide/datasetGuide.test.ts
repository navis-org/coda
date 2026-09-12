/**
 * What holds the Dataset Guide to the registry.
 *
 * `src/datasetguide/datasets.ts` repeats three fields off `DatasetFamily` — the label, the
 * backend and the glyph — because the page cannot import the family table without dragging the
 * whole data layer behind it. Its header argues that; this file is what makes it safe, and it is
 * `anatomy.test.ts`' arrangement: a hand-written document whose every borrowed value is pinned
 * against the source it depicts.
 *
 * Importing the registry is free here, which is the whole reason the copy is affordable.
 *
 * Four properties, and the first two are the ones that catch a dataset added next month:
 *
 *  1. every family has a guide entry;
 *  2. every guide entry names a family;
 *  3. the three borrowed fields agree;
 *  4. a family retired in the family table (`starter: false`) is in the `historical` tier here,
 *     so a recommendation cannot outlive the thing it recommends.
 *
 * Plus the two that are about the page rather than the registry: anchors are unique, and every
 * URL is one a browser will follow.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATASET_FAMILIES } from '../nodes/lib/datasetFamilies'
import { CLADES, DATASET_GUIDE, ELSEWHERE, EXCLUDED, TIERS } from './datasets'
import { anchor, datasetGuideHTML, inline, numberWord } from './render'

const byKey = new Map(DATASET_FAMILIES.map((f) => [f.key, f]))

describe('the dataset guide covers the registry', () => {
  /*
   * The property that makes leaving a dataset out safe: it has to be *typed*. A family that is
   * neither listed nor declared in `EXCLUDED` fails here, so the only way to drop one from the
   * guide is to say so and give a reason.
   */
  it('lists or excludes every dataset family', () => {
    const excluded = new Set(EXCLUDED.map((e) => e.key))
    const missing = DATASET_FAMILIES.filter(
      (f) => !excluded.has(f.key) && !DATASET_GUIDE.some((d) => d.key === f.key),
    ).map((f) => f.key)
    expect(missing, 'families neither listed nor excluded').toEqual([])
  })

  it('names no dataset that is not registered', () => {
    const stray = [...DATASET_GUIDE.map((d) => d.key), ...EXCLUDED.map((e) => e.key)].filter(
      (key) => !byKey.has(key),
    )
    expect(stray, 'guide entries naming no family').toEqual([])
  })

  it('does not both list and exclude a dataset', () => {
    const both = EXCLUDED.filter((e) => DATASET_GUIDE.some((d) => d.key === e.key)).map(
      (e) => e.key,
    )
    expect(both).toEqual([])
  })

  it('gives every exclusion a reason', () => {
    for (const e of EXCLUDED) expect(e.why.length, e.key).toBeGreaterThan(20)
  })

  it.each(DATASET_GUIDE.map((d) => [d.key, d] as const))(
    '%s borrows the family table’s label, backend and glyph',
    (key, entry) => {
      const family = byKey.get(key)
      expect(family, `no family ${key}`).toBeDefined()
      expect(entry.label).toBe(family!.label)
      expect(entry.backend).toBe(family!.backend)
      expect(entry.glyph).toBe(family!.glyph)
    },
  )

  /*
   * The one direction that matters: `starter: false` is the family table saying "do not start
   * here", and a guide recommending it anyway is worse than no guide. The converse is not
   * asserted — a dataset can be a poor starting point for reasons the family table does not
   * record, and `historical` is an editorial judgement.
   */
  it('puts every non-starter family in the historical tier', () => {
    for (const family of DATASET_FAMILIES) {
      if (family.starter !== false) continue
      const entry = DATASET_GUIDE.find((d) => d.key === family.key)
      expect(entry?.tier, `${family.key} is not a starter and should be historical`).toBe(
        'historical',
      )
    }
  })

  it('gives every entry a declared clade', () => {
    const ids = new Set(CLADES.map((c) => c.id))
    for (const d of DATASET_GUIDE) expect(ids.has(d.clade), `${d.key}: ${d.clade}`).toBe(true)
  })

  it('puts every entry in a declared tier', () => {
    const ids = new Set(TIERS.map((t) => t.id))
    for (const d of DATASET_GUIDE) expect(ids.has(d.tier), `${d.key}: ${d.tier}`).toBe(true)
  })
})

describe('the page it renders', () => {
  const html = datasetGuideHTML()

  it('gives every dataset a unique anchor', () => {
    const anchors = DATASET_GUIDE.map((d) => anchor(d.key))
    expect(new Set(anchors).size).toBe(anchors.length)
    for (const a of anchors) expect(html).toContain(`id="${a}"`)
  })

  it('names every dataset and every tier heading', () => {
    for (const d of DATASET_GUIDE) expect(html).toContain(d.label)
    for (const t of TIERS) expect(html).toContain(t.title)
  })

  /*
   * The point of rendering at build time at all: a crawler that runs no script has to reach the
   * prose. If this passes with the paragraphs missing, the SEO argument in `render.ts`' header
   * is fiction.
   */
  it('carries each dataset’s prose in the markup', () => {
    for (const d of DATASET_GUIDE) {
      const firstSentence = d.about.split(/[.\n]/)[0]!.trim()
      expect(html, d.key).toContain(firstSentence.slice(0, 40))
    }
  })

  it('links every repository, citation and toolkit over http(s)', () => {
    const urls = [
      ...DATASET_GUIDE.flatMap((d) => [
        ...d.repositories.map((r) => r.url),
        ...d.citations.map((c) => c.url),
        ...(d.toolkits ?? []).map((t) => t.url),
      ]),
      ...ELSEWHERE.flatMap((e) => e.where.map((w) => w.url)),
    ].filter(Boolean)
    for (const url of urls) expect(url, url).toMatch(/^https?:\/\//)
  })

  /*
   * `inline` escapes before it matches, so a `<` inside a label cannot reopen a tag, and a
   * non-http scheme is left as text. Both are one-line rules that are invisible when broken.
   */
  /*
   * A dataset excluded from the table still has to be reachable from the page, or the exclusion
   * is just a deletion with a comment attached.
   */
  it('draws every excluded dataset that carries a footnote', () => {
    for (const e of EXCLUDED) {
      if (!e.footnote) continue
      /* The whole rendered string, not a slice: a footnote opens in bold, so a raw prefix
         would not appear in the markup and the test would only ever pass by accident. */
      expect(html, e.key).toContain(inline(e.footnote))
    }
  })

  /*
   * `datasets.html`'s masthead states the count in words and no build step can derive it — the
   * file is hand-written markup spliced into, not generated. So it is pinned here instead: the
   * failure otherwise is a page that opens by misreporting how many datasets it covers, which
   * is both invisible in review and exactly the first thing a reader checks.
   */
  it('agrees with the masthead about how many datasets there are', () => {
    const masthead = readFileSync(new URL('../../datasets.html', import.meta.url), 'utf8')
    const word = numberWord(DATASET_GUIDE.length)
    expect(masthead, `masthead should say "${word} datasets"`).toContain(`${word} datasets`)
  })

  /*
   * The tab strip is CSS over a radio group, so these are the parts that break silently: a tab
   * whose filter rule was never generated does nothing, a row with no `data-clade` disappears
   * from every tab but All, and a strip with no `checked` opens showing an empty table.
   */
  describe('the specimen tabs', () => {
    const used = CLADES.filter((c) => DATASET_GUIDE.some((d) => d.clade === c.id))

    it('draws a tab per clade that has a row, and All', () => {
      expect(html).toContain('id="clade-all"')
      for (const c of used) expect(html, c.id).toContain(`id="clade-${c.id}"`)
    })

    it('draws no tab for a clade nothing uses', () => {
      for (const c of CLADES) {
        if (used.includes(c)) continue
        expect(html, c.id).not.toContain(`id="clade-${c.id}"`)
      }
    })

    it('generates a filter rule for every tab but All', () => {
      for (const c of used) expect(html, c.id).toContain(`.compare:has(#clade-${c.id}:checked)`)
      expect(html).not.toContain('#clade-all:checked')
    })

    it('opens on All, so the no-CSS view is the whole table', () => {
      expect(html).toMatch(/id="clade-all" class="tabs__input" checked/)
      expect(html.match(/ checked/g)?.length, 'exactly one checked radio').toBe(1)
    })

    it('tags every row with its clade', () => {
      for (const d of DATASET_GUIDE) {
        expect(html, d.key).toContain(`data-clade="${d.clade}"`)
      }
      const rows = html.match(/<tr data-backend=/g)?.length ?? 0
      const tagged = html.match(/<tr [^>]*data-clade=/g)?.length ?? 0
      expect(tagged).toBe(rows)
    })

    it('counts each tab off the rows it will show', () => {
      for (const c of used) {
        const n = DATASET_GUIDE.filter((d) => d.clade === c.id).length
        expect(html, c.id).toContain(
          `for="clade-${c.id}">${c.label}\n       <span class="tabs__n">${n}`,
        )
      }
    })
  })

  it('escapes markup and refuses a non-http scheme', () => {
    expect(inline('a <b> c')).toBe('a &lt;b&gt; c')
    expect(inline('[x](javascript:alert(1))')).not.toContain('<a')
    expect(inline('[x](/etc/passwd)')).not.toContain('<a')
    expect(inline('[x](https://example.com)')).toContain('href="https://example.com"')
  })

  /*
   * The relative arm, and the half of it that is easy to lose: an on-site link must *not* open
   * in a new tab. Both are one regex, so both are asserted where that regex is.
   */
  it('links an on-site path in the same tab', () => {
    const out = inline('[Open it](./index.html#!demo://dataset.mock.opticlobe)')
    expect(out).toContain('href="./index.html#!demo://dataset.mock.opticlobe"')
    expect(out).not.toContain('target="_blank"')
  })
})
