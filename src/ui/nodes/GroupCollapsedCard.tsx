/**
 * What a collapsed group draws: the frame's outline at one card's size, with a mini-map of the
 * cards inside it and one socket a side.
 *
 * **This one *is* a React Flow node, and the frame it replaces deliberately is not.** That
 * inversion is the whole design and is worth stating plainly, because `GroupLayer`'s header
 * argues the opposite case at length. A frame is decoration drawn around cards that are
 * themselves nodes, so making it a node would re-base its members' positions — React Flow's
 * `parentId` makes a child's `position` relative to the parent, and this document's positions
 * are absolute in the exporters, the ELK pass, the splice hit test and every saved file. A
 * *collapsed* frame has no members on the canvas at all: it is a box wires arrive at, which is
 * exactly what a node is. Left in the viewport portal it would need hand-rolled edge geometry,
 * hand-rolled handles and a hand-rolled hit test for the two ends of every crossing wire.
 *
 * It is still not in the document. The pseudo card is minted per render from
 * `layout/collapse.ts`, `graph.nodes` never contains it, and nothing that walks the document —
 * the inspector, the scheduler, the exporters, `inferOutputs` — can see one. Three React Flow
 * flags keep it that way, and each closes a path that would otherwise reach the store with an id
 * naming nothing: `draggable` (the drag is ours, and it writes the *members*' positions),
 * `selectable` (selection is the members', so the box lights up when all of them are selected)
 * and `deletable` (⌫ over a box would ask the store to delete an id it does not have).
 *
 * ## The promoted controls
 *
 * A group may put any of its members' params on the box (`GraphGroup.exposed`), which is what
 * makes a folded group something you can still *drive*. Each row is the same `ParamField` the
 * card and the inspector draw, handed an `InferContext` built for its own node the way all three
 * existing surfaces build one — so a column picker on a promoted param resolves against that
 * node's input schema exactly as it does on the card — and writing through the same
 * `setParam(nodeId, …)`. One value, two editors: nothing about evaluation, the cache or the
 * provenance key is different, because nothing about the param is.
 *
 * The row's own markup is local, as the card's, the inspector's and the styling rail's each are —
 * four copies of a label and a field around one widget, which is the arrangement this codebase
 * already has. Its label is `Card · Param`, always qualified: two members exposing `Limit` is the
 * ordinary case, and a row that renamed itself when a second one appeared would be worse than one
 * that was always long.
 *
 * ## The mini-map
 *
 * One rect per member, at its real relative position, scaled to fit and tinted by category —
 * which is the same `--cat-*` a card wears in its header strip, so a folded group is recognisable
 * as *that* group by its shape and its colours before the title is read. Rects rather than
 * `glyphs.ts` drawings: at this scale a node glyph is a smudge, where a rectangle at the right
 * place still says how many cards there are and how they are arranged. Members are laid out with
 * a floor on each side, since a card 8 flow units wide at the fitted scale is invisible and a
 * group of one would otherwise draw nothing at all.
 */

import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { useMemo } from 'react'

import { makeInferContext } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import type { CodaType } from '../../core/types'
import type { CollapsedBox, ExposedControl } from '../../layout/collapse'
import { FALLBACK_NODE_SIZE } from '../../layout/elkGraph'
import type { COLLAPSED_TYPE } from '../../layout/collapse'
import {
  COLLAPSED_HEADER_HEIGHT,
  COLLAPSED_IN,
  COLLAPSED_OUT,
  COLLAPSED_RADIUS,
  COLLAPSED_ROWS_PADDING,
  COLLAPSED_ROW_HEIGHT,
  COLLAPSED_SIZE,
} from '../../layout/collapse'
import { useAnyNodeState, useGraphStore, useNodeStateCount } from '../../store/graphStore'
import { union } from '../../layout/place'
import { plural } from '../format'
import { useGroupDrag } from '../groupDrag'
import { NodeRunRing } from './NodeRunRing'
import { STATE_GLYPH } from './runState'
import { GroupTitleInput } from '../GroupTitle'
import { ParamField } from '../params/ParamField'

/**
 * The mini-map's inset inside the card, in card pixels.
 *
 * Published as `--collapsed-map-pad` with the other three: the SVG's width and height are
 * arithmetic from it here, and the margin that has to match is CSS's.
 */
const MAP_PAD = 8
/** No member is drawn thinner than this, however far the fit scales it down. */
const MIN_CELL = 3

