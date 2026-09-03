/**
 * The canvas's add-node control: a **+** in the bottom-right corner that opens onto the six
 * categories, each of which opens onto its own nodes.
 *
 * ## Why a rail rather than one more door into the browser
 *
 * The **+** used to open `NodeBrowser` outright — one modal, a search box and 91 rows. That is
 * the right surface for "what can I add?" and the wrong one for "add a Filter", which is most
 * of what anybody does with it: a modal takes the canvas away, and the thing being added is
 * almost always one of a handful in a category the reader already has in mind. Two clicks with
 * the graph still on screen is the shorter route, and the browser is still the rail's bottom
 * button for everything else.
 *
 * It is built out of the two tables that already exist rather than a third: `nodeDefsByCategory`
 * decides what is in a category and in what order, and `ui/glyphs.ts` draws every button —
 * `CATEGORY_GLYPHS` for the rail, one drawing per node type for the band. So a node registered
 * next month appears here with a picture and no edit, which is the property `NodeThumbnail`
 * already has and the reason its `nodeGlyph` is exported rather than re-implemented.
 *
 * ## The rules that are not obvious
 *
 * **The band runs along the bottom and wraps upward, not out from the button in one row.**
 * Transform holds 25 nodes and Visualisation 18; a single row hanging off the corner runs off
 * the left edge of every window narrower than about 2,000px, and the fix for that is either a
 * scroll nobody can see the end of or a cap that hides nodes. Wrapping shows every node in the
 * category at once and degrades by getting taller, which is visible. What keeps it *attached* to
 * the button it came from is the other two rules: the bottom row is aligned with that button by
 * measurement, and the fill starts at the button's own end of it and snakes back.
 *
 * **The alignment is measured, never re-derived.** Where a category button sits is the stack's
 * arithmetic — an inset, the **+**, a gap, and *n* buttons of whatever size — and all of it
 * lives in `editor.css`. Restating it here would be a second spelling that agrees until somebody
 * changes a gap, so the button is asked for its rect instead. `BAND` is the converse and the
 * same rule: the few numbers both languages need are declared here and handed to the stylesheet
 * as custom properties.
 *
 * **A closed surface is unmounted, not hidden.** `usePresence` keeps it mounted for the length
 * of its exit animation and no longer, so a closed rail has no buttons in the accessibility
 * tree, no tab stops and nothing for a test to find. `visibility: hidden` would do the first
 * three in a browser and none of them under jsdom, which computes no styles — the test would
 * then pass while asserting the opposite of what ships.
 *
 * **The animation is `@keyframes`, not a transition.** A transition needs a previous computed
 * style to animate from, and these elements are mounting: they would appear at their final
 * position with the delay wasted. `backwards` fill is what makes the stagger hold each button
 * at its start state until its turn.
 *
 * **`column-reverse` draws the first child last.** The **+** is written first in the source
 * below and drawn at the bottom; so is the rail's browse button, which is why it ends up nearest
 * the **+**. Backwards, the whole stack hangs off the wrong end of the corner — which is what it
 * did, in Chrome, the first time it was rendered.
 *
 * The class prefix is `fab-menu` and not `add-menu`, which reads better and is taken: the
 * command palette has owned that namespace — `add-menu__name` included — since it was the
 * `+ Add` menu. Two blocks under one prefix is one stylesheet edit reaching a surface nobody
 * was looking at, and `.add-menu` in a test already resolved to the wrong element once.
 *
 * The container's `data-open` exists for one CSS rule and is worth reading before removing:
 * the feedback nudge is `z-index: 50` and parks itself in the gap **above** the closed button,
 * which is precisely where the rail unfolds. Open, this has to win; closed, the two do not
 * overlap and the order is nobody's business.
 *
 * `data-tour="add"` sits on the stack rather than on the button, because `tour.css` restores
 * pointer events to the spotlit element **and its subtree**: anchored on the button, the rail
 * it opens would be inert for the length of the step that asks the reader to open it. The band
 * is a *sibling* of the stack and so outside that subtree, which is why "Learn to Build" walks
 * the menu in three steps anchored on three surfaces rather than one — see `tour/build.ts`.
 *
 * **The open state is the store's**, not this component's: the feedback nudge reads it, and the
 * tour drives it. `setAddMenu` carries that reasoning.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { NodeCategory, NodeDefinition } from '../../core/node'
import { nodeDefsByCategory } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { CATEGORY_GLYPHS, GLYPH_STROKE_WIDTH, GLYPH_VIEWBOX } from '../glyphs'
import type { GlyphShape } from '../glyphs'
import { glyphElements } from '../glyphElements'
import { LOCKED_HINT } from '../lockCopy'
import { nodeTintVar } from '../socketStyle'
import { useDismissOnOutside } from '../useDismiss'
import { CATEGORY_LABELS } from './categoryLabels'
import { nodeGlyph } from './NodeThumbnail'
import { GlyphSvg } from './startGlyphs'

export interface AddMenuProps {
  /** Frozen canvas: the **+** dims exactly as it did when it was a lone button. */
  locked: boolean
  /** Open the full node browser — the rail's bottom button. */
  onBrowse: () => void
  /** Insert a node. The caller decides where it lands; see `canvasAnchor` in `Editor.tsx`. */
  onAdd: (nodeType: string) => void
}

