/**
 * The pieces a neuron is being extended with, as Suggest Merges searches them.
 *
 * `docs/seam-extend-plan.md` has the feature. A reader accepts a candidate on one of a neuron's
 * tips and presses Extend; the search then finds *that piece's* open ends and looks for what
 * continues them, treating the neuron and the pieces between as one object. This module is the
 * part of that with no I/O in it — which pieces, in what order, joined where — so that every
 * rule here has a test. The node (`suggestMerges.ts`) does the reading.
 *
 * ## What is extended arrives as pairs, and the tree is derived
 *
 * `seam:review` hands over a table of `parent`/`piece` pairs (`EXTENDED_FIELDS`), read through a
 * reference wire from its params alone. A pair says "this piece was accepted on that one's tip,
 * and is to be extended". The seeds are the neurons of the tips table; everything else follows.
 *
 * **The order must not depend on the order of clicks**, because the tables are built in it and a
 * reload followed by Run has to produce the tables the session did. So:
 *
 * - a piece belongs to **one** tree, at its smallest number of steps from any seed;
 * - reached by two routes of that length, it takes the parent with the lower id;
 * - pieces come out a seed at a time, breadth first within it — each level in the order of
 *   their parents, then by id.
 *
 * A pair no seed reaches says nothing: its parent was un-accepted, or belongs to another run.
 *
 * ## One neuron, not two objects that touch
 *
 * A piece's **path** is the seed and every piece between the seed and it. Not its siblings and
 * not anything accepted later — so a piece's answer does not change with what else was accepted,
 * and an end, once published, stays as it was.
 *
 * - `aliasOf`: in every box read for the piece, the path's roots are written as the seed's, so
 *   the pool, the sizes and the assessor's patches see one neuron. It rides on each end
 *   (`endToSearch`), which is also what has the neuron's size counted as the path's, summed —
 *   `queryCountOf` in `searchRun.ts`;
 * - `junctionOf`: the piece's end that faces the neuron is not searched. Phase 0 measured it a
 *   median 0.25 µm from the contact the piece was accepted at. **The one nearest tip**, where it
 *   is within the own-tip radius — not every tip within it: a piece of one level-2 chunk is
 *   shorter than that radius, and both its ends would go.
 *
 * Headless and pure.
 */

import { groupBy } from '../../core/collections'
import { compareIds, idText } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import type { TableValue, Value } from '../../core/values'
import { isTableValue } from '../../core/values'
import { isNodeId } from '../../data/cave/graphLayout'
import { nearestNode } from '../../data/soma'
import { NM_PER_UM } from '../../data/units'
import type { Lineage, PublishedEnd, TipRow } from './searchTips'
import { tipPositions } from './searchTips'
import type { Field } from './suggestionTables'
import { field, schemaOf, tableOf } from './suggestionTables'

/** "This piece, accepted on that one, is to be extended." */
export interface ExtendPair {
  readonly parent: string
  readonly piece: string
}

/**
 * A pair's key, `parent/piece` — **one spelling**, and the key a reader's verdict on a candidate is
 * filed under too (`seam:review`'s `verdicts`): the neuron or piece a tip is on, and the candidate.
 * Both ids are digits, so neither can hold the separator. An older verdict key, `end_uid:id`,
 * reads as no pair (`verdictPair`), so it can never be taken for one.
 */
export const verdictKey = (neuronId: string, candidateId: string): string =>
  `${neuronId}/${candidateId}`

/** A key's two ids, or undefined for one of the old shape (or a hand edit). */
export function verdictPair(
  key: string,
): { neuronId: string; candidateId: string } | undefined {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return undefined
  return { neuronId: key.slice(0, at), candidateId: key.slice(at + 1) }
}

/** Keys as pairs, in the order given; a key that is no pair is left out. */
export function pairsOf(keys: Iterable<string>): ExtendPair[] {
  const out: ExtendPair[] = []
  for (const key of keys) {
    const pair = verdictPair(key)
    if (pair) out.push({ parent: pair.neuronId, piece: pair.candidateId })
  }
  return out
}

/**
 * The output of `seam:review` the pairs leave by, and so the one a reference to it is read from.
 * One spelling for the node's port, its `asReference`, Suggest Merges' `producedBy` and the card.
 */
export const EXTENDED_PORT = 'extended'

