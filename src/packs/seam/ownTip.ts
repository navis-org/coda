/**
 * The own-tip rule: a piece is scored once, at the tip it attaches to.
 *
 * The last step of SEAM's search (`scripts/pilots/tip_show.py`'s `own_tip`, the user's decision
 * of 2026-11-04). The search runs per open end and keeps that end's best hundred candidates, so
 * a neurite lying between two ends of the same neuron turns up on both lists — and would then be
 * cut out, patched and assessed twice, with two different scores for the same piece and no rule
 * saying which to believe. This decides: a candidate stays on a list only if
 *
 * 1. its **contact** — the point where it comes nearest the query, not its centre — is within
 *    `OWN_TIP_UM` of the end the list belongs to, and
 * 2. **no other tip of the neuron is nearer** to that contact.
 *
 * Then `geo_rank` is renumbered `1..n` inside what is left, in the search's own order.
 *
 * **It is a per-neuron pass, which is why it is here and not in the bridge.** Everything else in
 * stages 4 and 5 happens inside one cutout and is vendored into `src/pyodide/seam/`; this reads
 * *every* tip of the neuron, including ends no list was ever searched for. SEAM's rv2 set has
 * one such end — 1967, on neuron 648518347669157986 — and it takes 42 candidates off three of
 * its neighbours' lists. A caller that passed only the searched ends would keep all 42, with
 * nothing downstream able to tell.
 *
 * **And it is TypeScript rather than a third vendored slice**, which `VENDORED.md` would
 * otherwise argue for. The rule is fifteen lines of numpy in one contiguous run, so slicing it
 * is possible — but a slice would make the whole per-neuron pass a Pyodide crossing carrying
 * every tip of the neuron, to run a nearest-neighbour query the editor already has an index for.
 * `tips.ts` beside it made the same call for the same reason, and the cost of both is that a
 * drift here is invisible to SEAM: `ownTip.test.ts` against SEAM's own kept set is what stands
 * in for the byte comparison the vendored files get.
 *
 * Headless and pure, like `tips.ts`.
 */

import { NM_PER_UM } from '../../data/units'
import type { KdTree } from '../../nodes/lib/kdTree'
import { buildKdTree } from '../../nodes/lib/kdTree'
import type { CandidateSearch } from '../../pyodide/cutoutSummary'

/**
 * How far a contact may be from its own tip, in micrometres — `tip_show.OWN_TIP_UM`.
 *
 * SEAM's number, not a knob: the rv2 set's `p_tip`, its cutoff and `r` were all fitted on lists
 * this rule had already been applied to, so a different limit gives a different set of
 * candidates scored against thresholds that no longer apply to it. `fixture.json` publishes the
 * value the set was built with (`pipeline.own_tip.own_um`), and **a caller holding a manifest
 * should pass that** rather than trusting this default to still agree — the same rule
 * `suggestionSet.ts` follows for the `shown` cutoff, which SEAM refits whenever a stage changes.
 *
 * It is a loose constant rather than a field of `tips.ts`' `SEAM_TIP_RULE`, which bundles its
 * six numbers precisely because they are one rule. The line between them is SEAM's own: the tip
 * rule decides *what a tip is* and its numbers were fitted together, while this one is applied
 * afterwards to a ranked list, and SEAM's manifest keeps `pipeline.tips` and `pipeline.own_tip`
 * as two blocks for that reason.
 */
export const OWN_TIP_UM = 2.0

/**
 * The columns this reads, **by SEAM's own names**.
 *
 * Checked at the top of `ownTipRule` rather than assumed, because a missing column arrives as
 * `undefined` and a list that reads nothing out of it keeps everything — a full answer with no
 * symptom.
 */
const NEEDED = ['contact_x_nm', 'contact_y_nm', 'contact_z_nm', 'geo_rank'] as const

/**
 * One open end's ranked candidates — the shape `runCandidateSearch` hands back, plus which end
 * it was searched at.
 *
 * **`columns` is passed through rather than re-spelled**, and that is the point. The search's
 * result names SEAM's own columns (`cutoutSummary.ts` argues for that: a subset named on this
 * side is a second list to keep in step with a file vendored precisely so it cannot drift).
 * Naming four of them again here in camelCase would put a hand-written transliteration at every
 * call site — and a swapped axis in one of those is silent, which is exactly what the contact
 * check in `pnpm probe:candidate-search` exists to catch one layer down.
 */
