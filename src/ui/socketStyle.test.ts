/**
 * The socket vocabulary, and the one part of it a test can reach.
 *
 * `portStyle` itself is a lookup and its contract is that colour never carries the type alone
 * (`colors.ts`: only three chromatic families clear the all-pairs colourblind gate, which is why
 * every socket is hue **plus** shape **plus** a visible label). What is asserted here is the
 * shape half staying distinct, and the one geometric rule that lives in CSS and cannot be
 * checked any other way — vitest applies no stylesheet and jsdom performs no layout, so the
 * declaration is the only thing a test here can hold. `tooltipPoint.test.ts` sets the precedent.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { cssRule } from '../test/cssRule'

import { GEOMETRY_KINDS, T } from '../core/types'
import { draggedWireStyle, familyColorVar, portStyle, typeColorVar } from './socketStyle'
import type { SocketFamily } from './socketStyle'

const CSS = readFileSync('src/ui/editor.css', 'utf8')

const rule = (selector: string) => cssRule(CSS, selector)

describe('portStyle: the type table', () => {
  it('gives a matrix its own shape as well as its own hue', () => {
    expect(portStyle({ type: T.matrix() })).toEqual({ family: 'matrix', shape: 'diamond' })
    expect(portStyle({ type: T.table() }).shape).not.toBe('diamond')
  })
})

describe('the stylesheet half', () => {
  /*
   * The diamond is the one shape that has to restate React Flow's centring, and getting that
   * wrong is invisible to every other test in the tree.
   *
   * React Flow centres a left/right handle with `transform: translate(∓50%, -50%)`. `transform`
   * is a single property, so a rule setting `transform: rotate(45deg)` replaces that rather than
   * adding to it — which is what shipped, and it put every Matrix socket 3.97px below its own
   * row and 3.97px off the card edge, measured in Chrome against a circle in the row beside it.
   *
   * Two things are asserted, because the fix has two halves that fail differently. The **side
   * rules** must carry the translate *before* the rotate: the independent `rotate` property
   * composes ahead of `transform`, so it rotates the centring offset with the element and lands
   * dy −1.64 on the left against an unmoved +3.97 on the right. And the **base rule** must set
   * no `transform` at all, since either side rule would then be competing with a bare rotation
   * on equal specificity grounds the moment somebody reorders the file.
   */
  it('centres the diamond socket before rotating it, on both sides', () => {
    for (const side of ['left', 'right'] as const) {
      const body = rule(`.socket[data-shape='diamond'].react-flow__handle-${side}`)
      expect(body, side).toMatch(/transform:\s*translate\([^)]*\)\s+rotate\(45deg\)/)
    }
    expect(rule(".socket[data-shape='diamond']")).not.toMatch(/transform:/)
  })
})

/**
 * Every family a socket can be, and the token the stylesheet must paint it with.
 *
 * `familyColorVar` is the one answer, and it is what the *wire* reads — the socket reads a CSS
 * rule keyed on `data-family`, which is a second transcription of the same table. They
 * disagreed: `geometry` had no arm at all, so every Skeletons, Meshes, Points and Transform
 * socket fell through to `--socket-any` and drew grey while the wire leaving it drew
 * `--socket-dataset` green. It read as one bad wire on one NBLAST card and was a whole family.
 *
 * Asked of the list rather than of the four families that were right, because the failure is
 * *silent by construction*: a missing arm is a socket that still paints, in a colour that still
 * belongs to the palette, on a card where nothing else looks wrong.
 */
