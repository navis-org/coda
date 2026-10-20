/**
 * What somebody changed about a Neuroglancer card's neurons *inside the viewer*: the ids they
 * double-clicked into the scene and the ids they took out of it.
 *
 * **Stored as edits on top of the input, not as a snapshot.** The card's scene is the neuron table
 * wired into it, and that table moves — a filter upstream is edited, a selection in Explore grows.
 * A snapshot would freeze it at the first double-click and the wire would stop meaning anything.
 * Edits keep both: what arrives is shown, minus what was removed, plus what was added.
 *
 * **One `ids` param, both lists**, as `+id` and `-id`: `chartSelection.ts`' rule for the heatmap's
 * two axes, for its reason — two params are two commits, and an undo would take back half of one
 * double-click. Sorted, so the same edits are always the same text and the provenance key does not
 * move over a change that changed nothing.
 *
 * Headless: the node applies the edits and the viewer derives them, and both read this module.
 */

import { compareIds, isSegmentId } from '../../core/ids'

export interface SelectionEdits {
  readonly added: ReadonlySet<string>
  readonly removed: ReadonlySet<string>
  /**
   * Shown in the list but hidden — a chip un-ticked, or a neuron double-clicked out, which in
   * neuroglancer hides rather than removes. Read only under `Hidden neurons: stay in Selected`;
   * otherwise a hidden neuron is a removed one.
   */
  readonly hidden: ReadonlySet<string>
}

export const NO_EDITS: SelectionEdits = {
  added: new Set(),
  removed: new Set(),
  hidden: new Set(),
}

const ADDED = '+'
const REMOVED = '-'
const HIDDEN = '~'

export function encodeSelectionEdits(edits: SelectionEdits): string[] {
  const sorted = (ids: ReadonlySet<string>) => [...ids].sort(compareIds)
  return [
    ...sorted(edits.added).map((id) => `${ADDED}${id}`),
    ...sorted(edits.removed).map((id) => `${REMOVED}${id}`),
    ...sorted(edits.hidden).map((id) => `${HIDDEN}${id}`),
  ]
}

/**
 * A stored edit list, split. An entry with an unknown prefix or a payload neuroglancer cannot
 * parse is dropped rather than guessed at — a hand-edited file is the other way one arrives, and
 * one unparseable segment id costs the viewer, not one neuron (`isSegmentId`).
 */
export function decodeSelectionEdits(raw: unknown): SelectionEdits {
  if (!Array.isArray(raw) || raw.length === 0) return NO_EDITS
  const added = new Set<string>()
  const removed = new Set<string>()
  const hidden = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = entry.slice(1)
    if (!isSegmentId(id)) continue
    if (entry.startsWith(ADDED)) added.add(id)
    else if (entry.startsWith(REMOVED)) removed.add(id)
    else if (entry.startsWith(HIDDEN)) hidden.add(id)
  }
  return { added, removed, hidden }
}

/**
 * The ids the card shows: the input in its own order without the removed ones, then the added
 * ones it did not already hold. Input order first, because the colour a data-driven encoding
 * gives a neuron is resolved against the input's rows.
 */
export function applySelectionEdits(
  input: readonly string[],
  edits: SelectionEdits,
): readonly string[] {
  if (edits.added.size === 0 && edits.removed.size === 0) return input
  const kept = input.filter((id) => !edits.removed.has(id))
  const held = new Set(input)
  const extra = [...edits.added].filter((id) => !held.has(id)).sort(compareIds)
  return [...kept, ...extra]
}

/**
 * Fold what the viewer now shows into the edits, relative to what it was last *told* to show.
 *
 * Relative to the scene that was applied rather than to the input table, and that is the point:
 * the input can change between a navigation and the frame's next report, and a diff against the
 * new input would turn every neuron the upstream edit added into a "removed" one. Measured against
 * what was sent, only the user's own double-clicks are a difference.
 *
 * A neuron taken out that had been added is simply un-added, and one put back that had been
 * removed is un-removed, so toggling a neuron twice leaves no trace — and this needs no knowledge
 * of which ids the input holds.
 */
export function mergeShownSegments(
  edits: SelectionEdits,
  intended: readonly string[],
  shown: readonly string[],
  /** Which of `shown` are hidden, where hidden neurons stay selected; undefined keeps the old set. */
  hidden?: readonly string[],
): SelectionEdits {
  const wanted = new Set(intended)
  const now = new Set(shown)
  const added = new Set(edits.added)
  const removed = new Set(edits.removed)
  for (const id of now) {
    if (wanted.has(id)) continue
    if (!removed.delete(id)) added.add(id)
  }
  for (const id of wanted) {
    if (now.has(id)) continue
    if (!added.delete(id)) removed.add(id)
  }
  return { added, removed, hidden: hidden ? new Set(hidden) : edits.hidden }
}

/**
 * A layer's selection as an in-place update should leave it: what the card asks for, plus every
 * change the user has made in the frame that the card had not seen when it asked.
 *
 * Without the second half an update set mid-gesture takes back a double-click: the card computes
 * update n+1 from the frame's report of A, the user double-clicks B before the frame reports again,
 * and n+1 arrives listing A and not B. The frame then reports against n+1, which the card folds
 * against the scene it sent, and B is gone without a trace.
 *
 * Decided per id, against `told` — the last selection the card sent for this layer. Where the
 * frame shows an id differently from `told`, the user changed it. Where the card's new update also
 * differs from `told` for that id, the card has decided about it since, from the user's own report
 * or from upstream, and the card wins. Only where the update says the same as before is the user's
 * change one it has not seen, and that is kept. The card's own spelling is why it has to be this
 * way round: under "leave Selected" a neuron hidden in the viewer is a removal, so the card stops
 * listing a neuron the frame still shows hidden, and keeping every difference from `told` would
 * bring it back.
 *
 * Each map is id → visible; an absent id is not selected. `told` undefined means the frame does not
 * know what it was last told, and then nothing is kept, rather than every segment shown counting as
 * the user's.
 */
export function keepUnseenChanges<K>(
  wanted: ReadonlyMap<K, boolean>,
  told: ReadonlyMap<K, boolean> | undefined,
  current: ReadonlyMap<K, boolean>,
): Map<K, boolean> {
  const out = new Map(wanted)
  if (!told) return out
  const unseen = (id: K) => wanted.get(id) === told.get(id)
  // Selected, shown or hidden in the frame, where the card still says what it said before.
  for (const [id, visible] of current) {
    if (told.get(id) !== visible && unseen(id)) out.set(id, visible)
  }
  // Taken out in the frame, likewise.
  for (const id of told.keys()) if (!current.has(id) && unseen(id)) out.delete(id)
  return out
}