export type EndCandidates = Pick<CandidateSearch, 'rows' | 'columns'> & {
  /**
   * Which tip of the neuron this list was searched at — an **index into `tipsNm`**.
   *
   * An index rather than a position, so that the rule can ask "is the nearest tip this one?"
   * by identity. Two tips at the same place would otherwise be indistinguishable, and the whole
   * point of the rule is to pick exactly one of them.
   */
  readonly tip: number
}

/** What the rule left of one list. */
export interface OwnTipList {
  /** The tip it was searched at, carried through unchanged. */
  readonly tip: number
  /**
   * The rows that survived, as indices into the list given, **in the new rank's order** — so a
   * kept row's renumbered `geo_rank` is its position here plus one.
   *
   * Indices rather than a rebuilt table because the caller holds the columns: the search returns
   * eight features, a score and a contact point per row, and copying all of them here would be a
   * second place for the column list to live.
   */
  readonly kept: Int32Array
  /** Dropped for a contact further than `ownUm` from this list's own tip. */
  readonly tooFar: number
  /** Near enough, but another tip of the neuron lies nearer the contact. */
  readonly anothersTip: number
}

/**
 * For each tip, the lowest-numbered tip standing at exactly the same place — itself, usually.
 *
 * **The tie-break, decided once instead of per candidate.** The k-d tree keeps the first
 * strictly-nearer point it meets, so which of two tips at the same distance it names depends on
 * the order its traversal happened to reach them; SEAM asks `cKDTree.query`, which answers the
 * lowest index. Left alone the two disagree, and quietly: one of a pair of tips loses *every*
 * candidate it shares with the other, which reads downstream as an end with nothing near it.
 *
 * Two tips at one place is the case that can really arise — the tip rule snaps every end onto
 * the nearest mesh vertex, and a short spur's two ends can land on one. A tie between tips at
 * *different* places needs two distances equal to the last bit and does not survive floating
 * point, so this map is the whole of it. rv2 has neither: no neuron in it has two tips at one
 * position, and none of its 141,980 near-enough contacts is equidistant from two — so nothing
 * in the golden exercises this and `ownTip.test.ts` builds the case by hand.
 *
 * A map over the tips rather than a scan per candidate: the question "is any tip nearer than
 * mine" is already the tree's, and all this adds is which of a coincident pair owns the place.
 */
function canonicalTips(tipsNm: Float32Array, tips: number): Int32Array {
  const canonical = new Int32Array(tips)
  const first = new Map<string, number>()
  for (let i = 0; i < tips; i++) {
    const at = `${tipsNm[i * 3]},${tipsNm[i * 3 + 1]},${tipsNm[i * 3 + 2]}`
    const held = first.get(at)
    if (held === undefined) {
      first.set(at, i)
      canonical[i] = i
    } else {
      canonical[i] = held
    }
  }
  return canonical
}

/**
 * Apply the rule to one neuron's lists.
 *
 * `tipsNm` is **every** open end of the neuron, `n × 3` nanometres in the layout
 * `Tips.positions` uses — the snapped positions, which is what the search was run at. The lists
 * may cover any subset of them; an end with no list simply takes candidates away from its
 * neighbours, which is exactly what it does in SEAM.
 */
