/**
 * A miniature of a node, for the add-node browser.
 *
 * Everything here is derived from the `NodeDefinition`: the header tint comes from the
 * category, and the dots on each edge are the node's real ports, wearing the same colour
 * and shape grammar as sockets on the canvas. So a node added next year gets a correct
 * thumbnail for free, and the browser doubles as a way to learn the socket language.
 *
 * The centre glyph is keyed to the **category**, which is why six drawings cover every
 * node. `NODE_GLYPHS` overrides that for the viewers, whose identity genuinely *is* a visual
 * form (rows / grid / bars / node-link / skeleton) — a new visualisation node without an
 * override still gets the generic chart glyph rather than an empty box.
 *
 * All five overrides exist because the start page derives an example's tile art from the
 * graph's terminal viewer node: without them three of the five examples showed the same
 * generic bars.
 */

import type { NodeCategory, NodeDefinition, PortDef } from '../../core/node'
import { socketStyle } from '../socketStyle'
import type { SocketShape } from '../socketStyle'
import { plural } from '../format'

const WIDTH = 78
const HEIGHT = 52
const HEADER_HEIGHT = 11
/** Beyond this the dots stop being legible; Adjacency's three inputs is the current max. */
const MAX_DOTS = 4

export interface NodeThumbnailProps {
  def: NodeDefinition
}

export function NodeThumbnail({ def }: NodeThumbnailProps) {
  const inputs = (def.inputs ?? []).slice(0, MAX_DOTS)
  const outputs = (def.outputs ?? []).slice(0, MAX_DOTS)
  const tint = `var(--cat-${def.category})`

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

      {inputs.map((port, index) => (
        <SocketDot
          key={`in-${port.id}`}
          port={port}
          x={1}
          y={dotY(index, inputs.length)}
        />
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
 * Per-node overrides, used only where the node's whole point is a visual form. Anything
 * without an entry falls back to its category glyph, so this map is optional by design.
 */
const NODE_GLYPHS: Record<string, () => React.ReactElement> = {
  // Lines of prose, the last one short. A note's identity is a visual form too, and the utility
  // category's three dots would say "some tool" about the one node that is plainly not one.
  'note.text': () => (
    <>
      <line x1={4} y1={7} x2={20} y2={7} />
      <line x1={4} y1={12} x2={20} y2={12} />
      <line x1={4} y1={17} x2={13} y2={17} />
    </>
  ),
  'out.table': () => (
    <>
      <line x1={5} y1={7} x2={19} y2={7} />
      <line x1={5} y1={12} x2={19} y2={12} />
      <line x1={5} y1={17} x2={19} y2={17} />
    </>
  ),
  'out.heatmap': () => (
    <>
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={5 + col * 5}
            y={5 + row * 5}
            width={4}
            height={4}
            fill="currentColor"
            fillOpacity={0.25 + ((row + col) % 3) * 0.3}
            stroke="none"
          />
        )),
      )}
    </>
  ),
  'out.barChart': () => (
    <>
      <line x1={5} y1={5} x2={5} y2={19} />
      <line x1={7} y1={8} x2={19} y2={8} />
      <line x1={7} y1={12} x2={15} y2={12} />
      <line x1={7} y1={16} x2={11} y2={16} />
    </>
  ),
  // Axes with a cloud of marks, one of them square: a scatter's identity is the scatter of
  // points, and the odd mark is the shape channel saying it exists.
  'out.scatter': () => (
    <>
      <line x1={5} y1={5} x2={5} y2={19} />
      <line x1={5} y1={19} x2={19} y2={19} />
      <circle cx={9} cy={15} r={1.4} fill="currentColor" stroke="none" />
      <circle cx={12} cy={11} r={1.4} fill="currentColor" stroke="none" />
      <circle cx={11} cy={16} r={1.4} fill="currentColor" stroke="none" />
      <circle cx={16} cy={8} r={1.4} fill="currentColor" stroke="none" />
      <rect x={13.6} y={13.6} width={2.6} height={2.6} fill="currentColor" stroke="none" />
    </>
  ),
  'out.network': () => (
    <>
      <circle cx={6} cy={7} r={2.2} />
      <circle cx={18} cy={6} r={2.2} />
      <circle cx={12} cy={13} r={2.2} />
      <circle cx={6} cy={19} r={2.2} />
      <circle cx={18} cy={18} r={2.2} />
      <path d="M8 8l2.3 3.3M16 7.4l-2.4 3.9M10.2 14.4L7.6 17.4M13.9 14.5l2.6 2.4" />
    </>
  ),
  'out.viewer3d': () => (
    <>
      <path d="M12 21V9" />
      <path d="M12 12L7 7M12 15l5-4M12 9l-3-4M12 11l4-6" />
      <circle cx={7} cy={7} r={1.3} />
      <circle cx={17} cy={11} r={1.3} />
      <circle cx={9} cy={5} r={1.3} />
      <circle cx={16} cy={5} r={1.3} />
    </>
  ),
}

const CATEGORY_GLYPHS: Record<NodeCategory, () => React.ReactElement> = {
  // A stack of discs: a dataset.
  dataset: () => (
    <>
      <ellipse cx={12} cy={7} rx={7} ry={2.6} />
      <path d="M5 7v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V7" />
      <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
    </>
  ),
  // A magnifier: a search.
  query: () => (
    <>
      <circle cx={10.5} cy={10.5} r={5.5} />
      <line x1={14.5} y1={14.5} x2={19} y2={19} />
    </>
  ),
  // A funnel: rows in, fewer rows out.
  transform: () => <path d="M4 5h16l-6 7v7h-4v-7z" />,
  // A trend line: a computed result.
  analysis: () => <polyline points="4,18 9,11 14,14 20,5" />,
  // Generic chart, for a viewer with no specific glyph.
  visualisation: () => (
    <>
      <line x1={5} y1={19} x2={19} y2={19} />
      <rect x={6} y={11} width={3.5} height={8} fill="currentColor" stroke="none" />
      <rect x={11} y={7} width={3.5} height={12} fill="currentColor" stroke="none" />
      <rect x={16} y={14} width={3.5} height={5} fill="currentColor" stroke="none" />
    </>
  ),
  utility: () => (
    <>
      <circle cx={7} cy={12} r={1.6} fill="currentColor" stroke="none" />
      <circle cx={12} cy={12} r={1.6} fill="currentColor" stroke="none" />
      <circle cx={17} cy={12} r={1.6} fill="currentColor" stroke="none" />
    </>
  ),
}

/**
 * The glyph a node type draws, unpositioned, so another surface can render it at its own
 * size. Exported rather than duplicated: tile art that gets redrawn per surface is art that
 * eventually disagrees with itself. The start page's example tiles use this.
 */
export function nodeGlyph(type: string, category: NodeCategory): React.ReactElement {
  const draw = NODE_GLYPHS[type] ?? CATEGORY_GLYPHS[category]
  return draw()
}

function CategoryGlyph({ def }: { def: NodeDefinition }) {
  const size = 22
  const x = (WIDTH - size) / 2
  // Centred in whatever the card actually is: an annotation has no header strip to sit under.
  const top = def.annotation ? 0 : HEADER_HEIGHT
  const y = top + (HEIGHT - top - size) / 2

  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / 24})`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="node-thumb__glyph"
    >
      {nodeGlyph(def.type, def.category)}
    </g>
  )
}