/**
 * The most a member may be scaled by, as a fraction of a `FALLBACK_NODE_SIZE` card's width.
 *
 * A fit alone is wrong at the small end: one card in a frame fills the whole map with a single
 * block, which reads as a solid tile rather than as a drawing of one node, and two cards side by
 * side read as a group of forty. Capping the scale means a small group draws small and centred —
 * so the mini-map says *how much* is folded away as well as how it is arranged.
 */
const MAX_CELL = 42

export interface GroupCollapsedData {
  [key: string]: unknown
  box: CollapsedBox
  onContextMenu: (groupId: string, screenPosition: { x: number; y: number }) => void
}

export type GroupCollapsedNode = Node<GroupCollapsedData, typeof COLLAPSED_TYPE>

export function GroupCollapsedCard({ data }: NodeProps<GroupCollapsedNode>) {
  const { box, onContextMenu } = data
  const group = box.group
  // Renaming is the store's — `editingGroupId`, which the frame's outline reads too. It is not
  // in `data` because that would put it in `rfNodes`' dependencies, rebuilding every card on
  // the canvas whenever a rename started.
  const editing = useGraphStore((s) => s.editingGroupId) === group.id
  const editTitle = useGraphStore((s) => s.editGroupTitle)
  // What the member cards would have shown, said by the box instead. Two of the seven states,
  // and they are the two that are about *work*: one happening now, one that has already happened
  // and outlives the run that caused it. See `useNodeStateCount`.
  const running = useAnyNodeState(group.nodeIds, 'running')
  const failed = useNodeStateCount(group.nodeIds, 'error')
  const selection = useGraphStore((s) => s.selection)
  const toggle = useGraphStore((s) => s.toggleGroupCollapsed)
  const peekGroup = useGraphStore((s) => s.peekGroup)
  const dragHandlers = useGroupDrag()
  const handlers = dragHandlers(group)

  /*
   * The declared size, not React Flow's `width`/`height` props — which are the same number in a
   * browser, since the box is not resizable and the wrapper is given exactly this. The
   * difference is where they are *not* the same: under a measurement stub they are whatever the
   * stub answers, and the mini-map's arithmetic below is a subtraction from this height. One
   * source, and it is the one `layout/collapse.ts` also hands ELK.
   */
  const size = box.size
  /*
   * A Set, not `includes` in a loop: this card subscribes to the selection, so it re-runs on
   * every pointer move of a rubber-band drag, and a group of twenty inside a hundred-node
   * selection is two thousand comparisons a frame. `GroupLayer` builds one Set for all frames;
   * here there is one card per box, so the memo is per box.
   */
  const allSelected = useMemo(() => {
    if (group.nodeIds.length === 0 || selection.length < group.nodeIds.length) return false
    const selected = new Set(selection)
    return group.nodeIds.every((id) => selected.has(id))
  }, [group.nodeIds, selection])

  return (
    <>
      {/*
       * The card's own ring, told where this box's corner is. **Indeterminate on purpose** — a
       * group's progress is not the mean of its members', and averaging a member reporting 90%
       * with one that has not started claims a number nobody measured. What it says is
       * "something in here is working", which is the question a folded box raises.
       */}
      {running && <NodeRunRing radius={COLLAPSED_RADIUS} />}
      <div
        className="group-collapsed nopan"
        data-color={group.color ?? 'grey'}
        // The card's own attribute, and the box joins the card's own rule for it — see
        // `.coda-node[data-state='error']`. Only the failure: `running` is the ring's to say, and
        // a card says it on its header strip rather than its border, which a folded box has not
        // got.
        data-state={failed > 0 ? 'error' : undefined}
        data-filled={group.filled || undefined}
        data-dashed={group.dashed || undefined}
        data-selected={allSelected || undefined}
        data-group-id={group.id}
        style={
          {
            width: size.width,
            height: size.height,
            // The numbers both languages need, handed to the stylesheet rather than restated in
            // it. `boxSize` adds up exactly these; see `layout/collapse.ts`.
            '--collapsed-header': `${COLLAPSED_HEADER_HEIGHT}px`,
            '--collapsed-row': `${COLLAPSED_ROW_HEIGHT}px`,
            '--collapsed-rows-pad': `${COLLAPSED_ROWS_PADDING}px`,
            '--collapsed-map-pad': `${MAP_PAD}px`,
            '--collapsed-radius': `${COLLAPSED_RADIUS}px`,
          } as React.CSSProperties
        }
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onContextMenu(group.id, { x: event.clientX, y: event.clientY })
        }}
        /*
         * Double-click the *body* to look inside — the header keeps its own double-click for
         * renaming, and the controls band stops the event because a double-click in a text field
         * selects a word. So the gesture lands on the mini-map, which is the part of the box that
         * is a picture of what the panel will show.
         */
        onDoubleClick={(event) => {
          event.stopPropagation()
          peekGroup(group.id)
        }}
        {...handlers}
      >
        {/*
         * Both sockets are `isConnectable={false}`: a wire dragged to a box would have to name a
         * card inside it, and which one is a question the box cannot answer. Present all the same,
         * because they are where the merged wires terminate — see `layout/collapse.ts`.
         */}
        <Handle
          type="target"
          position={Position.Left}
          id={COLLAPSED_IN}
          isConnectable={false}
          className="group-collapsed__port"
        />
        <div
          className="group-collapsed__header"
          // Double-click to rename, as on the expanded frame's outline. On the header alone: the
          // rows below hold real fields, where a double-click selects a word.
          onDoubleClick={(event) => {
            event.stopPropagation()
            editTitle(group.id)
          }}
        >
          <button
            type="button"
            className="group-collapsed__chevron nodrag"
            title="Expand this group"
            aria-label="Expand group"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              toggle(group.id)
            }}
          >
            ▸
          </button>
          {editing ? (
            <GroupTitleInput group={group} />
          ) : (
            <span className="group-collapsed__title">{group.title || 'Group'}</span>
          )}
          {failed > 0 && <FailedBadge failed={failed} of={group.nodeIds.length} />}
          <span
            className="group-collapsed__count"
            title={`${group.nodeIds.length} nodes inside`}
          >
            {group.nodeIds.length}
          </span>
        </div>
        {/*
         * The map keeps the bare box's height whatever the box grew to: `boxSize` adds the
         * controls band *on top of* `COLLAPSED_SIZE.height`, so this is that addition not made
         * rather than an addition undone.
         */}
        <GroupMiniMap box={box} />
        {box.exposed.length > 0 && <ExposedControls controls={box.exposed} />}
        <Handle
          type="source"
          position={Position.Right}
          id={COLLAPSED_OUT}
          isConnectable={false}
          className="group-collapsed__port"
        />
      </div>
    </>
  )
}

