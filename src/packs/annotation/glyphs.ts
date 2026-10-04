/**
 * The Cell typing/annotation pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it.
 */

import type { GlyphShape } from '../../ui/glyphs'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  /*
   * A folder holding Embedding's two clusters of dots: a project is a folder, and what it holds
   * is an embedding. The dots are `core.embed`'s own, scaled into the folder, so the two read as
   * the same thing — one computed in Coda, one read from a file.
   */
  'annotation:bigclust': [
    [
      'path',
      {
        d: 'M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9.5A1.5 1.5 0 0 0 19.5 8h-7l-2-2.5h-6A1.5 1.5 0 0 0 3 7v.5',
      },
    ],
    ['circle', { cx: '8', cy: '15.6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '10.2', cy: '16.8', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '7.4', cy: '17.6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.2', cy: '11.4', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '17.2', cy: '12.6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15', cy: '13.6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
  ],
  /*
   * Edit Table's drawing — a table and the pencil on it — with an arrow leaving its corner: the
   * same edit, sent somewhere. Edit Table changes the graph's copy; this changes the backend's.
   */
  'annotation:editor': [
    ['rect', { x: '3.5', y: '6.5', width: '12', height: '12', rx: '1.5' }],
    ['path', { d: 'M3.5 10.5h12' }],
    ['path', { d: 'M6.2 14h6.6' }],
    ['path', { d: 'M13.4 21.1l-2.7.7.7-2.7 6.3-6.3 2 2z' }],
    ['path', { d: 'M18.5 9.5V3.5M16.3 5.7l2.2-2.2 2.2 2.2' }],
  ],
}

export default glyphs
