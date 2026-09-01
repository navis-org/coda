/**
 * The art on the start page's doors rail — the one hand-drawn glyph set in the app.
 *
 * Every other tile on that page derives its picture from something the app already draws:
 * `nodeGlyph` for a graph's terminal viewer, `datasetGlyph` for a family. That rule exists so a
 * rail which *grows* never ships a blank tile — add an example next year and it gets a correct
 * picture for free. This rail cannot grow on its own: it is three tours from a fixed table plus
 * one Zoo, and none of them is a node or a dataset, so there is nothing to derive from. A door
 * added here arrives with its own drawing or it does not arrive.
 *
 * Drawn to `GlyphSvg`'s conventions in `StartPage.tsx`: a 24-unit box, `currentColor` stroke at
 * 1.4, round caps and joins, no fill. So the tint the card sets is the whole of their colour.
 */

import type { ReactNode } from 'react'

/**
 * The picture for a door, by card id — `tour:<id>` or `zoo`.
 *
 * Keyed by the id the card already carries rather than by a field on it, so a new tour in
 * `TOURS` needs one entry here and nothing else. The fallback is the Zoo's mark rather than
 * `undefined`, because a missing key must still draw *something*: an empty `<svg>` wearing the
 * right class is exactly the blank tile the derived-art rule is about.
 */
export function doorGlyph(id: string): ReactNode {
  return GLYPHS[id] ?? GLYPHS.zoo
}

const GLYPHS: Record<string, ReactNode> = {
  /*
   * A signpost. The Guided Tour points at things in place, which is what a signpost is for —
   * and its silhouette shares nothing with the other three, which is the property that matters
   * at 44px. Two plates pointing opposite ways so the shape is not read as a flag.
   */
  'tour:guided': (
    <>
      <path d="M12 4 V20.5" />
      <path d="M9.2 20.5 H14.8" />
      <path d="M12 6.2 H18.2 L20 8.4 L18.2 10.6 H12" />
      <path d="M12 12.4 H5.8 L4 14.6 L5.8 16.8 H12" />
    </>
  ),
  /*
   * Two wired nodes and a third arriving, dashed. Learn to Build empties the canvas and then
   * adds a node at a time, so the picture is the moment before the third one lands — the dash
   * is what distinguishes it from a plain three-node pipeline, and from the Dashboard's grid.
   */
  'tour:build': (
    <>
      <rect x={2.6} y={5.6} width={6.8} height={4.8} rx={1.2} />
      <rect x={14.6} y={5.6} width={6.8} height={4.8} rx={1.2} />
      <path d="M9.4 8 H14.6" />
      <path d="M12 8 V15.4" />
      <rect
        x={8.6}
        y={15.4}
        width={6.8}
        height={4.8}
        rx={1.2}
        strokeDasharray="2.2 2"
      />
    </>
  ),
  /*
   * The grid itself, in the proportions a dashboard actually lands in: two cells over one wide
   * one. `ROW_SPANS` makes a cell a third, a half, two thirds or the whole of the view, so a
   * picture of four equal squares would be a claim about the layout that the grid does not make.
   */
  'tour:dashboard': (
    <>
      <rect x={3} y={4.6} width={18} height={14.8} rx={1.6} />
      <path d="M3 12.2 H21" />
      <path d="M12 4.6 V12.2" />
    </>
  ),
  /*
   * A pipeline under a lens: search, over the thing being searched. The Zoo's own cards draw
   * each workflow's real shape (`ZooThumbnail`), so a small graph is the honest stand-in for
   * what is behind this door. The three nodes sit on an *uneven* chain deliberately — two level
   * across the top and one below reads as a face at tile size, which is the one thing a picture
   * of a graph must not do.
   */
  zoo: (
    <>
      <circle cx={10.5} cy={10.5} r={7} />
      <path d="M15.6 15.6 L20.5 20.5" />
      <circle cx={7.9} cy={7.6} r={1.4} />
      <circle cx={13.3} cy={9.9} r={1.4} />
      <circle cx={9.4} cy={13.6} r={1.4} />
      <path d="M9.2 8.2 L12 9.3" />
      <path d="M12.6 11.1 L10.1 12.4" />
    </>
  ),
}
