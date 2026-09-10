/**
 * The Screen Map: every control on the shell boxed and labelled, all at once.
 *
 * See `mapSpots.ts` for what it labels and why this is not a fourth tour, `mapLayout.ts` for
 * where the labels go, and `MapStage.tsx` for the measuring and drawing, which a node's own map
 * shares. This file is the part only the guide has: the lifecycle.
 *
 * ## What it borrows
 *
 * `guideState.ts`, shared with the tours — the inspector so the panel has a box, a graph on an
 * empty canvas so the canvas is not an empty rectangle labelled "the canvas", and the sentence
 * owning up to having opened one. The map adds one thing of its own: a selection, so the panel
 * has something in it. **Borrow before prepare**, the ordering `drive` records, or the restore
 * faithfully puts back what the map itself just wrote.
 *
 * Below `NARROW_QUERY` it stands down to a list instead — see `MapList`, which carries the
 * argument.
 */

import { useLayoutEffect, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { useNarrowShell } from '../smallScreen'
import { borrow, ensureGraph, restore } from './guideState'
import { MapList, MapStage } from './MapStage'
import { MAP_SPOTS } from './mapSpots'

const TITLE = 'Screen Map'

export function ScreenMap() {
  const open = useGraphStore((s) => s.screenMapOpen)
  if (!open) return null
  return <Lifecycle />
}

/**
 * The half that borrows and hands back, mounted only while the map is up.
 *
 * Split from `ScreenMap` so the effect below runs on the *open*, not on every render of a closed
 * map — the borrow is a snapshot, and an effect with a `[]` dependency on a component that is
 * always mounted takes it once, at boot, from a store nobody has touched yet.
 */
function Lifecycle() {
  const narrow = useNarrowShell()
  const close = useGraphStore((s) => s.closeScreenMap)

  /*
   * `null` until the borrow has happened, and that is not a nicety — it is what makes the
   * measurement correct.
   *
   * React runs layout effects child-first, so a stage mounted in the same commit as this one
   * measures **before** the effect below has opened the inspector: the panel is not in the DOM
   * yet, its spot finds nothing, and the map comes up one label short with nothing to say so.
   * (Found exactly that way — the count was 15 against 16 and every spot resolved when asked
   * afterwards.) Holding the stage back for one commit puts the whole prepare in front of it,
   * and a `setState` from a layout effect re-renders before paint, so nothing flashes.
   *
   * The value it carries once it is not `null` is `ensureGraph`'s sentence — empty when the
   * canvas already had a workflow on it.
   */
  const [preamble, setPreamble] = useState<string | null>(null)

  /*
   * Borrow, prepare and hand back. `finishGuide` is last and unconditional: however the map was
   * closed, it was read, which is the honest reading of a guide that shows everything it has to
   * say in one screen. There is no half-way through to abandon, so there is no `completed` to be
   * false.
   */
  useLayoutEffect(() => {
    const held = borrow()
    const opened = ensureGraph()
    const state = useGraphStore.getState()
    if (!state.panels.inspector) state.togglePanel('inspector')
    // Something for the inspector to hold. The first node rather than a chosen one: the panel is
    // being labelled, not explained.
    const first = useGraphStore.getState().graph.nodes[0]
    if (first && useGraphStore.getState().selection.length === 0) state.setSelection([first.id])
    setPreamble(opened)
    return () => {
      restore(held, true)
      useGraphStore.getState().finishGuide('map', true)
    }
  }, [])

  if (preamble === null) return null
  return narrow ? (
    <MapList
      spots={MAP_SPOTS}
      title={TITLE}
      lede={`What each part of the editor is for. On a wider screen this is drawn on the editor itself, with a box round each one.${preamble}`}
      onClose={close}
    />
  ) : (
    <MapStage
      spots={MAP_SPOTS}
      title={TITLE}
      text={`Everything the editor is showing you right now, labelled.${preamble}`}
      onClose={close}
    />
  )
}
