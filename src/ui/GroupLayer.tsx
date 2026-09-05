/**
 * Group frames on the canvas: the box, its title, and the drag that moves everything inside it.
 *
 * **Not a React Flow node.** The library's own group node re-bases its children's `position` to
 * be relative to the parent, and this document's positions are absolute everywhere — the
 * exporters, the ELK pass, the splice hit test and every saved file. So a frame is drawn into
 * `ViewportPortal`, which puts plain DOM into the transformed viewport at flow coordinates, and
 * the document keeps one meaning of "position". The cost is that the drag is ours to write; see
 * below, where it is nine lines.
 *
 * **Three properties of the viewport are load-bearing here, and all three are inherited rather
 * than asked for.**
 *
 *  - The portal is the *last* child of the viewport, so at the default depth a frame would paint
 *    over every card. `z-index: -1` on the layer puts it under the cards and under the wires,
 *    which is where a background belongs; the viewport is itself a stacking context (`z-index:
 *    2` plus a transform), so the negative depth cannot escape it and land behind the canvas.
 *  - `.react-flow__viewport` is `pointer-events: none` and the cards switch it back on. The
 *    frame does the same, and only on the parts that are meant to be grabbable — so the
 *    **interior stays click-through**: panning, box-select and clicking a card inside a frame
 *    all behave exactly as they do on bare canvas. The outline itself is a `pointer-events:
 *    stroke` rect with an invisible band `GROUP_GRAB` wide over the top of it.
 *  - Panning is d3-zoom's, bound to `.react-flow__pane` with a *native* listener below React's
 *    root — so `stopPropagation` on a synthetic event cannot reach it. The `nopan` class is what
 *    d3's own filter reads, and it is the only thing that stops the canvas sliding out from
 *    under a frame being dragged.
 *
 * The drag itself is `ui/groupDrag.ts`, shared with the box a *collapsed* frame folds into — it
 * writes through `moveNodes`, the same action a card drag uses.
 *
 * **A collapsed frame draws none of this, and is a React Flow node.** That inversion is
 * deliberate and is argued where it lives, in `nodes/GroupCollapsedCard.tsx`: the case against a
 * node here is that a frame's members are cards whose positions must stay absolute, and a folded
 * frame has no members on the canvas at all — it is a box wires arrive at, which is what a node
 * is. `groupBoxes` skips them, so this layer simply never sees one.
 */

import { ViewportPortal } from '@xyflow/react'
import type { MeasuredSizes } from '../layout/elkGraph'
import { COLLAPSED_RADIUS } from '../layout/collapse'
import { groupBoxes } from '../layout/groupBounds'
import { useGraphStore } from '../store/graphStore'
import { useGroupDrag } from './groupDrag'
import { GroupTitleInput } from './GroupTitle'

/**
 * Width of the invisible band over the outline that a pointer can grab, in flow units.
 *
 * Centred on the stroke, so it reaches ±7 either side. Wide enough to hit without aiming at a
 * 1.5px line, and narrow enough to stay clear of the cards inside — which is the other half of
 * why `GROUP_PADDING` is 24 rather than 8.
 */
export const GROUP_GRAB = 14

export interface GroupLayerProps {
  /** What React Flow last measured for each card. Without it every box fits the fallback size. */
  measured: MeasuredSizes
  onContextMenu: (groupId: string, screenPosition: { x: number; y: number }) => void
}