/**
 * How many cards inside the fold have failed.
 *
 * The card's own badge — same class, same `data-state`, same glyph off `STATE_GLYPH` — with a
 * count after it, which is the one thing a card's badge never has to say. `--count` widens the
 * 14px disc into a pill for it; two characters in a circle sized for one is a clip.
 *
 * One sentence for both the tooltip and the screen reader, because they are one fact — and
 * written separately, one of them shipped as `1 nodes failed`.
 */
function FailedBadge({ failed, of }: { failed: number; of: number }) {
  const said = `${plural(failed, 'node')} of ${of} inside failed — open the group to see which`
  return (
    <span
      className={`state-badge${failed > 1 ? ' state-badge--count' : ''}`}
      data-state="error"
      title={said}
      aria-label={said}
    >
      {STATE_GLYPH.error}
      {failed > 1 ? failed : ''}
    </span>
  )
}

/**
 * The promoted params, as rows of controls.
 *
 * **The band swallows the pointer** rather than relying on `nodrag`: React Flow's own class only
 * stops *its* drag, and the box's drag is ours — a pointerdown on a slider would otherwise take
 * hold of the frame and move every card inside it while the value stayed put. Dragging is by the
 * header and the mini-map, which is what a reader reaches for anyway.
 */
function ExposedControls({ controls }: { controls: ExposedControl[] }) {
  return (
    <div
      className="group-collapsed__rows"
      onPointerDown={(event) => event.stopPropagation()}
      // A double-click in a field selects a word; it must not also open the peek.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {controls.map((control) => (
        <ExposedRow key={`${control.node.id} ${control.param.id}`} control={control} />
      ))}
    </div>
  )
}

/**
 * One promoted control.
 *
 * A component of its own so the `InferContext` can be memoised, which is what the card, the
 * inspector and the styling rail each do — built inline it is six fresh closures per row on
 * every render of the box, including the ones a rubber-band selection causes.
 */
