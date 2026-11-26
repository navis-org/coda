/**
 * How much review work a `seam:proofreadMerges` card keeps (user, 2026-11-19): **the full work of the last
 * `KEPT_NEURONS` neurons worked on**, so a long campaign does not outgrow the browser's storage
 * for the workflow (a tab's slot is about 2 M characters, `docs/persistence.md`).
 *
 * A neuron is worked on when the card writes something for it — a verdict, an Extend, an
 * Auto-extend, Auto-extend listed — never when it is only looked at. The order is the `recent`
 * param, oldest first. When a write puts more than `KEPT_NEURONS` neurons in it, the oldest lose
 * their verdicts, extended pieces, Auto-extend presses, refusals and hand picks **in that same
 * edit**, so one Ctrl+Z brings them back, and the card says so on the status bar. The merge record keeps its own
 * recency (`appendRecorded`): it grows only at a Submit.
 *
 * **Decided from the params alone, at a write, never from the input**: `Tips` arrives late and in
 * parts while the search runs, and a card rewired for a minute would make every other neuron look
 * gone.
 *
 * **Only what the list names is a neuron** (user, 2026-11-22). Anything else with work — a piece
 * Auto-extend took, whose accept is the search's and so in no param; work from before the list
 * existed — is never counted and never cleared on its own: it goes only with a neuron being cleared
 * that reaches it, and stays while a kept one does too. It was once counted as a neuron, oldest of
 * all, and a first verdict on such a piece was cleared in the edit that wrote it. The cost is that
 * work nothing listed reaches stays.
 *
 * Which pairs are a neuron's: those whose parent is the neuron, or a piece reached from it through
 * any pair (`piecesOf` over every pair, verdicts included) — wider than the tree the card lists
 * (`extendedKeys`), so the verdicts beyond a piece taken back keep their entries while its neuron
 * is kept, waiting for it to be extended again, as they do everywhere else.
 *
 * The card hands in Auto-extend's pairs (`known`), and **a parent the write itself touches is the
 * neuron's** — the card writes only for the neuron it is on: both as edges a neuron reaches its
 * pieces by, and to take a piece back out of the list where an earlier write put it there as a
 * neuron. Neither is needed for safety; both only make the list and the reach right.
 */

import { decodePicks, encodePicks } from './handPicks'
import { pairsOf, piecesOf, verdictPair } from './pieces'
import {
  PAIR_PARAMS,
  decodeExtend,
  decodeVerdicts,
  encodeExtend,
  encodeVerdicts,
  pairParents,
} from './reviewQueue'

/** How many neurons keep their full work (user, 2026-11-19). */
export const KEPT_NEURONS = 10

export function decodeRecent(raw: unknown): string[] {
  return String(raw ?? '')
    .split(';')
    .map((id) => id.trim())
    .filter((id) => id !== '')
}

/**
 * The card's `write` for work on `neuron`, with `recent` moved on and — where that leaves more than
 * `KEPT_NEURONS` neurons — the oldest neurons' pairs taken out. `evicted` names those neurons.
 *
 * A listed id with no work left — read off the heads of the params' groups (`pairParents`), with no
 * verdict decoded — leaves the list. Where the rest fit, nothing more is read. Otherwise every pair
 * is decoded, as the edges a neuron reaches its pieces by.
 */
export function withRecentWork(
  params: Readonly<Record<string, unknown>>,
  neuron: string | undefined,
  write: Readonly<Record<string, string>>,
  /** Pairs no param holds, as `parent/piece`: Auto-extend's accepts (`AutoGrowth.accepted`). */
  known: Iterable<string> = [],
): { write: Record<string, string>; evicted: string[] } {
  const out: Record<string, string> = { ...write }
  if (neuron === undefined) return { write: out, evicted: [] }
  const after: Readonly<Record<string, unknown>> = { ...params, ...write }
  /** Write `id` where `next` is not what it holds already. */
  const put = (id: string, next: string) => {
    if (next !== String(after[id] ?? '')) out[id] = next
  }

  const knownPairs = pairsOf(known)
  const knownPieces = new Set(knownPairs.map((pair) => pair.piece))
  const parents = new Set(['verdicts', ...PAIR_PARAMS].flatMap((id) => pairParents(after[id])))
  const listed = decodeRecent(params['recent']).filter(
    (id) => id !== neuron && parents.has(id) && !knownPieces.has(id),
  )
  if (listed.length < KEPT_NEURONS) {
    put('recent', [...listed, neuron].join(';'))
    return { write: out, evicted: [] }
  }

  const verdicts = decodeVerdicts(after['verdicts'])
  const lists = PAIR_PARAMS.map((id) => [id, decodeExtend(after[id])] as const)
  const touched = touchedBy(params, write, verdicts, lists).filter((id) => id !== neuron)
  const pairs = [
    ...pairsOf([...verdicts.keys(), ...lists.flatMap(([, keys]) => [...keys])]),
    ...knownPairs,
    ...touched.map((parent) => ({ parent: neuron, piece: parent })),
  ]
  /*
   * A listed id leaves the list where it is now known to be a piece — taken by Auto-extend, or
   * worked on for this neuron — never because a stored pair names it: a neuron can be another's
   * candidate, rejected there, and is still a neuron.
   */
  const touchedNow = new Set(touched)
  const order = [...listed.filter((id) => !touchedNow.has(id)), neuron]
  const kept = order.slice(-KEPT_NEURONS)
  const evicted = order.slice(0, order.length - kept.length)
  put('recent', kept.join(';'))
  if (evicted.length === 0) return { write: out, evicted }

  /*
   * What a cleared neuron reaches through any pair goes with it — unless a kept neuron reaches it
   * too, whoever it was given on. What neither reaches stays (see the header).
   */
  const reachOf = (ids: readonly string[]) =>
    new Set([...ids, ...piecesOf(pairs, ids).map((piece) => piece.id)])
  const keptReach = reachOf(kept)
  const goneReach = reachOf(evicted)
  const goes = (root: string) => goneReach.has(root) && !keptReach.has(root)
  const keeps = (key: string) => {
    const pair = verdictPair(key)
    // A key of the old shape is nobody's, and goes at a clear as it always has.
    return pair !== undefined && !goes(pair.neuronId)
  }
  put('verdicts', encodeVerdicts(new Map([...verdicts].filter(([key]) => keeps(key)))))
  for (const [id, keys] of lists) put(id, encodeExtend([...keys].filter(keeps)))
  // A hand pick goes with the pair that accepts it: on a root a cleared neuron reaches.
  if (after['picks']) {
    put('picks', encodePicks(decodePicks(after['picks']).filter((pick) => !goes(pick.root))))
  }
  return { write: out, evicted }
}

/**
 * The parents whose pairs this write adds or changes — work on the neuron the card is on, whatever
 * else names them. `verdicts` and `lists` are the params after the write, decoded already.
 */
function touchedBy(
  params: Readonly<Record<string, unknown>>,
  write: Readonly<Record<string, string>>,
  verdicts: ReadonlyMap<string, string>,
  lists: readonly (readonly [string, ReadonlySet<string>])[],
): string[] {
  const keys: string[] = []
  if ('verdicts' in write) {
    const before = decodeVerdicts(params['verdicts'])
    for (const [key, said] of verdicts) if (before.get(key) !== said) keys.push(key)
  }
  for (const [id, after] of lists) {
    if (!(id in write)) continue
    const before = decodeExtend(params[id])
    for (const key of after) if (!before.has(key)) keys.push(key)
  }
  return [...new Set(pairsOf(keys).map((pair) => pair.parent))]
}
