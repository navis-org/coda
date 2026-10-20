/**
 * The VFB Line Gallery card: Expression Images' rows as thumbnails, one tile per driver line.
 *
 * It reuses NeuronBridge's tile (`ImageTile`) and its two drawing rules: **one tile per line, at
 * its first whole-line image**, the line's other images behind `+N` and drawn only when opened —
 * every tile is an `<img>` from VFB's file server, so an image not shown is a request not made —
 * and **lines arrive in steps**, the first `tiles` and more on request.
 *
 * Laid out like NeuronBridge's card: **a large view on top, the grid below.** The view
 * (`ImageStage.tsx`, which describes its modes) shows the opened image, the first line's
 * until one is chosen. Above it, the line, specimen and template; below it, the dataset, licence
 * and VFB link. The licence is on the tile too: it travels with the image, and a gallery is
 * where somebody decides what to reuse. Which view, and whether the template shows, are the
 * node's presentational params, so they persist with the workflow.
 *
 * **An opened line is one band** (`TileGroup`): its images gathered under one border across the
 * grid, so which images belong to which line does not rest on a dashed outline.
 */

import { useMemo, useState } from 'react'

import { groupBy } from '../../core/collections'
import type { TableValue } from '../../core/values'
import { optionalColumn } from '../../core/values'
import type { VfbLineImage } from '../../data/vfb/bridge'
import { nonEmpty } from '../../data/vfb/common'
import { vfbTemplate } from '../../data/vfb/templates'
import type { GalleryView } from '../../packs/vfb/ops'
import { GALLERY_VIEWS, IMAGE_COLUMNS as C } from '../../packs/vfb/ops'
import { plural } from '../../style/format'
import { ColumnLinkCell } from '../ColumnLinkCell'
import { tableToCsvParts } from '../export'
import { ImageTile, ShowMore, TileGroup } from '../viewers/ImageTile'
import { Segmented } from '../viewers/Segmented'
import type { ExportSource } from '../viewers/ViewerActions'
import { ViewerActions } from '../viewers/ViewerActions'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { ImageStage } from './ImageStage'

