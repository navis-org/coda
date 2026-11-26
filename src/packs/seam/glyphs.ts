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
   * A twig that stops, and a separate piece just past its end, with an arrow closing the gap:
   * the tip, the candidate, and the merge. The gap is the drawing's whole statement — the two
   * strokes must not touch, or it is a neuron rather than a neuron missing its continuation.
   */
  'seam:loadMergeCandidates': [
    ['path', { d: 'M4 20.5V12M4 16l-2-2.5M4 14l2.5-3' }],
    ['path', { d: 'M4 12V8' }],
    ['path', { d: 'M20 3.5v6M20 7l-2-2M20 9l2-2.5' }],
    ['path', { d: 'M20 9.5v3' }],
    ['path', { d: 'M8 7h6M12 5l2 2-2 2', 'stroke-dasharray': 'none' }],
  ],
  /*
   * The gap closed: the same twig and piece as Load Merge Candidates, with a tick beside them. The
   * tick is the statement — this node is where a judgement is made, not where one is found.
   */
  'seam:proofreadMerges': [
    ['path', { d: 'M4 20.5V12M4 16l-2-2.5M4 14l2.5-3' }],
    ['path', { d: 'M4 12V8' }],
    ['path', { d: 'M14 4.5v5M14 7l-1.5-1.5M14 9l1.5-2' }],
    ['path', { d: 'M8 7h4' }],
    ['path', { d: 'M16.5 17.5l2.5 2.5 4-5.5' }],
  ],
  /*
   * A branch whose twigs stop, with the ends ringed: where the reconstruction runs out, found
   * but not yet joined to anything. Deliberately the *left half* of Load Merge Candidates' drawing —
   * the same twig and the same stop, without the piece beyond the gap, because that is exactly
   * what this node knows and the next stage adds. Rings rather than filled dots, since a score
   * is a degree of suspicion and not a verdict.
   */
  'seam:openEnds': [
    ['path', { d: 'M12 21v-7M12 14 7 9M12 16l5-5' }],
    ['path', { d: 'M7 9 5.5 6.5M17 11l1.5-2.5' }],
    ['circle', { cx: '5', cy: '5.5', r: '2' }],
    ['circle', { cx: '19', cy: '7.5', r: '2' }],
  ],
  /*
   * The same open end Find Open Ends rings, with the pieces the search found around it and an
   * arrow to the one the forest put first. Deliberately *between* the other two drawings: Find
   * Open Ends has the ring and no piece, Load Merge Candidates has the piece and no ring, and this
   * is the stage that turns one into the other. The two unmarked strokes are the rest of the
   * pool — without them it is Load Merge Candidates again, and the ranking is the whole point.
   */
  'seam:findMergeCandidates': [
    ['path', { d: 'M4 20.5V12M4 16l-2-2.5M4 14l2.5-3' }],
    ['path', { d: 'M4 12V8.5' }],
    ['circle', { cx: '4', cy: '6.5', r: '1.8' }],
    ['path', { d: 'M12 4.5v5' }],
    ['path', { d: 'M17 9.5v5' }],
    ['path', { d: 'M19.5 2.5v4' }],
    ['path', { d: 'M7 6.5h3.5M9.5 5l1.5 1.5-1.5 1.5' }],
  ],
}

export default glyphs
