/**
 * The four layout buttons on the canvas controls rail.
 *
 * They live in the rail beside Zoom In / Zoom Out / Fit View rather than in the toolbar because
 * that is where the other things that move the *view* are, and because a control whose effect is
 * on the canvas belongs over the canvas. React Flow's `<Controls>` renders its children as
 * further `ControlButton`s, so this is four of those and a popover.
 *
 *   ⌗  arrange now         one pass, undoable, selection-aware
 *   ⟳  auto-layout         a mode; a drag or an open turns it off
 *   ⤳  wire routing        curved or orthogonal; see `EdgeRouting`
 *   ⚙  options             the bubble below
 *
 * Two kinds of control. Arrange is a verb and holds nothing; the other two are toggles and say
 * so with `aria-pressed` and an accent tint. Routing briefly had a third position and could not
 * honestly claim a pressed state then — that mode is gone, and `EdgeRouting` records why.
 */

import { useCallback, useRef, useState } from 'react'
import { ControlButton } from '@xyflow/react'

import type {
  EdgeRouting,
  LayoutAlgorithm,
  LayoutAlignment,
  LayoutDirection,
} from '../../layout/options'
import {
  LAYOUT_ALGORITHMS,
  LAYOUT_ALIGNMENTS,
  LAYOUT_DIRECTIONS,
  SPACING_RANGE,
} from '../../layout/options'
import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'

const ALGORITHM_LABELS: Record<LayoutAlgorithm, string> = {
  layered: 'Layered',
  force: 'Force',
  mrtree: 'Tree',
  radial: 'Radial',
}

const ALIGNMENT_LABELS: Record<LayoutAlignment, string> = {
  BRANDES_KOEPF: 'Balanced',
  LINEAR_SEGMENTS: 'Linear segments',
  SIMPLE: 'Simple',
}

/**
 * What each routing is called, and what it promises.
 *
 * The description is the second line of the button's tooltip and is the only place the trade is
 * stated on screen: `routed` leaves most wires curved, which looks like the setting only half
 * worked unless somebody has been told that a wire is bent exactly when ELK had to bend it.
 */
const ROUTING_LABELS: Record<EdgeRouting, { name: string; hint: string }> = {
  curved: { name: 'Curved', hint: 'Every wire is a curve.' },
  orthogonal: {
    name: 'Orthogonal',
    hint: 'Right-angled steps — wires the last arrange routed follow the gaps it left them.',
  },
}

const DIRECTION_GLYPHS: Record<LayoutDirection, string> = {
  RIGHT: '→',
  DOWN: '↓',
  LEFT: '←',
  UP: '↑',
}

/** Three cards and a wire — the same thing the button does, drawn small. */
function ArrangeIcon() {
  return (
    <svg className="layout-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="0.5" y="5.5" width="4" height="5" rx="1" />
      <rect x="11.5" y="1.5" width="4" height="5" rx="1" />
      <rect x="11.5" y="9.5" width="4" height="5" rx="1" />
      <path d="M4.5 8h3.5V4h3.5M8 8v4h3.5" strokeLinecap="round" />
    </svg>
  )
}

