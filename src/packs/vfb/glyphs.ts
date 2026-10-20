/**
 * The VFB pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it.
 */

import type { GlyphShape } from '../../ui/glyphs'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  // An arbour with a tag hung on it: a neuron given the name an ontology has for its type. The tag
  // is `neuron.idsFromLabel`'s, which is the same mark meaning "a label".
  'vfb:neurons': [
    ['circle', { cx: '7', cy: '17.4', r: '1.8' }],
    ['path', { d: 'M8.3 16.1l3.4-3.6M11.7 12.5l1.2-4.1M11.7 12.5l3.6.6' }],
    ['path', { d: 'M13.6 3.8h4.8l2.4 2.4-4.6 4.6-4.4-4.4z' }],
    ['circle', { cx: '17.6', cy: '5.4', r: '.6', fill: 'currentColor', stroke: 'none' }],
  ],
  // An "i" in a circle with the type's tag on it: what VFB says about a term.
  'vfb:info': [
    ['circle', { cx: '10.4', cy: '13.4', r: '7' }],
    ['path', { d: 'M10.4 12.4v4.4' }],
    ['circle', { cx: '10.4', cy: '9.6', r: '.7', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M15.4 2.8h4l2 2-3.8 3.8-3.6-3.6z' }],
  ],
  // A page of text with the same tag on its corner: the papers that go with a type.
  'vfb:publications': [
    ['rect', { x: '4.4', y: '4.4', width: '12.4', height: '16', rx: '1.4' }],
    ['path', { d: 'M7.2 9h6.8M7.2 12.2h6.8M7.2 15.4h4.4' }],
    ['path', { d: 'M15.4 2.8h4l2 2-3.8 3.8-3.6-3.6z' }],
  ],
  // A short stretch of helix — a construct — with the type's tag on it: the lines that label a type.
  'vfb:lines': [
    ['path', { d: 'M3.6 15.4c2.4-4.4 4.8-4.4 7.2 0s4.8 4.4 7.2 0' }],
    ['path', { d: 'M3.6 11.4c2.4 4.4 4.8 4.4 7.2 0s4.8-4.4 7.2 0' }],
    ['path', { d: 'M6 13.4h.01M13.2 13.4h.01' }],
    ['path', { d: 'M15.4 2.8h4l2 2-3.8 3.8-3.6-3.6z' }],
  ],
  // Two stacked frames, the front one with a blob of signal: registered image stacks.
  'vfb:images': [
    ['rect', { x: '6.4', y: '3.6', width: '13.6', height: '11.6', rx: '1.4' }],
    ['rect', { x: '3.6', y: '7.2', width: '13.6', height: '12.4', rx: '1.4' }],
    ['path', { d: 'M7.6 15.6c.8-2.6 2.6-3.8 4.2-2.6 1.2.9 1.8-.6 3-.2' }],
  ],
  // A scatter of dots filling a brain-like outline: an image drawn as points.
  'vfb:expression': [
    ['path', { d: 'M4 13.2c0-4.4 3.6-7.6 8-7.6s8 3.2 8 7.6c0 3.2-2.6 5.2-8 5.2s-8-2-8-5.2z' }],
    ['circle', { cx: '8.6', cy: '11.4', r: '.8', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '9.6', r: '.8', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.4', cy: '12', r: '.8', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '10.6', cy: '14.8', r: '.8', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '14', cy: '15.4', r: '.8', fill: 'currentColor', stroke: 'none' }],
  ],
  // A grid of four frames, one starred: a gallery somebody picks from.
  'vfb:gallery': [
    ['rect', { x: '3.6', y: '3.6', width: '7.4', height: '7.4', rx: '1' }],
    ['rect', { x: '13', y: '3.6', width: '7.4', height: '7.4', rx: '1' }],
    ['rect', { x: '3.6', y: '13', width: '7.4', height: '7.4', rx: '1' }],
    ['path', { d: 'M16.7 13.4l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z' }],
  ],
}

export default glyphs