export function GroupLayer({ measured, onContextMenu }: GroupLayerProps) {
  const graph = useGraphStore((s) => s.graph)
  const selection = useGraphStore((s) => s.selection)
  const collapse = useGraphStore((s) => s.toggleGroupCollapsed)
  // Which frame is being renamed is the store's, not a prop: three surfaces ask, and the menu
  // that starts it cannot reach either of the two that draw it. See `editingGroupId`.
  const editingId = useGraphStore((s) => s.editingGroupId)
  const editTitle = useGraphStore((s) => s.editGroupTitle)
  // A primitive — invariant 7. Only the cursor reads it; the refusal is `moveNodes`'s own.
  const locked = useGraphStore((s) => s.locked)
  // The gesture is `ui/groupDrag.ts`, shared with the box a collapsed frame folds into.
  const dragHandlers = useGroupDrag()

  if (!graph.groups?.length) return null

  const boxes = groupBoxes(graph, measured)
  const byId = new Map(graph.groups.map((g) => [g.id, g]))
  const selected = new Set(selection)

  return (
    <ViewportPortal>
      <div className="group-layer" data-locked={locked || undefined}>
        {boxes.map((box) => {
          const group = byId.get(box.id)
          if (!group) return null
          const isSelected =
            group.nodeIds.length > 0 && group.nodeIds.every((id) => selected.has(id))
          const editing = editingId === group.id
          const handlers = {
            ...dragHandlers(group, { disabled: editing }),
            onDoubleClick: (event: React.MouseEvent) => {
              event.stopPropagation()
              editTitle(group.id)
            },
            onContextMenu: (event: React.MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
              onContextMenu(group.id, { x: event.clientX, y: event.clientY })
            },
          }

          return (
            <div
              key={group.id}
              className="group-frame"
              data-color={group.color ?? 'grey'}
              data-filled={group.filled || undefined}
              data-dashed={group.dashed || undefined}
              data-selected={isSelected || undefined}
              data-group-id={group.id}
              style={
                {
                  transform: `translate(${box.x - GROUP_GRAB / 2}px, ${
                    box.y - GROUP_GRAB / 2
                  }px)`,
                  width: box.width + GROUP_GRAB,
                  height: box.height + GROUP_GRAB,
                  // The one constant that decides this geometry, published so the stylesheet
                  // does not spell it a second time.
                  '--group-grab': `${GROUP_GRAB}px`,
                } as React.CSSProperties
              }
            >
              {/*
               * One `<svg>` and three rects, rather than a `<div>` with a border, because only
               * SVG can say "the stroke is the target and the middle is not". A bordered div
               * takes the whole rectangle or none of it, and taking the whole rectangle is what
               * makes the canvas inside a frame stop panning.
               */}
              <svg
                className="group-frame__svg"
                width={box.width + GROUP_GRAB}
                height={box.height + GROUP_GRAB}
                aria-hidden="true"
              >
                <rect
                  className="group-frame__fill"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx={COLLAPSED_RADIUS}
                />
                <rect
                  className="group-frame__line"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx={COLLAPSED_RADIUS}
                />
                {/*
                 * The grab band: transparent, `GROUP_GRAB` wide, centred on the same path. Last
                 * so it is on top of the two it covers, and `nopan` so d3-zoom's filter — a
                 * native listener React cannot stop — leaves the pointer alone.
                 */}
                <rect
                  className="group-frame__grab nopan"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx={COLLAPSED_RADIUS}
                  strokeWidth={GROUP_GRAB}
                  {...handlers}
                />
              </svg>

              {/*
               * Always drawn, where the title alone was drawn only when there was one: the
               * chevron is one of the two ways to fold a frame and the only one that is visible
               * without a right-click, so an unnamed frame has to carry it too. An untitled
               * frame therefore shows a chevron and nothing else, which is a smaller mark than
               * the outline it sits on.
               */}
              <div className="group-frame__title-row">
                <button
                  type="button"
                  className="group-frame__chevron nopan"
                  title="Collapse this group"
                  aria-label="Collapse group"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    collapse(group.id)
                  }}
                >
                  ▾
                </button>
                {editing && <GroupTitleInput group={group} />}
                {!editing && group.title && (
                  <button
                    type="button"
                    className="group-frame__title nopan"
                    title={`Group: ${group.title}`}
                    {...handlers}
                  >
                    {group.title}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </ViewportPortal>
  )
}