/** The same cards, with the arrow that says it keeps happening. */
function AutoLayoutIcon() {
  return (
    <svg className="layout-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="0.5" y="5.5" width="4" height="5" rx="1" />
      <rect x="11.5" y="9.5" width="4" height="5" rx="1" />
      <path d="M4.5 8h3.5v4h3.5" strokeLinecap="round" />
      <path
        d="M14.2 5.6A4 4 0 0 0 7.6 3.2M7.4 1.2v2.2h2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A wire doing what the current routing does to it — a curve, or a right-angled step.
 *
 * The drawing changes with the mode rather than only the tint, because a toggle whose two states
 * differ by a background colour says nothing about *what* it toggles. The two cards stay put
 * across both, so the only thing that moves is the wire.
 */
function RoutingIcon({ routing }: { routing: EdgeRouting }) {
  return (
    <svg className="layout-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="0.5" y="1.5" width="4" height="4" rx="1" />
      <rect x="11.5" y="10.5" width="4" height="4" rx="1" />
      {routing === 'curved' ? (
        <path d="M4.5 3.5C9 3.5 7 12.5 11.5 12.5" strokeLinecap="round" />
      ) : (
        <path d="M4.5 3.5h3.5v9h3.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

function OptionsIcon() {
  return (
    <svg className="layout-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.6" data-fill="" />
      <circle cx="10.5" cy="8" r="1.6" data-fill="" />
      <circle cx="6.5" cy="12" r="1.6" data-fill="" />
    </svg>
  )
}

export function LayoutControls({ onArrange }: { onArrange: () => void }) {
  const autoLayout = useGraphStore((s) => s.autoLayout)
  const setAutoLayout = useGraphStore((s) => s.setAutoLayout)
  const edgeRouting = useGraphStore((s) => s.edgeRouting)
  const toggleEdgeRouting = useGraphStore((s) => s.toggleEdgeRouting)
  const options = useGraphStore((s) => s.layoutOptions)
  const setLayoutOptions = useGraphStore((s) => s.setLayoutOptions)
  // Primitives, not the whole selection array — this only asks whether the button is scoped.
  const scoped = useGraphStore((s) => s.selection.length >= 2)

  const [open, setOpen] = useState(false)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismissOnOutside(bubbleRef, close, { onEscape: true, enabled: open })

  const layered = options.algorithm === 'layered'
  const orthogonal = edgeRouting === 'orthogonal'

  return (
    <>
      <ControlButton
        onClick={onArrange}
        title={scoped ? 'Arrange the selected nodes' : 'Arrange all nodes'}
        aria-label={scoped ? 'Arrange the selected nodes' : 'Arrange all nodes'}
      >
        <ArrangeIcon />
      </ControlButton>

      <ControlButton
        onClick={() => setAutoLayout(!autoLayout)}
        className={autoLayout ? 'layout-toggle--on' : undefined}
        aria-pressed={autoLayout}
        title={
          autoLayout
            ? 'Auto-layout is on — dragging a node turns it off'
            : 'Re-arrange after every structural change'
        }
        aria-label="Auto-layout"
      >
        <AutoLayoutIcon />
      </ControlButton>

      {/*
       * Between the auto-layout toggle and the options bubble, because arranging is what makes it
       * worth more than a restyle: a wire the last arrange routed follows the gap ELK left it,
       * and everything else takes a plain step. It works with nothing arranged — that is the
       * whole reason the third mode was dropped — but it is *better* next to the buttons that
       * arrange, so it sits with them.
       */}
      <ControlButton
        onClick={toggleEdgeRouting}
        className={orthogonal ? 'layout-toggle--on' : undefined}
        aria-pressed={orthogonal}
        title={`Wires: ${ROUTING_LABELS[edgeRouting].name} — ${ROUTING_LABELS[edgeRouting].hint}`}
        aria-label={`Wire routing: ${ROUTING_LABELS[edgeRouting].name}`}
      >
        <RoutingIcon routing={edgeRouting} />
      </ControlButton>

      <div className="layout-options" ref={bubbleRef}>
        <ControlButton
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          aria-expanded={open}
          title="Layout options"
          aria-label="Layout options"
        >
          <OptionsIcon />
        </ControlButton>

        {open && (
          <div
            className="layout-bubble nodrag nowheel"
            role="group"
            aria-label="Layout options"
          >
            <label className="layout-bubble__row">
              <span>Algorithm</span>
              <select
                value={options.algorithm}
                onChange={(e) =>
                  setLayoutOptions({ algorithm: e.target.value as LayoutAlgorithm })
                }
              >
                {LAYOUT_ALGORITHMS.map((value) => (
                  <option key={value} value={value}>
                    {ALGORITHM_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>

            <div className="layout-bubble__row">
              <span id="layout-direction">Direction</span>
              <div
                className="layout-bubble__segments"
                role="group"
                aria-labelledby="layout-direction"
              >
                {LAYOUT_DIRECTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={options.direction === value}
                    aria-label={value}
                    onClick={() => setLayoutOptions({ direction: value })}
                  >
                    {DIRECTION_GLYPHS[value]}
                  </button>
                ))}
              </div>
            </div>

            <label className="layout-bubble__row">
              <span>Node gap</span>
              <input
                type="range"
                min={SPACING_RANGE.min}
                max={SPACING_RANGE.max}
                step={4}
                value={options.nodeSpacing}
                onChange={(e) => setLayoutOptions({ nodeSpacing: Number(e.target.value) })}
              />
              <output>{options.nodeSpacing}</output>
            </label>

            <label className="layout-bubble__row">
              <span>Layer gap</span>
              <input
                type="range"
                min={SPACING_RANGE.min}
                max={SPACING_RANGE.max}
                step={4}
                value={options.layerSpacing}
                onChange={(e) => setLayoutOptions({ layerSpacing: Number(e.target.value) })}
              />
              <output>{options.layerSpacing}</output>
            </label>

            {/*
             * Alignment is layered's own. Disabled rather than hidden on the other three, so the
             * bubble does not change height under the pointer and the control's absence has a
             * visible cause.
             */}
            <label className="layout-bubble__row" data-disabled={!layered ? 'true' : undefined}>
              <span>Alignment</span>
              <select
                value={options.alignment}
                disabled={!layered}
                title={layered ? undefined : 'Layered only'}
                onChange={(e) =>
                  setLayoutOptions({ alignment: e.target.value as LayoutAlignment })
                }
              >
                {LAYOUT_ALIGNMENTS.map((value) => (
                  <option key={value} value={value}>
                    {ALIGNMENT_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>

            <label className="layout-bubble__row layout-bubble__row--check">
              <input
                type="checkbox"
                checked={options.packComponents}
                onChange={(e) => setLayoutOptions({ packComponents: e.target.checked })}
              />
              <span>Pack disconnected parts</span>
            </label>

            <div className="layout-bubble__foot">
              <button type="button" className="btn" onClick={onArrange}>
                Arrange now
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
