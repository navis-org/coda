/**
 * The overview page's tripwires.
 *
 * The page is a static document — a fourth vite entry, not a route — so nothing
 * in the app fails when it goes stale. Two things about it *are* checkable
 * against the registry, and both had already drifted once before this file
 * existed: the mock-up this page was built from listed CAVE as "in progress"
 * and CATMAID as "planned", months after both had shipped.
 *
 * What is deliberately **not** asserted is the layout: the geometry, the
 * scroll reveal and the mock widgets are exactly what jsdom cannot see, and the
 * page carries the same standing as the tutorial there — driven by hand in a
 * real browser, at several widths, and not by the suite.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import { BACKENDS, DATASET_FAMILIES } from '../nodes/lib/datasetFamilies'
import '../nodes'

const HTML = readFileSync(new URL('../../overview.html', import.meta.url), 'utf8')

/**
 * The page's prose, flattened enough to search.
 *
 * The named entities the markup uses for typography would otherwise make a
 * match depend on which spelling of a hyphen happened to be written — `FIB-19`
 * in one place and `FIB&#8209;19` in another, both of which are the dataset the
 * reader sees.
 */
const TEXT = HTML.replace(/&#8209;|\u2011/g, '-')
  .replace(/&nbsp;|&#160;|\u00a0/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')

describe('the overview page', () => {
  /*
   * The claim the hero makes about the registry's size. A floor rather than a
   * count, so adding a node does not fail a test that is about the page being
   * *wrong* — only dropping below what it advertises does.
   */
  it('does not claim more nodes than the registry has', () => {
    const claim = /(\d+)\+ nodes/.exec(TEXT)
    expect(claim, 'the hero should still state a node count').toBeTruthy()
    expect(listableNodeDefs().length).toBeGreaterThanOrEqual(Number(claim![1]))
  })

  /*
   * "Support for (almost) every major connectome today" is a claim about the
   * backend table, so a fourth backend has to reach the page. The mock family's
   * label is deliberately empty and is skipped for the same reason it adds no
   * suffix to a node's name.
   */
  it('names every backend that has a name', () => {
    for (const backend of Object.values(BACKENDS)) {
      if (!backend.label) continue
      expect(TEXT, `${backend.label} is missing from the page`).toContain(backend.label)
    }
  })

  /* And every real dataset a reader could pick, for the same reason. */
  it('names every non-synthetic dataset family', () => {
    for (const family of DATASET_FAMILIES) {
      if (family.synthetic) continue
      expect(TEXT, `${family.label} is missing from the page`).toContain(family.label)
    }
  })

  /*
   * The analysis chains name real nodes, and say two things about each: what it
   * is called, and — through `data-cat`, which is what `theme.css` colours the
   * chip from — which category it is in. Both drift silently. A renamed node
   * leaves a chip advertising a card the app no longer draws, and a
   * recategorised one leaves a chip in the wrong colour on a page whose whole
   * chromatic vocabulary is that colour meaning something.
   *
   * Attribute order is fixed by the pattern rather than parsed, which is the
   * trade jsdom-free matching has made everywhere else in this file. A chip
   * written with the attributes the other way round is then invisible to the
   * test, so the count is asserted too — there are four chains plus the inline
   * chips in their variant lines, and zero would otherwise pass everything.
   */
  it('names real nodes in the analysis chains', () => {
    const chips = [
      ...HTML.matchAll(
        /<span class="chip[^"]*" data-cat="([^"]+)" data-node="([^"]+)">([^<]+)<\/span>/g,
      ),
    ]
    expect(chips.length, 'no node chips found — has the markup changed shape?').toBeGreaterThan(
      15,
    )
    for (const [, category, type, text] of chips) {
      const def = getNodeDef(type!)
      expect(def, `${type} is not a registered node`).toBeTruthy()
      expect(text!.replace(/&#8209;|\u2011/g, '-')).toBe(def!.label)
      expect(def!.category, `${type} is drawn as ${category}`).toBe(category)
    }
  })

  /*
   * The entry script, because a rename would build green and serve a page with
   * no reveal and no theme — which reads as a styling bug rather than a missing
   * module.
   */
  it('loads its own entry rather than the app', () => {
    expect(HTML).toContain('src="/src/overview/main.ts"')
    expect(HTML).not.toContain('/src/main.tsx')
  })
})
