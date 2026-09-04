/**
 * The drawing for every node type, as data.
 *
 * ## Why this is a table rather than JSX
 *
 * Three surfaces draw these: the add-node browser's thumbnail and the start page's tile art
 * (React, `glyphElements`), and `nodes.html` (plain strings, `glyphMarkup`). That page is a
 * separate vite entry with no React in it at all — see `nodeguide/main.ts` — so a JSX table
 * could not reach it, and for as long as there were six category drawings plus ten overrides
 * it carried a hand-kept copy instead. At one drawing per node that copy is 101 chances to
 * drift, which is the arrangement `markGeometry.ts` already refused once: a comment saying two
 * languages agree is not an invariant. So the shapes are primitives and each surface has its
 * own six-line renderer.
 *
 * ## The grammar
 *
 * A base shape names the **material** and the drawing on top names the **operation**, which is
 * what makes a family legible without reading the label: Filter, Sort and Sample are all a
 * table with something happening inside it; Mirror, Transform and Clean Skeletons are all an
 * arbour. Colour is not part of it — every shape inherits `currentColor`, because the category
 * tint is already spent on the card header and the backend pip, and a second colour channel
 * here would compete with the socket palette's three-hue budget (`colors.ts`).
 *
 * Four marks are shared across families, and each is load-bearing:
 *
 * - **The funnel** is filtering, on `core.filterTable` and on `net.filter`. Reusing it is what
 *   says the two nodes are the same verb on different material.
 * - **A dashed outline** is a selection the user made — `cluster.selectedToNeurons`,
 *   `cluster.clustersToNeurons` — never an edge and never part of the thing it sits on.
 * - **The four-point spark** is "cleaned", on `neuron.cleanSkeletons` and `neuron.cleanMeshes`.
 * - **Weight says role** in a node-link drawing: a larger or filled disc is the node the
 *   question is about, a plain one is what came back.
 *
 * ## What is deliberately absent
 *
 * A per-dataset drawing. The twelve published connectomes resolve through `DATASET_GLYPHS`,
 * which is the silhouette their card already wears — a species and a coarse anatomical kind,
 * never a dataset, for the reason `DatasetPreview.tsx` records at length. `dataset.fib19` is
 * the single entry that adds a mark to one (a crop edge, because it is a partial
 * reconstruction of the same structure Optic Lobe covers whole, and the two are the same
 * backend so the header pip cannot separate them). That is an addition on top of the shared
 * silhouette rather than a replacement for it, so a dataset added tomorrow still gets a
 * picture, which is the property the rule exists to protect.
 */

import type { NodeCategory } from '../core/node'
import type { DatasetGlyph } from '../nodes/lib/datasetFamilies'

/** Attribute names are React's spelling; `glyphMarkup` hyphenates them for the string side. */
export type GlyphAttrs = Readonly<Record<string, string>>
export type GlyphShape = readonly [
  tag: string,
  attrs: GlyphAttrs,
  children?: readonly GlyphShape[],
]

/**
 * The box every glyph is drawn in, and the weight it is drawn at.
 *
 * Both are exported because both are transcribed otherwise: the renderers write the `viewBox`
 * and scale into it, and `specimenShapes` divides by the box to fit a silhouette and then
 * multiplies the weight back. Those two have to agree or every dataset tile draws faint, which
 * reads as a rendering bug rather than as a constant — so neither gets a second literal.
 */
export const GLYPH_BOX = 24
export const GLYPH_STROKE_WIDTH = 1.6

// ---------------------------------------------------------------------------
// Dataset silhouettes
// ---------------------------------------------------------------------------

/**
 * The specimen silhouettes, drawn in a `0 0 52 46` box.
 *
 * These are the dataset card's art, moved here so the card, the thumbnail, the wizard's
 * dataset step and `nodes.html` all read one copy. `DatasetPreview.tsx` still holds the design
 * record for *why* a glyph is a species and a coarse anatomical kind; this is only where the
 * paths live now.
 */
