/**
 * The picture at the top of a dataset node.
 *
 * A placeholder for now — a specimen silhouette, not a rendering of the data — but it occupies
 * the space a real preview will take, so switching to one later is a change of content rather
 * than of layout.
 *
 * **Six drawings cover every dataset, and a seventh is never required.** The glyph is keyed to a
 * coarse anatomical kind (`brain`, `vnc`, `cns`, `optic`) declared in the family table, with
 * `specimen` as the fallback, so a dataset added tomorrow gets a sensible picture without
 * anybody drawing one. That is the same rule `NodeThumbnail` follows, and for the same reason:
 * per-dataset artwork means the next dataset ships blank.
 */

import type { DatasetGlyph } from '../../nodes/lib/datasetFamilies'

const GLYPHS: Record<DatasetGlyph, () => React.ReactElement> = {
  // Central brain: two lobes over a midline stalk.
  brain: () => (
    <>
      <path d="M20 26c-6 0-9-4-9-8s3-8 9-8c3 0 5 1 6 3 1-2 3-3 6-3 6 0 9 4 9 8s-3 8-9 8" />
      <path d="M26 13v20" />
      <path d="M20 33h12" />
    </>
  ),
  // Ventral nerve cord: a tapering ladder of neuromeres.
  vnc: () => (
    <>
      <path d="M26 8c-7 0-11 5-11 11 0 8 3 14 11 22 8-8 11-14 11-22 0-6-4-11-11-11z" />
      <path d="M17 19h18M18 26h16M20 33h12" />
    </>
  ),
  // Whole CNS: brain above, nerve cord below.
  cns: () => (
    <>
      <path d="M18 14c0-3 3-6 8-6s8 3 8 6-3 6-8 6-8-3-8-6z" />
      <path d="M26 20v6" />
      <path d="M26 26c-5 0-8 3-8 7 0 5 3 8 8 12 5-4 8-7 8-12 0-4-3-7-8-7z" />
      <path d="M20 33h12" />
    </>
  ),
  // Optic lobe: stacked retinotopic layers.
  optic: () => (
    <>
      <path d="M14 12c8-3 16-3 24 0" />
      <path d="M13 20c9-3 17-3 26 0" />
      <path d="M14 28c8-3 16-3 24 0" />
      <path d="M17 36c6-2 12-2 18 0" />
      <path d="M14 12v24M38 12v24" />
    </>
  ),
  // Anything else: a jar. Honest about being a stand-in.
  specimen: () => (
    <>
      <rect x={16} y={12} width={20} height={26} rx={3} />
      <path d="M20 8h12v4H20z" />
      <path d="M16 22c5 2 15 2 20 0" />
    </>
  ),
}

/**
 * One silhouette, unpositioned — see `nodeGlyph` in `NodeThumbnail` for why this is shared
 * rather than redrawn. Coordinates are in the `0 0 52 46` box.
 */
export function datasetGlyph(glyph: DatasetGlyph): React.ReactElement {
  return (GLYPHS[glyph] ?? GLYPHS.specimen)()
}

export interface DatasetPreviewProps {
  glyph: DatasetGlyph
  /** Shown under the glyph — the dataset and resolved version. */
  caption?: string | undefined
}

export function DatasetPreview({ glyph, caption }: DatasetPreviewProps) {
  return (
    <div className="dataset-preview" data-glyph={glyph}>
      <svg
        viewBox="0 0 52 46"
        className="dataset-preview__art"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {datasetGlyph(glyph)}
      </svg>
      {caption && <span className="dataset-preview__caption">{caption}</span>}
    </div>
  )
}
