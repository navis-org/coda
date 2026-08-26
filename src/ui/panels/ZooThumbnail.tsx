/**
 * A Zoo entry's card art: the workflow's own shape, drawn from the layout digest in the index.
 *
 * The alternative was the glyph the start page uses for an example — `tileNode` picks the last
 * visualisation node and draws its category art. That is right there, where five cards sit
 * beside five different pictures. It fails in a browser of a hundred community workflows, where
 * most chains end in a table or a network plot and the rail becomes rows of the same icon.
 *
 * So the card draws the pipeline: a box per node in its real canvas position, a line per wire,
 * tinted by the same `--cat-*` tokens the node headers use. It is recognisable at 200 px in the
 * way a minimap is — you cannot read it, but you can see a two-branch join, a long linear chain
 * and a fan-out, and those are the differences worth seeing before you open something.
 *
 * **Three decisions that each look like a detail:**
 *
 * *Notes are excluded.* A workflow's text notes sit above and below the pipeline and are wider
 * than it — `examples/index.ts` places them across several columns on purpose. Included in the
 * bounds, they push the actual chain into a thin band across the middle, so the picture becomes
 * mostly empty rectangle. The card is about the pipeline; the README is where the prose is.
 *
 * *The node's size is not in the digest, and is not guessed per type either.* Every box is the
 * same nominal card. At this scale the real widths differ by a few pixels, and reading
 * `NODE_BODIES` here would make the art depend on a table that exists for the canvas.
 *
 * *An unregistered type still draws*, in the neutral border colour — `nodeTintVar`'s fallback.
 * That is registry drift made visible rather than silent: a workflow deposited against a node
 * this build no longer has should look like something is missing, because something is.
 */

import { useMemo } from 'react'

import { getNodeDef, isAnnotation } from '../../core/registry'
import type { ZooLayout } from '../../data/zoo/format'
import { filterLayout } from '../../data/zoo/format'
import { CHART_INK } from '../colors'
import { nodeTintVar } from '../socketStyle'

/**
 * Read off `dark` and used in both themes, which is not a shortcut: `muted` is the one ink that
 * is identical in the two palettes — achromatic, 4.9:1 dark and 3.5:1 light — precisely so it
 * never competes with a categorical encoding. `encoding.ts` pins it the same way.
 */
const WIRE = CHART_INK.dark.muted

/** The nominal card, in flow units: `--node-width` and about the height of a two-param node. */
const NODE_W = 232
const NODE_H = 132
/**
 * Wire thickness, also in flow units, so it scales with the drawing rather than with the card.
 *
 * A tenth of a node's width, which is far heavier than a wire on the real canvas and is the
 * point: at 128px the whole viewBox is ~2500 units wide, so the canvas's own stroke lands under
 * half a pixel and the picture becomes a row of disconnected boxes. Measured in a browser, not
 * guessed — the first value drawn here was 10 and it was invisible in both themes.
 */
const WIRE_W = 24
/** Breathing room around the drawing, as a fraction of the larger dimension. */
const PAD = 0.06

export interface ZooThumbnailProps {
  layout: ZooLayout
  /** Rendered width in CSS pixels; the height follows from the aspect ratio the caller sets. */
  width?: number
  height?: number
}

interface Box {
  x: number
  y: number
  tint: string
  known: boolean
}

export function ZooThumbnail({ layout, width = 208, height = 116 }: ZooThumbnailProps) {
  const drawing = useMemo(() => {
    /*
     * Notes dropped through the same helper `parseZooIndex` uses, because dropping a node shifts
     * every index after it and an edge kept by its original index joins the wrong two boxes.
     */
    const kept = filterLayout(layout, ([, , type]) => !isAnnotation(type))
    if (kept.nodes.length === 0) return undefined

    /*
     * Bounds in one pass. Four `Math.min(...boxes.map(…))` calls were four throwaway arrays for
     * four numbers — and the spread form is also the one that blows the call stack on a large
     * array, which a digest will not reach but a reader should not have to check.
     */
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const boxes: Box[] = kept.nodes.map(([x, y, type]) => {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      return { x, y, tint: nodeTintVar(type), known: getNodeDef(type) !== undefined }
    })

    maxX += NODE_W
    maxY += NODE_H
    const pad = Math.max(maxX - minX, maxY - minY) * PAD

    return {
      boxes,
      wires: kept.edges,
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
    }
  }, [layout])

  if (!drawing) {
    return <div className="zoo-thumb zoo-thumb--empty" style={{ width, height }} aria-hidden />
  }

  return (
    <svg
      className="zoo-thumb"
      width={width}
      height={height}
      viewBox={drawing.viewBox}
      /*
       * Letterboxed rather than stretched. A wide chain squeezed into a square card is a
       * different graph — the whole value here is that the shape is recognisable.
       */
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${drawing.boxes.length} nodes`}
    >
      {/*
       * Wires under the boxes, and in `muted` rather than `grid`. `CHART_INK.grid` is 1.27:1
       * against the dark surface — invisible by design, and correct for chrome. A wire carries
       * the structure this picture is *for*, so it takes the achromatic 4.9:1 ink instead. See
       * the palette note in CLAUDE.md.
       */}
      <g stroke={WIRE} strokeWidth={WIRE_W} strokeLinecap="round" fill="none">
        {drawing.wires.map(([from, to]) => {
          const a = drawing.boxes[from]!
          const b = drawing.boxes[to]!
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x + NODE_W}
              y1={a.y + NODE_H / 2}
              x2={b.x}
              y2={b.y + NODE_H / 2}
            />
          )
        })}
      </g>
      {drawing.boxes.map((box, index) => (
        <rect
          key={index}
          x={box.x}
          y={box.y}
          width={NODE_W}
          height={NODE_H}
          rx={18}
          fill={box.tint}
          // An unknown type is hollow: the outline says a node was here, the absent fill says
          // this build cannot draw it.
          fillOpacity={box.known ? 0.85 : 0}
          stroke={box.known ? 'none' : WIRE}
          strokeWidth={box.known ? 0 : WIRE_W * 0.8}
          strokeDasharray={box.known ? undefined : '20 16'}
        />
      ))}
    </svg>
  )
}