/**
 * The table a reference to `seam:review` is handed: one row per pair, and what the row says of it.
 *
 * `mode` is `extend` for a piece extended by hand, `auto` for one Auto-extend was pressed on, and
 * `refused` for a pair the reader gave a verdict other than accept — which Auto-extend must not
 * take, and which is sent only while an Auto-extend is live (`docs/seam-auto-extend-plan.md`).
 * A table without the column is every row `extend`, as before it existed.
 *
 * `auto_min_q` is the reader's own floor for Auto-extend (`ExtendPlan.autoMinQ`), the same on every
 * row and written only while an Auto-extend is live — as the refusals are — so changing it with
 * none to apply it to re-keys no search. Empty, or a table without it, is SEAM's cutoff alone.
 */
export const EXTENDED_FIELDS: readonly Field[] = [
  field('parent', 'parent', 'str'),
  field('piece', 'piece', 'str'),
  field('mode', 'mode', 'str'),
  field('auto_min_q', 'auto_min_q', 'f64'),
]

type ExtendMode = 'extend' | 'auto' | 'refused'

export function extendedSchema(): TableSchema {
  return schemaOf(EXTENDED_FIELDS)
}

/** What Review hands the search: the pieces to extend, and what Auto-extend is told. */
export interface ExtendPlan {
  /** Every piece extended, by hand or by an Auto-extend press — `auto` pairs among them. */
  readonly pairs: readonly ExtendPair[]
  /** The pieces Auto-extend was pressed on, by id. Each is a piece of a pair in `pairs`. */
  readonly roots: ReadonlySet<string>
  /** Pairs, as `parent/piece`, that Auto-extend must not accept: the reader said otherwise. */
  readonly refused: ReadonlySet<string>
  /**
   * The least `q` Auto-extend takes a first candidate at, on top of SEAM's cutoff (`autoTakes`):
   * the reader's to raise (user, 2026-11-19). Undefined is SEAM's cutoff alone.
   */
  readonly autoMinQ?: number | undefined
}

/** The plan as the table `seam:review` publishes — the one writer of that shape. */
export function extendedTable(plan: ExtendPlan): TableValue {
  const refused = pairsOf([...plan.refused].sort())
  const rows = [...plan.pairs, ...refused]
  return tableOf(EXTENDED_FIELDS, {
    parent: rows.map((pair) => pair.parent),
    piece: rows.map((pair) => pair.piece),
    mode: [
      ...plan.pairs.map((pair): ExtendMode => (plan.roots.has(pair.piece) ? 'auto' : 'extend')),
      ...refused.map((): ExtendMode => 'refused'),
    ],
    auto_min_q: rows.map(() => plan.autoMinQ ?? null),
  })
}

/**
 * The plan out of whatever is on the wire — and nothing for anything that is not such a table.
 *
 * Read strictly, because each id is about to be a root the search asks a chunkedgraph for: a row
 * that is not two chunkedgraph ids, or names a piece as its own parent, is left out.
 */
export function extendPlanOf(value: Value | undefined): ExtendPlan {
  const pairs: ExtendPair[] = []
  const roots = new Set<string>()
  const refused = new Set<string>()
  if (!isTableValue(value)) return { pairs, roots, refused }
  const parents = value.data['parent'] ?? []
  const pieces = value.data['piece'] ?? []
  const modes = value.data['mode']
  // The same on every row; a cell that is no chance is SEAM's cutoff alone.
  const floor = (value.data['auto_min_q'] ?? []).find(
    (cell): cell is number => typeof cell === 'number' && cell >= 0 && cell <= 1,
  )
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const parent = idText(parents[i] ?? null)
    const piece = idText(pieces[i] ?? null)
    if (!parent || !piece || parent === piece) continue
    // `isNodeId`, as the merge plan asks of the same ids: 0 is "no object", and read as a
    // piece it would have every unlisted supervoxel in a box written as the neuron's.
    if (!isNodeId(parent) || !isNodeId(piece)) continue
    const key = verdictKey(parent, piece)
    const mode = modes?.[i] ?? 'extend'
    if (mode === 'refused') {
      refused.add(key)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ parent, piece })
    if (mode === 'auto') roots.add(piece)
  }
  return { pairs, roots, refused, ...(floor === undefined ? {} : { autoMinQ: floor }) }
}

/**
 * From this many level-2 chunks a piece is large: the Extend button says so, `Extend on accept`
 * leaves it to the button, and Auto-extend does not accept it (users, 2026-11-16 and -18).
 *
 * Measured, not chosen (`docs/seam-extend-plan.md`, phase 0): below it a piece's open ends were
 * found in under 2 s and it had a handful of them; from 41 chunks the median was 6 s and 73 tips,
 * 21 s at 496 chunks and 150 s at 2,704 — before any end is searched. Said, never refused
 * (`docs/limits.md`): one press still extends it.
 */
