/**
 * The Cortex pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it.
 */

import type { GlyphShape } from '../../ui/glyphs'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  /*
   * Two cells at two depths across two layer boundaries: a pyramidal cell, its apical dendrite
   * reaching up through the layers, and a round-bodied cell deeper down. What the node draws is
   * cells *against depth*, which the boundaries say and no single neuron does; two rather than
   * one because it is a wall of them.
   */
  'cortex:gallery': [
    ['path', { d: 'M3 8h2M11 8h2M19 8h2M3 15h2M11 15h2M19 15h2' }],
    ['path', { d: 'M6.8 13.2 8 10.8l1.2 2.4z' }],
    ['path', { d: 'M8 10.8V3M6.8 13.2 5.2 15.6M9.2 13.2l1.6 2.4M8 13.2V21' }],
    ['circle', { cx: '16', cy: '17', r: '1.4' }],
    ['path', { d: 'M15.2 15.9 13.8 11M16.8 15.9l1.4-4.6M16 18.4V21' }],
  ],
}

export default glyphs
