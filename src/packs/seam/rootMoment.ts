/**
 * When Suggest Merges reads each neuron (`momentsFrom`), and what the SEAM nodes say about the
 * moment they read one at — one wording for Find Open Ends and Suggest Merges, which both follow
 * their query neuron rather than a materialization (`docs/seam-live-plan.md`). Each node adds
 * what the moment meant for its own answer. Find Open Ends picks its moments in the data layer
 * (`somataLive`), with no `Searched at` to honour.
 */

import { namedFew } from '../../core/prose'
import { parseCaveTimestamp } from '../../data/cave/datastack'
import type { RootLife } from '../../data/cave/rootIds'
import { momentWithin } from '../../data/cave/rootIds'
import { agree } from '../../style/format'

/** Each neuron's moment, and the three kinds of neuron a reader is told about. */
export interface NeuronMoments {
  readonly moments: Map<string, number>
  /**
   * Roots replaced before the wanted moment, each with the last moment it was current — read
   * as it last stood.
   */
  readonly editedBefore: Map<string, number>
  /** Roots replaced since the wanted moment, likewise — read at it, before the edit. */
  readonly editedAfter: Map<string, number>
  /** Roots made after the wanted moment, and so read from when they were made. */
  readonly later: string[]
}

/**
 * When each root is read: its wanted moment moved into its life (`momentWithin`). A root
 * replaced is listed whatever moment it is read at, since the neuron has changed since; a root
 * made after its wanted moment is listed where it is still current.
 */
export function momentsFrom(
  lives: ReadonlyMap<string, RootLife>,
  wantedOf: (root: string) => number,
): NeuronMoments {
  const moments = new Map<string, number>()
  const editedBefore = new Map<string, number>()
  const editedAfter = new Map<string, number>()
  const later: string[] = []
  for (const [root, life] of lives) {
    const wanted = wantedOf(root)
    moments.set(root, momentWithin(life, wanted))
    if (!life.current) (life.last < wanted ? editedBefore : editedAfter).set(root, life.last)
    else if (life.made >= wanted) later.push(root)
  }
  return { moments, editedBefore, editedAfter, later }
}

/** A moment as a reader compares it with CAVE's own stamps: `2026-11-17 07:37 UTC`. */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** "This neuron has been edited since: 6485… (current until 2026-11-17 07:37 UTC)." */
export function editedSince(replaced: ReadonlyMap<string, number>): string {
  const list = [...replaced].map(([id, at]) => `${id} (current until ${utcMinute(at)})`)
  return (
    `${agree(list.length, 'This neuron has', 'These neurons have')} been edited since: ` +
    `${namedFew(list)}.`
  )
}

/** "6485… is not a root wclee_aedes_brain's chunkedgraph knows" — the caller ends the sentence. */
export function notRoots(ids: readonly string[], datastack: string): string {
  return (
    `${namedFew(ids)} ${agree(ids.length, 'is not a root', 'are not roots')} ` +
    `${datastack}’s chunkedgraph knows`
  )
}

/**
 * Suggest Merges' `Searched at`, read: each neuron's moment by its root id, epoch ms, and the
 * entries that are not one. Entries are `root=moment`, the moment ISO 8601, separated by commas
 * or whitespace.
 *
 * **What is not an entry is handed back, not thrown.** The record is the node's own, so one was
 * edited by hand or written by an older build — a document saved on 2026-11-17 holds the single
 * moment the first version kept. Refusing it left the node failing with a remedy (the card's ⟳)
 * that a failed card does not show, since its foot appears only once a run has read data. So the
 * node says what it set aside, and writes the record back without it.
 */
export function readSearchedAt(text: string): {
  moments: Map<string, number>
  unread: string[]
} {
  const moments = new Map<string, number>()
  const unread: string[] = []
  for (const entry of text.split(/[\s,]+/).filter(Boolean)) {
    const [root, moment, extra] = entry.split('=')
    // UTC where the entry names no offset, as the help says — a hand-typed one too.
    const at = parseCaveTimestamp(moment ?? '')
    if (!root || extra !== undefined || at === undefined) unread.push(entry)
    else moments.set(root, at)
  }
  return { moments, unread }
}

/** `readSearchedAt`'s inverse, in the order given. */
export function writeSearchedAt(moments: ReadonlyMap<string, number>): string {
  return [...moments].map(([root, at]) => `${root}=${new Date(at).toISOString()}`).join(', ')
}