export const LARGE_PIECE_CHUNKS = 41

/**
 * How many layers of pieces one Auto-extend press may accept, counted from the piece it was
 * pressed on (user, 2026-11-18). Pieces on the last layer are accepted and not searched.
 */
export const AUTO_DEPTH = 10

/** What `autoTakes` asks of an end's first candidate. */
export interface AutoFirst {
  readonly shown: boolean | null | undefined
  /** SEAM's `q` for the tip: the number its cutoff is a value of. */
  readonly q: number | null | undefined
  readonly organelle: boolean | null | undefined
  readonly l2Chunks: number | null | undefined
  readonly id: string
}

/**
 * Whether Auto-extend takes an end's first candidate — **the one rule**, read by the search over
 * its finished ends and by the card over the published rows, so the two grow the same tree.
 *
 * SEAM's own cutoff (`shown`, and only an explicit `true`: a run with no assessor has no cutoff),
 * and the reader's floor on `q` where one is set (`ExtendPlan.autoMinQ`) — which can only raise
 * the bar, since the cutoff still applies under it — not an organelle, not large, and a real
 * object.
 */
export function autoTakes(first: AutoFirst, minQ?: number): boolean {
  if (first.shown !== true || first.organelle === true) return false
  if (minQ !== undefined && !(typeof first.q === 'number' && first.q >= minQ)) return false
  if (typeof first.l2Chunks === 'number' && first.l2Chunks >= LARGE_PIECE_CHUNKS) return false
  return isNodeId(first.id)
}

/**
 * The size Auto-extend turned an end's first candidate down for, where that was **its size
 * alone** — refused by `autoTakes`, taken with the size left out, so the two cannot drift. Where a
 * chain stops on a piece this large it has usually run into a false merge, in that piece or in the
 * chain itself (user, 2026-11-21), so the card marks the row.
 */
export function autoTooLarge(first: AutoFirst, minQ?: number): number | undefined {
  if (autoTakes(first, minQ) || !autoTakes({ ...first, l2Chunks: undefined }, minQ)) return
  return first.l2Chunks ?? undefined
}

/** What Auto-extend added to the tree: the tree, and which pairs it accepted. */
export interface AutoGrowth {
  /** Every piece placed — by hand and by Auto-extend — in `piecesOf`'s order. */
  readonly tree: readonly Piece[]
  /** The pieces whose own ends are searched: all of `tree` but Auto-extend's last layer. */
  readonly searched: readonly Piece[]
  /** The pairs Auto-extend accepted, as `parent/piece`, each to the piece it was pressed on. */
  readonly accepted: ReadonlyMap<string, string>
  /**
   * The pieces whose ends Auto-extend reads: below a press and fewer than `AUTO_DEPTH` layers
   * down — where the card looks for a chain stopped on a large piece (`autoStoppedLarge`).
   */
  readonly autoRead: readonly Piece[]
}

/**
 * The tree, with what Auto-extend accepted grown onto it — **one derivation, read by the search
 * and by the card**, so what is searched and what is listed as accepted cannot disagree.
 *
 * In rounds from the pairs extended by hand: every searched piece below an Auto-extend press, and
 * fewer than `AUTO_DEPTH` layers below it, offers the first candidates `firsts` names for its
 * ends (already filtered by `autoTakes`). A candidate is taken unless it is refused, a seed,
 * extended by hand, or placed in the tree already — **so a piece is never taken twice**, each
 * round only adds pairs, and the rounds end. (A piece the reader extended *beyond* one Auto-extend
 * took can move nearer the seed once that one is placed; `RunBook.reorder` searches it again
 * there.) A candidate offered by two pieces in one round goes to the nearer the seed, then to the
 * lower id: `piecesOf`'s rule. A press nested under another's tree starts its own count.
 *
 * Nothing here depends on the order of clicks: the rounds are a function of the pairs and of
 * what the ends say, so a reload and a run end on the same tree.
 */