// prettier-ignore
export const DATASET_GLYPHS: Readonly<Record<DatasetGlyph, readonly GlyphShape[]>> = {
  fly_brain: [
    ['path', { d: 'M 26 32.74 C 26.68 32.78 27.22 32.28 28.41 31.54 28.79 31.3 28.91 31.68 29.89 31.08 30.85 30.5 31.08 30.3 32.89 27.83 35.74 29.25 36.02 28.87 38.21 31.19 42.9 36.17 48.31 29.52 48.69 27.36 48.76 26.97 49.78 24.6 48.45 21.93 48.06 21.14 45.47 17.73 42.35 17.98 40.42 18.14 40.42 17.8 39.22 16.29 39.19 16.24 35.27 12.53 32.57 12.65 28.67 12.83 27.43 13.71 27.07 13.97 26.62 14.28 26.3 14.38 26 14.35 25.7 14.38 25.38 14.28 24.93 13.97 24.57 13.71 23.33 12.83 19.43 12.65 16.73 12.53 12.81 16.24 12.78 16.29 11.58 17.8 11.58 18.14 9.65 17.98 6.53 17.73 3.94 21.14 3.55 21.93 2.22 24.6 3.24 26.97 3.31 27.36 3.69 29.52 9.1 36.17 13.79 31.19 15.98 28.87 16.26 29.25 19.11 27.83 20.92 30.3 21.14 30.5 22.11 31.08 23.09 31.68 23.21 31.3 23.59 31.54 24.78 32.28 25.32 32.78 26 32.74 Z' }],
  ],
  fly_vnc: [
    ['path', { d: 'M 26 5.87 C 23.74 5.87 21.55 3.38 19.23 6.48 16.88 9.6 20.16 12.23 20.09 14.78 20.05 15.93 16.85 20.22 19.85 22.87 21.44 24.29 22.42 24.21 21.51 26.16 19.83 29.74 17.72 30.85 20.57 34.59 22.58 37.23 22.24 38.65 23.33 39.61 24.36 40.51 25.11 41.08 26 41.08 26.89 41.08 27.64 40.51 28.67 39.61 29.77 38.65 29.42 37.23 31.43 34.59 34.28 30.85 32.17 29.74 30.49 26.16 29.58 24.21 30.56 24.29 32.16 22.87 35.15 20.22 31.95 15.93 31.92 14.78 31.84 12.23 35.12 9.6 32.78 6.48 30.46 3.38 28.26 5.87 26 5.87 Z' }],
  ],
  fly_cns: [
    ['path', { d: 'M 26.02 18.84 C 24.55 18.84 23.12 17.22 21.61 19.23 20.08 21.27 22.22 22.98 22.17 24.64 22.15 25.39 20.07 28.18 22.01 29.91 23.05 30.83 23.69 30.78 23.1 32.05 22 34.38 20.63 35.11 22.48 37.54 23.79 39.26 23.57 40.18 24.29 40.81 24.96 41.4 25.44 41.77 26.02 41.77 26.6 41.77 27.09 41.4 27.76 40.81 28.47 40.18 28.25 39.26 29.56 37.54 31.42 35.11 30.04 34.38 28.95 32.05 28.35 30.78 28.99 30.83 30.03 29.91 31.98 28.18 29.9 25.39 29.88 24.64 29.82 22.98 31.96 21.27 30.44 19.23 28.92 17.22 27.49 18.84 26.02 18.84 Z' }],
    ['path', { d: 'M 26.02 16.62 C 26.46 16.65 26.81 16.33 27.59 15.84 27.84 15.69 27.91 15.93 28.56 15.54 29.18 15.17 29.33 15.03 30.51 13.43 32.37 14.35 32.55 14.1 33.97 15.62 37.03 18.86 40.55 14.53 40.8 13.12 40.85 12.87 41.51 11.32 40.64 9.58 40.39 9.07 38.7 6.85 36.67 7.01 35.41 7.11 35.42 6.9 34.63 5.91 34.61 5.88 32.06 3.46 30.3 3.54 27.76 3.66 26.96 4.23 26.72 4.4 26.43 4.6 26.22 4.67 26.02 4.65 25.83 4.67 25.62 4.6 25.33 4.4 25.09 4.23 24.29 3.66 21.75 3.54 19.98 3.46 17.43 5.88 17.41 5.91 16.63 6.9 16.63 7.11 15.38 7.01 13.34 6.85 11.66 9.07 11.4 9.58 10.53 11.32 11.2 12.87 11.24 13.12 11.49 14.53 15.02 18.86 18.07 15.62 19.5 14.1 19.68 14.35 21.53 13.43 22.72 15.03 22.86 15.17 23.49 15.54 24.13 15.93 24.21 15.69 24.45 15.84 25.23 16.33 25.58 16.65 26.02 16.62 Z' }],
  ],
  fly_optic: [
    ['path', { d: 'M 16.81 22.61 L 16.94 23.65 17.13 24.8 17.43 25.87 17.52 26.15 17.73 26.7 18.29 27.92 19.7 30.16 19.91 30.42 21 31.64 21.28 31.91 22.24 32.69 22.84 33.14 24.07 33.93 24.9 34.41 25.87 34.81 26.95 35.15 27.04 35.15 27.64 35.09 28.94 34.7 29.54 34.3 29.99 33.96 30.7 33.24 32.45 31.21 32.7 30.76 32.9 30.33 33.11 29.76 33.13 29.6 32.86 28.49 32.68 27.83 29.05 13.45 28.84 12.68 28.58 12.03 28.19 11.42 27.6 10.59 27.09 9.92 26.6 9.5 26.17 9.34 25.65 9.21 25.06 9.18 24.94 9.18 24.61 9.27 23.69 9.61 23.51 9.7 23.24 9.88 22.94 10.09 22.16 10.67 20.81 11.92 19.39 13.47 18.98 14.07 18.39 14.95 17.82 15.96 17.45 16.69 17.16 17.71 16.91 18.92 16.85 19.83 16.8 20.89 16.8 22.1 16.81 22.61 Z' }],
    ['path', { d: 'M 25.9 17.85 L 25.95 20.01 26.34 22.01 26.52 22.63 27.04 23.76 28.24 26.34 30.23 27.71 31.41 28.46 32.58 28.81 33.29 28.83 33.7 28.79 34.28 28.53 34.55 28.37 34.86 28.17 35.21 27.87 36.46 26.05 36.67 25.67 36.73 25.15 36.75 24.83 36.75 24.6 36.73 24.1 36.62 23.17 36.41 22.4 35.85 20.99 35.65 20.53 33.63 15.28 33.08 14.17 32.54 13.38 32.26 13.02 31.99 12.79 31.6 12.5 30.43 11.98 29.25 11.83 29.1 11.82 28.71 11.83 28.46 11.85 28.14 12.03 27.71 12.39 26.52 15.09 26.09 16.85 25.9 17.78 25.9 17.85 Z' }],
    ['path', { d: 'M 23.64 24.15 L 24.2 25.37 24.57 26.11 24.77 26.43 25.07 26.86 25.69 27.69 26.84 28.88 27.19 29.21 28.06 29.83 28.76 30.23 29.1 30.35 29.33 30.41 29.86 30.46 31.07 30.55 31.8 30.53 32.47 30.22 33.09 29.78 33.7 29.26 34.45 28.37 34.9 27.26 34.59 24.67 33.77 23.11 30.49 16.01 29.84 14.41 29.2 13.67 28.84 13.34 28.41 13.08 28.06 12.92 27.48 12.84 27.24 12.84 27.04 12.87 26.57 12.98 26.21 13.1 25.84 13.27 25.4 13.56 24.94 14.17 24.14 15.44 23.65 16.38 23.3 17.25 23.04 18.16 22.86 19.1 22.79 20.14 22.79 20.41 23.12 22.42 23.64 24.15 Z' }],
  ],
  fly_hemibrain: [
    ['path', { d: 'M 13.97 20.75 C 13.97 21.42 13.95 32.68 14.06 32.87 14.14 33 14.69 33.25 15.12 33.29 15.96 33.38 15.78 33 15.86 32.18 L 17.57 32.18 C 17.78 32.83 17.59 33.12 18.53 33.22 19.32 33.3 19.32 33.31 20.05 33.02 L 21.39 33.81 21.44 34.05 C 21.57 34.12 23.11 34.91 23.13 34.85 23.21 34.65 23.08 34.37 23.22 34.22 24.88 32.5 26.61 34.41 26.8 34.63 26.84 34.67 26.74 35.16 26.92 35.44 27.4 36.19 28.46 35.74 28.56 35.74 28.8 34.16 28.78 34.17 28.79 32.59 30.17 31.85 30.69 32.1 30.74 30.54 30.81 28.38 30.24 28.2 31.49 26.42 36.04 28.61 36.32 29.12 36.51 28.5 36.75 27.71 36.57 27.56 37.29 27.15 37.41 27.08 38.03 27.51 38.03 26.05 38.06 11.1 37.96 11.11 37.93 10.27 37.1 10.25 36.86 9.9 36.61 10.6 36.41 11.12 36.5 11.12 36.46 12.17 L 34.77 12.17 C 34.67 11.97 34.73 11.72 34.63 11.51 34.53 11.3 33.86 10.71 32.52 13.49 L 30.91 13.65 C 30.84 13.53 29.94 11.22 29.08 11.04 26.7 10.56 26.7 10.9 25.38 11.01 24.9 11.05 22.64 10.38 20.6 11.12 18.66 11.83 18.36 11.41 17.39 12.8 16.98 13.38 15.25 13.94 14.7 15.44 14.15 16.93 14.81 17.64 14.97 18.03 14.69 18.47 14.34 18.86 14.06 19.29 14 19.39 14.05 19.4 13.97 20.75 Z' }],
  ],
  mouse_brain: [
    ['path', { d: 'M 26 39.15 C 24.28 39.09 22.38 38.5 19.11 37.41 15.79 36.31 16.59 35.33 15.46 33.83 13.69 31.47 15.55 31.14 15.22 30.61 15.17 30.53 15.04 30.68 14.43 29.76 13.01 27.63 13.41 24.07 13.46 23.57 14.04 18.32 15.02 17.55 15.4 16.95 15.75 16.4 18.89 11.47 20.63 10.7 21.55 10.29 20.48 9.88 20.81 8.57 21.13 7.3 20.31 6.74 21.29 6.63 22.45 6.5 22.33 6.13 23.48 5.9 24.89 5.62 25.48 6.06 26 6.01 26.52 6.06 27.11 5.62 28.52 5.9 29.67 6.13 29.55 6.5 30.71 6.63 31.69 6.74 30.87 7.3 31.19 8.57 31.52 9.88 30.45 10.29 31.37 10.7 33.11 11.47 36.25 16.4 36.6 16.95 36.98 17.55 37.96 18.32 38.54 23.57 38.59 24.07 38.99 27.63 37.57 29.76 36.96 30.68 36.83 30.53 36.78 30.61 36.45 31.14 38.31 31.47 36.54 33.83 35.41 35.33 36.21 36.31 32.89 37.41 29.62 38.5 27.72 39.09 26 39.15 Z' }],
  ],
  fly_larva: [
    ['path', { d: 'M 7.68 13.97 C 7.73 14.53 6.83 14.67 7.87 16.18 8.98 17.79 10.29 17.73 10 19.21 9.89 19.8 10.01 19.79 9.84 20.39 9.72 20.84 10.08 21.32 9.2 22.33 8.48 23.14 11.32 24.92 12.1 25.84 12.43 26.23 12.22 26.46 12.73 26.55 14.1 26.81 14.05 27.1 15.42 26.98 16.7 26.86 18.2 28.47 19.29 27.59 20.29 26.79 23.98 27.65 24.67 27.27 24.97 27.1 26.77 27.4 28.05 26.94 28.95 26.62 29.01 27.08 30.28 26.7 30.94 26.51 35.92 26.52 36.04 26.57 37.29 27.04 37.31 26.88 38.59 27.23 39.51 27.48 42.41 27.95 42.75 28 42.91 28.02 43.55 28.94 47.47 26.23 48.65 25.42 46.95 25.27 46.37 24.56 45.32 23.29 45.21 23.39 43.61 23 43.35 22.94 43.71 23.23 43.51 23.39 43.27 23.58 43.24 22.85 43.16 22.83 42.66 22.69 41.25 22.93 40.75 22.54 40.44 22.31 39.08 22.66 38.01 22.26 37.23 21.97 37.18 22.28 36.43 21.96 35.47 21.56 35.48 21.42 34.46 21.6 34.19 21.65 34.2 21.28 31.01 21.67 30.44 21.73 26.79 21.53 23.71 21.92 21.94 22.03 21.27 22.55 19.71 21.75 18.59 21.18 18.36 21.81 17.35 21.06 16.16 20.17 14.91 20.5 15.77 19.3 15.88 19.15 17.26 18.36 17.49 19.39 17.62 19.96 18.63 19.61 18.04 18.55 17.95 18.38 17.49 17.93 17.53 17.51 17.61 16.56 17.24 16.7 16.61 15.99 17.7 12.97 15.54 13.17 15.38 13.11 14.56 12.81 14.71 11.72 12.62 12.5 10.85 13.15 10.78 12.83 9.48 12.87 8.12 12.92 7.62 14 7.68 13.97 Z' }],
  ],
  specimen: [
    ['rect', { x: '16', y: '12', width: '20', height: '26', rx: '3' }],
    ['path', { d: 'M20 8h12v4H20z' }],
    ['path', { d: 'M16 22c5 2 15 2 20 0' }],
  ],
}

