/**
 * A miniature of a node, for the add-node browser.
 *
 * Everything here is derived from the `NodeDefinition`: the header tint comes from the
 * category, and the dots on each edge are the node's real ports, wearing the same colour
 * and shape grammar as sockets on the canvas. So a node added next year gets a correct
 * thumbnail for free, and the browser doubles as a way to learn the socket language.
 *
 * The centre glyph is one drawing **per node type**, from `ui/glyphs.ts` — which is also where
 * the grammar behind them is written down, and why the table is data rather than JSX. This file
 * only renders it: `glyphShapes` picks the drawing, falling back to the node's dataset
 * silhouette and then to its category, so a node added next month still gets a picture and the
 * browser never has a blank row.
 *
 * The dataset silhouette is asked for by *family*, not by node type. That is the one place this
 * component reaches past `NodeDefinition`, and it is the same rule the card body follows — see
 * `DatasetPreview.tsx` for why a glyph is a species and a coarse anatomical kind.
 */

import type { NodeCategory, NodeDefinition, PortDef } from '../../core/node'

import type { DatasetBackend } from '../../nodes/lib/datasetFamilies'
import {
  BACKENDS,
  backendForNodeType,
  familyForNodeType,
} from '../../nodes/lib/datasetFamilies'
import { GLYPH_BOX, GLYPH_STROKE_WIDTH, glyphShapes } from '../glyphs'
import { glyphElements } from '../glyphElements'
import { nodeTintVar, socketStyle } from '../socketStyle'
import type { SocketShape } from '../socketStyle'
import { plural } from '../format'
import { defaultInputPorts, defaultOutputPorts } from '../../core/ports'

const WIDTH = 78
const HEIGHT = 52
const HEADER_HEIGHT = 11
/** Beyond this the dots stop being legible; Adjacency's three inputs is the current max. */
const MAX_DOTS = 4

export interface NodeThumbnailProps {
  def: NodeDefinition
}

export function NodeThumbnail({ def }: NodeThumbnailProps) {
  // A type, not an instance: the arity a fresh node opens at. See `core/ports.ts`.
  const inputs = defaultInputPorts(def).slice(0, MAX_DOTS)
  const outputs = defaultOutputPorts(def).slice(0, MAX_DOTS)
  /*
   * A dataset tile is tinted by *backend*, matching its card. Falls through to the category
   * token for everything else, and for a backend nobody has styled yet. The fallback argument
   * never fires here — a thumbnail is built from a definition, so the type is registered by
   * construction — and is passed anyway so the expression says what it resolves to.
   */
  const backend = backendForNodeType(def.type)
  const tint = nodeTintVar(def.type, `var(--cat-${def.category})`)

  /*
   * An annotation is drawn as what it is on the canvas: a framed box of text, no header strip
   * and no sockets. Keyed off `def.annotation` rather than off the type, so the one property
   * that decides how the real card renders decides how its preview does too — a browser tile
   * that promised a node with ports would be lying about the thing it inserts.
   */
  if (def.annotation) {
    return (
      <svg
        className="node-thumb"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${def.label}: a text note, no ports`}
      >
        <rect
          x={0.9}
          y={0.9}
          width={WIDTH - 1.8}
          height={HEIGHT - 1.8}
          rx={3}
          fill="var(--note-surface)"
          stroke="var(--note-border)"
          strokeWidth={1.8}
        />
        <CategoryGlyph def={def} />
      </svg>
    )
  }

  return (
    <svg
      className="node-thumb"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${def.label}: ${plural(inputs.length, 'input')}, ${plural(outputs.length, 'output')}`}
    >
      {/* Card body */}
      <rect
        x={0.75}
        y={0.75}
        width={WIDTH - 1.5}
        height={HEIGHT - 1.5}
        rx={4}
        fill="var(--surface-2)"
        stroke="var(--border-strong)"
        strokeWidth={1}
      />
      {/* Header strip, tinted by category — the same cue as the real node header. */}
      <path
        d={`M0.75 4.75a4 4 0 0 1 4-4h${WIDTH - 9.5}a4 4 0 0 1 4 4v${HEADER_HEIGHT - 4}H0.75z`}
        fill={tint}
        fillOpacity={0.5}
      />
      <line
        x1={0.75}
        x2={WIDTH - 0.75}
        y1={HEADER_HEIGHT}
        y2={HEADER_HEIGHT}
        stroke="var(--border)"
        strokeWidth={1}
      />

      <CategoryGlyph def={def} />
      {backend && <BackendMark backend={backend} />}

      {inputs.map((port, index) => (
        <SocketDot key={`in-${port.id}`} port={port} x={1} y={dotY(index, inputs.length)} />
      ))}
      {outputs.map((port, index) => (
        <SocketDot
          key={`out-${port.id}`}
          port={port}
          x={WIDTH - 1}
          y={dotY(index, outputs.length)}
        />
      ))}
    </svg>
  )
}

