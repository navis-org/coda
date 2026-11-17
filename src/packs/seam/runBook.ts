/**
 * What one Suggest Merges run has found so far, kept so that **the order the work is done in is
 * not the order it is published in**.
 *
 * ## Why this exists
 *
 * A run publishes two tables as it goes, and they have to be the tables a plain run would end
 * on: each neuron's ends as its tips are listed, then each extended piece's, breadth first
 * (`pieces.ts`). The work is not done in that order. An end the memory holds is answered before
 * one that has to be measured, and a piece the reader has just extended is searched ahead of
 * the ends its neuron still has left (`docs/seam-extend-plan.md`).
 *
 * The first version handed out table rows and tip numbers *as the work was done*, so going
 * back to the plain order meant taking the pieces off seven lists by name and doing them again
 * — and each side effect of doing a piece twice needed an answer of its own. Two review rounds
 * said the same thing.
 *
 * So: **one record per root — a neuron or a piece alike — numbered within itself**, and the
 * tables are put together from the records, in the plain order, whenever they are published
 * (`assemble`). A piece can then be taken as often as wanted — early, as a draft joined by the
 * ends its parent has so far, and again once every end is in — and "again" only searches what
 * changed.
 *
 * **What follows from a root's ends is asked of the book, never kept beside it**: which of its
 * tips are still wanted (`wanted`), and where each of its pieces joins it (`contactOf`). Every
 * change to a root's ends passes through here, so the book knows when an answer is out of date.
 * Kept by the caller, the second of those went stale in the one case nobody was looking at.
 *
 * Headless and pure: no volume, no model, no clock. The node does the searching and tells this
 * what it found.
 */

import { groupBy } from '../../core/collections'
import { concatBatches } from '../../nodes/lib/tableOps'
import type { TableValue } from '../../core/values'
import type { Piece } from './pieces'
import { pieceContacts, pieceLineage } from './pieces'
import type { Lineage, PublishedEnd, TipRow } from './searchTips'

/** One neuron of the run: its tips' places in the incoming rows. */
export interface BookNeuron {
  readonly id: string
  /** For each of the neuron's tips, in its own order, the index of that tip in `rows`. */
  readonly at: readonly number[]
}

/** What the run holds of one extended piece. Everything in it is numbered within the piece. */
export interface PieceRecord {
  /** Its tips that can be searched; `row` is the row of its own tips table. */
  readonly mine: readonly TipRow[]
  /** The end it joins what it was accepted on by, as an index into `mine`. */
  readonly junction: number | undefined
  /** Its search failed part way: listed as it stands, and not tried again in this run. */
  readonly failed: boolean
}

/** The tables' inputs, in the order a plain run takes everything — `published`'s arguments. */
export interface Assembled {
  readonly table: TableValue
  /** Every searchable tip: the neurons' as they came in, then each piece's. */
  readonly tips: readonly TipRow[]
  /** Finished ends, each numbered into `tips`. */
  readonly ends: readonly PublishedEnd[]
  /** The rows of `table` the run attempts. */
  readonly attempting: ReadonlySet<number>
  /** Each piece's rows' lineage, by row of `table`; a neuron's own rows have none. */
  readonly lineage: readonly (Lineage | undefined)[]
}

/** One root as the book keeps it: a neuron, or a piece with what only a piece has. */
interface Entry {
  mine: readonly TipRow[]
  /** The indices into `mine` the run attempts. */
  attempt: Set<number>
  /** Finished ends, by index into `mine`; each end's `tip` is that index. */
  ends: Map<number, PublishedEnd>
  /** Bumped whenever `ends` changes, so what was read off them can tell it is out of date. */
  version: number
  /** A piece's own tips table, which of `mine` fit in the volume, its join and whether it failed. */
  grown?: {
    tips: TableValue
    fits: readonly boolean[]
    junction: number | undefined
    failed: boolean
  }
}