/**
 * Bottom-to-top order of the rail.
 *
 * A `Record` rather than an array so a seventh category is a type error here rather than a
 * silently missing button. The order is the registry's, with `utility` brought to the bottom:
 * the rail is read from the **+** upward, and the categories nearest the thumb are the ones a
 * reader reaches for without deciding — the browser, then the notes and loop plumbing.
 */
const RAIL_ORDER: Record<NodeCategory, number> = {
  utility: 0,
  dataset: 1,
  query: 2,
  transform: 3,
  analysis: 4,
  visualisation: 5,
}

/**
 * How long a closing surface stays mounted, and how long its exit animation runs — one number,
 * handed to the stylesheet as `--fab-out` below. It was two spellings for a while and they had
 * already drifted by 10ms, which is the whole of the argument for `BAND` doing the same thing.
 */
const EXIT_MS = 140

/**
 * The band's geometry, in px, and the one place it is written down.
 *
 * Both languages need it: TypeScript to decide how many buttons fit on a row and where the
 * bottom row has to sit, CSS to draw them. So it is declared here and handed to the stylesheet
 * as custom properties on the band element — a second copy in `editor.css` is two sets of
 * numbers that agree until one of them is edited, which is the arrangement `markGeometry.ts`
 * refused once already.
 *
 * `nodeHeight` is fixed rather than natural for the same reason: a label runs to one line or
 * two, so a row whose height is its content puts the discs of a one-line row and a two-line row
 * at different heights — and the alignment below is measured from the row's *bottom*.
 */
const BAND = {
  nodeWidth: 78,
  nodeHeight: 72,
  gap: 4,
  disc: 38,
  padTop: 4,
} as const

/** Bottom edge of the band to the centre of the bottom row's disc. */
const ROW_ANCHOR = BAND.nodeHeight - BAND.padTop - BAND.disc / 2

/** The band never sits lower than the **+** itself, whatever a measurement says. */
const MIN_BAND_BOTTOM = 20

/** How many buttons fit a row of this width. At least one, so an unmeasured band still draws. */
export function rowCapacity(width: number): number {
  return Math.max(1, Math.floor((width + BAND.gap) / (BAND.nodeWidth + BAND.gap)))
}

export interface BandRow {
  defs: NodeDefinition[]
  /** Index of the row's first node in the whole list — its key, and its stagger offset. */
  from: number
  /** Drawn right-to-left. True for the bottom row, then alternating. */
  reverse: boolean
}

