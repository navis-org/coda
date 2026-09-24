/**
 * The ZapBench pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it.
 */

import type { GlyphShape } from '../../ui/glyphs'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  /*
   * Three traces with one transient each, at three different times. The registry has no line
   * chart, so a wave is an unspent silhouette — and it is the right one here: what this node
   * hands on is a population's activity against time, which no matrix or table glyph says. The
   * transients are offset rather than aligned, because a column of simultaneous spikes would
   * read as a stimulus rather than as several neurons.
   */
  'zapbench:neuronTraces': [
    ['path', { d: 'M3 6h4l1.5-3L11 6h10' }],
    ['path', { d: 'M3 12h9l1.5-3.4L16 12h5' }],
    ['path', { d: 'M3 18h5l1.5-2.6L11 18h10' }],
  ],
  /*
   * The same three transients inside a frame: the whole population at once rather than a
   * selection of it. The frame is the matrix's own outline, which is what makes this the
   * overview a selection is drawn from.
   */
  'zapbench:traces': [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '1.5' }],
    ['path', { d: 'M5.5 9h3.5l1.3-2.6L12.6 9h5.9' }],
    ['path', { d: 'M5.5 13h6.5l1.3-2.6L15.6 13h2.9' }],
    ['path', { d: 'M5.5 17h2l1.3-2.6L11.1 17h7.4' }],
  ],
  // One transient, an arrow, an arbour: a cell's activity resolved to the neuron carrying it.
  'zapbench:neurons': [
    ['path', { d: 'M3 6h5l1.5-3L12 6h9' }],
    ['path', { d: 'M6 9.4v4.8M4.2 12.4 6 14.2l1.8-1.8' }],
    ['circle', { cx: '11.6', cy: '18.6', r: '1.8' }],
    ['path', { d: 'M12.9 17.3l3.3-3.5M16.2 13.8l2.8-2.6M16.2 13.8l1.1 3.6' }],
  ],
}

export default glyphs
