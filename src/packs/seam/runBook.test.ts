/**
 * The run's book: one record per root, and the tables put together from the records in the
 * order a plain run takes everything — whatever order the work was done in.
 *
 * What is pinned is that property. Nearly every test here does the work in an order a plain
 * run never would, and asks for the plain run's answer. The last block is the whole rule the
 * node follows for a piece — where it joins, which end is the join, what is still wanted —
 * driven twice over: early, on what its parent had so far, and in the plain order.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { TableValue } from '../../core/values'
import type { Piece } from './pieces'
import { junctionOf } from './pieces'
import { runBook } from './runBook'
import type { RunBook } from './runBook'
import type { PublishedEnd, TipRow } from './searchTips'

const N1 = '720'
const N2 = '721'

const tipsTable = (ids: readonly string[]): TableValue =>
  makeTable(tableSchema(column(ID_COLUMN_NAME, 'str'), column('end_uid', 'i64')), {
    [ID_COLUMN_NAME]: [...ids],
    end_uid: ids.map((_, i) => i),
  })

/** A tip at `x` micrometres along one axis, which is all `junctionOf` needs to tell them apart. */
const tip = (neuronId: string, row: number, xUm = row): TipRow => ({
  neuronId,
  endUid: row,
  nm: [xUm * 1000, 0, 0],
  eTip: undefined,
  row,
})

/** What an end lists: a root, how far off it is, and where the two touch (µm along the axis). */
type Listed = { root: string; gap: number; at: number }
/**
 * An end as the book and `pieceContacts` read it: which tip it is the end of, a name to follow
 * it by, and its list. The rest of a real end is the search's and is not read here.
 */
const end = (at: number, name: string, lists: readonly Listed[] = []): PublishedEnd =>
  ({
    end: {
      tip: at,
      name,
      candRoot: BigUint64Array.from(lists.map((one) => BigInt(one.root))),
      columns: {
        contact_x_nm: lists.map((one) => one.at * 1000),
        contact_y_nm: lists.map(() => 0),
        contact_z_nm: lists.map(() => 0),
        min_dist_um: lists.map((one) => one.gap),
      },
    },
    order: new Int32Array(),
  }) as unknown as PublishedEnd
const named = (ends: readonly PublishedEnd[]) =>
  ends.map((one) => `${(one.end as unknown as { name: string }).name}@${one.end.tip}`)

const piece = (id: string, parent: string, path: string[]): Piece => ({
  id,
  seed: N1,
  parent,
  depth: path.length - 1,
  path,
})
const P1 = piece('801', N1, [N1, '801'])
const P2 = piece('802', N1, [N1, '802'])
const Q = piece('803', '801', [N1, '801', '803'])

/** Two neurons, **interleaved** in the table: the first has rows 0 and 2, the second row 1. */
const base = () =>
  runBook({
    table: tipsTable([N1, N2, N1]),
    rows: [tip(N1, 0), tip(N2, 1), tip(N1, 2)],
    neurons: [
      { id: N1, at: [0, 2] },
      { id: N2, at: [1] },
    ],
    attempting: new Set([0, 1, 2]),
    order: [P1, P2, Q],
  })
/** A piece's record: tips at the given places, all of which fit. */
const add = (book: RunBook, one: Piece, places: readonly number[]) =>
  book.addPiece(
    one,
    tipsTable(places.map(() => one.id)),
    places.map((x, i) => tip(one.id, i, x)),
    places.map(() => true),
  )

