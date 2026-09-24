/**
 * The Plugins dialog: every node pack this build has, what it adds, and a switch for it.
 *
 * Opened from the toolbar beside Connections and from the node browser's footer. A switch hides a
 * pack's nodes from everywhere new work starts — the node browser, the canvas **+** menu, the
 * command palette and the Workflow Wizard — and changes nothing else: a workflow using the pack
 * still opens, runs and saves, and while one is open the pack stays offered, which its row says
 * so that a switch that seems to do nothing is not a mystery. See `docs/packs.md`.
 *
 * "Plugins" on screen and "packs" in the code: the reader's word for a thing added to an app, and
 * the code's word for what one is made of. A pack may one day bring more than nodes, which is why
 * this is its own dialog rather than a section of the node browser.
 */

import { useId } from 'react'

import type { NodeDefinition } from '../../core/node'
import { packsNeeding } from '../../core/packs'
import { getPack, registeredPacks } from '../../core/registry'
import type { PackDefinition } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { plural } from '../format'
import { GLYPH_STROKE_WIDTH, GLYPH_VIEWBOX } from '../glyphs'
import { Modal, ModalHeader } from '../Modal'
import {
  switchPack,
  useOwnSwitchedOffPacks,
  useSwitchedOffPacks,
  useWorkflowPacks,
} from '../packSwitches'
import { nodeGlyph } from './NodeThumbnail'
import { GlyphSvg } from './startGlyphs'

export function PluginsDialog() {
  const open = useGraphStore((s) => s.pluginsOpen)
  const close = useGraphStore((s) => s.closePlugins)
  if (!open) return null
  return <PluginsBody onClose={close} />
}

function PluginsBody({ onClose }: { onClose: () => void }) {
  const packs = registeredPacks()
  // A pack's parts come straight after it, so the list reads as the packs and what is in them.
  const ordered = packs
    .filter((p) => p.parent === undefined)
    .flatMap((top) => [top, ...packs.filter((p) => p.parent === top.id)])
  return (
    /*
     * Portalled, because it is opened from *inside* another dialog — the wizard's "Open Plugins" —
     * and two overlays at one z-index stack in document order: mounted in the toolbar, it drew
     * underneath the wizard that opened it. Escape still closes it first (`useOverlayEscape`).
     */
    <Modal className="overlay__panel plugins" label="Plugins" onClose={onClose} portal>
      <ModalHeader onClose={onClose}>Plugins</ModalHeader>
      <ul className="plugins__list">
        {ordered.map((pack) => (
          <PackRow key={pack.id} pack={pack} />
        ))}
        {packs.length === 0 && <li className="plugins__empty">This build has no plugins.</li>}
      </ul>
      <footer className="plugins__footer">
        Extra tools for particular kinds of data. Switching one off hides its nodes when you add
        something new; workflows that use it still open and run.
      </footer>
    </Modal>
  )
}

/**
 * One pack's row. Its switch shows the pack's **own** switch, so a part of a pack that is off keeps
 * showing what it will be when its parent comes back — greyed out, with a line saying why, as a
 * switch that something else needs is.
 */
function PackRow({ pack }: { pack: PackDefinition }) {
  const id = useId()
  const switchedOff = useSwitchedOffPacks()
  const ownOff = useOwnSwitchedOffPacks()
  const inUse = useWorkflowPacks()
  const on = !switchedOff.has(pack.id)
  // The parent, when it is off — which greys this part's switch and says why.
  const offParent =
    pack.parent !== undefined && switchedOff.has(pack.parent) ? pack.parent : undefined
  const neededBy = packsNeeding(pack.id, switchedOff).map(labelOf)
  const needs = (pack.requires ?? []).map(labelOf)
  const face = pack.nodes.find((n) => n.type === pack.glyph) ?? pack.nodes[0]
  const notes = [
    needs.length > 0 && `Needs ${needs.join(', ')}.`,
    neededBy.length > 0 && `Needed by ${neededBy.join(', ')}, so it stays on.`,
    offParent !== undefined && `Off while ${labelOf(offParent)} is off.`,
  ].filter(Boolean)
  return (
    <li>
      {/* The whole row is the label, so a click anywhere on it flips the switch. */}
      <label className="plugins__row" data-on={on} data-part={pack.parent !== undefined}>
        {face && (
          <span className="plugins__tile">
            <NodeGlyph def={face} className="plugins__glyph" />
          </span>
        )}
        <span className="plugins__text">
          <span className="plugins__name">
            <span id={`${id}-name`}>{pack.label}</span>
            {inUse.includes(pack.id) && (
              <span
                className="plugins__badge"
                title={
                  on
                    ? 'The open workflow uses this plugin'
                    : 'The open workflow uses this plugin, so its nodes stay offered while it is open'
                }
              >
                used here
              </span>
            )}
          </span>
          <span id={`${id}-blurb`} className="plugins__blurb">
            {pack.description}
          </span>
          {notes.length > 0 && (
            <span id={`${id}-notes`} className="plugins__deps">
              {notes.join(' ')}
            </span>
          )}
          <span
            className="plugins__nodes"
            aria-label={`Adds ${plural(pack.nodes.length, 'node')}`}
          >
            {pack.nodes.map((def) => (
              <span key={def.type} className="plugins__node">
                <NodeGlyph def={def} className="plugins__node-glyph" />
                {def.label}
              </span>
            ))}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          /* Named by the pack alone and described by the rest: the row is the label, so the name
             would otherwise be every word on it, read out before the state. */
          aria-labelledby={`${id}-name`}
          aria-describedby={notes.length > 0 ? `${id}-blurb ${id}-notes` : `${id}-blurb`}
          checked={offParent !== undefined ? !ownOff.has(pack.id) : on}
          disabled={neededBy.length > 0 || offParent !== undefined}
          onChange={(e) => switchPack(pack.id, e.target.checked)}
        />
      </label>
    </li>
  )
}

/** A node's drawing, at the size its class sets — the same glyph its card and the palette show. */
function NodeGlyph({ def, className }: { def: NodeDefinition; className: string }) {
  return (
    <GlyphSvg viewBox={GLYPH_VIEWBOX} className={className} strokeWidth={GLYPH_STROKE_WIDTH}>
      {nodeGlyph(def.type, def.category)}
    </GlyphSvg>
  )
}

/** A pack's name, by id — the one spelling for both "Needs" and "Needed by". */
function labelOf(id: string): string {
  return getPack(id)?.label ?? id
}
