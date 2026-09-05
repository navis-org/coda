/**
 * The menu on a group frame: rename it, restyle it, take it apart.
 *
 * The styling lives *here* rather than in the inspector, and that is a deliberate call. The
 * inspector is node-shaped — one selected node's params, its port types, its result — and a
 * second mode for a thing that is not a node would need group selection in the store beside the
 * node selection already there. A frame has four decisions in it (a name, a colour, a fill, a
 * dash), which is a menu's worth, and a menu opens on the thing it is about.
 *
 * The swatches are **names**, not colours: what is stored is `blue`, and `theme.css` decides what
 * blue is in each mode. See `GROUP_COLORS` for why a document may not carry a CSS value.
 */

import { useMemo, useRef, useState } from 'react'

import type { GraphGroup, GraphNode, GroupColor } from '../../core/graph'
import { GROUP_COLORS, nodesById } from '../../core/graph'
import { isExposed } from '../../core/groups'
import type { NodeDefinition, ParamDef } from '../../core/node'
import { configurableParams } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
import { shortcutKeys } from '../shortcuts'
import { useDismissOnOutside } from '../useDismiss'
import { AlignTools } from './AlignTools'

/**
 * Which of the members' params the folded box carries.
 *
 * **Inside the menu rather than in a flyout**, unlike the toolbar's submenus: a flyout is a
 * second panel to place against a window edge, and `Dropdown`'s own note records that a panel
 * holding one must switch its scrolling off because `overflow-y: auto` clips the other axis too.
 * A section that opens in place has neither problem, and it can scroll — which it has to, since a
 * frame of six cards can offer forty params.
 *
 * **Closed by default and counted on its own row**, because the list is long and this is not what
 * most right-clicks are for. Toggling a param does *not* close the menu, exactly as the swatches
 * below do not: picking controls is a several-at-a-time job.
 *
 * `configurableParams` is what is offered, which is the same predicate the card, the inspector
 * and the box itself ask — so a param the node's current values have switched off is not on the
 * list, and neither is a nonce some widget writes. A node with a body of its own (Find Neurons,
 * Paths) offers its params all the same: the box draws the generic control, which for most of
 * them is the card's own control and for a few is the raw value. That is the reader's call to
 * make, not a rule per node type kept true by hand.
 */