describe('the run book', () => {
  it('starts as the incoming table, with every neuron’s tips wanted and nothing found', () => {
    const book = base()
    const now = book.assemble()
    expect(now.table.length).toBe(3)
    expect(now.tips.map((one) => one.row)).toEqual([0, 1, 2])
    expect(now.ends).toEqual([])
    expect([...now.attempting]).toEqual([0, 1, 2])
    expect(now.lineage).toEqual([])
    // Numbered within each neuron, not by table row.
    expect(book.wanted(N1)).toEqual([0, 1])
    expect(book.wanted(N2)).toEqual([0])
  })

  it('does not want a neuron’s tip the run does not attempt', () => {
    const book = runBook({
      table: tipsTable([N1, N1]),
      rows: [tip(N1, 0), tip(N1, 1)],
      neurons: [{ id: N1, at: [0, 1] }],
      // Row 0's box is outside the volume.
      attempting: new Set([1]),
      order: [],
    })
    expect(book.wanted(N1)).toEqual([1])
  })

  /** A neuron at a time, each as its tips are listed — the order a plain run finishes them in. */
  it('lists a neuron’s ends as its tips are listed, whatever order they were finished in', () => {
    const book = base()
    book.put(N2, end(0, 'second neuron'))
    book.put(N1, end(1, 'first neuron, second tip'))
    expect(book.wanted(N1)).toEqual([0])
    book.put(N1, end(0, 'first neuron, first tip'))
    // Numbered into the table: the first neuron's second tip is row 2.
    expect(named(book.assemble().ends)).toEqual([
      'first neuron, first tip@0',
      'first neuron, second tip@2',
      'second neuron@1',
    ])
    expect(book.wanted(N1)).toEqual([])
  })

  it('puts the pieces beneath the neurons in the plain order, not the order they were taken in', () => {
    const book = base()
    // Taken deepest first, and the neuron's last end after all of them.
    add(book, Q, [0])
    add(book, P2, [0, 1])
    add(book, P1, [0, 1])
    for (const one of [Q, P2, P1]) book.join(one.id, undefined)
    book.put(Q.id, end(0, 'q'))
    book.put(P1.id, end(1, 'p1 second'))
    book.put(P2.id, end(0, 'p2 first'))
    book.put(P1.id, end(0, 'p1 first'))
    book.put(N1, end(1, 'n1 second'))
    const now = book.assemble()
    // The table: the three incoming rows, then the first piece's two, the second's two, q's one.
    expect(now.table.data[ID_COLUMN_NAME]).toEqual([
      N1,
      N2,
      N1,
      '801',
      '801',
      '802',
      '802',
      '803',
    ])
    expect(now.tips.map((one) => `${one.neuronId}:${one.row}`)).toEqual([
      `${N1}:0`,
      `${N2}:1`,
      `${N1}:2`,
      '801:3',
      '801:4',
      '802:5',
      '802:6',
      '803:7',
    ])
    // Each end numbered into the whole, in that same order.
    expect(named(now.ends)).toEqual([
      'n1 second@2',
      'p1 first@3',
      'p1 second@4',
      'p2 first@5',
      'q@7',
    ])
    expect([...now.attempting].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('leaves a piece that has no record yet out of the tables', () => {
    const book = base()
    add(book, P2, [0])
    book.join(P2.id, undefined)
    expect(book.assemble().table.data[ID_COLUMN_NAME]).toEqual([N1, N2, N1, '802'])
    expect(book.piece(P1.id)).toBeUndefined()
  })

  it('marks the joining end, attempts the rest, and says each row’s lineage', () => {
    const book = base()
    add(book, P1, [0, 1, 2])
    // Nothing is wanted until the join is said.
    expect(book.wanted(P1.id)).toEqual([])
    expect(book.join(P1.id, 1)).toBe(true)
    expect(book.wanted(P1.id)).toEqual([0, 2])
    expect(book.piece(P1.id)!.junction).toBe(1)
    const now = book.assemble()
    expect([...now.attempting].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5])
    expect(now.lineage.slice(3)).toEqual([
      { seed: N1, parent: N1, depth: 1, junction: false },
      { seed: N1, parent: N1, depth: 1, junction: true },
      { seed: N1, parent: N1, depth: 1, junction: false },
    ])
    expect(now.lineage.slice(0, 3)).toEqual([undefined, undefined, undefined])
    // Said again, nothing has changed.
    expect(book.join(P1.id, 1)).toBe(false)
  })

  /**
   * A piece taken early is joined by the ends its parent had so far. When a later end moves the
   * join, the end found at what is now the joining tip goes, and the old joining tip is wanted.
   */
  it('moves a join: drops the end found at the new joining tip, and wants the old one', () => {
    const book = base()
    add(book, P1, [0, 1, 2])
    book.join(P1.id, 0)
    book.put(P1.id, end(1, 'second'))
    book.put(P1.id, end(2, 'third'))
    // Built once already, with the first join: the next build has to be a new one.
    expect(book.assemble().lineage[3]?.junction).toBe(true)
    expect(book.join(P1.id, 2)).toBe(true)
    expect(book.piece(P1.id)!.junction).toBe(2)
    expect(book.wanted(P1.id)).toEqual([0])
    expect(named(book.assemble().ends)).toEqual(['second@4'])
    expect(book.assemble().lineage[5]?.junction).toBe(true)
    expect(book.assemble().lineage[3]?.junction).toBe(false)
  })

  it('never attempts a tip whose box is outside the volume, and counts those', () => {
    const book = base()
    book.addPiece(P1, tipsTable(['801', '801']), [tip('801', 0), tip('801', 1)], [true, false])
    book.join(P1.id, undefined)
    expect(book.wanted(P1.id)).toEqual([0])
    expect(book.piecesOutside()).toBe(1)
    // Unless that tip is the join, which is no open end wherever it lies.
    book.join(P1.id, 1)
    expect(book.piecesOutside()).toBe(0)
  })

  /** A table row that is no searchable tip — no position, say — still has its row. */
  it('keeps a piece’s rows where they are when some of them are no tip', () => {
    const book = base()
    // Three rows; only rows 0 and 2 are tips.
    book.addPiece(
      P1,
      tipsTable(['801', '801', '801']),
      [tip('801', 0), tip('801', 2)],
      [true, true],
    )
    book.join(P1.id, 1)
    const now = book.assemble()
    expect(now.tips.slice(3).map((one) => one.row)).toEqual([3, 5])
    expect([...now.attempting].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    // The join is the second *tip*, which is the table's third row of the piece.
    expect(now.lineage.slice(3).map((one) => one?.junction)).toEqual([false, false, true])
  })

  it('takes what a failed search never reached off its attempts, and keeps what it found', () => {
    const book = base()
    add(book, P1, [0, 1, 2])
    book.join(P1.id, undefined)
    book.put(P1.id, end(0, 'first'))
    book.fail(P1.id)
    expect(book.piece(P1.id)!.failed).toBe(true)
    expect(book.wanted(P1.id)).toEqual([])
    expect([...book.assemble().attempting].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    expect(named(book.assemble().ends)).toEqual(['first@3'])
  })

  /**
   * Where a piece joins does not depend on whether its search went well: a failed piece's join
   * still moves when its parent's ends say so — and what it never reached stays unattempted.
   */
  it('moves the join of a piece whose search failed, without attempting anything new', () => {
    const book = base()
    add(book, P1, [0, 1, 2])
    book.join(P1.id, 0)
    book.put(P1.id, end(1, 'second'))
    // Tip 2 was never reached.
    book.fail(P1.id)
    expect(book.join(P1.id, 1)).toBe(true)
    expect(book.piece(P1.id)).toMatchObject({ junction: 1, failed: true })
    // The end found at what is now the join goes; the old join and the unreached tip stay off.
    expect(book.wanted(P1.id)).toEqual([])
    expect(named(book.assemble().ends)).toEqual([])
    expect([...book.assemble().attempting].sort((a, b) => a - b)).toEqual([0, 1, 2])
    expect(
      book
        .assemble()
        .lineage.slice(3)
        .map((one) => one?.junction),
    ).toEqual([false, true, false])
  })

  /** A record is a reading, taken when asked for. */
  it('says what is true of a piece when it is asked', () => {
    const book = base()
    expect(add(book, P1, [0, 1]).junction).toBeUndefined()
    book.join(P1.id, 1)
    expect(book.piece(P1.id)).toMatchObject({ junction: 1, failed: false })
    book.fail(P1.id)
    expect(book.piece(P1.id)!.failed).toBe(true)
  })

  /** The tables are rebuilt from the same parts until the shape moves; an end alone moves none. */
  it('hands back the same table until a piece is added, joined or fails', () => {
    const book = base()
    add(book, P1, [0, 1])
    book.join(P1.id, undefined)
    const before = book.assemble()
    book.put(P1.id, end(0, 'first'))
    const after = book.assemble()
    expect(after.table).toBe(before.table)
    expect(after.tips).toBe(before.tips)
    add(book, P2, [0])
    expect(book.assemble().table).not.toBe(before.table)
  })

  it('refuses what it has no record of, and a neuron where a piece is meant', () => {
    expect(() => base().put('899', end(0, 'x'))).toThrow(/no record of 899/)
    expect(() => base().join(N1, 0)).toThrow(/is a neuron, not a piece/)
  })
})

/**
 * Where a piece joins is read off its parent's ends, and the book answers from the ends there
 * are when it is asked — no caller keeps the answer, so none can keep an old one.
 */
describe('the order growing as Auto-extend takes pieces', () => {
  it('hands back a root’s finished ends in the order of its tips', () => {
    const book = base()
    add(book, P1, [0, 1])
    book.join(P1.id, undefined)
    book.put(P1.id, end(1, 'second'))
    book.put(P1.id, end(0, 'first'))
    expect(named(book.endsOf(P1.id))).toEqual(['first@0', 'second@1'])
    expect(book.endsOf('999')).toEqual([])
  })

  it('publishes a piece added to the order, in its place', () => {
    const book = runBook({
      table: tipsTable([N1]),
      rows: [tip(N1, 0)],
      neurons: [{ id: N1, at: [0] }],
      attempting: new Set([0]),
      order: [P1],
    })
    add(book, P1, [0])
    book.join(P1.id, undefined)
    const taken = piece('850', '801', [N1, '801', '850'])
    book.reorder([P1, taken])
    add(book, taken, [0])
    book.join(taken.id, undefined)
    expect(book.assemble().table.data[ID_COLUMN_NAME]).toEqual([N1, '801', '850'])
  })

  /** Its ends were searched with another path read as the neuron (`aliasOf`). */
  it('forgets a piece whose path moved, and the pieces beyond it', () => {
    const book = base()
    add(book, P1, [0])
    add(book, Q, [0])
    for (const one of [P1, Q]) book.join(one.id, undefined)
    book.put(Q.id, end(0, 'q'))
    // 803 is now reached through 802; 801 stays where it was.
    const moved = piece('803', '802', [N1, '802', '803'])
    book.reorder([P1, P2, moved])
    expect(book.piece(P1.id)).toBeDefined()
    expect(book.piece(Q.id)).toBeUndefined()
    expect(book.endsOf(Q.id)).toEqual([])
  })

  /** A new record counts its ends from 0 again, and must not meet the old reading's number. */
  it('asks where a moved piece’s own pieces join it afresh', () => {
    const book = base()
    add(book, P1, [0, 1])
    book.join(P1.id, undefined)
    // Q joins 801 at its second end, as 801 stood.
    book.put(P1.id, end(0, 'a'))
    book.put(P1.id, end(1, 'b', [{ root: '803', gap: 0.1, at: 5 }]))
    expect(book.contactOf(Q)).toEqual([5000, 0, 0])
    // 801 is now reached another way: its record goes, and is made again.
    const moved = piece('801', '802', [N1, '802', '801'])
    const q = piece('803', '801', [N1, '802', '801', '803'])
    book.reorder([P2, moved, q])
    add(book, moved, [0, 1])
    book.join(moved.id, undefined)
    book.put(moved.id, end(0, 'a'))
    book.put(moved.id, end(1, 'b', [{ root: '803', gap: 0.1, at: 9 }]))
    // As many ends as before, so the same version number: the contact is the new end's.
    expect(book.contactOf(q)).toEqual([9000, 0, 0])
  })

  it('counts no open end outside the volume for a piece the order dropped', () => {
    const book = base()
    book.addPiece(P2, tipsTable([P2.id, P2.id]), [tip(P2.id, 0), tip(P2.id, 1)], [false, true])
    book.join(P2.id, undefined)
    expect(book.piecesOutside()).toBe(1)
    book.reorder([P1])
    expect(book.piecesOutside()).toBe(0)
  })

  it('keeps a piece no longer in the order, and leaves it out of the tables', () => {
    const book = base()
    add(book, P1, [0])
    add(book, P2, [0])
    for (const one of [P1, P2]) book.join(one.id, undefined)
    book.reorder([P1])
    expect(book.assemble().table.data[ID_COLUMN_NAME]).toEqual([N1, N2, N1, '801'])
    // Back in its old place, it is published again as it was.
    book.reorder([P1, P2])
    expect(book.assemble().table.data[ID_COLUMN_NAME]).toEqual([N1, N2, N1, '801', '802'])
  })
})

describe('where a piece joins, by what its parent’s ends say now', () => {
  it('has no contact until an end of the parent lists the piece', () => {
    const book = base()
    expect(book.contactOf(P1)).toBeUndefined()
    book.put(N1, end(0, 'a', [{ root: '899', gap: 0.1, at: 5 }]))
    expect(book.contactOf(P1)).toBeUndefined()
    book.put(N1, end(1, 'b', [{ root: '801', gap: 0.3, at: 7 }]))
    expect(book.contactOf(P1)).toEqual([7000, 0, 0])
  })

  /** The stale answer: asked early, then asked again after a nearer listing arrived. */
  it('answers again once the parent’s ends have moved', () => {
    const book = base()
    book.put(N1, end(1, 'far', [{ root: '801', gap: 0.3, at: 7 }]))
    expect(book.contactOf(P1)).toEqual([7000, 0, 0])
    // Asked for its sibling in between, which is answered from the same walk.
    expect(book.contactOf(P2)).toBeUndefined()
    book.put(
      N1,
      end(0, 'near', [
        { root: '801', gap: 0.05, at: 2 },
        { root: '802', gap: 0.2, at: 3 },
      ]),
    )
    expect(book.contactOf(P1)).toEqual([2000, 0, 0])
    expect(book.contactOf(P2)).toEqual([3000, 0, 0])
  })

  it('reads a piece of a piece off the piece’s own ends, and drops it when that end goes', () => {
    const book = base()
    add(book, P1, [0, 1, 2])
    book.join(P1.id, 0)
    expect(book.contactOf(Q)).toBeUndefined()
    book.put(P1.id, end(2, 'lists q', [{ root: '803', gap: 0.1, at: 9 }]))
    expect(book.contactOf(Q)).toEqual([9000, 0, 0])
    // The tip that end was found at turns out to be the join: the end goes, and what it listed.
    book.join(P1.id, 2)
    expect(book.contactOf(Q)).toBeUndefined()
  })

  it('has none for a piece whose parent has no record', () => {
    expect(base().contactOf(Q)).toBeUndefined()
  })
})

/**
 * **The property the run rests on**: a piece taken early — joined by what its parent had so far
 * — and settled again once every end is in, ends on the tables a plain run ends on.
 *
 * `settle` below is the node's rule for one piece, less the searching: ask where it joins, say
 * which end is the join, and "search" whatever is still wanted. Driven in two orders against
 * two books, the answers must be equal.
 */
describe('a piece taken early and settled again ends where a plain run ends', () => {
  const OWN_UM = 2
  /** What each root's ends list, by tip: the search's answers, the same in any order. */
  const FOUND: Record<string, readonly (readonly Listed[])[]> = {
    // The neuron's first tip lists the piece at 0.3 µm, near x = 10; its second, nearer, near 0.
    [N1]: [[{ root: '801', gap: 0.3, at: 10 }], [{ root: '801', gap: 0.05, at: 0 }]],
    [N2]: [[]],
    // The piece's ends: the one near 10 lists a piece of its own.
    '801': [[], [{ root: '803', gap: 0.1, at: 10.5 }], []],
    '803': [[], []],
  }
  /** Each piece's tips, by where they are: the first piece has ends near 0, near 10 and at 20. */
  const TIPS: Record<string, readonly number[]> = { '801': [0.2, 10.2, 20], '803': [10.6, 30] }

  const search = (book: RunBook, root: string, only?: readonly number[]) => {
    for (const at of book.wanted(root)) {
      if (only && !only.includes(at)) continue
      book.put(root, end(at, `${root}/${at}`, FOUND[root]![at]))
    }
  }
  /** The node's `settle`, with a table lookup where it searches. */
  const settle = (book: RunBook, one: Piece, ahead = false) => {
    const contact = book.contactOf(one)
    if (ahead && !contact) return
    const record = book.piece(one.id) ?? add(book, one, TIPS[one.id]!)
    book.join(one.id, junctionOf(record.mine, contact, OWN_UM))
    search(book, one.id)
  }
  const order = [P1, Q]
  const fresh = () =>
    runBook({
      table: tipsTable([N1, N2, N1]),
      rows: [tip(N1, 0), tip(N2, 1), tip(N1, 2)],
      neurons: [
        { id: N1, at: [0, 2] },
        { id: N2, at: [1] },
      ],
      attempting: new Set([0, 1, 2]),
      order,
    })

  const plain = () => {
    const book = fresh()
    search(book, N1)
    search(book, N2)
    for (const one of order) settle(book, one)
    return book
  }

  it('joins the piece where the nearer listing says, in a plain run', () => {
    const book = plain()
    // Near x = 0: the piece's first tip is the join, and the other two are searched.
    expect(book.piece('801')!.junction).toBe(0)
    expect(named(book.assemble().ends)).toEqual([
      `${N1}/0@0`,
      `${N1}/1@2`,
      `${N2}/0@1`,
      '801/1@4',
      '801/2@5',
      '803/1@7',
    ])
  })

  /**
   * Early, only the neuron's first end is in, and it lists the piece near x = 10 — so the draft
   * joins the piece by its *second* tip, searches the first, and never searches the second,
   * which is the one that lists the piece of the piece.
   */
  it('ends on the same tables when the piece went ahead on half its parent’s ends', () => {
    const book = fresh()
    search(book, N1, [0])
    for (const one of order) settle(book, one, true)
    // The draft: joined at the wrong end, and the piece beyond it not reached at all.
    expect(book.piece('801')!.junction).toBe(1)
    expect(book.piece('803')).toBeUndefined()
    search(book, N1)
    search(book, N2)
    for (const one of order) settle(book, one)
    expect(book.assemble()).toEqual(plain().assemble())
    expect(book.piece('801')!.junction).toBe(0)
  })

  it('ends on the same tables when the pieces are settled over and over', () => {
    const book = fresh()
    search(book, N1, [1])
    for (const one of order) settle(book, one, true)
    for (const one of order) settle(book, one, true)
    search(book, N1)
    for (const one of order) settle(book, one)
    search(book, N2)
    for (const one of order) settle(book, one)
    for (const one of order) settle(book, one)
    expect(book.assemble()).toEqual(plain().assemble())
  })
})
