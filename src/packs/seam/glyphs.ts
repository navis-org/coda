/**
 * The SEAM pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it.
 */

import type { GlyphShape } from '../../ui/glyphs'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  /*
   * Two little arbours that touch, with a dashed line down the join: one segment, two neurons,
   * and where the cut would go. The dash is the whole statement — a single arbour would be a
   * skeleton glyph, and two apart would be a pair of neurons rather than one segment to divide.
   */
  /*
   * A patch of surface with a bright spot on it: the arbour, and the window the model is sure
   * about. Dots rather than a boundary, because what the node returns is a confidence per place
   * and not a cut — the drawing should not promise a line the node does not draw.
   */
  'seam:findMerges': [
    ['path', { d: 'M5 20V9M5 14 2.5 11M5 12l2.5-3M19 20V9M19 14l2.5-3M19 12l-2.5-3' }],
    ['path', { d: 'M5 9C5 5.5 8 4 12 4s7 1.5 7 5' }],
    ['circle', { cx: '12', cy: '7.2', r: '2.6', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '8.6', cy: '5.6', r: '1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.4', cy: '5.6', r: '1', fill: 'currentColor', stroke: 'none' }],
  ],
  'seam:affinityClusters': [
    ['path', { d: 'M7 20V9M7 14 3.5 10M7 12.5l3-3.5M7 9 5 5.5' }],
    ['path', { d: 'M17 20V9M17 14l3.5-4M17 12.5 14 9M17 9l2-3.5' }],
    ['path', { d: 'M12 2.5v19', 'stroke-dasharray': '2 2.5' }],
  ],
}

export default glyphs
