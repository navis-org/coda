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
 * The output of `seam:review` the pairs leave by, and so the one a reference to it is read from.
 * One spelling for the node's port, its `asReference`, Suggest Merges' `producedBy` and the card.
 */
export const EXTENDED_PORT = 'extended'

/** The table a reference to `seam:review` is handed: one row per pair. */
export const EXTENDED_FIELDS: readonly Field[] = [
  field('parent', 'parent', 'str'),
  field('piece', 'piece', 'str'),
]

export function extendedSchema(): TableSchema {
  return schemaOf(EXTENDED_FIELDS)
}

/** The pairs as the table `seam:review` publishes — the one writer of that shape. */
export function extendedTable(pairs: readonly ExtendPair[]): TableValue {
  return tableOf(EXTENDED_FIELDS, {
    parent: pairs.map((pair) => pair.parent),
    piece: pairs.map((pair) => pair.piece),
  })
}

/**
 * The pairs out of whatever is on the wire — and nothing for anything that is not such a table.
 *
 * Read strictly, because each id is about to be a root the search asks a chunkedgraph for: a row
 * that is not two chunkedgraph ids, or names a piece as its own parent, is left out.
 */
export function extendPairs(value: Value | undefined): ExtendPair[] {
  if (!isTableValue(value)) return []
  const parents = value.data['parent'] ?? []
  const pieces = value.data['piece'] ?? []
  const out: ExtendPair[] = []
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const parent = idText(parents[i] ?? null)
    const piece = idText(pieces[i] ?? null)
    if (!parent || !piece || parent === piece) continue
    // `isNodeId`, as the merge plan asks of the same ids: 0 is "no object", and read as a
    // piece it would have every unlisted supervoxel in a box written as the neuron's.
    if (!isNodeId(parent) || !isNodeId(piece)) continue
    const key = `${parent}/${piece}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ parent, piece })
  }
  return out
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
 * most of what an Extend pressed on a large neuron cost. The ids are `extendPairs`', so each is
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