describe('a socket and its wire agree on the hue', () => {
  const FAMILIES: SocketFamily[] = [
    'table',
    'matrix',
    'dataset',
    'geometry',
    'transform',
    'layers',
    'scalar',
    'any',
  ]
  const THEME = readFileSync('src/ui/theme.css', 'utf8')

  /*
   * `familyColorVar` decides a *wire*; a `--sock` rule in `theme.css` decides the socket, the
   * help figure's pip, the node guide's, the inspector's chip and the add-menu thumbnail. Those
   * were six transcriptions of one table and they had drifted twice — `geometry` had no arm at
   * all in `editor.css`, and `NodeThumbnail` built the token by interpolating the family name,
   * so the three newest families resolved nothing. A missing arm paints a legal-looking socket
   * in a real palette colour, which is why neither showed.
   *
   * There is one table now, so this is one assertion over it rather than a parser per
   * stylesheet — and the second test below is what keeps it the only one.
   */
  it('gives every family the token its wire would use, under both spellings', () => {
    for (const family of FAMILIES) {
      for (const attr of ['data-family', 'data-fam']) {
        const start = THEME.indexOf(`[${attr}='${family}']`)
        expect(start, `${attr}=${family}`).toBeGreaterThan(-1)
        const body = THEME.slice(start, THEME.indexOf('}', start))
        expect(body, `${attr}=${family}`).toContain(`--sock: ${familyColorVar(family)}`)
      }
    }
  })

  it('is read, never transcribed, by the surfaces that draw a socket', () => {
    // Any per-family `--socket-*` arm outside the table is a seventh spelling in the making.
    for (const path of [
      'src/ui/editor.css',
      'src/help/figure.css',
      'src/nodeguide/nodeguide.css',
      'src/overview/overview.css',
      'src/tutorial/tutorial.css',
    ]) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/\[data-fam(?:ily)?='/.test(selector ?? '')) continue
        expect(body ?? '', `${path}: ${(selector ?? '').trim()}`).not.toMatch(
          /var\(--socket-|var\(--t-/,
        )
      }
    }
  })
})

describe('draggedWireStyle', () => {
  it('is the origin type colour, and nothing else', () => {
    expect(draggedWireStyle({ type: T.matrix() })).toEqual({ stroke: typeColorVar(T.matrix()) })
    // No width and no dasharray: those live in `editor.css` and say *in flight*, not what is
    // flowing, so a wire that lands must not inherit them.
    expect(Object.keys(draggedWireStyle({ type: T.table() }))).toEqual(['stroke'])
  })

  it('falls back to the achromatic token rather than to the accent', () => {
    // A drag from a port whose type has not resolved is grey, which is what its socket is.
    expect(draggedWireStyle(undefined).stroke).toBe('var(--socket-scalar)')
  })

  /*
   * The half of this function's own doc comment that was not true until `PortDef.kinds` existed:
   * "dragged backwards from an input it is the colour of what that port accepts". A geometry
   * port declares `T.any()`, so the wire left `Mirror Neurons` grey and the reader was hunting
   * for violet sockets with a grey wire in hand.
   */
  it('takes a declared kind set over the `any` the port is typed as', () => {
    expect(draggedWireStyle({ type: T.any(), kinds: GEOMETRY_KINDS }).stroke).toBe(
      'var(--socket-geometry)',
    )
    expect(draggedWireStyle({ type: T.any() }).stroke).toBe('var(--socket-scalar)')
  })
})

/**
 * The one row of the socket table that is not a `CodaType`.
 *
 * Both halves are load-bearing and both fail silently. The **family** is what makes the four
 * `… Neurons` cards read as being about geometry at all; drawn from the type alone they
 * were grey, which in this vocabulary means *anything at all* and is the claim `PortDef.kinds`
 * exists to withdraw. The **shape** has to be one the geometry family has not already spent, or
 * an unwired Mirror input is indistinguishable from a Skeletons — and `ring` was the only one
 * left, which is why this needed no seventh hue and no stylesheet change (see `theme.css` on
 * why a seventh hue is not available to spend).
 */
describe('portStyle', () => {
  it('draws a geometry-only `any` port as a violet ring', () => {
    expect(portStyle({ type: T.any(), kinds: GEOMETRY_KINDS })).toEqual({
      family: 'geometry',
      shape: 'ring',
    })
  })

  it('draws a subset of geometry the same way — Split Neurons declines points and still says so', () => {
    expect(portStyle({ type: T.any(), kinds: ['skeletons', 'meshes'] })).toEqual({
      family: 'geometry',
      shape: 'ring',
    })
  })

  it('leaves a set with no name, and a bare `any`, in the achromatic ring', () => {
    // `For Each` steps through tables as well as geometry, so no family names it.
    expect(
      portStyle({ type: T.any(), kinds: ['table', 'neurons', 'skeletons', 'meshes'] }),
    ).toEqual({ family: 'any', shape: 'ring' })
    expect(portStyle({ type: T.any() })).toEqual({ family: 'any', shape: 'ring' })
  })

  /*
   * The family is asked of the *members*, never named beside the label — which is what keeps a
   * second named set from silently drawing as geometry. Written as "if the set has a name, draw
   * violet", `kindSetLabel` gaining a "Collections" entry would have painted `For Each`'s table
   * ports as geometry rings, and nothing would have failed.
   *
   * Asked through `portStyle` itself, which it could not be while the name was the outer gate —
   * the members-agree rule then only ran on sets `kindSetLabel` had already admitted, so its
   * interesting branch was unreachable and the helper had to be exported to be reached at all.
   */
  it('derives the family from the members, so a mixed set can never borrow one', () => {
    // Both matrix-family kinds, so they agree and the ring is drawable...
    expect(portStyle({ type: T.any(), kinds: ['matrix', 'network'] })).toEqual({
      family: 'matrix',
      shape: 'ring',
    })
    // ...where a set spanning two families has no family to wear, named or not.
    expect(portStyle({ type: T.any(), kinds: ['matrix', 'skeletons'] })).toEqual({
      family: 'any',
      shape: 'ring',
    })
  })

  /*
   * The two rules that have to agree, and they agree today by the coincidence of one entry.
   * `kindSetLabel` names a set when every member is in `GEOMETRY_KINDS`; `portStyle` draws it
   * when every member's row in the socket table gives the same family. A kind added to one and
   * not the other gives a violet ring labelled "Any", or "Geometries" beside a grey dot — the
   * exact disagreement `TypeChip` was just fixed for, one level up.
   */
  it('agrees with `kindSetLabel` about which kinds are geometry', () => {
    for (const kind of GEOMETRY_KINDS) {
      expect(portStyle({ type: { kind } }).family, kind).toBe('geometry')
    }
  })

  it('keeps every shape in the geometry family distinct, or the ring says nothing', () => {
    const shapes = [
      portStyle({ type: T.any(), kinds: GEOMETRY_KINDS }),
      portStyle({ type: T.skeletons() }),
      portStyle({ type: T.meshes() }),
      portStyle({ type: T.points() }),
    ]
    expect(shapes.every((s) => s.family === 'geometry')).toBe(true)
    expect(new Set(shapes.map((s) => s.shape)).size).toBe(4)
  })
})
