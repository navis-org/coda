/**
 * The stage a screen map is drawn on: every spot boxed, labelled, and joined by a leader — and
 * the list it stands down to on the narrow shell.
 *
 * Shared by the two maps there are. The shell's (`ScreenMap.tsx`, one of the guides) labels the
 * editor; a node's (`NodeMap.tsx`, the header button on a full-size surface) labels one body. What
 * differs between them is what they label, where the finders look, and what the panel says — the
 * lifecycle round them is each caller's own, since only the guide borrows anything. Everything
 * here is the part that would otherwise be written twice: the measurement, the placement, the
 * hover, the dismissal.
 *
 * ## Two passes, because a label's height is its text
 *
 * Every box is measured, and so is every label. The boxes have to be: an element's rect is the
 * whole point, and a figure that guessed at it would be `anatomy.ts` again — a drawing of an app
 * rather than the app. The *labels* have to be because their height is not knowable before they
 * are laid out: the width is fixed, the note is one sentence, and one sentence wraps to two lines
 * or three depending on the words in it. So:
 *
 *  1. Find the spots and take their rects (`useLayoutEffect`, after whatever the caller prepared
 *     has committed — see `ScreenMap`'s `Lifecycle`).
 *  2. Render the labels at their fixed width, unplaced and invisible, and measure them.
 *  3. Place everything and draw.
 *
 * An extra commit for something that appears once, which is the cheap half of the trade. The
 * expensive half would be estimating a height from a character count, which is the kind of number
 * that is right on the machine it was tuned on.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { union } from '../../layout/place'
import { useDismissOnOutside } from '../useDismiss'
import { layoutViewport } from '../menu/placement'
import { ModalHeader } from '../Modal'
import type { LabelBox, Placement, Rect } from './mapLayout'
import { placeLabels } from './mapLayout'
import type { MapSpot } from './mapSpots'

import './screenMap.css'

/**
 * How wide a label is, and the only place that decides.
 *
 * Set inline on the element from here rather than in `screenMap.css`, because it is the number
 * the placement is *told*: a stylesheet cannot import a constant, and a width the arithmetic and
 * the drawing disagree about by a few pixels is a label that overlaps its neighbour on screen and
 * does not in the test.
 */
const LABEL_W = 176

/** A spot that is on this screen, with the box its elements come to. */
interface Found {
  spot: MapSpot
  box: Rect
}

/**
 * Everything the map can see right now, looking inside `root`.
 *
 * A spot with no element is left out rather than drawn empty — see `mapSpots.ts`. A zero-sized
 * rect counts as absent for the same reason: a control React has rendered but the layout has not
 * given a size to is not on screen, whatever `querySelector` says. Several elements come to one
 * box through `union`, which is `place.ts`' and answers `undefined` for the empty set — the
 * "not on this screen" case, already handled.
 */
function collect(spots: readonly MapSpot[], root: ParentNode): Found[] {
  const out: Found[] = []
  for (const spot of spots) {
    const rects = spot
      .find(root)
      .filter((node): node is Element => Boolean(node))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
    const box = union(
      rects.map((rect) => ({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })),
    )
    if (box) out.push({ spot, box })
  }
  return out
}

export interface MapStageProps {
  spots: readonly MapSpot[]
  /**
   * Where the finders look. Absent means the document, which is the shell's case.
   *
   * A node's map needs it because the same body is drawn twice: an Explore card on the canvas
   * carries the same `.explore__input` and the same rows as the overlay above it, so a finder
   * asking the document unions the card's search box into the overlay's and draws one box round
   * both — the width of the window.
   */
  scope?: RefObject<ParentNode | null>
  /** The dialog's name, and the panel's heading. */
  title: string
  /** The panel's sentence. */
  text: string
  onClose: () => void
}