function ExposedRow({ control }: { control: ExposedControl }) {
  const { node, def, param } = control
  const setParam = useGraphStore((s) => s.setParam)
  // The object itself — there is no primitive to select here, and this is one reference that
  // changes only when inference re-runs. Invariant 7: the selector allocates nothing.
  const inference = useGraphStore((s) => s.inference)
  const ctx = useMemo(
    () => makeInferContext(def, node.params, inference.nodes[node.id]?.inputs ?? NO_INPUTS),
    [def, node.params, node.id, inference],
  )

  const owner = node.title ?? def.label
  return (
    <div className="group-collapsed__row">
      <span
        className="group-collapsed__row-label"
        title={
          param.help ? `${owner} · ${param.label} — ${param.help}` : `${owner} · ${param.label}`
        }
      >
        {/*
         * Two spans, because the *param* is the half that has to survive: at 288px a single
         * ellipsised string reads `Explore Dataset · Sea…`, which names the card you already know
         * and hides the control you were looking for. The owner shrinks and the label does not.
         */}
        <span className="group-collapsed__row-owner">{owner}</span>
        <span className="group-collapsed__row-param">{param.label}</span>
      </span>
      <ParamField
        param={param}
        value={node.params[param.id]}
        ctx={ctx}
        variant="inspector"
        onChange={(value) => setParam(node.id, param.id, value)}
      />
    </div>
  )
}

/** Shared, so a node with nothing resolved on its inputs still gets a stable context. */
const NO_INPUTS: Readonly<Record<string, CodaType | undefined>> = {}

/**
 * The members, drawn to scale.
 *
 * The `viewBox` is the members' own bounding box and the SVG is sized in card pixels, so the fit
 * is `preserveAspectRatio`'s rather than arithmetic of ours — which is what keeps a wide group
 * and a tall one both centred, and keeps the drawing correct when the box has grown for a band
 * of promoted controls. The floor on a member's own extent is
 * applied in *flow* units for the same reason: at the scale a forty-card group fits into, a
 * stroke width would be all that was left of each card.
 */
function GroupMiniMap({ box }: { box: CollapsedBox }) {
  /*
   * The *bare* box's height, whatever the box grew to: `boxSize` adds the controls band on top
   * of `COLLAPSED_SIZE.height`, so the map keeps what it had rather than being handed a
   * subtraction to undo. The width is the box's, which the band does widen.
   */
  const { width } = box.size
  const height = COLLAPSED_SIZE.height
  // `union` is `place.ts`'s, the same one `groupBox` and the arrange's own bounds use — four
  // hand-rolled `Math.min` reductions is how three answers to one question come to disagree.
  const bounds = union(box.members) ?? { x: 0, y: 0, width: 1, height: 1 }
  const { x: left, y: top } = bounds
  const span = { width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) }

  // The drawing area, in card pixels: everything below the header.
  const area = {
    width: width - MAP_PAD * 2,
    height: height - COLLAPSED_HEADER_HEIGHT - MAP_PAD,
  }
  /*
   * The cap is applied by *widening the box*, not by scaling the drawing: `preserveAspectRatio`
   * fits whatever the `viewBox` says, so a view larger than the members is the same statement as
   * a smaller scale — and it keeps the fit, the centring and the aspect in one mechanism rather
   * than three. `MAX_CELL` is per card width, so a group of one draws one card-sized mark.
   */
  const most = FALLBACK_NODE_SIZE.width / MAX_CELL
  const view = {
    width: Math.max(span.width, area.width * most),
    height: Math.max(span.height, area.height * most),
  }
  // A member is never drawn thinner than `MIN_CELL` card pixels, expressed as the flow-unit
  // extent that comes to at the scale this fit will use.
  const scale = Math.min(area.width / view.width, area.height / view.height)
  const floor = scale > 0 ? MIN_CELL / scale : 0

  return (
    <svg
      className="group-collapsed__map"
      viewBox={`${left - (view.width - span.width) / 2} ${top - (view.height - span.height) / 2} ${
        view.width
      } ${view.height}`}
      preserveAspectRatio="xMidYMid meet"
      width={area.width}
      height={area.height}
      aria-hidden="true"
    >
      {box.members.map((member) => (
        <rect
          key={member.id}
          className="group-collapsed__cell"
          data-category={getNodeDef(member.type)?.category ?? 'utility'}
          x={member.x}
          y={member.y}
          width={Math.max(member.width, floor)}
          height={Math.max(member.height, floor)}
          rx={floor / 2}
        />
      ))}
    </svg>
  )
}