/** The 52-box the silhouettes are authored in. */
const SPECIMEN_WIDTH = 52
const SPECIMEN_HEIGHT = 46
const SPECIMEN_SCALE = GLYPH_BOX / SPECIMEN_WIDTH

/** The two `viewBox` strings a caller can need, so neither is typed out at a call site. */
export const GLYPH_VIEWBOX = `0 0 ${GLYPH_BOX} ${GLYPH_BOX}`
export const SPECIMEN_VIEWBOX = `0 0 ${SPECIMEN_WIDTH} ${SPECIMEN_HEIGHT}`

/**
 * A silhouette placed in the shared 24-box.
 *
 * Scaling the path scales its stroke with it — 1.6 would land at 0.74 and every dataset tile
 * would draw thinner than every other node — so the group puts the weight back. Derived rather
 * than transcribed: the two numbers have to agree or the whole dataset category looks faint,
 * which is the kind of wrong that reads as a rendering bug rather than as a constant.
 */
export function specimenShapes(
  glyph: DatasetGlyph,
  mark: readonly GlyphShape[] = [],
): readonly GlyphShape[] {
  const dy = (GLYPH_BOX - SPECIMEN_HEIGHT * SPECIMEN_SCALE) / 2
  return [
    [
      'g',
      {
        transform: `translate(0 ${dy.toFixed(2)}) scale(${SPECIMEN_SCALE.toFixed(4)})`,
        strokeWidth: (GLYPH_STROKE_WIDTH / SPECIMEN_SCALE).toFixed(2),
      },
      [...DATASET_GLYPHS[glyph], ...mark],
    ],
  ]
}

// ---------------------------------------------------------------------------
// Per-node drawings
// ---------------------------------------------------------------------------

/** The three Custom dataset nodes, which are one drawing wearing three backend pips. */
const CUSTOM_DATASET: readonly GlyphShape[] = [
  ['ellipse', { cx: '10.4', cy: '6.6', rx: '6.4', ry: '2.4' }],
  ['path', { d: 'M4 6.6v8.6c0 1.3 2.9 2.4 6.4 2.4' }],
  ['path', { d: 'M4 11c0 1.3 2.9 2.4 6.4 2.4' }],
  ['path', { d: 'M14 16h6.6M14 19.4h6.6' }],
  ['circle', { cx: '16.4', cy: '16', r: '1.5' }],
  ['circle', { cx: '18.6', cy: '19.4', r: '1.5' }],
]

/**
 * A mark drawn *on top of* a dataset node's family silhouette, by node type.
 *
 * Its own table rather than an entry in `NODE_GLYPHS`, because the two are different claims. An
 * entry there replaces the drawing and has to name a silhouette to get one back — which is the
 * family's own `glyph` field written out a second time, so changing the family would leave this
 * node on the old picture with nothing to say so. A mark here says only "and this as well": the
 * silhouette still comes from the family, and there is no way to spell a replacement.
 *
 * FIB-19 is the only one. It is a partial reconstruction of the structure Optic Lobe covers
 * whole, and the two are the same backend, so the header pip cannot separate them; the crop edge
 * is drawn in the silhouette's own 52-box, since that is where the group puts it.
 */
const DATASET_MARKS: Readonly<Record<string, readonly GlyphShape[]>> = {
  'dataset.fib19': [['path', { d: 'M35.5 10.5V35', strokeDasharray: '5 4.5' }]],
}

/**
 * One entry per node type, grouped by base shape rather than by category — the family is the
 * argument, and two nodes in one family are usually in two different categories.
 *
 * A type with no entry falls through to `CATEGORY_GLYPHS`, which is why adding a node does not
 * require drawing one. Dataset nodes carrying a family fall through to their silhouette first.
 */