/** Spread dots evenly through the body, below the header. */
function dotY(index: number, count: number): number {
  const top = HEADER_HEIGHT + 7
  const bottom = HEIGHT - 7
  if (count <= 1) return (top + bottom) / 2
  return top + (index * (bottom - top)) / (count - 1)
}

function SocketDot({ port, x, y }: { port: PortDef; x: number; y: number }) {
  const { family, shape } = socketStyle(port.type)
  const color = `var(--socket-${family === 'any' ? 'scalar' : family})`
  return renderShape(shape, x, y, color)
}

function renderShape(shape: SocketShape, x: number, y: number, color: string) {
  const stroke = 'var(--surface-2)'
  switch (shape) {
    case 'ring':
      return (
        <circle cx={x} cy={y} r={3.4} fill="var(--surface-2)" stroke={color} strokeWidth={2} />
      )
    case 'diamond':
      return (
        <rect
          x={x - 3}
          y={y - 3}
          width={6}
          height={6}
          rx={1}
          fill={color}
          stroke={stroke}
          strokeWidth={1}
          transform={`rotate(45 ${x} ${y})`}
        />
      )
    case 'square':
      return (
        <rect
          x={x - 3}
          y={y - 3}
          width={6}
          height={6}
          rx={1}
          fill={color}
          stroke={stroke}
          strokeWidth={1}
        />
      )
    case 'dot':
      return <circle cx={x} cy={y} r={2.4} fill={color} />
    default:
      return <circle cx={x} cy={y} r={3.6} fill={color} stroke={stroke} strokeWidth={1} />
  }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/**
 * The glyph a node type draws, unpositioned, so another surface can render it at its own size.
 * Exported rather than duplicated: tile art that gets redrawn per surface is art that
 * eventually disagrees with itself. The start page's example tiles use this.
 */
export function nodeGlyph(type: string, category: NodeCategory): React.ReactElement {
  return <>{glyphElements(glyphShapes(type, category, familyForNodeType(type)?.glyph))}</>
}

function CategoryGlyph({ def }: { def: NodeDefinition }) {
  const size = 22
  const x = (WIDTH - size) / 2
  // Centred in whatever the card actually is: an annotation has no header strip to sit under.
  const top = def.annotation ? 0 : HEADER_HEIGHT
  const y = top + (HEIGHT - top - size) / 2

  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / GLYPH_BOX})`}
      fill="none"
      stroke="currentColor"
      strokeWidth={GLYPH_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="node-thumb__glyph"
    >
      {nodeGlyph(def.type, def.category)}
    </g>
  )
}

/**
 * Which pip a backend lights, derived from `BACKENDS` rather than restated.
 *
 * That table's comment promises a fourth backend is "one entry here rather than four edits spread
 * across the UI", and a second map keyed by the same ids in a second file was the fourth edit.
 */
const BACKEND_IDS = Object.keys(BACKENDS)

/**
 * A small mark on a dataset tile saying which backend serves it.
 *
 * Colour is never the only channel here — the socket palette's rule — and this is the non-colour
 * half of it in the one surface where the node's *name* is small: a browser grid shows dozens of
 * tiles at once, and two greens a stop apart are a weaker signal at that size than on a card.
 *
 * Pips rather than a letter, because the tile is 22px of glyph and a legible letter would compete
 * with it. One lit pip in a fixed slot, so the mark is positional rather than a count to read.
 */
function BackendMark({ backend }: { backend: DatasetBackend }) {
  // Always found: `backend` only ever arrives from `backendForNodeType`, which returns values out
  // of the very table `BACKEND_IDS` is the keys of.
  const slot = BACKEND_IDS.indexOf(backend.id)
  const gap = 4.4
  const right = WIDTH - 6
  return (
    <g aria-hidden="true">
      {BACKEND_IDS.map((_id, i) => (
        <circle
          key={i}
          cx={right - (BACKEND_IDS.length - 1 - i) * gap}
          cy={HEADER_HEIGHT / 2}
          r={1.6}
          fill="var(--text-inverse)"
          opacity={i === slot ? 0.95 : 0.25}
        />
      ))}
    </g>
  )
}
