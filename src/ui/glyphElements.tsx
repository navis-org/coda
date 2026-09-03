/**
 * The React half of `glyphs.ts`.
 *
 * Its own file because `glyphs.ts` must stay free of React — `nodes.html` imports the table and
 * has no React in its bundle — and because both surfaces that draw glyphs as elements sit in
 * different directories (`panels/NodeThumbnail`, `nodes/DatasetPreview`), so neither is the
 * natural owner of the other's renderer.
 */

import { createElement } from 'react'

import type { GlyphShape } from './glyphs'
import { mapGlyph } from './glyphs'

/**
 * Unpositioned shapes. The caller's `<g>` supplies fill, stroke and size, so one glyph draws at
 * 22px in the browser and at 30px on a start-page tile without knowing either. Weight is the
 * caller's too for every glyph *except* a dataset silhouette, whose scaling group carries an
 * absolute `strokeWidth` — it has to, or the scale would thin it. See `specimenShapes`.
 */
export function glyphElements(shapes: readonly GlyphShape[]): React.ReactElement[] {
  return mapGlyph(shapes, (tag, attrs, index, children) =>
    createElement(tag, { key: index, ...attrs }, children),
  )
}
