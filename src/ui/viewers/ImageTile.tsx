/**
 * One image as a tile — a thumbnail to open, a name and a figure under it, tags, a `+N` for the
 * group's other images, and a pin — and the "Show more" footer under a grid of them.
 *
 * Shared by the NeuronBridge card and the VFB Line Gallery, under `.image-tile*` classes.
 *
 * What stays in each caller is what the tile is *about*: where the thumbnail comes from, what the
 * figure means, which tags it carries. What is here is the furniture: the button that opens it,
 * the image that may not exist, the toggle for its group's other images, and the ☆ that sends it
 * to a `Pinned` port.
 */

import type { ReactNode } from 'react'

import { formatNumber, plural } from '../../style/format'

export function ImageTile({
  src,
  alt,
  name,
  figure,
  figureTitle,
  openTitle,
  onOpen,
  secondary = false,
  selected,
  group,
  others,
  tags,
  pinned,
  onPin,
}: {
  src: string | undefined
  alt: string
  /** The tile's name, selectable: a line, a specimen. */
  name: string
  /** A short figure beside the name — a score, a count — and its tooltip. */
  figure?: ReactNode
  figureTitle?: string
  openTitle: string
  onOpen: () => void
  /** One of a group's further images, drawn dashed. */
  secondary?: boolean
  selected: boolean
  /** The group a lead tile stands for, which stepping scrolls to; further images are not stops. */
  group?: string
  /** On a lead tile, the group's other images: how many, whether shown, and the toggle. */
  others?: { count: number; open: boolean; onToggle: () => void }
  /** Second-row content before the spacer: badges and marks. */
  tags?: ReactNode
  pinned: boolean
  onPin: () => void
}) {
  return (
    <div
      className="image-tile"
      data-secondary={secondary || undefined}
      data-line={secondary ? undefined : group}
      data-selected={selected || undefined}
    >
      <button type="button" className="image-tile__thumb" title={openTitle} onClick={onOpen}>
        {src ? (
          <img src={src} alt={alt} loading="lazy" draggable={false} />
        ) : (
          <span className="image-tile__muted">no image</span>
        )}
      </button>
      <div className="image-tile__foot">
        <span className="image-tile__name" title={name}>
          {name}
        </span>
        {figure !== undefined && (
          <span className="image-tile__figure" title={figureTitle}>
            {figure}
          </span>
        )}
      </div>
      <div className="image-tile__foot">
        {tags}
        <span className="profile__spacer" />
        {others && others.count > 0 && (
          <button
            type="button"
            className="image-tile__others"
            aria-expanded={others.open}
            title={
              others.open ? 'Hide this line’s other images' : 'Show this line’s other images'
            }
            onClick={others.onToggle}
          >
            {others.open ? '−' : '+'}
            {others.count}
          </button>
        )}
        <button
          type="button"
          className="image-tile__star"
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
          title={
            pinned ? 'Unpin — remove from the Pinned port' : 'Pin — send to the Pinned port'
          }
          onClick={onPin}
        >
          {pinned ? '★' : '☆'}
        </button>
      </div>
    </div>
  )
}

/** Under a grid shown in steps: how many of how many lines, and the button that adds a step. */
export function ShowMore({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  if (total <= shown) return null
  return (
    <div className="image-tiles__more">
      <span className="image-tile__muted">
        Showing {formatNumber(shown)} of {plural(total, 'line')}
      </span>
      <button type="button" className="tile__link" onClick={onMore}>
        Show more
      </button>
    </div>
  )
}

/**
 * A group's tiles — a line's lead image and, opened, its others — kept as plain grid items while
 * closed and gathered into one bordered band across the grid while open, so which images belong
 * to which line reads at a glance rather than from a dashed outline on each.
 *
 * Always the same element, `display: contents` while closed: swapping a fragment for a `<div>`
 * would remount every tile in the line, images included, on each open and close.
 */
export function TileGroup({
  open,
  label,
  children,
}: {
  open: boolean
  label?: string
  children: ReactNode
}) {
  return (
    <div
      className="image-tiles__group"
      data-open={open || undefined}
      role={open ? 'group' : undefined}
      aria-label={open ? label : undefined}
    >
      {children}
    </div>
  )
}
