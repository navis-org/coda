/**
 * How much review work a `seam:review` card keeps (user, 2026-11-19): **the full work of the last
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
 * gone. A neuron with work that the list does not name — work from before the list existed — is
 * older than any it names.
 *
 * Which pairs are a neuron's: those whose parent is the neuron, or a piece reached from it through
 * any pair (`piecesOf` over every pair, verdicts included) — wider than the tree the card lists
 * (`extendedKeys`), so the verdicts beyond a piece taken back keep their entries while its neuron
 * is kept, waiting for it to be extended again, as they do everywhere else.
 */

import { compareIds } from '../../core/ids'
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
 * **A neuron is a parent no pair names as its piece.** A piece whose accept was taken back has left
 * `extend`, but a verdict on it — or the verdicts on its own candidates, waiting for it to be
 * extended again — still name it, so it is never counted, and never takes a neuron's place.
 *
 * Where every parent not listed could be a neuron and they would still fit — read off the heads of
 * the params' groups (`pairParents`), with no verdict decoded — nothing is dropped and nothing more
 * is read. Otherwise every pair is decoded, as the edges a kept neuron reaches its pieces by.
 */
export function withRecentWork(
  params: Readonly<Record<string, unknown>>,
  neuron: string | undefined,
  write: Readonly<Record<string, string>>,
): { write: Record<string, string>; evicted: string[] } {
  const out: Record<string, string> = { ...write }
  if (neuron === undefined) return { write: out, evicted: [] }
  const after: Readonly<Record<string, unknown>> = { ...params, ...write }
  /** Write `id` where `next` is not what it holds already. */
  const put = (id: string, next: string) => {
    if (next !== String(after[id] ?? '')) out[id] = next
  }

  const parents = new Set(['verdicts', ...PAIR_PARAMS].flatMap((id) => pairParents(after[id])))
  const listed = decodeRecent(params['recent']).filter((id) => id !== neuron && parents.has(id))
  const others = [...parents].filter((id) => id !== neuron && !listed.includes(id))
  if (others.length + listed.length < KEPT_NEURONS) {
    put('recent', [...listed, neuron].join(';'))
    return { write: out, evicted: [] }
  }

  const verdicts = decodeVerdicts(after['verdicts'])
  const lists = PAIR_PARAMS.map((id) => [id, decodeExtend(after[id])] as const)
  const pairs = pairsOf([...verdicts.keys(), ...lists.flatMap(([, keys]) => [...keys])])
  const named = new Set(pairs.map((pair) => pair.piece))
  const unlisted = others.filter((id) => !named.has(id)).sort(compareIds)
  const order = [...unlisted, ...listed, neuron]
  const kept = order.slice(-KEPT_NEURONS)
  const evicted = order.slice(0, order.length - kept.length)
  put('recent', kept.join(';'))
  if (evicted.length === 0) return { write: out, evicted }

  // What the kept neurons reach through any pair keeps its pairs, whoever it was given on.
  const reach = new Set([...kept, ...piecesOf(pairs, kept).map((piece) => piece.id)])
  const keeps = (key: string) => {
    const pair = verdictPair(key)
    return pair !== undefined && reach.has(pair.neuronId)
  }
  put('verdicts', encodeVerdicts(new Map([...verdicts].filter(([key]) => keeps(key)))))
  for (const [id, keys] of lists) put(id, encodeExtend([...keys].filter(keeps)))
  // A hand pick goes with the pair that accepts it: on a root the kept neurons reach.
  if (after['picks']) {
    put(
      'picks',
      encodePicks(decodePicks(after['picks']).filter((pick) => reach.has(pick.root))),
    )
  }
  return { write: out, evicted }
}