/**
 * The band's rows, bottom first, alternating direction.
 *
 * The fill runs out from the category button along the bottom row, back along the row above it,
 * and out again — so `rows[0]` is drawn right-to-left, `rows[1]` left-to-right, and so on. Two
 * properties are the point and both are easy to lose. A **partial row keeps its own direction**,
 * which is what makes the last row continue the one below it from the side that one ended on
 * rather than float in the middle of the canvas — so the direction is the row's index, never
 * "whichever way the leftovers look better". And the chunks are the list **in order**, so the
 * DOM order stays alphabetical whatever the drawing does: the tab order, a screen reader and
 * every `getAllByRole` read the list rather than the shape.
 */
export function snakeRows(defs: readonly NodeDefinition[], perRow: number): BandRow[] {
  const rows: BandRow[] = []
  for (let from = 0; from < defs.length; from += perRow)
    rows.push({
      defs: defs.slice(from, from + perRow),
      from,
      reverse: (from / perRow) % 2 === 0,
    })
  return rows
}

/**
 * The numbers CSS needs from here, as one static object.
 *
 * `--band-bottom` is deliberately *not* in it: that one is measured, and it is painted straight
 * onto the element rather than routed through state — `DashboardView`'s rule for `--dash-row`,
 * and for its reason, since it changes on every frame of a resize and React reads it never.
 */
const FAB_VARS = {
  '--node-w': `${BAND.nodeWidth}px`,
  '--node-h': `${BAND.nodeHeight}px`,
  '--node-gap': `${BAND.gap}px`,
  '--disc': `${BAND.disc}px`,
  '--node-pad': `${BAND.padTop}px`,
  '--fab-out': `${EXIT_MS}ms`,
} as React.CSSProperties

/** One handler for every button here: none of them wants the pane behind it to see the press. */
const stopPointer = (event: React.PointerEvent) => event.stopPropagation()

/*
 * `memo`, and the reason is the canvas rather than this component: `EditorCanvas` subscribes to
 * the graph and re-renders on every mutation *and* on every pointer move of a node drag. All
 * three props are stable — a primitive and two `useCallback`s — so the whole subtree, up to 25
 * buttons and their SVGs while a band is open, stays out of that hot path.
 */
