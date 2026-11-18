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

/** Each neuron's moment, and the two kinds of neuron a reader is told about. */
export interface NeuronMoments {
  readonly moments: Map<string, number>
  /**
   * Roots no longer current, each with the last moment it was. Read before the edit either way —
   * at the wanted moment, or as it last stood where it was replaced before that — so a reader is
   * told the one thing that matters: the answer predates the neuron as it is now.
   */
  readonly edited: Map<string, number>
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
  const edited = new Map<string, number>()
  const later: string[] = []
  for (const [root, life] of lives) {
    const wanted = wantedOf(root)
    moments.set(root, momentWithin(life, wanted))
    if (!life.current) edited.set(root, life.last)
    else if (life.made >= wanted) later.push(root)
  }
  return { moments, edited, later }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** A moment as a reader says it: `14:09 UTC on 17 November`, with the year when it is not this one. */
export function utcWhen(ms: number, now = Date.now()): string {
  const at = new Date(ms)
  const time = at.toISOString().slice(11, 16)
  const year =
    at.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`
  return `${time} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year}`
}

/** The words every "no longer current" sentence opens with — what `saysNoLongerCurrent` finds. */
const NO_LONGER = { one: 'is no longer a current root', many: 'are no longer current' }

/**
 * "6485… is no longer a current root: it was edited at 14:09 UTC on 17 November, and its
 * suggestions are from before that edit." — the caller says what is from before it, in both
 * numbers, and adds the remedy.
 */
export function noLongerCurrent(
  edited: ReadonlyMap<string, number>,
  answer: { readonly one: string; readonly many: string },
): string {
  const [first] = edited
  if (edited.size === 1 && first) {
    const [id, at] = first
    return `${id} ${NO_LONGER.one}: it was edited at ${utcWhen(at)}, and ${answer.one}.`
  }
  const list = [...edited].map(([id, at]) => `${id} (edited at ${utcWhen(at)})`)
  return `${edited.size} roots ${NO_LONGER.many}: ${namedFew(list)}; ${answer.many}.`
}

/** Whether a warning is one `noLongerCurrent` wrote, so a caller passing warnings on can drop it. */
export function saysNoLongerCurrent(warning: string): boolean {
  return warning.includes(NO_LONGER.one) || warning.includes(NO_LONGER.many)
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
