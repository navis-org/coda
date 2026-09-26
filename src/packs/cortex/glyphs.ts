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
  /*
   * The gallery's layer boundaries under a scatter of points, one measured down from the pia:
   * the pia a solid line, the depth a drop from it to a point. What the node adds is where each
   * point sits, which the drop says and no point alone does.
   */
  'cortex:depth': [
    ['path', { d: 'M3 3.5h18' }],
    ['path', { d: 'M3 10h2M11 10h2M19 10h2M3 16.5h2M11 16.5h2M19 16.5h2' }],
    ['path', { d: 'M16 3.5v8.8M14.8 11.2 16 12.4l1.2-1.2' }],
    ['circle', { cx: '16', cy: '14', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '7.5', cy: '7', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '9', cy: '13.2', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '19.5', r: '1.3', fill: 'currentColor', stroke: 'none' }],
  ],
  /*
   * A histogram turned to run down the cortex: bars growing from a vertical axis, the layer
   * boundaries dashed at their far side. The histogram's filled bars, so the family reads.
   */
  'cortex:laminarProfile': [
    ['line', { x1: '4', y1: '3', x2: '4', y2: '21' }],
    [
      'rect',
      { x: '4', y: '4.5', width: '5', height: '3', fill: 'currentColor', stroke: 'none' },
    ],
    [
      'rect',
      { x: '4', y: '8.5', width: '12', height: '3', fill: 'currentColor', stroke: 'none' },
    ],
    [
      'rect',
      { x: '4', y: '12.5', width: '9', height: '3', fill: 'currentColor', stroke: 'none' },
    ],
    [
      'rect',
      { x: '4', y: '16.5', width: '4', height: '3', fill: 'currentColor', stroke: 'none' },
    ],
    ['path', { d: 'M18 8h3M18 16h3' }],
  ],
}

export default glyphs