// prettier-ignore
export const NODE_GLYPHS: Readonly<Record<string, readonly GlyphShape[]>> = {

  // --- The table ---------------------------------------------------------------
  // A rounded box with a header rule. Everything that keeps a table a table and changes what is
  // inside it. The axis is load-bearing: rows are drawn where the node acts on rows, columns
  // where it acts on columns.
  // A funnel in the table body — rows in the top, fewer out the bottom. The old transform
  // category glyph, kept, and now the set’s shared filter mark: Filter Network wears the same
  // funnel.
  'core.filterTable': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M8 11.6 10.8 14.8V18.6L13.2 17.4V14.8L16 11.6Z' }],
  ],
  'core.sort': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M7 12.4h10M7 15.4h6.5M7 18.4h3.5' }],
  ],
  // Two rows taken, one left. Deliberately not the funnel: Sample picks by position or at
  // random, Filter picks by a condition.
  'core.sample': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['rect', { x: '7', y: '11.3', width: '10', height: '1.9', rx: '.5', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M7 15.2h10' }],
    ['rect', { x: '7', y: '17.2', width: '10', height: '1.9', rx: '.5', fill: 'currentColor', stroke: 'none' }],
  ],
  'core.dedupe': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M7 12.4h10M7 16.4h10' }],
    ['path', { d: 'M5.9 17.6 18.1 15.2' }],
  ],
  // The column table with one column filled. This is where the axis rule is easiest to see:
  // Sort draws rows, Select draws columns, and neither draws both.
  'core.select': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M9.33 4.5v15M14.67 4.5v15' }],
    ['rect', { x: '9.33', y: '9', width: '5.34', height: '10.5', fill: 'currentColor', fillOpacity: '.22', stroke: 'none' }],
  ],
  'core.rename': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 10.5h16' }],
    ['path', { d: 'M6.4 7.4h3M13 7.4h4.6' }],
    ['path', { d: 'M10.6 6.1 12 7.4l-1.4 1.3' }],
    ['path', { d: 'M6.4 14h11.2M6.4 17h7.4' }],
  ],
  'core.editTable': [
    ['rect', { x: '3.5', y: '4.5', width: '12', height: '12', rx: '1.5' }],
    ['path', { d: 'M3.5 8.5h12' }],
    ['path', { d: 'M6.2 12h6.6' }],
    ['path', { d: 'M13.4 19.6l-2.7.7.7-2.7 6.3-6.3 2 2z' }],
  ],
  'core.selectOne': [
    ['path', { d: 'M6.5 6.6h11' }],
    ['rect', { x: '4', y: '9.6', width: '16', height: '4.8', rx: '1.2' }],
    ['path', { d: 'M6.5 17.4h11' }],
    ['path', { d: 'M15.4 10.9 16.8 12l-1.4 1.1' }],
  ],
  'out.describe': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M7.6 17.6v-4.2M12 17.6v-6.4M16.4 17.6v-2.6' }],
  ],
  'core.uploadTable': [
    ['path', { d: 'M4 9.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 9.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z' }],
    ['path', { d: 'M4 13h16' }],
    ['path', { d: 'M12 2.6v5.4M9.5 5.1 12 2.6l2.5 2.5' }],
  ],
  'core.tableFromUrl': [
    ['circle', { cx: '12', cy: '6.1', r: '3.6' }],
    ['path', { d: 'M8.4 6.1h7.2' }],
    ['path', { d: 'M12 2.5c1.7 2 1.7 5.2 0 7.2-1.7-2-1.7-5.2 0-7.2z' }],
    ['rect', { x: '4.4', y: '12.6', width: '15.2', height: '6.9', rx: '1.4' }],
    ['path', { d: 'M4.4 15.7h15.2' }],
  ],
  'cave.updateRootIds': [
    ['rect', { x: '3.5', y: '5', width: '11', height: '14', rx: '1.5' }],
    ['path', { d: 'M3.5 9h11' }],
    ['path', { d: 'M6 12h6M6 15.5h4.5' }],
    ['path', { d: 'M20.4 15.4a4.3 4.3 0 1 0-1.7 3.4' }],
    ['path', { d: 'M20.6 12.2v3.2h-3.2' }],
  ],
  'cave.tables': [
    ['rect', { x: '3.8', y: '5', width: '3.2', height: '3.2', rx: '.8' }],
    ['path', { d: 'M9.2 6.6h11' }],
    ['rect', { x: '3.8', y: '10.4', width: '3.2', height: '3.2', rx: '.8' }],
    ['path', { d: 'M9.2 12h11' }],
    ['rect', { x: '3.8', y: '15.8', width: '3.2', height: '3.2', rx: '.8' }],
    ['path', { d: 'M9.2 17.4h11' }],
  ],
  'cave.tableInfo': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M4 9h16' }],
    ['path', { d: 'M6.8 12.4h5M6.8 15.8h3.4' }],
    ['circle', { cx: '16.3', cy: '15.4', r: '3.5' }],
    ['path', { d: 'M16.3 14.8v2.8' }],
    ['circle', { cx: '16.3', cy: '13.4', r: '.6', fill: 'currentColor', stroke: 'none' }],
  ],

  // --- The fan ---------------------------------------------------------------
  // Many becoming one, or one changing shape. The fan is the family mark; rotating it ninety
  // degrees is how a node says "same operation, other axis", which is cheaper than inventing a
  // second drawing.
  'core.groupBy': [
    ['path', { d: 'M4 6.6h5.4M4 12h5.4M4 17.4h5.4' }],
    ['path', { d: 'M9.4 6.6c3.2 0 1.2 5.4 4.2 5.4M9.4 17.4c3.2 0 1.2-5.4 4.2-5.4' }],
    ['path', { d: 'M13.6 12H20' }],
  ],
  // The same fan turned ninety degrees, because Combine Columns is Group By on the other axis.
  'core.combineColumns': [
    ['path', { d: 'M6.6 4v5.4M12 4v5.4M17.4 4v5.4' }],
    ['path', { d: 'M6.6 9.4c0 3.2 5.4 1.2 5.4 4.2M17.4 9.4c0 3.2-5.4 1.2-5.4 4.2' }],
    ['path', { d: 'M12 13.6V20' }],
  ],
  'core.join': [
    ['rect', { x: '3.4', y: '5', width: '11.4', height: '11.4', rx: '1.5' }],
    ['path', { d: 'M3.4 8.4h11.4' }],
    ['rect', { x: '9.2', y: '7.6', width: '11.4', height: '11.4', rx: '1.5' }],
    ['path', { d: 'M9.2 11h11.4' }],
  ],
  'core.stack': [
    ['rect', { x: '4', y: '4.4', width: '16', height: '4.4', rx: '1.2' }],
    ['rect', { x: '4', y: '9.8', width: '16', height: '4.4', rx: '1.2' }],
    ['rect', { x: '4', y: '15.2', width: '16', height: '4.4', rx: '1.2' }],
  ],
  // A grid with a sweep around it. Rotation is the only mark that says "reshape" without
  // needing a before-and-after panel, which will not fit. The arrowhead sits on the arc’s real
  // tangent — computed, not eyeballed, or it reads as a broken join.
  'core.pivot': [
    ['rect', { x: '3.4', y: '4.2', width: '8.4', height: '8.4', rx: '1.2' }],
    ['path', { d: 'M3.4 8.4h8.4M7.6 4.2v8.4' }],
    ['path', { d: 'M13.5 4.4A7.4 7.4 0 0 1 13.5 18.8' }],
    ['path', { d: 'M16.4 19.7 13.5 18.8l2.2-2.1' }],
  ],
  // The identical arc travelled the other way, so the head moves to the other end. The pair
  // only works read together, which is an argument for keeping them adjacent in the browser
  // too.
  'core.unpivot': [
    ['rect', { x: '3.4', y: '4.2', width: '8.4', height: '8.4', rx: '1.2' }],
    ['path', { d: 'M3.4 8.4h8.4M7.6 4.2v8.4' }],
    ['path', { d: 'M13.5 18.8A7.4 7.4 0 0 0 13.5 4.4' }],
    ['path', { d: 'M15.7 6.5 13.5 4.4l2.9-.9' }],
  ],
  'core.relabel': [
    ['path', { d: 'M3.6 8h4.4M3.6 16h4.4' }],
    ['path', { d: 'M16 8h4.4M16 16h4.4' }],
    ['path', { d: 'M10 8h4M12.4 6.4 14 8l-1.6 1.6' }],
    ['path', { d: 'M10 16h4M12.4 14.4 14 16l-1.6 1.6' }],
  ],
  // A luggage tag. Qualifying attaches where an id came from without changing the id, which is
  // what a tag does and what a prefix does not look like.
  'core.qualifyIds': [
    ['path', { d: 'M4.4 5.6h6l6.2 6.2-5 5-6.2-6.2z' }],
    ['circle', { cx: '7.2', cy: '8.4', r: '1.15' }],
  ],

  // --- The matrix ---------------------------------------------------------------
  // A square grid. Four nodes carry a matrix on a wire, and each one is told apart by which
  // cells are filled — not by decoration around the grid.
  // A matrix with a row header and a column header. The headers separate it from the Heatmap
  // glyph: Adjacency is a matrix that knows whose row is whose.
  'neuron.adjacency': [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '1.5' }],
    ['path', { d: 'M9 4v16M4 9h16' }],
    ['rect', { x: '9.9', y: '9.9', width: '4.2', height: '4.2', fill: 'currentColor', fillOpacity: '.8', stroke: 'none' }],
    ['rect', { x: '15', y: '9.9', width: '4.2', height: '4.2', fill: 'currentColor', fillOpacity: '.28', stroke: 'none' }],
    ['rect', { x: '9.9', y: '15', width: '4.2', height: '4.2', fill: 'currentColor', fillOpacity: '.34', stroke: 'none' }],
    ['rect', { x: '15', y: '15', width: '4.2', height: '4.2', fill: 'currentColor', fillOpacity: '.8', stroke: 'none' }],
  ],
  // A filled diagonal — everything is perfectly like itself. The one property every similarity
  // matrix has and no other matrix in Coda does.
  'core.similarity': [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '1.5' }],
    ['path', { d: 'M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16' }],
    ['rect', { x: '4.6', y: '4.6', width: '4.2', height: '4.2', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '9.9', y: '9.9', width: '4.2', height: '4.2', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '15.2', y: '15.2', width: '4.2', height: '4.2', fill: 'currentColor', stroke: 'none' }],
  ],
  'neuron.nblastMatches': [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '1.5' }],
    ['path', { d: 'M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16' }],
    ['circle', { cx: '17.34', cy: '6.67', r: '1.9', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '6.67', cy: '12', r: '1.9', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '17.34', r: '1.9', fill: 'currentColor', stroke: 'none' }],
  ],
  'core.normalize': [
    ['rect', { x: '4', y: '5', width: '16', height: '14', rx: '1.5' }],
    ['rect', { x: '6.2', y: '7.4', width: '11.6', height: '2.4', fill: 'currentColor', fillOpacity: '.22', stroke: 'none' }],
    ['rect', { x: '6.2', y: '7.4', width: '4', height: '2.4', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '6.2', y: '11', width: '11.6', height: '2.4', fill: 'currentColor', fillOpacity: '.22', stroke: 'none' }],
    ['rect', { x: '6.2', y: '11', width: '9.2', height: '2.4', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '6.2', y: '14.6', width: '11.6', height: '2.4', fill: 'currentColor', fillOpacity: '.22', stroke: 'none' }],
    ['rect', { x: '6.2', y: '14.6', width: '6.4', height: '2.4', fill: 'currentColor', stroke: 'none' }],
  ],

  // --- The arbour ---------------------------------------------------------------
  // A branching centreline. Everything whose material is a neuron’s shape rather than a row of
  // numbers. The soma disc, the faceted solid and the filled point are the three sub-materials:
  // skeleton, mesh, point cloud.
  'neuron.skeletons': [
    ['circle', { cx: '6.4', cy: '18.4', r: '2' }],
    ['path', { d: 'M7.8 17 12 12.4M12 12.4l4.2-4.6M12 12.4l1.4 5M16.2 7.8l3.4-1.8M16.2 7.8l-.6-3.4M13.4 17.4l3.6 1.6' }],
  ],
  'neuron.meshes': [
    ['path', { d: 'M12 3.6l7.4 4.2v8.4L12 20.4 4.6 16.2V7.8z' }],
    ['path', { d: 'M12 12v8.4M4.6 7.8 12 12l7.4-4.2' }],
  ],
  // One point onto another. Filled dots rather than the graph family’s hollow circles, because
  // a synapse is a location and not a neuron; the gap before the second dot is the cleft.
  'neuron.synapses': [
    ['circle', { cx: '6.8', cy: '12', r: '2.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '17.2', cy: '12', r: '2.4', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M9.8 12h3.6' }],
    ['path', { d: 'M12.2 10.2 14 12l-1.8 1.8' }],
  ],
  'neuron.mirror': [
    ['path', { d: 'M12 3.6v16.8', strokeDasharray: '2.6 2.4' }],
    ['path', { d: 'M7.6 19.4v-5.2L4.8 11M7.6 14.2l3-2.6M10.6 11.6l-.8-2.8' }],
    ['path', { d: 'M16.4 19.4v-5.2L19.2 11M16.4 14.2l-3-2.6M13.4 11.6l.8-2.8' }],
  ],
  'neuron.xform': [
    ['path', { d: 'M4 8V4.6h3.4M20 8V4.6h-3.4M4 16v3.4h3.4M20 16v3.4h-3.4' }],
    ['path', { d: 'M12 17.4V13l-2.6-2.8M12 12.6l2.8-2.4M14.8 10.2l-.6-2.8' }],
  ],
  // Two arbours and a plus. Deliberately not Stack Tables’ three slabs — same verb, different
  // material, and the material is what the icon names.
  'neuron.stack': [
    ['path', { d: 'M6.4 19.4v-4.2l-2.4-2.6M6.4 15.2l2.4-2M8.8 13.2l-.4-2.6' }],
    ['path', { d: 'M17.6 19.4v-4.2l2.4-2.6M17.6 15.2l-2.4-2M15.2 13.2l.4-2.6' }],
    ['path', { d: 'M12 8.4v4.4M9.8 10.6h4.4' }],
  ],
  'core.landmarkTransform': [
    ['path', { d: 'M4 7c5.4-2 10.6-2 16 0M4 12.6c5.4-2 10.6-2 16 0M4 18.2c5.4-2 10.6-2 16 0' }],
    ['path', { d: 'M8 5.5v13.4M16 4.4v13.4' }],
    ['circle', { cx: '8', cy: '11.5', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '16', cy: '10.4', r: '1.4', fill: 'currentColor', stroke: 'none' }],
  ],
  // Arbour plus a four-point spark. The spark is the shared "cleaned" mark — it appears here
  // and on Clean Meshes and nowhere else in the set.
  'neuron.cleanSkeletons': [
    ['path', { d: 'M8 19.6v-5.2L5 11M8 14.4l3.2-2.8M11.2 11.6l-.8-3' }],
    ['path', { d: 'M17.6 4.6l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z' }],
  ],
  // The mesh solid with the same spark, smaller and in the corner. Two nodes, one verb, one
  // mark.
  'neuron.cleanMeshes': [
    ['path', { d: 'M10.2 4.2l6.4 3.7v7.4l-6.4 3.7-6.4-3.7V7.9z' }],
    ['path', { d: 'M19.2 13.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' }],
  ],
  // Two arbours facing each other under a double arrow. Shape against shape, which is what
  // NBLAST scores.
  'neuron.nblast': [
    ['path', { d: 'M6 19.6V15l-2.6-2.8M6 14.6l2.6-2.2M8.6 12.4l-.5-2.8' }],
    ['path', { d: 'M18 19.6V15l2.6-2.8M18 14.6l-2.6-2.2M15.4 12.4l.5-2.8' }],
    ['path', { d: 'M9.6 6.6h4.8M11 5.2 9.6 6.6 11 8M13 5.2l1.4 1.4L13 8' }],
  ],
  // The same double arrow over two synapse clouds instead of two arbours. Read side by side,
  // the pair tells you exactly what each node compares.
  'neuron.synblast': [
    ['path', { d: 'M9.6 6.6h4.8M11 5.2 9.6 6.6 11 8M13 5.2l1.4 1.4L13 8' }],
    ['circle', { cx: '6', cy: '14', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '8.6', cy: '18', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '4.6', cy: '18.6', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '18', cy: '14', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.4', cy: '18', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '19.4', cy: '18.6', r: '1.5', fill: 'currentColor', stroke: 'none' }],
  ],
  'out.profile': [
    ['path', { d: 'M6.8 19.6v-5.2L4 11.4M6.8 14.4l2.8-2.4M9.6 12l-.6-2.8' }],
    ['path', { d: 'M13.6 6.6h6.8M13.6 10.4h6.8M13.6 14.2h4.6' }],
  ],

  // --- The node-link graph ---------------------------------------------------------------
  // Circles and wires. Weight says role: a larger or filled disc is the node the question is
  // about, a plain one is what came back. Nothing here uses a soma disc, which is reserved for
  // the arbour family, and Filter Network borrows its funnel from Filter Table rather than
  // inventing a second way to say the same verb.
  'neuron.connectivity': [
    ['circle', { cx: '6', cy: '12', r: '2.4' }],
    ['circle', { cx: '18', cy: '6.6', r: '1.8' }],
    ['circle', { cx: '18', cy: '12', r: '1.8' }],
    ['circle', { cx: '18', cy: '17.4', r: '1.8' }],
    ['path', { d: 'M8.3 11.1l7.9-3.6M8.4 12h7.8M8.3 12.9l7.9 3.6' }],
  ],
  'neuron.paths': [
    ['circle', { cx: '5', cy: '17.6', r: '2' }],
    ['circle', { cx: '19', cy: '5.8', r: '2' }],
    ['circle', { cx: '11.2', cy: '10.4', r: '1.7' }],
    ['circle', { cx: '16.6', cy: '15.4', r: '1.5' }],
    ['path', { d: 'M6.4 16.1l3.6-4.2M12.6 9.6l4.6-2.6' }],
    ['path', { d: 'M12.2 11.6l3.2 2.6' }],
  ],
  'neuron.influence': [
    ['circle', { cx: '12', cy: '12', r: '2.2', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M15.6 8.4a5.1 5.1 0 0 1 0 7.2M8.4 15.6a5.1 5.1 0 0 1 0-7.2' }],
    ['path', { d: 'M18.4 5.6a9.1 9.1 0 0 1 0 12.8M5.6 18.4a9.1 9.1 0 0 1 0-12.8' }],
  ],
  'net.build': [
    ['path', { d: 'M3.4 8h4.6M3.4 12h4.6M3.4 16h4.6' }],
    ['circle', { cx: '13.4', cy: '7.2', r: '1.9' }],
    ['circle', { cx: '19.6', cy: '12.6', r: '1.9' }],
    ['circle', { cx: '13', cy: '17.4', r: '1.9' }],
    ['path', { d: 'M14.9 8.4l3.2 2.8M18.6 14.2l-3.9 2.4M13.2 15.5l.16-6.4' }],
  ],
  // Filter Table’s funnel, unchanged, under a network instead of a table. Same verb, different
  // material — reusing the mark is what says the two nodes do the same thing, and it costs the
  // reader nothing to learn twice.
  'net.filter': [
    ['circle', { cx: '5', cy: '6.2', r: '1.8' }],
    ['circle', { cx: '12', cy: '4.6', r: '1.8' }],
    ['circle', { cx: '19', cy: '6.6', r: '1.8' }],
    ['path', { d: 'M6.8 5.8l3.4-.8M13.8 5.1l3.4 1.1' }],
    ['path', { d: 'M7.2 10.4 10.4 13.9V18.2L13.6 16.6V13.9L16.8 10.4Z' }],
  ],
  // A hub weighted solid against four plain neighbours. Centrality is a number per node, and
  // size is how that number is always drawn.
  'net.centrality': [
    ['circle', { cx: '12', cy: '12', r: '3.2', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '5.6', cy: '7.2', r: '1.6' }],
    ['circle', { cx: '18.4', cy: '6.8', r: '1.6' }],
    ['circle', { cx: '5.4', cy: '17.2', r: '1.6' }],
    ['circle', { cx: '18.6', cy: '17.2', r: '1.6' }],
    ['path', { d: 'M7 8.2l2.4 2M16.9 7.9l-2.3 2M6.8 16.2l2.4-2M17.2 16.2l-2.4-2' }],
  ],
  // A graph with statistics read off it. Metrics is cheap and Centrality is expensive; the
  // icons keep them apart because the browser does not.
  'net.metrics': [
    ['circle', { cx: '6.6', cy: '7', r: '1.8' }],
    ['circle', { cx: '6.6', cy: '16.6', r: '1.8' }],
    ['circle', { cx: '12.6', cy: '11.8', r: '1.8' }],
    ['path', { d: 'M8.1 8l3.1 2.6M8.1 15.5l3.1-2.5' }],
    ['path', { d: 'M15.4 19.4h6.4' }],
    ['path', { d: 'M17 19.4v-5.6M20.4 19.4v-9.6' }],
  ],
  'compare.matchTypes': [
    ['circle', { cx: '6', cy: '6.4', r: '1.7' }],
    ['circle', { cx: '6', cy: '12', r: '1.7' }],
    ['circle', { cx: '6', cy: '17.6', r: '1.7' }],
    ['circle', { cx: '18', cy: '6.4', r: '1.7' }],
    ['circle', { cx: '18', cy: '12', r: '1.7' }],
    ['circle', { cx: '18', cy: '17.6', r: '1.7' }],
    ['path', { d: 'M7.7 6.4h8.6M7.7 12h8.6M7.7 16.9l8.6-4' }],
  ],
  'compare.connectivity': [
    ['circle', { cx: '6', cy: '7.4', r: '2' }],
    ['circle', { cx: '18', cy: '7.4', r: '2' }],
    ['path', { d: 'M8.2 7.4h6.4M13.2 6 14.6 7.4l-1.4 1.4' }],
    ['circle', { cx: '6', cy: '16.6', r: '2' }],
    ['circle', { cx: '18', cy: '16.6', r: '2' }],
    ['path', { d: 'M8.2 16.6h6.4M13.2 15.2l1.4 1.4-1.4 1.4' }],
  ],
  'neuron.partnerVectors': [
    ['circle', { cx: '5.8', cy: '12', r: '2.2' }],
    ['path', { d: 'M8.2 12h2.6' }],
    ['rect', { x: '11.4', y: '9.2', width: '9.2', height: '5.6', rx: '1.2' }],
    ['path', { d: 'M14.5 9.2v5.6M17.6 9.2v5.6' }],
  ],

  // --- The merge tree ---------------------------------------------------------------
  // A four-leaf dendrogram. Three nodes build, cut and draw one; two more take a selection out
  // of one. What changes is only what is added to the same tree.
  // The bare tree. Base shape for everything that produces, cuts or draws a hierarchy.
  'cluster.linkage': [
    ['path', { d: 'M5 19.5v-4.5h4.5v4.5' }],
    ['path', { d: 'M14.5 19.5v-6.5h5v6.5' }],
    ['path', { d: 'M7.25 15V8.5H17V13' }],
    ['path', { d: 'M12.1 8.5V4.6' }],
  ],
  'cluster.cut': [
    ['path', { d: 'M5 19.5v-4.5h4.5v4.5' }],
    ['path', { d: 'M14.5 19.5v-6.5h5v6.5' }],
    ['path', { d: 'M7.25 15V8.5H17V13' }],
    ['path', { d: 'M12.1 8.5V4.6' }],
    ['path', { d: 'M2.6 11.4h18.8', strokeDasharray: '2.8 2.2' }],
  ],
  'out.dendrogram': [
    ['path', { d: 'M5 19.5v-4.5h4.5v4.5' }],
    ['path', { d: 'M14.5 19.5v-6.5h5v6.5' }],
    ['path', { d: 'M7.25 15V8.5H17V13' }],
    ['path', { d: 'M12.1 8.5V4.6' }],
    ['circle', { cx: '5', cy: '19.5', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '9.5', cy: '19.5', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '14.5', cy: '19.5', r: '1.3', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '19.5', cy: '19.5', r: '1.3', fill: 'currentColor', stroke: 'none' }],
  ],
  // A dashed box over a fork, then an arbour. Dashed because a selection is not part of the
  // tree; the same box appears on Clusters to Neurons.
  'cluster.selectedToNeurons': [
    ['path', { d: 'M4.6 11.6V8.2h5.2v3.4M7.2 8.2V5.6' }],
    ['rect', { x: '3', y: '4.2', width: '8.4', height: '8.6', rx: '1.2', strokeDasharray: '2.6 2.1' }],
    ['path', { d: 'M12.8 15.6h2.6M13.9 14.5l1.5 1.1-1.5 1.1' }],
    ['path', { d: 'M18.4 20.4v-4.6L16 13.2M18.4 16.8l2.4-2' }],
  ],
  // Two dashed clusters, then an arbour. Same dash, arrow and arbour as Selected to Neurons —
  // the two nodes differ only in what they read from.
  'cluster.clustersToNeurons': [
    ['circle', { cx: '7', cy: '7.6', r: '3.4', strokeDasharray: '2.6 2.1' }],
    ['circle', { cx: '6', cy: '7', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '8.2', cy: '8.4', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '7', cy: '15.8', r: '3.4', strokeDasharray: '2.6 2.1' }],
    ['circle', { cx: '6', cy: '15.2', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '8.2', cy: '16.6', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M12.4 11.8h2.6M13.5 10.7l1.5 1.1-1.5 1.1' }],
    ['path', { d: 'M18.4 19.4v-4.4L16.2 12.6M18.4 15.8l2-1.8' }],
  ],
  'neuron.nblastKnn': [
    ['circle', { cx: '11.4', cy: '12', r: '7.2', strokeDasharray: '2.8 2.3' }],
    ['circle', { cx: '11.4', cy: '12', r: '2.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '7.6', cy: '8.6', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.6', cy: '9.6', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '13.4', cy: '16.4', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '21', cy: '4.6', r: '1.3' }],
    ['circle', { cx: '20.6', cy: '19.2', r: '1.3' }],
  ],

  // --- The region ---------------------------------------------------------------
  // A neuropil blob. Five nodes are about places rather than cells; the blob keeps them
  // together and stops them borrowing the arbour, which would claim they are about neurons.
  'neuron.roiCounts': [
    ['path', { d: 'M5.6 10.6c.8-3.7 4.4-6.3 8.1-5.8 3.7.5 6.6 4 6.3 7.8-.3 3.8-3.6 6.9-7.4 6.9-3.8 0-7.8-5.2-7-8.9z' }],
    ['path', { d: 'M9.6 15.6v-3.4M12.4 15.6v-5.6M15.2 15.6v-2.4' }],
  ],
  'neuron.roiCompleteness': [
    ['path', { d: 'M5.6 10.6c.8-3.7 4.4-6.3 8.1-5.8 3.7.5 6.6 4 6.3 7.8-.3 3.8-3.6 6.9-7.4 6.9-3.8 0-7.8-5.2-7-8.9z' }],
    ['path', { d: 'M7 13.8h10M8.4 16.4h7.4M10.6 18.6h3.4' }],
  ],
  'neuron.roiMeshes': [
    ['path', { d: 'M5.6 10.6c.8-3.7 4.4-6.3 8.1-5.8 3.7.5 6.6 4 6.3 7.8-.3 3.8-3.6 6.9-7.4 6.9-3.8 0-7.8-5.2-7-8.9z' }],
    ['path', { d: 'M6 11.8c3.8 2.8 8.6 2.8 13-.4' }],
    ['path', { d: 'M12.6 4.8c-2.8 3.8-2.8 10.4 0 14.6' }],
  ],
  // Two regions and an arrow. The only node whose output is a matrix of places, so the blob
  // appears twice rather than gaining a grid.
  'neuron.roiConnectivity': [
    ['g', { transform: 'translate(0.34 2.28) scale(0.52)', strokeWidth: '3.08' }, [
      ['path', { d: 'M5.6 10.6c.8-3.7 4.4-6.3 8.1-5.8 3.7.5 6.6 4 6.3 7.8-.3 3.8-3.6 6.9-7.4 6.9-3.8 0-7.8-5.2-7-8.9z' }],
    ]],
    ['g', { transform: 'translate(10.34 9.28) scale(0.52)', strokeWidth: '3.08' }, [
      ['path', { d: 'M5.6 10.6c.8-3.7 4.4-6.3 8.1-5.8 3.7.5 6.6 4 6.3 7.8-.3 3.8-3.6 6.9-7.4 6.9-3.8 0-7.8-5.2-7-8.9z' }],
    ]],
    ['path', { d: 'M10.8 11.4l3 3' }],
    ['path', { d: 'M13.9 12.3v2.6h-2.6' }],
  ],
  'out.rois': [
    ['circle', { cx: '12', cy: '12', r: '7.6' }],
    ['path', { d: 'M12 4.4v15.2' }],
    ['circle', { cx: '8.6', cy: '9.6', r: '2', fill: 'currentColor', fillOpacity: '.6', stroke: 'none' }],
    ['circle', { cx: '15.4', cy: '9.6', r: '2', fill: 'currentColor', fillOpacity: '.25', stroke: 'none' }],
    ['circle', { cx: '12', cy: '15.8', r: '2', fill: 'currentColor', fillOpacity: '.42', stroke: 'none' }],
  ],

  // --- The lens and the tag ---------------------------------------------------------------
  // How a set of neurons is named in the first place. Two nodes look for them, two spell them
  // out, one lets you write the query yourself.
  // A magnifier arriving over a list. Explore is a browser, so the list is drawn first and the
  // lens second; Find Neurons is the other way round.
  'neuron.explore': [
    ['path', { d: 'M4 6.4h16M4 10.4h16M4 14.4h6.4' }],
    ['circle', { cx: '14.4', cy: '15.4', r: '4' }],
    ['path', { d: 'M17.3 18.3l3.1 3.1' }],
  ],
  // A tiny arbour inside the lens. Same magnifier as Explore, different thing under it — which
  // is the difference between the two nodes.
  'neuron.findNeurons': [
    ['circle', { cx: '10.8', cy: '10.8', r: '6.2' }],
    ['path', { d: 'M15.4 15.4l4.2 4.2' }],
    ['path', { d: 'M10.8 15v-5.4M10.8 11.6l2.6-2.2M10.8 9.8L8.6 8' }],
  ],
  // A tag with an arrow leaving it. The label goes in and ids come out; the tag is shared with
  // Qualify Ids, which puts one on instead of reading one.
  'neuron.idsFromLabel': [
    ['path', { d: 'M4.4 5.6h6l6.2 6.2-5 5-6.2-6.2z' }],
    ['circle', { cx: '7.2', cy: '8.4', r: '1.15' }],
    ['path', { d: 'M14.4 18h5.4M17.4 15.6l2.4 2.4-2.4 2.4' }],
  ],
  'neuron.inputIds': [
    ['rect', { x: '4', y: '4.5', width: '16', height: '15', rx: '1.5' }],
    ['path', { d: 'M7 8.6h6.4M7 12h8M7 15.4h4.4' }],
    ['path', { d: 'M15.4 13.6v4.4' }],
  ],
  'neuron.rawCypher': [
    ['rect', { x: '3.6', y: '4.6', width: '16.8', height: '14.8', rx: '2' }],
    ['path', { d: 'M3.6 8.4h16.8' }],
    ['path', { d: 'M7 11.8l2.2 2.2L7 16.2M11.6 16.2h5.4' }],
  ],

  // --- The specimen ---------------------------------------------------------------
  // Reuses the silhouettes already drawn for the dataset card body in DatasetPreview.tsx — a
  // species and a coarse anatomical kind, never a dataset. Nothing new was drawn for the twelve
  // published connectomes; they are the same art, scaled into the 24-box.
  // The disc stack with two sliders. Named rather than written out three times: "configured by
  // hand" is the thing the Custom nodes have in common, the pip already says which backend, and
  // three copies of one drawing is three chances for two of them to stay in step.
  'dataset.neuprint': CUSTOM_DATASET,
  'dataset.cave': CUSTOM_DATASET,
  'dataset.catmaid': CUSTOM_DATASET,
  'dataset.description': [
    ['rect', { x: '5', y: '3.6', width: '14', height: '16.8', rx: '1.6' }],
    ['rect', { x: '7.8', y: '6.4', width: '6.4', height: '2', rx: '.6', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M7.8 11h8.4M7.8 14.2h8.4M7.8 17.4h5' }],
  ],
  'out.datasetSummary': [
    ['ellipse', { cx: '8.6', cy: '6.6', rx: '4.6', ry: '1.9' }],
    ['path', { d: 'M4 6.6v7.6c0 1 2 1.9 4.6 1.9' }],
    ['path', { d: 'M4 10.8c0 1 2 1.9 4.6 1.9' }],
    ['path', { d: 'M12 19.4h10' }],
    ['path', { d: 'M13.6 19.4v-6.2M17 19.4v-9.6M20.4 19.4v-4' }],
  ],
  // A labelled sheet with a disc stack in the corner — this table lives inside a datastack. All
  // four annotation sources share the sheet; only the corner changes.
  'annotation.caveTable': [
    ['rect', { x: '3.4', y: '4.4', width: '13.6', height: '13.6', rx: '1.4' }],
    ['path', { d: 'M3.4 8h13.6M8.4 8v10' }],
    ['ellipse', { cx: '19.6', cy: '15.4', rx: '2.8', ry: '1.1' }],
    ['path', { d: 'M16.8 15.4v4.4c0 .6 1.25 1.1 2.8 1.1s2.8-.5 2.8-1.1v-4.4' }],
  ],
  // Two lobes in the corner. FlyTable is a SeaTable base, so its accent is borrowed from what
  // it holds rather than from what it is — the weakest mark in the set.
  'annotation.flyTable': [
    ['rect', { x: '3.4', y: '4.4', width: '13.6', height: '13.6', rx: '1.4' }],
    ['path', { d: 'M3.4 8h13.6M8.4 8v10' }],
    ['circle', { cx: '18.4', cy: '18.8', r: '1.9' }],
    ['circle', { cx: '21.6', cy: '18.8', r: '1.9' }],
    ['path', { d: 'M19.6 17.4h1.2' }],
  ],
  'annotation.seaTable': [
    ['rect', { x: '3.4', y: '4.4', width: '13.6', height: '13.6', rx: '1.4' }],
    ['path', { d: 'M3.4 8h13.6M8.4 8v10' }],
    ['path', { d: 'M16.6 17.4c1-1.2 2-1.2 3 0s2 1.2 3 0' }],
    ['path', { d: 'M16.6 20.4c1-1.2 2-1.2 3 0s2 1.2 3 0' }],
  ],
  'annotation.googleSheet': [
    ['rect', { x: '3.4', y: '4.4', width: '13.6', height: '13.6', rx: '1.4' }],
    ['path', { d: 'M3.4 8h13.6M8.4 8v10' }],
    ['path', { d: 'M17.4 21a2.3 2.3 0 0 1 .3-4.6 3.1 3.1 0 0 1 5.9 1 2 2 0 0 1-.5 3.6z' }],
  ],

  // --- The four panes ---------------------------------------------------------------
  // Neuroglancer’s quad layout. Two nodes touch it — one emits a source, one views a scene —
  // and nothing else in Coda looks like this, so the pair is worth keeping visually adjacent.
  // The four panes with an arrow leaving them. A Neuroglancer Source emits a Dataset, and the
  // arrow is the whole difference from the viewer.
  'dataset.ngsource': [
    ['rect', { x: '3.6', y: '5.6', width: '12.8', height: '12.8', rx: '1.4' }],
    ['path', { d: 'M10 5.6v12.8M3.6 12h12.8' }],
    ['path', { d: 'M18.4 12h3M19.8 10.4 21.4 12l-1.6 1.6' }],
  ],
  'out.neuroglancer': [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '1.5' }],
    ['path', { d: 'M12 4v16M4 12h16' }],
    ['path', { d: 'M7.8 6.4v3M6.3 7.9h3' }],
    ['circle', { cx: '16', cy: '16', r: '2.2', fill: 'currentColor', fillOpacity: '.45', stroke: 'none' }],
  ],

  // --- The loop ---------------------------------------------------------------
  // Control flow and the way out. Three nodes that are about the graph itself rather than about
  // connectomes.
  'flow.forEach': [
    ['path', { d: 'M19.2 9.6A7.4 7.4 0 1 0 19.4 14.4' }],
    ['path', { d: 'M16.6 8.8l2.8.6.6-2.8' }],
    ['circle', { cx: '9', cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15', cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }],
  ],
  // Three passes fanning into one bin. The same fan as Group By, turned downward, because
  // Collect is the loop’s aggregation.
  'flow.collect': [
    ['circle', { cx: '6', cy: '5.4', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '5.4', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '18', cy: '5.4', r: '1.5', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M6 8.4c0 3.2 6 1.4 6 4.2 0-2.8 6-1 6-4.2' }],
    ['path', { d: 'M12 12.6v2.4' }],
    ['rect', { x: '5.6', y: '15.2', width: '12.8', height: '4.6', rx: '1.2' }],
  ],
  // An arrow into a tray. The only icon in the set that is a convention rather than a
  // derivation, and it should stay one.
  'out.download': [
    ['path', { d: 'M12 4v9.4M8.6 10 12 13.4 15.4 10' }],
    ['path', { d: 'M4.6 15.4V18a1.5 1.5 0 0 0 1.5 1.5h11.8A1.5 1.5 0 0 0 19.4 18v-2.6' }],
  ],
  // A clipboard with a list of ids on it. Its sibling in this pair is Download's tray, and the
  // two are drawn as *destinations* rather than as actions for that reason: both nodes are taps
  // that pass their input on, so what distinguishes them is where the copy of it ends up. The
  // rows inside are `neuron.inputIds`' rows at the same pitch, which is what says the material
  // is a list of ids and not a table.
  'out.copyIds': [
    ['rect', { x: '5.4', y: '5.6', width: '13.2', height: '13.9', rx: '1.6' }],
    ['rect', { x: '9.2', y: '3.4', width: '5.6', height: '3.6', rx: '1.2' }],
    ['path', { d: 'M8.6 11.6h6.8M8.6 15h4.6' }],
  ],

  // --- Kept as they are ---------------------------------------------------------------
  // The ten drawings already in NODE_GLYPHS, reproduced here so the sheet is the whole set.
  // They were done on the same principle this draft extends — a node whose identity is a visual
  // form gets that form — and none of them needs replacing.
  'out.table': [
    ['line', { x1: '5', y1: '7', x2: '19', y2: '7' }],
    ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
    ['line', { x1: '5', y1: '17', x2: '19', y2: '17' }],
  ],
  'out.heatmap': [
    ['rect', { x: '5', y: '5', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.25', stroke: 'none' }],
    ['rect', { x: '10', y: '5', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.55', stroke: 'none' }],
    ['rect', { x: '15', y: '5', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.85', stroke: 'none' }],
    ['rect', { x: '5', y: '10', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.55', stroke: 'none' }],
    ['rect', { x: '10', y: '10', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.85', stroke: 'none' }],
    ['rect', { x: '15', y: '10', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.25', stroke: 'none' }],
    ['rect', { x: '5', y: '15', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.85', stroke: 'none' }],
    ['rect', { x: '10', y: '15', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.25', stroke: 'none' }],
    ['rect', { x: '15', y: '15', width: '4', height: '4', fill: 'currentColor', fillOpacity: '.55', stroke: 'none' }],
  ],
  'out.barChart': [
    ['line', { x1: '5', y1: '5', x2: '5', y2: '19' }],
    ['line', { x1: '7', y1: '8', x2: '19', y2: '8' }],
    ['line', { x1: '7', y1: '12', x2: '15', y2: '12' }],
    ['line', { x1: '7', y1: '16', x2: '11', y2: '16' }],
  ],
  'out.histogram': [
    ['line', { x1: '4', y1: '19', x2: '20', y2: '19' }],
    ['rect', { x: '5', y: '14', width: '3', height: '5', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '8.5', y: '9', width: '3', height: '10', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '12', y: '6', width: '3', height: '13', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '15.5', y: '12', width: '3', height: '7', fill: 'currentColor', stroke: 'none' }],
  ],
  'out.pie': [
    ['circle', { cx: '12', cy: '12', r: '7' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M12 5 A7 7 0 0 1 19 12 L15 12 A3 3 0 0 0 12 8 Z', fill: 'currentColor', stroke: 'none' }],
  ],
  'out.distribution': [
    ['line', { x1: '4', y1: '8', x2: '20', y2: '8' }],
    ['rect', { x: '8', y: '5', width: '7', height: '6' }],
    ['line', { x1: '11', y1: '5', x2: '11', y2: '11' }],
    ['line', { x1: '6', y1: '16', x2: '19', y2: '16' }],
    ['rect', { x: '9', y: '13', width: '6', height: '6' }],
    ['line', { x1: '12', y1: '13', x2: '12', y2: '19' }],
  ],
  'out.scatter': [
    ['line', { x1: '5', y1: '5', x2: '5', y2: '19' }],
    ['line', { x1: '5', y1: '19', x2: '19', y2: '19' }],
    ['circle', { cx: '9', cy: '15', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '11', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '11', cy: '16', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '16', cy: '8', r: '1.4', fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: '13.6', y: '13.6', width: '2.6', height: '2.6', fill: 'currentColor', stroke: 'none' }],
  ],
  'out.network': [
    ['circle', { cx: '6', cy: '7', r: '2.2' }],
    ['circle', { cx: '18', cy: '6', r: '2.2' }],
    ['circle', { cx: '12', cy: '13', r: '2.2' }],
    ['circle', { cx: '6', cy: '19', r: '2.2' }],
    ['circle', { cx: '18', cy: '18', r: '2.2' }],
    ['path', { d: 'M8 8l2.3 3.3M16 7.4l-2.4 3.9M10.2 14.4L7.6 17.4M13.9 14.5l2.6 2.4' }],
  ],
  'out.viewer3d': [
    ['path', { d: 'M12 21V9' }],
    ['path', { d: 'M12 12L7 7M12 15l5-4M12 9l-3-4M12 11l4-6' }],
    ['circle', { cx: '7', cy: '7', r: '1.3' }],
    ['circle', { cx: '17', cy: '11', r: '1.3' }],
    ['circle', { cx: '9', cy: '5', r: '1.3' }],
    ['circle', { cx: '16', cy: '5', r: '1.3' }],
  ],
  // Lines of prose, the last one short.
  'note.text': [
    ['line', { x1: '4', y1: '7', x2: '20', y2: '7' }],
    ['line', { x1: '4', y1: '12', x2: '20', y2: '12' }],
    ['line', { x1: '4', y1: '17', x2: '13', y2: '17' }],
  ],
}

// ---------------------------------------------------------------------------
// Fallbacks and resolution
// ---------------------------------------------------------------------------

/**
 * What a node with no drawing of its own gets.
 *
 * Every type in the registry today has an entry above, so nothing reaches these — they exist
 * so a node added next month has a picture rather than an empty box, and so the browser never
 * has a blank row. Two of them are now also a mark in their own right (`transform`'s funnel is
 * Filter's, `utility`'s three dots are the elements inside For Each's loop); that is fine for a
 * fallback and worth knowing before treating either as free to reuse.
 */
export const CATEGORY_GLYPHS: Readonly<Record<NodeCategory, readonly GlyphShape[]>> = {
  // A stack of discs: a dataset. Also `neuron.dataset`'s own drawing — the generic node is
  // exactly what this fallback means, so it deliberately has no entry of its own.
  dataset: [
    ['ellipse', { cx: '12', cy: '7', rx: '7', ry: '2.6' }],
    ['path', { d: 'M5 7v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V7' }],
    ['path', { d: 'M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6' }],
  ],
  // A magnifier: a search.
  query: [
    ['circle', { cx: '10.5', cy: '10.5', r: '5.5' }],
    ['line', { x1: '14.5', y1: '14.5', x2: '19', y2: '19' }],
  ],
  // A funnel: rows in, fewer rows out.
  transform: [['path', { d: 'M4 5h16l-6 7v7h-4v-7z' }]],
  // A trend line: a computed result.
  analysis: [['polyline', { points: '4,18 9,11 14,14 20,5' }]],
  // Generic chart, for a viewer with no specific glyph.
  visualisation: [
    ['line', { x1: '5', y1: '19', x2: '19', y2: '19' }],
    [
      'rect',
      { x: '6', y: '11', width: '3.5', height: '8', fill: 'currentColor', stroke: 'none' },
    ],
    [
      'rect',
      { x: '11', y: '7', width: '3.5', height: '12', fill: 'currentColor', stroke: 'none' },
    ],
    [
      'rect',
      { x: '16', y: '14', width: '3.5', height: '5', fill: 'currentColor', stroke: 'none' },
    ],
  ],
  utility: [
    ['circle', { cx: '7', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '17', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }],
  ],
}

/**
 * The shapes a node draws, in the order the three fallbacks are tried.
 *
 * `datasetGlyph` is passed in rather than looked up, because this module must not import
 * `datasetFamilies` as a value: `nodes.html` would then carry the whole family table — blurbs,
 * versions and all — behind a page that needs one field of it. Each caller already has the
 * family to hand, or gets it from the registry at build time. It is required-but-nullable for
 * the same reason the lookup is not done here: forgetting it is silent, and drops all twelve
 * published connectomes onto the generic disc stack.
 */
export function glyphShapes(
  type: string,
  category: NodeCategory,
  datasetGlyph: DatasetGlyph | undefined,
): readonly GlyphShape[] {
  const own = NODE_GLYPHS[type]
  if (own) return own
  if (datasetGlyph) return specimenShapes(datasetGlyph, DATASET_MARKS[type])
  return CATEGORY_GLYPHS[category]
}

/**
 * Walk a glyph, building whatever the caller's surface is made of.
 *
 * The recursion exists for exactly one shape — `specimenShapes`' scaling group — but a renderer
 * that could not nest would have to special-case it, and a special case is how the two surfaces
 * start disagreeing. `create` is handed the child's `index` rather than a React key, because
 * naming it a key would be React's vocabulary in the one module that must not know about React.
 */
export function mapGlyph<T>(
  shapes: readonly GlyphShape[],
  create: (tag: string, attrs: GlyphAttrs, index: number, children: T[] | undefined) => T,
): T[] {
  return shapes.map(([tag, attrs, children], index) =>
    create(tag, attrs, index, children && mapGlyph(children, create)),
  )
}

/** React's `strokeWidth` back to SVG's `stroke-width`, for the string renderer. */
const svgAttr = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * A glyph as SVG source, for the surfaces that build HTML rather than elements.
 *
 * Values come from this file and never from user input, so they are interpolated as written;
 * the day one of them holds a quote, this needs escaping.
 */
export function glyphMarkup(shapes: readonly GlyphShape[]): string {
  return mapGlyph(shapes, (tag, attrs, _index, children) => {
    const written = Object.entries(attrs)
      .map(([name, value]) => ` ${svgAttr(name)}="${value}"`)
      .join('')
    return children ? `<${tag}${written}>${children.join('')}</${tag}>` : `<${tag}${written}/>`
  }).join('')
}
