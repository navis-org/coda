/**
 * The two card-chrome rules that decide pixels, asserted where they are declared.
 *
 * jsdom performs no layout, so neither of these can be measured here — and both fail *silently*
 * in a browser, which is why they are pinned at all rather than left to a screenshot somebody
 * takes once.
 *
 *   A socket is centred on the card's edge, so a card that clips at that edge shows half of it.
 *   The whole symbol is the port's type channel (colour cannot carry it alone — `socketStyle.ts`
 *   says why), so half a symbol is half a channel, and the card still looks perfectly fine.
 *
 *   The header is a saturated fill now, so anything in it that names a text token is invisible
 *   rather than wrong-coloured: `--text-muted` on the query blue is 1.5:1.
 *
 * Read from source rather than from a stylesheet object, as `runRing.placement.test.tsx` does:
 * vitest never applies the CSS. Paths are relative to the repo root, vitest's working directory.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { cssRule } from '../../test/cssRule'

const editor = readFileSync('src/ui/editor.css', 'utf8')
const theme = readFileSync('src/ui/theme.css', 'utf8')

describe('a card lets its sockets out', () => {
  it('clips with a bleed rather than at its own edge', () => {
    const card = cssRule(editor, '.coda-node')
    expect(card).not.toMatch(/overflow:\s*hidden/)
    expect(card).toMatch(/overflow:\s*clip/)
    // The token, not a literal: four stylesheets clip a card, and a page left on a stale bleed
    // would show half a socket again with nothing here to notice.
    expect(card).toMatch(/overflow-clip-margin:\s*var\(--card-bleed\)/)
  })

  it('bleeds at least as far as the hit target it draws, not just as far as the disc', () => {
    /*
     * The disc reaches 5.5px past the edge and the 20px target centred on it reaches 10px.
     * Clipping is hit-testing as well as paint, so a bleed sized for the disc would leave the
     * outer half of every target uncatchable while looking completely correct.
     */
    const margin = Number(/--card-bleed:\s*(\d+(?:\.\d+)?)px/.exec(theme)?.[1])
    const target = Number(
      /width:\s*(\d+(?:\.\d+)?)px/.exec(
        cssRule(editor, '.socket.react-flow__handle::before'),
      )?.[1],
    )
    expect(margin).toBeGreaterThanOrEqual(target / 2)
  })

  it('places both sides on the card edge, so neither is the cropped one', () => {
    expect(cssRule(editor, '.socket.react-flow__handle.react-flow__handle-left')).toMatch(
      /left:\s*-1px/,
    )
    expect(cssRule(editor, '.socket.react-flow__handle.react-flow__handle-right')).toMatch(
      /right:\s*-1px/,
    )
  })

  it('paints the sockets over the state bar, which used to be the other way round', () => {
    // The bar is opaque and 3px wide: under it, an input socket is a third of a disc.
    const bar = Number(/z-index:\s*(\d+)/.exec(cssRule(editor, '.coda-node::before'))?.[1])
    const socket = Number(
      /z-index:\s*(\d+)/.exec(cssRule(editor, '.socket.react-flow__handle'))?.[1],
    )
    expect(socket).toBeGreaterThan(bar)
  })

  it('states the corners its own clip stopped rounding', () => {
    // The clip edge grows with the margin and so do its radii, so nothing that paints to an
    // edge is rounded any more: the header, the last band, and the state bar say it themselves.
    expect(cssRule(editor, '.coda-node__header')).toMatch(/border-radius:/)
    expect(cssRule(editor, '.coda-node > :last-child')).toMatch(/border-bottom-left-radius:/)
    expect(cssRule(editor, '.coda-node::before')).toMatch(/border-radius:/)
  })
})

describe('the header palette', () => {
  const CATEGORIES = [
    'dataset',
    'query',
    'transform',
    'analysis',
    'visualisation',
    'utility',
  ] as const
  const BACKENDS = ['cave', 'catmaid', 'mock'] as const

  it('is one table, and every answer in it is a pair', () => {
    /*
     * A fill with no ink is the failure this catches: it inherits the previous category's,
     * legible about half the time, so it reads as a rendering fault rather than a gap. The ink
     * is a default on the three attributes with one override, so what is checked per key is the
     * fill; the default and its single exception are checked once, below.
     */
    for (const key of [...CATEGORIES, ...BACKENDS]) {
      const selector = BACKENDS.includes(key as (typeof BACKENDS)[number])
        ? `[data-backend='${key}']`
        : `[data-category='${key}'],\n[data-cat='${key}']`
      expect(cssRule(theme, selector), key).toMatch(/--cat-head:\s*var\(--cat-[a-z-]+-head\)/)
    }
    expect(cssRule(theme, '[data-category],\n[data-cat],\n[data-backend]')).toMatch(
      /--cat-ink:\s*var\(--cat-ink-light\)/,
    )
    // `mock` is the one pale fill and so the one dark ink; see the token block for why.
    expect(cssRule(theme, "[data-backend='mock']")).toMatch(
      /--cat-ink:\s*var\(--cat-ink-dark\)/,
    )
  })

  it('names only tokens that exist', () => {
    for (const [, token] of theme.matchAll(/--cat-head:\s*var\((--cat-[a-z-]+-head)\)/g)) {
      expect(theme, token).toMatch(new RegExp(`\\n\\s*${token}:\\s*#`))
    }
  })

  it('declares the fills once, so the two themes cannot disagree with one ink', () => {
    /*
     * The load-bearing property. Ink is a literal because the fill does not follow the theme;
     * a dark-mode override of a fill therefore keeps an ink picked for the light one, and the
     * result is legible in exactly one theme. Nothing else in this file would notice.
     */
    for (const [, token] of theme.matchAll(/\n\s*(--cat-[a-z-]+-head):\s*#/g)) {
      const declarations = theme.split(new RegExp(`\\n\\s*${token}:`)).length - 1
      expect(declarations, token).toBe(1)
    }
  })

  it('is what every card surface reads — none is still drawing the old tint', () => {
    /*
     * Four stylesheets draw a card: the editor's, the help figures' (which draw real registry
     * objects), and the two static pages'. A page left on `color-mix(--cat 16%)` advertises a
     * header the app stopped drawing, and nothing in its own suite can see that.
     */
    for (const path of [
      'src/ui/editor.css',
      'src/help/figure.css',
      'src/overview/overview.css',
      'src/tutorial/tutorial.css',
    ]) {
      const css = readFileSync(path, 'utf8')
      expect(css, path).toMatch(/background:\s*var\(--cat-head/)
      expect(css, path).not.toMatch(/color-mix\(in srgb, var\(--cat\) 16%/)
    }
  })

  it('leaves no text token in the header, where the fill is saturated', () => {
    const header = cssRule(editor, '.coda-node__header')
    expect(header).toMatch(/color:\s*var\(--cat-ink/)
    expect(header).not.toMatch(/var\(--text-/)
  })
})
