/**
 * The picture at the top of a dataset node.
 *
 * A placeholder for now — a specimen silhouette, not a rendering of the data — but it occupies
 * the space a real preview will take, so switching to one later is a change of content rather
 * than of layout.
 *
 * **A glyph is a species and a coarse anatomical kind, not a dataset.** `fly_brain`, `fly_vnc`,
 * `fly_cns`, `fly_optic`, `mouse_brain` — declared in the family table, with `specimen` as the
 * fallback, so a dataset added tomorrow gets a sensible picture without anybody drawing one.
 * That is the same rule `ui/glyphs.ts` follows, and for the same reason: per-dataset artwork
 * means the next dataset ships blank. `dataset.fib19` is the one entry that adds a mark on top
 * of a silhouette rather than replacing it, which is what keeps the fallback intact.
 *
 * The species prefix is what stopped that rule quietly lying. `MICrONS Minnie65` — a mouse
 * visual cortex volume — wore the fly central brain for as long as the kinds were named for
 * anatomy alone, because `brain` looked like it meant any brain. Nothing was broken and nothing
 * warned; the card simply showed the wrong animal.
 *
 * `fly_hemibrain` is the one entry that names a volume rather than a structure: a central brain
 * cropped to an imaged block. It is a deliberate exception, and the cost of another one is that
 * the rule above stops being a rule.
 */

import type { DatasetGlyph } from '../../nodes/lib/datasetFamilies'
import { DATASET_GLYPHS, SPECIMEN_VIEWBOX } from '../glyphs'
import { glyphElements } from '../glyphElements'
import { GlyphSvg } from '../panels/startGlyphs'

/**
 * One silhouette, unpositioned — see `glyphShapes` in `ui/glyphs.ts` for why this is shared
 * rather than redrawn, and for the rest of the drawing set it now sits in. The paths moved
 * there when every node got a glyph of its own; the design record above stayed here, because
 * what makes these a species and a coarse anatomical kind is a fact about datasets rather than
 * about drawings. Coordinates are still in the `0 0 52 46` box.
 */
export function datasetGlyph(glyph: DatasetGlyph): React.ReactElement {
  return <>{glyphElements(DATASET_GLYPHS[glyph])}</>
}

export interface DatasetPreviewProps {
  glyph: DatasetGlyph
  /** Shown under the glyph — the dataset and resolved version. */
  caption?: string | undefined
}

export function DatasetPreview({ glyph, caption }: DatasetPreviewProps) {
  return (
    <div className="dataset-preview" data-glyph={glyph}>
      <GlyphSvg viewBox={SPECIMEN_VIEWBOX} className="dataset-preview__art">
        {datasetGlyph(glyph)}
      </GlyphSvg>
      {caption && <span className="dataset-preview__caption">{caption}</span>}
    </div>
  )
}