export interface RunBook {
  /** Which of a root's tips the run attempts and has no end for yet, by index into its tips. */
  wanted(root: string): number[]
  /** A root's end is finished; `end.end.tip` is the index into that root's own tips. */
  put(root: string, end: PublishedEnd): void
  /** A piece's record, where the run has found its tips. */
  piece(id: string): PieceRecord | undefined
  /** Start a piece's record. Nothing is attempted until `join` says which end is the join. */
  addPiece(
    piece: Piece,
    tips: TableValue,
    mine: readonly TipRow[],
    fits: readonly boolean[],
  ): PieceRecord
  /**
   * Where a piece touches what it was accepted on, by what its parent's ends say **now** — or
   * `undefined` where none of them lists it (`pieceContacts`). Found for all of a parent's
   * pieces in one walk, and again only once the parent's ends have changed.
   */
  contactOf(piece: Piece): readonly [number, number, number] | undefined
  /**
   * Say which end a piece joins by. Its attempts become every tip that fits, less that one —
   * and an end already found for a tip that is no longer attempted is dropped, since the tip it
   * was found at turned out to be the join. Answers whether anything changed.
   *
   * A piece whose search failed is joined like any other — where it joins is not the search's
   * to decide — but gains no attempts by it.
   */
  join(id: string, junction: number | undefined): boolean
  /**
   * A piece's search failed: what it never reached is taken off its attempts — left there those
   * rows would read "not yet" on a finished run — and it is not searched again.
   */
  fail(id: string): void
  /** How many of the pieces' open ends — the joining end is none — have no box inside the volume. */
  piecesOutside(): number
  assemble(): Assembled
}

/** A root's finished ends in the order of its tips — the order everything is published in. */
function inOrder(root: Entry): Array<[number, PublishedEnd]> {
  return [...root.ends].sort(([a], [b]) => a - b)
}

/**
 * A book for one run. `order` is every piece the reader asked for, in the order a plain run
 * takes them; a piece with no record yet is simply not in the tables.
 */