export function growAuto(
  plan: ExtendPlan,
  seeds: readonly string[],
  /** The first candidates Auto-extend may take at a piece's ends, in its tips' order. */
  firsts: (piece: Piece) => readonly string[],
): AutoGrowth {
  const accepted = new Map<string, string>()
  if (plan.roots.size === 0) {
    const tree = piecesOf(plan.pairs, seeds)
    return { tree, searched: tree, accepted, autoRead: [] }
  }
  /** Auto-extend's last layer: accepted, never searched, and offering nothing. */
  const last = new Set<string>()
  const pairs = [...plan.pairs]
  // A piece the reader extended by hand is theirs, wherever the tree places it: never taken too.
  const reserved = new Set([...seeds, ...plan.pairs.map((pair) => pair.piece)])
  for (;;) {
    const tree = piecesOf(pairs, seeds)
    const placed = new Set(tree.map((piece) => piece.id))
    const claims = new Map<string, { parent: Piece; root: string; layer: number }>()
    const autoRead: Piece[] = []
    for (const piece of tree) {
      if (last.has(piece.id)) continue
      const from = pressedOn(piece, plan.roots)
      if (!from || from.layer >= AUTO_DEPTH) continue
      autoRead.push(piece)
      for (const id of firsts(piece)) {
        if (reserved.has(id) || placed.has(id)) continue
        if (plan.refused.has(verdictKey(piece.id, id))) continue
        if (nearerClaim(piece, claims.get(id)?.parent)) {
          claims.set(id, { parent: piece, root: from.root, layer: from.layer + 1 })
        }
      }
    }
    if (claims.size === 0) {
      return { tree, searched: tree.filter((piece) => !last.has(piece.id)), accepted, autoRead }
    }
    for (const [id, claim] of [...claims].sort(([a], [b]) => compareIds(a, b))) {
      pairs.push({ parent: claim.parent.id, piece: id })
      accepted.set(verdictKey(claim.parent.id, id), claim.root)
      if (claim.layer >= AUTO_DEPTH) last.add(id)
    }
  }
}

/**
 * Whether a parent's claim on a candidate beats the claim held: **nearer the seed, then the lower
 * id** — `piecesOf`'s rule, so a piece two parents offer goes to the one the tree would place it
 * under. Read by `growAuto` and by `Auto-extend listed` (`listedAutoPairs`).
 */
export function nearerClaim(
  parent: { readonly depth: number; readonly id: string },
  held: { readonly depth: number; readonly id: string } | undefined,
): boolean {
  if (!held) return true
  return (
    parent.depth < held.depth ||
    (parent.depth === held.depth && compareIds(parent.id, held.id) < 0)
  )
}

/**
 * The nearest Auto-extend press on a piece's way to its seed, itself included, and how far up.
 * Every id on a placed piece's path is placed: `piecesOf` reaches a piece only through it.
 */
function pressedOn(
  piece: Piece,
  roots: ReadonlySet<string>,
): { root: string; layer: number } | undefined {
  for (let at = piece.path.length - 1; at > 0; at--) {
    const id = piece.path[at]!
    if (roots.has(id)) return { root: id, layer: piece.path.length - 1 - at }
  }
  return undefined
}

/**
 * Where a piece sits, as one string: its path. Two readings of a piece with the same key were
 * searched as part of the same neuron-so-far (`aliasOf`), so their ends are the same ends.
 */
export function pathKey(piece: Pick<Piece, 'path'>): string {
  return piece.path.join('/')
}

/** One piece of a neuron being extended, placed in its tree. */
export interface Piece {
  readonly id: string
  /** The neuron the tree grows from — the id its whole path is read as. */
  readonly seed: string
  /** What it was accepted on: the seed, or another piece. */
  readonly parent: string
  /** Steps from the seed; a piece accepted on the seed itself is 1. */
  readonly depth: number
  /** The seed first, this piece last. */
  readonly path: readonly string[]
}

/**
 * Every piece a seed reaches, breadth first — the header's three rules.
 *
 * Level by level across all the seeds at once, so "the smallest number of steps from any seed"
 * is decided before "which seed": a piece accepted on two neurons under review joins the tree
 * that reaches it first, and at a tie the parent with the lower id.
 */
