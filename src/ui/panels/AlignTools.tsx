/**
 * Align and distribute, as a grid of icons inside a context menu.
 *
 * **Icons rather than eight menu rows**, on the swatch row's precedent one menu over: an
 * alignment *is* a picture, "Align left edges" is four words for a thing one glyph says, and
 * eight rows would double the length of a menu whose other half is about running a node. Every
 * button still carries its name in `title` and `aria-label`, which is the rule `Icons.tsx`
 * states: an icon-only control with neither is a control only its author can use.
 *
 * **The menu deliberately stays open.** Every other row here closes on click, because every
 * other row is a single decision; alignment is not — "align their left edges, then even the
 * vertical gaps" is one thought and two presses, and a menu that vanished after the first would
 * make the second a fresh right-click on a card that had just moved.
 *
 * The arithmetic is `layout/align.ts` and the commit is `moveNodes(moves, true)` — the *drag*
 * path rather than `arrangeNodes`, so an alignment ends auto-layout and becomes one undo step,
 * exactly as dragging the cards there by hand would. Sizes come from `measureCardSizes`, read at
 * click time: four of the six edges are meaningless without them, and a menu is not where a
 * measurement should be cached.
 */

import type { Move } from '../../layout/align'
import { MIN_ALIGN, MIN_DISTRIBUTE, alignNodes, distributeNodes } from '../../layout/align'
import { useGraphStore } from '../../store/graphStore'
import { measureCardSizes } from '../cardSizes'
import { LOCKED_HINT } from '../lockCopy'

/**
 * The glyphs, on a 16-unit grid.
 *
 * Each one draws the *rule* the cards are brought onto — a line at the edge in question — and
 * two bars of different lengths against it, because bars of one length would draw a picture in
 * which left, centre and right are the same operation. The distribute pair has no rule and three
 * bars instead: what it is about is the space between them, so the space is what varies.
 */
const RULE = { fill: 'currentColor', opacity: 0.55 }
const BAR = { fill: 'currentColor', opacity: 0.85 }

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

interface Tool {
  id: string
  label: string
  hint: string
  icon: React.ReactNode
  run: (nodes: Parameters<typeof alignNodes>[0], measured: ReturnType<typeof measureCardSizes>) => Move[]
  /** How many cards it takes to mean anything. */
  min: number
}

const TOOLS: Tool[][] = [
  [
    {
      id: 'align-left',
      label: 'Align left edges',
      hint: 'Every card onto the leftmost edge in the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'left'),
      icon: (
        <Glyph>
          <rect x="1" y="2" width="1.4" height="12" {...RULE} />
          <rect x="4" y="3.5" width="10" height="3.2" {...BAR} />
          <rect x="4" y="9.3" width="6" height="3.2" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'align-centerX',
      label: 'Centre horizontally',
      hint: 'Every card onto the vertical centre line of the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'centerX'),
      icon: (
        <Glyph>
          <rect x="7.3" y="2" width="1.4" height="12" {...RULE} />
          <rect x="3" y="3.5" width="10" height="3.2" {...BAR} />
          <rect x="5" y="9.3" width="6" height="3.2" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'align-right',
      label: 'Align right edges',
      hint: 'Every card onto the rightmost edge in the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'right'),
      icon: (
        <Glyph>
          <rect x="13.6" y="2" width="1.4" height="12" {...RULE} />
          <rect x="2" y="3.5" width="10" height="3.2" {...BAR} />
          <rect x="6" y="9.3" width="6" height="3.2" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'distribute-x',
      label: 'Distribute horizontally',
      hint: 'Even the gaps left to right, leaving the outermost pair where they are',
      min: MIN_DISTRIBUTE,
      run: (nodes, measured) => distributeNodes(nodes, measured, 'x'),
      icon: (
        <Glyph>
          <rect x="1" y="3" width="2.6" height="10" {...BAR} />
          <rect x="6.7" y="3" width="2.6" height="10" {...BAR} />
          <rect x="12.4" y="3" width="2.6" height="10" {...BAR} />
        </Glyph>
      ),
    },
  ],
  [
    {
      id: 'align-top',
      label: 'Align top edges',
      hint: 'Every card onto the topmost edge in the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'top'),
      icon: (
        <Glyph>
          <rect x="2" y="1" width="12" height="1.4" {...RULE} />
          <rect x="3.5" y="4" width="3.2" height="10" {...BAR} />
          <rect x="9.3" y="4" width="3.2" height="6" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'align-centerY',
      label: 'Centre vertically',
      hint: 'Every card onto the horizontal centre line of the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'centerY'),
      icon: (
        <Glyph>
          <rect x="2" y="7.3" width="12" height="1.4" {...RULE} />
          <rect x="3.5" y="3" width="3.2" height="10" {...BAR} />
          <rect x="9.3" y="5" width="3.2" height="6" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'align-bottom',
      label: 'Align bottom edges',
      hint: 'Every card onto the lowest edge in the selection',
      min: MIN_ALIGN,
      run: (nodes, measured) => alignNodes(nodes, measured, 'bottom'),
      icon: (
        <Glyph>
          <rect x="2" y="13.6" width="12" height="1.4" {...RULE} />
          <rect x="3.5" y="2" width="3.2" height="10" {...BAR} />
          <rect x="9.3" y="6" width="3.2" height="6" {...BAR} />
        </Glyph>
      ),
    },
    {
      id: 'distribute-y',
      label: 'Distribute vertically',
      hint: 'Even the gaps top to bottom, leaving the outermost pair where they are',
      min: MIN_DISTRIBUTE,
      run: (nodes, measured) => distributeNodes(nodes, measured, 'y'),
      icon: (
        <Glyph>
          <rect x="3" y="1" width="10" height="2.6" {...BAR} />
          <rect x="3" y="6.7" width="10" height="2.6" {...BAR} />
          <rect x="3" y="12.4" width="10" height="2.6" {...BAR} />
        </Glyph>
      ),
    },
  ],
]

export interface AlignToolsProps {
  /** The cards to act on — the selection, or a group's members. */
  ids: readonly string[]
}

export function AlignTools({ ids }: AlignToolsProps) {
  const locked = useGraphStore((s) => s.locked)

  const apply = (tool: Tool) => {
    const store = useGraphStore.getState()
    const wanted = new Set(ids)
    // Graph order, not selection order: every one of these is a set operation, and two people
    // who selected the same cards in a different sequence must get the same answer.
    const nodes = store.graph.nodes.filter((n) => wanted.has(n.id))
    const moves = tool.run(nodes, measureCardSizes())
    // Nothing to do is *nothing to do*: `moveNodes` mints a fresh graph whatever it is handed,
    // so calling it here would leave an undo step for a press that changed no position.
    if (moves.length > 0) store.moveNodes(moves, true)
  }

  return (
    <div className="context-menu__tools" role="group" aria-label="Align and distribute">
      {TOOLS.map((row, index) => (
        <div className="context-menu__tool-row" key={index}>
          {row.map((tool) => {
            const tooShort = ids.length < tool.min
            return (
              <button
                key={tool.id}
                type="button"
                className="context-menu__tool"
                aria-label={tool.label}
                title={
                  locked
                    ? LOCKED_HINT
                    : tooShort
                      ? `${tool.label} — select at least ${tool.min} cards`
                      : `${tool.label}: ${tool.hint}`
                }
                disabled={locked || tooShort}
                onClick={() => apply(tool)}
              >
                {tool.icon}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