function ExposedPicker({ group }: { group: GraphGroup }) {
  const [open, setOpen] = useState(false)
  const toggleExposed = useGraphStore((s) => s.toggleExposedParam)
  const graph = useGraphStore((s) => s.graph)

  // Only while the section is showing: the enumeration walks every member and runs every
  // `visibleIf` they declare, and this row is closed on almost every right-click.
  const members = useMemo(() => {
    if (!open) return []
    const nodes = nodesById(graph)
    const found: Array<{ node: GraphNode; def: NodeDefinition; params: ParamDef[] }> = []
    for (const id of group.nodeIds) {
      const node = nodes.get(id)
      const def = node ? getNodeDef(node.type) : undefined
      if (!node || !def) continue
      const params = configurableParams(def, node.params)
      if (params.length > 0) found.push({ node, def, params })
    }
    return found
  }, [open, graph, group.nodeIds])

  const count = group.exposed?.length ?? 0

  return (
    <>
      <button
        type="button"
        className="context-menu__item context-menu__item--parent"
        aria-expanded={open}
        title="Put a card's controls on the box this frame folds into"
        onClick={() => setOpen((was) => !was)}
      >
        Controls on the folded box{count > 0 ? ` (${count})` : ''}
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="context-menu__controls">
          {members.map(({ node, def, params }) => (
            <div key={node.id}>
              <div className="context-menu__caption">{node.title ?? def.label}</div>
              {params.map((param) => {
                const on = isExposed(group, node.id, param.id)
                return (
                  <button
                    key={param.id}
                    type="button"
                    className="context-menu__item"
                    aria-pressed={on}
                    title={param.help ?? param.label}
                    onClick={() => toggleExposed(group.id, node.id, param.id)}
                  >
                    {on ? '✓ ' : ''}
                    {param.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Named for the reader rather than for the token: a swatch has to say something out loud. */
const COLOR_LABELS: Record<GroupColor, string> = {
  grey: 'Grey',
  blue: 'Blue',
  orange: 'Orange',
  green: 'Green',
  pink: 'Pink',
  violet: 'Violet',
}

export interface GroupContextMenuProps {
  screenPosition: { x: number; y: number }
  groupId: string
  onClose: () => void
}

export function GroupContextMenu({ screenPosition, groupId, onClose }: GroupContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const store = useGraphStore()
  const group = store.graph.groups?.find((g) => g.id === groupId)

  useDismissOnOutside(ref, onClose, { onEscape: true })

  if (!group) return null

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: Math.min(screenPosition.x, window.innerWidth - 190),
        top: Math.min(screenPosition.y, window.innerHeight - 240),
      }}
      role="menu"
    >
      <div className="context-menu__caption">{group.title || 'Untitled group'}</div>
      {/* Which frame is being renamed is `editingGroupId`: this menu can reach neither the
          outline nor the folded box that draws the field. */}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => store.editGroupTitle(groupId))}
      >
        {group.title ? 'Rename' : 'Name this group'}
      </button>
      <button
        type="button"
        className="context-menu__item"
        title="Select every card inside the frame"
        onClick={act(() => store.setSelection(group.nodeIds))}
      >
        Select {group.nodeIds.length} nodes
      </button>
      {/*
       * Folding is live under the lock, like renaming and recolouring below and unlike Ungroup:
       * it hides cards where they are and puts them back where they were. The row says which way
       * it goes rather than naming the state, because a menu row is read as a verb.
       */}
      <button
        type="button"
        className="context-menu__item"
        title={
          group.collapsed
            ? 'Draw the cards inside this frame again'
            : 'Fold this frame into one box, with its wires joined at its edges'
        }
        onClick={act(() => store.toggleGroupCollapsed(groupId))}
      >
        {group.collapsed ? 'Expand' : 'Collapse'}
      </button>

      {/*
       * Only while folded: an expanded frame's cards are on the canvas already, and a row that
       * opened a panel to show what is in front of you would be a second way of looking at it.
       */}
      {group.collapsed && (
        <button
          type="button"
          className="context-menu__item"
          title="Show the cards inside this frame in a panel, without unfolding it"
          onClick={act(() => store.peekGroup(groupId))}
        >
          Look inside
        </button>
      )}

      <div className="context-menu__sep" />
      <ExposedPicker group={group} />

      <div className="context-menu__sep" />
      {/*
       * The same grid the node menu carries, pointed at the frame's members rather than at the
       * selection: a group *is* a set of cards somebody has already picked out, which is the
       * only argument these tools take.
       */}
      <div className="context-menu__caption">Align &amp; distribute</div>
      <AlignTools ids={group.nodeIds} />

      <div className="context-menu__sep" />
      {/*
       * A row of swatches rather than six menu items: colour is the one choice here where the
       * value *is* its own label, and a list of words next to a canvas would be six lines
       * saying what one line can show.
       */}
      <div className="context-menu__swatches" role="group" aria-label="Frame colour">
        {GROUP_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="context-menu__swatch"
            data-color={color}
            data-current={(group.color ?? 'grey') === color || undefined}
            aria-label={COLOR_LABELS[color]}
            aria-pressed={(group.color ?? 'grey') === color}
            title={COLOR_LABELS[color]}
            onClick={() => store.styleGroup(groupId, { color })}
          />
        ))}
      </div>
      <button
        type="button"
        className="context-menu__item"
        aria-pressed={group.filled === true}
        title="Tint the inside of the frame instead of drawing an outline only"
        onClick={() => store.styleGroup(groupId, { filled: !group.filled })}
      >
        {group.filled ? '✓ ' : ''}Filled
      </button>
      <button
        type="button"
        className="context-menu__item"
        aria-pressed={group.dashed === true}
        onClick={() => store.styleGroup(groupId, { dashed: !group.dashed })}
      >
        {group.dashed ? '✓ ' : ''}Dashed
      </button>

      <div className="context-menu__sep" />
      {/*
       * Ungroup, not Delete: nothing is removed from the graph, so the danger styling every
       * other terminal row wears would be a lie about what this does.
       */}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => store.ungroup([groupId]))}
        disabled={store.locked}
        title={store.locked ? LOCKED_HINT : 'Remove the frame; the cards stay where they are'}
      >
        Ungroup <kbd>{shortcutKeys('ungroup')}</kbd>
      </button>
    </div>
  )
}