export function ownTipRule(
  tipsNm: Float32Array,
  lists: readonly EndCandidates[],
  ownUm = OWN_TIP_UM,
): OwnTipList[] {
  /*
   * Everything is checked before anything is built. A caller walking a neuron set would
   * otherwise pay for one tree per neuron before learning that its lists were malformed, and
   * the tip range is a property of the *call* — tips and lists together — rather than of any
   * one list.
   */
  const tips = Math.floor(tipsNm.length / 3)
  const at = new Set<number>()
  for (const one of lists) {
    refuseBadList(one, tips)
    /*
     * One list per end. Two lists at one tip would each keep the candidates they share, which
     * is the double-scoring the whole rule exists to prevent — and it would do it silently,
     * since each list on its own is a perfectly ordinary answer. Every other malformed shape
     * is refused here, so staying quiet about this one would read as accepting it.
     */
    if (at.has(one.tip)) {
      throw new Error(`Two candidate lists are at tip ${one.tip}; the rule takes one per end.`)
    }
    at.add(one.tip)
  }
  const tree = buildKdTree(tipsNm)
  /*
   * Squared, so the per-row test is three multiplications rather than a `Math.hypot` whose root
   * the comparison throws away — and so both halves of the rule decide in the same space, since
   * the k-d tree compares squared throughout. `tips.ts` precomputes `somaSq` for the same
   * reason. Overflow is not a risk at nanometre coordinates: 10^6 nm squared is 10^12, which a
   * double holds exactly.
   */
  const limitSq = (ownUm * NM_PER_UM) ** 2
  const canonical = canonicalTips(tipsNm, tips)
  return lists.map((one) => decide(one, tipsNm, tree, canonical, limitSq))
}

function refuseBadList(one: EndCandidates, tips: number): void {
  if (!Number.isInteger(one.tip) || one.tip < 0 || one.tip >= tips) {
    throw new Error(
      `A candidate list is at tip ${one.tip}, which is not one of the ${tips} tips given. ` +
        'The rule asks whether another tip of the neuron is nearer, so it needs the whole set.',
    )
  }
  for (const name of NEEDED) {
    const column = one.columns[name]
    if (!column) {
      throw new Error(`The candidate list at tip ${one.tip} has no "${name}" column.`)
    }
    if (column.length !== one.rows) {
      throw new Error(
        `The list at tip ${one.tip} says ${one.rows} rows and its "${name}" column has ${column.length}.`,
      )
    }
  }
}

function decide(
  one: EndCandidates,
  tipsNm: Float32Array,
  tree: KdTree,
  canonical: Int32Array,
  limitSq: number,
): OwnTipList {
  /*
   * Which tip owns this list's place. Where a tip shares it with a lower-numbered one, that is
   * the other tip — and then this list keeps nothing, every near-enough candidate counting as
   * the twin's. That is the rule doing its job rather than an edge case: the pair is one place,
   * and a piece attached there is scored once.
   */
  const owner = canonical[one.tip]!
  // Bound once: each `one.columns[name]` is a property load, and the loop runs per candidate.
  const xs = one.columns['contact_x_nm']!
  const ys = one.columns['contact_y_nm']!
  const zs = one.columns['contact_z_nm']!
  const rank = one.columns['geo_rank']!
  const ownX = tipsNm[one.tip * 3]!
  const ownY = tipsNm[one.tip * 3 + 1]!
  const ownZ = tipsNm[one.tip * 3 + 2]!
  let tooFar = 0
  let anothersTip = 0
  const kept: number[] = []
  for (let i = 0; i < one.rows; i++) {
    const x = xs[i]!
    const y = ys[i]!
    const z = zs[i]!
    const dx = x - ownX
    const dy = y - ownY
    const dz = z - ownZ
    if (dx * dx + dy * dy + dz * dz > limitSq) {
      tooFar += 1
      continue
    }
    /*
     * Unbounded, although the own tip is already known to be within the limit. Bounding the
     * search at that distance would reject a contact sitting *exactly* on the limit — the
     * traversal keeps a point only when it is strictly nearer than the bound — and turn a kept
     * candidate into a dropped one at the one distance the rule explicitly admits. It costs
     * almost nothing: the walk self-bounds at its first leaf.
     */
    const nearest = tree.nearestIndex(x, y, z)
    if (canonical[nearest]! !== owner || owner !== one.tip) {
      anothersTip += 1
      continue
    }
    kept.push(i)
  }
  /*
   * The renumbering itself, which is pandas' `rank(method='first')` over `geo_rank` — not a
   * repair of a list that arrived out of order. Reading the column rather than trusting the row
   * order is what makes the rule independent of how the rows were handed over; `kept` is built
   * ascending, so the tie-break keeps arrival order without resting on `sort` being stable.
   */
  kept.sort((a, b) => rank[a]! - rank[b]! || a - b)
  return { tip: one.tip, kept: Int32Array.from(kept), tooFar, anothersTip }
}