export const AddMenu = memo(function AddMenu({ locked, onBrowse, onAdd }: AddMenuProps) {
  /*
   * The menu's state is the store's, not this component's — see `setAddMenu` there for the two
   * readers that put it there. Primitives, so the snapshot identity check is satisfied
   * (invariant 7).
   */
  const open = useGraphStore((s) => s.addMenuOpen)
  const category = useGraphStore((s) => s.addMenuCategory)
  const setAddMenu = useGraphStore((s) => s.setAddMenu)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setAddMenu(false), [setAddMenu])

  // Escape and a pointer anywhere else — the canvas included, which is the "click away to
  // dismiss without adding anything" half of the gesture. Capture phase, so it beats the
  // click handler on whatever was pressed. Bound only while something is open.
  useDismissOnOutside(rootRef, close, { onEscape: true, enabled: open })

  // The lock arriving with the menu up would leave a rail of buttons that all refuse.
  useEffect(() => {
    if (locked) close()
  }, [locked, close])

  /*
   * `nodeDefsByCategory` and not a module-level constant: the registry is filled by an import
   * side effect (`src/nodes`), and a table built at this module's own init time would be empty
   * for whichever import order a future entry point happens to have.
   */
  const groups = useMemo(
    () => nodeDefsByCategory().sort((a, b) => RAIL_ORDER[a.category] - RAIL_ORDER[b.category]),
    [],
  )
  /*
   * The category the band is *showing*, which outlives the one that is open by the length of the
   * exit animation — so it empties on the way out rather than the moment it is dismissed. Held as
   * the category and not as the group, because then one hook covers both surfaces and the group
   * is a lookup: a second presence flag beside a remembered value is two facts that can drift.
   */
  const held = useHeld(category, EXIT_MS)
  const band = groups.find((group) => group.category === held)
  const railMounted = useHeld(open || null, EXIT_MS) !== null

  /*
   * Where the band sits and how wide a row may be — **measured**, never re-derived.
   *
   * The bottom row lines its discs up with the category button it came out of, and that button's
   * position is the rail's arithmetic: a stack inset, the **+**, a gap, and however many buttons
   * of whatever size sit below it. All of that lives in `editor.css`; a copy of it here would be
   * a second spelling that agrees until somebody changes a gap. So the button is asked where it
   * is, against the container both are inside.
   *
   * `useLayoutEffect` rather than `useEffect`: this runs before paint, so the first render's
   * unmeasured band — every button on a row of its own — is never on screen. The observer is on
   * the container, which is the canvas, so a window resize re-wraps and re-aligns.
   *
   * **Only the row capacity is state.** The offset is painted straight onto the element, which is
   * `DashboardView`'s rule for `--dash-row` and for the same reason: this fires on every frame of
   * a resize, React never reads the number, and a `setState` per frame re-renders every button in
   * the band. The capacity is a small integer, so an ordinary drag re-renders only when it
   * crosses a column boundary — which is exactly when the rows really do change.
   */
  const bandRef = useRef<HTMLDivElement>(null)
  const [perRow, setPerRow] = useState(1)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !category) return
    const measure = () => {
      // `.fab-menu__cat` and not `[data-cat]` alone: the band is written *before* the stack, so
      // a root-scoped attribute lookup returns whatever is first in document order. The band
      // carrying a category of its own once made this measure the band against itself — a wrong
      // number rather than an error, and the alignment silently went with it.
      const button = root.querySelector(`.fab-menu__cat[data-cat="${category}"]`)
      const band = bandRef.current
      if (!button || !band) return
      const rect = button.getBoundingClientRect()
      const offset = root.getBoundingClientRect().bottom - (rect.top + rect.height / 2)
      band.style.setProperty(
        '--band-bottom',
        `${Math.max(MIN_BAND_BOTTOM, offset - ROW_ANCHOR)}px`,
      )
      setPerRow(rowCapacity(band.clientWidth))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [category])

  const rows = useMemo(() => snakeRows(band?.defs ?? [], perRow), [band, perRow])

  return (
    <div className="fab-menu" ref={rootRef} data-open={open} style={FAB_VARS}>
      {band && (
        <div
          className="fab-menu__band"
          ref={bandRef}
          data-band={band.category}
          data-open={category !== null}
          role="group"
          aria-label={`${CATEGORY_LABELS[band.category]} nodes`}
        >
          {rows.map((row) => (
            // `from` and not the array index: a key has to survive the re-chunk a resize does.
            <div className="fab-menu__row" key={row.from} data-reverse={row.reverse}>
              {row.defs.map((def, index) => (
                <NodeButton
                  key={def.type}
                  def={def}
                  index={row.from + index}
                  onClick={() => {
                    onAdd(def.type)
                    close()
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="fab-menu__stack" data-tour="add">
        <button
          type="button"
          className="add-fab nodrag"
          data-open={open}
          onClick={() => setAddMenu(!open)}
          disabled={locked}
          title={locked ? LOCKED_HINT : 'Add a node — by category, or browse everything (Tab)'}
          aria-label="Add a node"
          aria-expanded={open}
          onPointerDown={stopPointer}
        >
          {/* One drawing, rotated by CSS: a + turned 45° is the × that closes it, and the turn
              is what says the two are the same control rather than two buttons in one place. */}
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
            <path
              d="M12 5v14M5 12h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {railMounted && (
          <div className="fab-menu__rail" data-open={open}>
            <RailButton
              index={0}
              label="Browse all nodes"
              shapes={BROWSE_GLYPH}
              onClick={() => {
                close()
                onBrowse()
              }}
            />
            {groups.map((group, index) => (
              <RailButton
                key={group.category}
                index={index + 1}
                label={`${CATEGORY_LABELS[group.category]} nodes`}
                shapes={CATEGORY_GLYPHS[group.category]}
                tint={`var(--cat-${group.category})`}
                category={group.category}
                pressed={category === group.category}
                onClick={() =>
                  setAddMenu(true, category === group.category ? null : group.category)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

/** A round, wordless button in the rail. The name is in `title` and `aria-label` only. */
function RailButton({
  index,
  label,
  shapes,
  tint,
  category,
  pressed,
  onClick,
}: {
  index: number
  label: string
  shapes: readonly GlyphShape[]
  tint?: string
  /** Absent on the browser button. It is what the band's alignment measures against. */
  category?: NodeCategory
  pressed?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="fab-menu__cat nodrag"
      style={{ '--i': index, '--tint': tint } as React.CSSProperties}
      title={label}
      aria-label={label}
      data-cat={category}
      aria-pressed={pressed}
      onClick={onClick}
      onPointerDown={stopPointer}
    >
      <Glyph shapes={shapes} />
    </button>
  )
}

/** A node in the band: the same circle, with the node's name in small muted text under it. */
function NodeButton({
  def,
  index,
  onClick,
}: {
  def: NodeDefinition
  index: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="fab-menu__node nodrag"
      style={
        {
          '--i': index,
          // The same ladder the thumbnail two clicks away resolves, rather than the category
          // token alone: a dataset node wears its *backend's* tint on its card, and the band
          // colouring it generically would be the two surfaces disagreeing about one node.
          '--tint': nodeTintVar(def.type, `var(--cat-${def.category})`),
        } as React.CSSProperties
      }
      title={def.description ?? def.label}
      onClick={onClick}
      onPointerDown={stopPointer}
    >
      <span className="fab-menu__disc" aria-hidden="true">
        <Glyph>{nodeGlyph(def.type, def.category)}</Glyph>
      </span>
      <span className="fab-menu__name">{def.label}</span>
    </button>
  )
}

/**
 * One glyph, sized by CSS.
 *
 * `GlyphSvg` is the app's one drawing box and exists precisely so the seven attributes are not
 * transcribed again; the weight is `GLYPH_STROKE_WIDTH` rather than its 1.4 default because a
 * dataset silhouette's own scaling group puts that number back, and the twelve connectomes would
 * otherwise draw heavier than every other node in the band. Shapes or elements: the rail passes
 * a table out of `glyphs.ts`, the band passes `nodeGlyph`'s already-built elements.
 */
function Glyph({ shapes, children }: { shapes?: readonly GlyphShape[]; children?: ReactNode }) {
  return (
    <GlyphSvg
      viewBox={GLYPH_VIEWBOX}
      className="fab-menu__glyph"
      strokeWidth={GLYPH_STROKE_WIDTH}
    >
      {shapes ? glyphElements(shapes) : children}
    </GlyphSvg>
  )
}

/**
 * The browser's own mark: four tiles, i.e. a grid of everything.
 *
 * Drawn here rather than in `glyphs.ts` because that table is one drawing per *node type* and
 * per category, and a button that opens a dialog is neither — an entry there would be the one
 * key in the table that no node can ever resolve to.
 */
const BROWSE_GLYPH: readonly GlyphShape[] = [
  ['rect', { x: '4', y: '4', width: '7', height: '7', rx: '1.6' }],
  ['rect', { x: '13', y: '4', width: '7', height: '7', rx: '1.6' }],
  ['rect', { x: '4', y: '13', width: '7', height: '7', rx: '1.6' }],
  ['rect', { x: '13', y: '13', width: '7', height: '7', rx: '1.6' }],
]

/**
 * Hold a value for `ms` after it goes `null`, so a closing surface can animate out.
 *
 * The alternative — mounting it always and hiding it — is what makes a closed menu's buttons
 * findable by tests and by a screen reader in every environment that does not compute styles.
 *
 * A value rather than a boolean because the band needs both halves at once ("is it up" and "what
 * was in it"), and two hooks answering those separately is two facts that can disagree. The rail,
 * which only needs the first, passes `open || null` and asks whether the answer is null.
 */
function useHeld<T>(value: T | null, ms: number): T | null {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    if (value !== null) {
      setHeld(value)
      return
    }
    const timer = window.setTimeout(() => setHeld(null), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return value ?? held
}