export function runBook(base: {
  table: TableValue
  rows: readonly TipRow[]
  neurons: readonly BookNeuron[]
  /** The rows of `table` the run attempts among the neurons' own. */
  attempting: ReadonlySet<number>
  order: readonly Piece[]
}): RunBook {
  const roots = new Map<string, Entry>()
  for (const neuron of base.neurons) {
    const mine = neuron.at.map((index) => base.rows[index]!)
    const attempt = new Set<number>()
    for (const [i, tip] of mine.entries()) if (base.attempting.has(tip.row)) attempt.add(i)
    roots.set(neuron.id, { mine, attempt, ends: new Map(), version: 0 })
  }
  const siblings = groupBy(base.order, (piece) => piece.parent)
  /** Where a parent's pieces join it, and the parent's `version` that was read at. */
  const joins = new Map<string, { at: number; found: ReturnType<typeof pieceContacts> }>()
  /** The parts of `assemble` that only move when a piece is added, joined or fails. */
  let shaped: { value: Omit<Assembled, 'ends'>; offsets: Map<string, number> } | undefined

  const shapeNow = () => {
    if (shaped) return shaped
    const tables = [base.table]
    const tips: TipRow[] = [...base.rows]
    const attempting = new Set(base.attempting)
    const lineage: (Lineage | undefined)[] = []
    const offsets = new Map<string, number>()
    let rows = base.table.length
    for (const piece of base.order) {
      const root = roots.get(piece.id)
      if (!root?.grown) continue
      const { grown } = root
      offsets.set(piece.id, tips.length)
      lineage.length = rows
      lineage.push(
        ...pieceLineage(
          piece,
          grown.tips.length,
          grown.junction === undefined ? undefined : root.mine[grown.junction]!.row,
        ),
      )
      for (const [i, tip] of root.mine.entries()) {
        tips.push({ ...tip, row: rows + tip.row })
        if (root.attempt.has(i)) attempting.add(rows + tip.row)
      }
      tables.push(grown.tips)
      rows += grown.tips.length
    }
    shaped = { value: { table: concatBatches(tables), tips, attempting, lineage }, offsets }
    return shaped
  }

  const rootOf = (id: string) => {
    const root = roots.get(id)
    if (!root) throw new Error(`seam run book: no record of ${id}`)
    return root
  }
  const pieceOf = (id: string) => {
    const root = rootOf(id)
    if (!root.grown) throw new Error(`seam run book: ${id} is a neuron, not a piece`)
    return { root, grown: root.grown }
  }
  /** A piece's record as it stands now. A reading, not a handle: ask again after a change. */
  const view = (root: Entry): PieceRecord => ({
    mine: root.mine,
    junction: root.grown!.junction,
    failed: root.grown!.failed,
  })

  return {
    wanted: (id) => {
      const root = rootOf(id)
      // Sorted as a guard: `attempt` is filled in rising order today, and the order is read.
      return [...root.attempt].filter((tip) => !root.ends.has(tip)).sort((a, b) => a - b)
    },
    put: (id, end) => {
      const root = rootOf(id)
      root.ends.set(end.end.tip, end)
      root.version += 1
    },
    piece: (id) => {
      const root = roots.get(id)
      return root?.grown ? view(root) : undefined
    },
    addPiece: (piece, tips, mine, fits) => {
      const root: Entry = {
        mine,
        attempt: new Set(),
        ends: new Map(),
        version: 0,
        grown: { tips, fits, junction: undefined, failed: false },
      }
      roots.set(piece.id, root)
      shaped = undefined
      return view(root)
    },
    contactOf: (piece) => {
      const parent = roots.get(piece.parent)
      if (!parent) return undefined
      let held = joins.get(piece.parent)
      if (!held || held.at !== parent.version) {
        const wanted = (siblings.get(piece.parent) ?? []).map((one) => one.id)
        held = {
          at: parent.version,
          found: pieceContacts(
            inOrder(parent).map(([, end]) => end),
            wanted,
          ),
        }
        joins.set(piece.parent, held)
      }
      return held.found.get(piece.id)
    },
    join: (id, junction) => {
      const { root, grown } = pieceOf(id)
      const attempt = new Set<number>()
      for (const [i, fit] of grown.fits.entries()) {
        // A piece whose search failed attempts only what it found: the rest stays off, as
        // `fail` left it, or those rows would read "not yet" on a finished run.
        if (fit && i !== junction && (!grown.failed || root.ends.has(i))) attempt.add(i)
      }
      const same =
        grown.junction === junction &&
        attempt.size === root.attempt.size &&
        [...attempt].every((i) => root.attempt.has(i))
      if (same) return false
      grown.junction = junction
      root.attempt = attempt
      for (const i of [...root.ends.keys()]) {
        if (attempt.has(i)) continue
        root.ends.delete(i)
        root.version += 1
      }
      shaped = undefined
      return true
    },
    fail: (id) => {
      const { root, grown } = pieceOf(id)
      grown.failed = true
      for (const i of [...root.attempt]) if (!root.ends.has(i)) root.attempt.delete(i)
      shaped = undefined
    },
    piecesOutside: () => {
      let outside = 0
      // The joining end is no open end, inside the volume or not.
      for (const { grown } of roots.values()) {
        if (!grown) continue
        outside += grown.fits.filter((fit, i) => !fit && i !== grown.junction).length
      }
      return outside
    },
    assemble: () => {
      const { value, offsets } = shapeNow()
      const ends: PublishedEnd[] = []
      const take = (root: Entry, numbered: (tip: number) => number) => {
        for (const [tip, end] of inOrder(root)) {
          ends.push({ ...end, end: { ...end.end, tip: numbered(tip) } })
        }
      }
      // Each neuron's ends as its tips are listed — whatever order they were finished in.
      for (const neuron of base.neurons) take(roots.get(neuron.id)!, (tip) => neuron.at[tip]!)
      // Then each piece's, in the plain order, numbered into the whole.
      for (const piece of base.order) {
        const offset = offsets.get(piece.id)
        if (offset !== undefined) take(roots.get(piece.id)!, (tip) => offset + tip)
      }
      return { ...value, ends }
    },
  }
}