export interface LineGalleryViewerProps {
  /** Expression Images' table, or anything with `imageId`, `lineId` and `thumbnail` columns. */
  images: TableValue | undefined
  /** Lines shown at first, and added by each "Show more". */
  tiles: number
  /** The stored `pins` param: pinned image ids. */
  pins: readonly string[]
  onPins: (next: string[]) => void
  /** The stored `view` and `withTemplate` params: the large view's mode, and its template. */
  mode: GalleryView
  onMode: (next: GalleryView) => void
  withTemplate: boolean
  onWithTemplate: (next: boolean) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** One image row, read once. */
interface GalleryImage {
  readonly imageId: string
  readonly lineId: string
  readonly line: string
  readonly specimen: string
  readonly part: VfbLineImage['part']
  readonly template?: string
  readonly thumbnail?: string
  readonly dataset?: string
  readonly license?: string
  readonly nrrd?: string
}

interface GalleryLine {
  readonly lineId: string
  /** In the table's order, which puts whole-line images first (`imagesTable`). */
  readonly images: readonly GalleryImage[]
}

/** The table's images grouped by line, lines in the order they first appear. */
function readLines(table: TableValue): GalleryLine[] | undefined {
  const ids = optionalColumn(table, C.imageId)
  const lineIds = optionalColumn(table, C.lineId)
  if (!ids || !lineIds) return undefined
  // Each named column read once, as a row accessor, so each field below names its own column.
  const at = (name: string) => {
    const values = optionalColumn(table, name)
    return (row: number) => nonEmpty(values?.[row])
  }
  const read = {
    line: at(C.line),
    specimen: at(C.specimen),
    part: at(C.part),
    template: at(C.template),
    thumbnail: at(C.thumbnail),
    dataset: at(C.dataset),
    license: at(C.license),
    nrrd: at(C.nrrd),
  }
  const images: GalleryImage[] = []
  ids.forEach((cell, row) => {
    const imageId = nonEmpty(cell)
    const lineId = nonEmpty(lineIds[row])
    if (!imageId || !lineId) return
    images.push({
      imageId,
      lineId,
      line: read.line(row) ?? lineId,
      specimen: read.specimen(row) ?? imageId,
      part: read.part(row) === 'fragment' ? 'fragment' : 'line',
      template: read.template(row),
      thumbnail: read.thumbnail(row),
      dataset: read.dataset(row),
      license: read.license(row),
      nrrd: read.nrrd(row),
    })
  })
  return [...groupBy(images, (i) => i.lineId)].map(([lineId, group]) => ({
    lineId,
    images: group,
  }))
}

/** `CC-BY-NC-SA_4.0` → `CC-BY-NC-SA`, short enough for a tile; the tooltip keeps the version. */
const licenceBadge = (license: string) => license.replace(/_\d.*$/, '').replace(/_/g, '-')

/**
 * The pins the `Pinned` port emits — those still in the incoming table — and how many stored pins
 * are not, which an upstream change can leave behind and the port drops.
 */
function pinCaption(pins: readonly string[], images: ReadonlyMap<string, unknown>): string {
  if (pins.length === 0) return ''
  const here = pins.filter((id) => images.has(id)).length
  const gone = pins.length - here
  const head = `${plural(here, 'image')} pinned`
  return gone > 0 ? `${head}; ${plural(gone, 'pin')} no longer in the table` : head
}

/** What an image shows, for its `alt`, on the tile and in the large view alike. */
const altText = (image: GalleryImage) => `${image.line} expression, ${image.specimen}`

export function LineGalleryViewer(props: LineGalleryViewerProps) {
  const { images, tiles, pins, onPins, mode, onMode, withTemplate, onWithTemplate } = props
  const { compact, baseName, onExpand, onError } = props
  const lines = useMemo(() => (images ? readLines(images) : undefined), [images])
  const [shown, setShown] = useState(tiles)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // The opened image by id, so a new table without it simply shows nothing open.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const pinned = useMemo(() => new Set(pins), [pins])
  const byId = useMemo(
    () => new Map(lines?.flatMap((l) => l.images).map((i) => [i.imageId, i])),
    [lines],
  )

  if (!images)
    return <ViewerEmpty>Connect VFB Expression Images to browse its lines.</ViewerEmpty>
  if (!lines) {
    return <ViewerEmpty>The incoming table has no imageId and lineId columns.</ViewerEmpty>
  }
  if (lines.length === 0) return <ViewerEmpty>No images in the incoming table.</ViewerEmpty>
  // The opened image, or the first line's until one is chosen: the view is never empty.
  const selected = (selectedId && byId.get(selectedId)) || lines[0]!.images[0]!

  const togglePin = (image: GalleryImage) =>
    onPins(
      pinned.has(image.imageId)
        ? pins.filter((id) => id !== image.imageId)
        : [...pins, image.imageId],
    )
  const toggleExpand = (lineId: string) =>
    setExpanded((before) => {
      const next = new Set(before)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  const tile = (image: GalleryImage, secondary: boolean, others?: number) => (
    <ImageTile
      key={image.imageId}
      src={image.thumbnail}
      alt={altText(image)}
      name={secondary ? image.specimen : image.line}
      openTitle={`${image.specimen} — open`}
      onOpen={() => setSelectedId(image.imageId)}
      secondary={secondary}
      selected={selected.imageId === image.imageId}
      group={image.lineId}
      others={
        others === undefined
          ? undefined
          : {
              count: others,
              open: expanded.has(image.lineId),
              onToggle: () => toggleExpand(image.lineId),
            }
      }
      tags={
        <>
          {image.part === 'fragment' && <span className="image-tile__badge">fragment</span>}
          {image.license && (
            <span className="image-tile__badge" title={image.license}>
              {licenceBadge(image.license)}
            </span>
          )}
        </>
      }
      pinned={pinned.has(image.imageId)}
      onPin={() => togglePin(image)}
    />
  )

  const exportSource: ExportSource = {
    csv: () => tableToCsvParts(images),
  }

  return (
    <div className="viewer vfb-gallery nodrag" data-compact={compact || undefined}>
      <div className="vfb-gallery__view">
        <div className="vfb-gallery__facts">
          <span className="image-tile__name">{selected.line}</span>
          <span className="image-tile__muted" title={selected.specimen}>
            {selected.specimen}
          </span>
          {selected.template && (
            <span className="image-tile__badge">
              {vfbTemplate(selected.template)?.label ?? selected.template}
            </span>
          )}
          <span className="profile__spacer" />
          <Segmented label="View" options={GALLERY_VIEWS} value={mode} onChange={onMode} />
          {mode === 'projection' && (
            <label
              className="tile__toggle"
              title="Unticked: the image stack’s own projection, the signal alone (downloads the stack)"
            >
              <input
                type="checkbox"
                checked={withTemplate}
                onChange={(e) => onWithTemplate(e.target.checked)}
              />
              template
            </label>
          )}
        </div>
        <ImageStage
          // Keyed on the image, so zoom and the loaded stack start over with each.
          key={selected.imageId}
          thumbnail={selected.thumbnail}
          nrrd={selected.nrrd}
          alt={altText(selected)}
          mode={mode}
          withTemplate={withTemplate}
          turned={vfbTemplate(selected.template)?.turnedClockwise ?? false}
        />
        <div className="vfb-gallery__links">
          {selected.dataset && <span className="image-tile__muted">{selected.dataset}</span>}
          {selected.license && (
            <span className="image-tile__muted">Licence: {selected.license}</span>
          )}
          <span className="profile__spacer" />
          <ColumnLinkCell link="vfb" value={selected.imageId} />
        </div>
      </div>
      <div className="vfb-gallery__scroll nowheel">
        <div className="image-tiles">
          {lines.slice(0, shown).map((line) => {
            const open = expanded.has(line.lineId) && line.images.length > 1
            return (
              <TileGroup key={line.lineId} open={open} label={line.images[0]!.line}>
                {tile(line.images[0]!, false, line.images.length - 1)}
                {open && line.images.slice(1).map((i) => tile(i, true))}
              </TileGroup>
            )
          })}
        </div>
        <ShowMore
          shown={shown}
          total={lines.length}
          onMore={() => setShown((n) => n + tiles)}
        />
      </div>
      <div className="viewer__caption">
        <span>{pinCaption(pins, byId)}</span>
        <ViewerActions
          baseName={baseName ?? 'vfb-lines'}
          source={exportSource}
          compact={compact}
          {...(onExpand ? { onExpand } : {})}
          {...(onError ? { onError } : {})}
        />
      </div>
    </div>
  )
}
