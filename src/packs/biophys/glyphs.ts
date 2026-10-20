/**
 * The Biophysics pack's card drawings, merged into `NODE_GLYPHS` by `ui/glyphs.ts`.
 *
 * Data only, held to `ui/glyphs.ts`' own lint rule: `nodes.html` draws these with no React and no
 * node definitions in it. The model and the run are on Skeletons' arbour, the material they are
 * made from; the recording cards and the fit are on a trace, theirs.
 */

import type { GlyphShape } from '../../ui/glyphs'

/** Skeletons' arbour: a soma and its branches, as `neuron.skeletons` draws it (`glyphs.test.ts` holds the copy to it). */
const ARBOUR =
  'M7.8 17 12 12.4M12 12.4l4.2-4.6M12 12.4l1.4 5M16.2 7.8l3.4-1.8M16.2 7.8l-.6-3.4M13.4 17.4l3.6 1.6'

const glyphs: Readonly<Record<string, readonly GlyphShape[]>> = {
  /*
   * The arbour cut into compartments: a short bar across each branch where one compartment ends
   * and the next begins. What the node does to a skeleton is the cutting.
   */
  'biophys:model': [
    ['circle', { cx: '6.4', cy: '18.4', r: '2' }],
    ['path', { d: ARBOUR }],
    ['path', { d: 'M8.9 13.8l1.9 1.8M13.1 9.2l1.9 1.8M11.5 15.3l2.4-.7M17.3 5.3l.9 1.7' }],
  ],
  /*
   * The arbour faint, an action potential across it: what comes out of a run is a voltage over
   * time, and the neuron is what it was run on.
   */
  'biophys:simulate': [
    ['circle', { cx: '6.4', cy: '18.4', r: '2', strokeOpacity: '.4' }],
    ['path', { d: ARBOUR, strokeOpacity: '.4' }],
    ['path', { d: 'M3 10h5l1.4-6.5 1.8 10 1.3-3.5H21' }],
  ],
  /*
   * A recorded trace under Upload Table's arrow: the mark that says "brought in", on the material
   * — a voltage over time — that comes in.
   */
  'biophys:loadRecording': [
    ['path', { d: 'M3 16.5h5l1.3-5 1.6 7.5 1.2-2.5H21' }],
    ['path', { d: 'M12 2.6v5.4M9.5 5.1 12 2.6l2.5 2.5' }],
  ],
  /*
   * Two traces of different shape, one above the other, and a faint line through both at one
   * time: what the node does is put them on one axis.
   */
  'biophys:combineTraces': [
    ['path', { d: 'M3 8.5h5l1.3-5 1.6 7 1.2-2H21' }],
    ['path', { d: 'M3 17h5l1.3-2.5 1.6 4 1.2-1.5H21' }],
    ['path', { d: 'M9.3 2.5v19', strokeOpacity: '.4' }],
  ],
  /*
   * A noisy recorded trace faint, a smooth fitted curve through it: what comes out of a fit is the
   * model that draws the second.
   */
  'biophys:fit': [
    [
      'path',
      {
        d: 'M3 18h4l.8-5.6.8 1.4.8-2.4.9 1.2.8-1.6.9.8.9-1 .9.6.9-.7.9.4H21',
        strokeOpacity: '.4',
      },
    ],
    ['path', { d: 'M3 18h4c.9-5 2.6-7.4 5.2-8 2.6-.5 5.5-.6 8.8-.6' }],
  ],
}

export default glyphs