export function piecesOf(pairs: readonly ExtendPair[], seeds: readonly string[]): Piece[] {
  const children = groupBy(pairs, (pair) => pair.parent)
  const placed = new Set(seeds)
  const out: Piece[] = []
  let level: Array<{ id: string; seed: string; path: readonly string[] }> = seeds.map(
    (seed) => ({
      id: seed,
      seed,
      path: [seed],
    }),
  )
  for (let depth = 1; level.length > 0; depth++) {
    // The best parent for each piece first seen at this depth.
    const found = new Map<string, (typeof level)[number]>()
    for (const parent of level) {
      for (const { piece } of children.get(parent.id) ?? []) {
        if (placed.has(piece)) continue
        const rival = found.get(piece)
        if (!rival || compareIds(parent.id, rival.id) < 0) found.set(piece, parent)
      }
    }
    const rank = new Map(level.map((parent, at) => [parent.id, at]))
    const next = [...found].sort(
      ([a, parentA], [b, parentB]) =>
        rank.get(parentA.id)! - rank.get(parentB.id)! || compareIds(a, b),
    )
    level = next.map(([id, parent]) => {
      placed.add(id)
      const path = [...parent.path, id]
      out.push({ id, seed: parent.seed, parent: parent.id, depth, path })
      return { id, seed: parent.seed, path }
    })
  }
  /*
   * A seed at a time, each still breadth first. Which tree a piece belongs to is decided level by
   * level across the seeds, above; the *order* is by seed, because one neuron's pieces overlap
   * each other in the volume and two neurons' do not — taken level by level across seeds, the
   * search would drop and ask again for the same supervoxels' roots at every turn.
   */
  const rank = new Map(seeds.map((seed, at) => [seed, at]))
  return out
    .map((piece, at) => ({ piece, at }))
    .sort((a, b) => rank.get(a.piece.seed)! - rank.get(b.piece.seed)! || a.at - b.at)
    .map(({ piece }) => piece)
}

/**
 * Where each piece touches what it was accepted on, in nanometres — read off the parent's
 * finished ends, and absent where none of them lists the piece.
 *
 * A piece can be listed at more than one of the parent's tips. **The smallest gap wins** — what
 * `acceptedPieces` orders an accepted piece's rows by first, so the junction looked for here is
 * the place Submit tries first to make the merge at (`mergePlan.ts` tries the piece's rows on
 * its parent in that order).
 *
 * **For all of one parent's pieces at once, in one walk of its ends.** Compared as the numbers the lists hold: a string per candidate of every end of the parent was
 * most of what an Extend pressed on a large neuron cost. The ids are `extendPlanOf`'s, so each is
 * a chunkedgraph id and always parses.
 */
export function pieceContacts(
  parentEnds: readonly PublishedEnd[],
  pieceIds: readonly string[],
): Map<string, readonly [number, number, number]> {
  const best = new Map<
    bigint,
    { id: string; gap: number; at: readonly [number, number, number] }
  >()
  const wanted = new Map(pieceIds.map((id) => [BigInt(id), id]))
  for (const { end } of parentEnds) {
    for (let i = 0; i < end.candRoot.length; i++) {
      const root = end.candRoot[i]!
      const id = wanted.get(root)
      if (id === undefined) continue
      const at = [
        end.columns['contact_x_nm']?.[i],
        end.columns['contact_y_nm']?.[i],
        end.columns['contact_z_nm']?.[i],
      ]
      if (!at.every((value) => typeof value === 'number' && Number.isFinite(value))) continue
      const gap = end.columns['min_dist_um']?.[i]
      const measured = typeof gap === 'number' && Number.isFinite(gap) ? gap : Infinity
      const held = best.get(root)
      // Strictly smaller, so the first listing keeps a tie.
      if (!held || measured < held.gap) {
        best.set(root, { id, gap: measured, at: at as [number, number, number] })
      }
    }
  }
  return new Map([...best.values()].map((one) => [one.id, one.at]))
}

/**
 * Which of a piece's tips is the end that joins it to the neuron — an index into `tips`, or
 * `undefined` where there is no contact to measure from or no tip near it.
 */
export function junctionOf(
  tips: readonly TipRow[],
  contactNm: readonly [number, number, number] | undefined,
  ownUm: number,
): number | undefined {
  if (!contactNm) return undefined
  // In the positions the own-tip rule itself measures, so the two agree on what is near a tip.
  const at = nearestNode(tipPositions(tips), contactNm, ownUm * NM_PER_UM)
  return at < 0 ? undefined : at
}

/** The roots a piece's boxes are to read as the seed's: its path, less the seed itself. */
export function aliasOf(piece: Pick<Piece, 'seed' | 'path'>): Map<bigint, bigint> {
  const seed = BigInt(piece.seed)
  return new Map(piece.path.filter((id) => id !== piece.seed).map((id) => [BigInt(id), seed]))
}

/**
 * The lineage of a piece's rows, for `tipsWithFirsts` — one entry per row of the piece's own
 * tips table, the joining end marked.
 */
export function pieceLineage(
  piece: Piece,
  rows: number,
  /** Which row of the piece's table is the end it joins by, where one was found. */
  junctionRow: number | undefined,
): Lineage[] {
  return Array.from({ length: rows }, (_, row) => ({
    seed: piece.seed,
    parent: piece.parent,
    depth: piece.depth,
    junction: row === junctionRow,
  }))
}