export function MapStage({ spots, scope, title, text, onClose }: MapStageProps) {
  const [found, setFound] = useState<Found[] | null>(null)
  const [places, setPlaces] = useState<Map<string, Placement> | null>(null)
  /**
   * Which spot the pointer is on, if any — the box, its leader and its label light together and
   * everything else dims.
   *
   * A figure with sixteen labels and sixteen leaders is a figure a reader has to *trace*, and the
   * one question they are asking at any moment is "which of these goes with which". So the leader
   * stops being decoration and becomes the answer: hovering either end lights the whole triple.
   *
   * State rather than a ref, unlike `usePanGesture`'s drag flag: this changes on enter and leave
   * of a spot — sixteen of them — not per pointer move, so the re-render it costs is one per
   * gesture and the alternative would be reaching into the DOM by hand. It voids no memo either;
   * the measuring effect keys on `found`, which a hover does not touch.
   */
  const [hot, setHot] = useState<string | null>(null)
  const labels = useRef(new Map<string, HTMLDivElement | null>())
  const panel = useRef<HTMLDivElement>(null)

  /** Enter/leave for a hover target. `leave` clears only if it is still this spot's turn. */
  const hover = (id: string) => ({
    onPointerEnter: () => setHot(id),
    onPointerLeave: () => setHot((current) => (current === id ? null : current)),
  })

  /*
   * The panel is the only thing on this surface that takes a click, so it is the "inside" — a
   * press anywhere else, on a label or on bare scrim, closes. Escape is on `useOverlayEscape`'s
   * stack, which puts this above the viewer or the card it was opened from.
   */
  useDismissOnOutside(panel, onClose, { onEscape: true })

  /*
   * Pass one. In a layout effect rather than an effect: this runs in the commit that put the map
   * on screen, and a rect read a frame later is a rect read after the reader has seen an
   * unlabelled screen flash past.
   *
   * The resize is coalesced through `requestAnimationFrame`, `anatomyStage.ts`' arrangement:
   * every event here costs two forced layouts and three renders, and a drag-resize fires it
   * per frame — with the labels visibly snapping to the top-left in between, since `setPlaces`
   * has to clear.
   */
  useLayoutEffect(() => {
    let frame = 0
    const measure = () => {
      setPlaces(null)
      setFound(collect(spots, scope?.current ?? document))
    }
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [spots, scope])

  /*
   * Pass two: the labels exist now, at their own height. `found` is the dependency because a
   * resize replaces it, and a resize is exactly when every one of these has to be asked again.
   */
  useLayoutEffect(() => {
    if (!found) return
    const items: LabelBox[] = []
    for (const { spot, box } of found) {
      const node = labels.current.get(spot.id)
      if (!node) continue
      items.push({
        id: spot.id,
        side: spot.side,
        box,
        width: LABEL_W,
        height: node.getBoundingClientRect().height,
        region: spot.region,
        at: spot.at,
      })
    }
    const bar = panel.current?.getBoundingClientRect()
    const laid = placeLabels(
      items,
      layoutViewport(),
      bar ? [{ x: bar.left, y: bar.top, width: bar.width, height: bar.height }] : [],
    )
    setPlaces(new Map(laid.map((place) => [place.id, place])))
  }, [found])

  return (
    <div
      className="smap"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-hover={hot ? '' : undefined}
    >
      {/* Drawn, not just a dismissal region: it is what separates the labels from the app under
          them. The dismissal is `useDismissOnOutside`'s, so this takes no handler. */}
      <div className="smap__scrim" />

      {/*
        A region box is not a hover target, and its label is. The canvas's box is most of the
        window and the inspector's is a whole column of it, so a pointer over either is a pointer
        that is always on something — every other spot would spend its life dimmed. `screenMap.css`
        withholds the pointer from them; hovering the words "The canvas" lights the same triple.
      */}
      {found?.map(({ spot, box }) => (
        <div
          key={spot.id}
          className="smap__box"
          data-spot={spot.id}
          data-region={spot.region ? '' : undefined}
          data-hot={hot === spot.id ? '' : undefined}
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          {...(spot.region ? {} : hover(spot.id))}
        />
      ))}

      {places && places.size > 0 && (
        <svg className="smap__leaders" aria-hidden="true">
          {/* A region label has no leader — it sits in the thing it names. Skipped rather than
              drawn empty: an empty `points` renders nothing on screen and is a `NaN` to anything
              reading the attribute back, which is how the probe first reported every leader
              missing its label. */}
          {[...places.values()]
            .filter((place) => place.leader.length > 0)
            .map((place) => (
              <polyline
                key={place.id}
                data-spot={place.id}
                data-hot={hot === place.id ? '' : undefined}
                points={place.leader.map(([x, y]) => `${x},${y}`).join(' ')}
              />
            ))}
        </svg>
      )}

      {found?.map(({ spot }) => {
        const place = places?.get(spot.id)
        return (
          <div
            key={spot.id}
            ref={(node) => {
              labels.current.set(spot.id, node)
            }}
            className="smap__label"
            data-spot={spot.id}
            data-side={spot.side}
            data-hot={hot === spot.id ? '' : undefined}
            {...hover(spot.id)}
            /* Unplaced means "still being measured": parked at the top-left at its real width so
               the height that comes back is the height it will have. `visibility`, not `display`,
               or it has no height to measure at all. */
            style={
              place
                ? { left: place.x, top: place.y, width: LABEL_W }
                : { left: 0, top: 0, width: LABEL_W, visibility: 'hidden' }
            }
          >
            <strong>{spot.label}</strong>
            <span>{spot.note}</span>
          </div>
        )
      })}

      <div className="smap__panel" ref={panel}>
        <div className="smap__panelText">
          <strong>{title}</strong>
          <span>{text}</span>
        </div>
        <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>
          Done
        </button>
      </div>
    </div>
  )
}

export interface MapListProps {
  spots: readonly MapSpot[]
  title: string
  /** What sits above the list — including that a wider screen would draw it in place. */
  lede: string
  onClose: () => void
}

/**
 * The narrow shell's answer: the same spots, as a list.
 *
 * Not the map with smaller labels. Below 720px the toolbar has folded most of what the shell's map
 * names into `⋯`, so more than half the boxes would be missing — and a map with holes in it is
 * worse than a list, because the holes are invisible. Every spot is listed, including the ones
 * that are not on screen at this width, which is the one thing the list can do that the map
 * cannot. Same answer `nodeguide.css` gives the anatomy figure below its own breakpoint, for the
 * same reason: scaling a figure about small controls is how it becomes unreadable.
 */
export function MapList({ spots, title, lede, onClose }: MapListProps) {
  const sheet = useRef<HTMLDivElement>(null)
  useDismissOnOutside(sheet, onClose, { onEscape: true })
  return (
    <div className="smap smap--list" role="dialog" aria-modal="true" aria-label={title}>
      <div className="smap__scrim" />
      <div className="smap__sheet" ref={sheet}>
        <ModalHeader onClose={onClose}>{title}</ModalHeader>
        <p className="smap__lede">{lede}</p>
        <ul className="smap__rows">
          {spots.map((spot) => (
            <li key={spot.id}>
              <strong>{spot.label}</strong>
              <span>{spot.note}</span>
            </li>
          ))}
        </ul>
        <div className="smap__sheetFoot">
          <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
