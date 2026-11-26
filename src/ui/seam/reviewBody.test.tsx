// @vitest-environment jsdom

/**
 * The Proofread Merges card.
 *
 * What is pinned here is the loop a proofreader actually performs — click a row, judge it, page
 * to the next candidate — and three things in it that fail without throwing. A body replaces the
 * generic param rows outright, so a filter it forgets exists only in the inspector. Every
 * decision is a **param**, because the card is drawn on the canvas and in the overlay at once
 * and component state would leave the two on different rows. And a verdict is keyed on the
 * (tip, candidate) pair, so paging and then judging must record the candidate on screen rather
 * than the tip's first.
 *
 * The viewer is absent here on purpose: jsdom has no WebGL, and with no registered source the
 * card has no published scene to build one from. The queue is what this file is about.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import type { ParamValue, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import { selectTable } from '../../nodes/lib/tableOps'
import { makeTable } from '../../core/values'
import type { CellValue, TableValue, Value } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import '../../nodes'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import type { SubmitState } from './mergeSession'
import type * as VerdictLog from '../../data/verdictLog'
import type * as FollowEdit from '../../packs/seam/followEdit'
import type * as MergeSession from './mergeSession'
import { announceEdit } from '../../data/cave/rootEdits'
import { resetVerdictLog, verdictLogState, writeSharing } from '../../data/verdictLog'
import { ReviewBody, submitPress } from './ReviewBody'
import { VerdictButtons } from './VerdictButtons'
import { NEUROGLANCER_TYPE } from '../../nodes/output/neuroglancer'
import { setHoveredSegment } from '../viewers/segmentHover'
import { decodePicks, encodePicks } from '../../packs/seam/handPicks'
import { decodeVerdicts } from '../../packs/seam/reviewQueue'
import { LARGE_PIECE_CHUNKS } from '../../packs/seam/pieces'

/** Submit's session, faked: the card only reads its state and opens it. */
const openSubmit = vi.fn()
const closeSubmit = vi.fn()
let submitState: SubmitState = 'none'
let submitChecked: { done: number; total: number } | undefined
/** The currency check, faked: roots in `edited` are outdated, and what was asked is kept. */
const edited = new Set<string>()
const askedCurrency: string[][] = []
/** Asks sooner than usual — a suggested edit, or the row in view — each with its age. */
const soonerCurrency: { roots: string[]; currentForMs: number }[] = []
vi.mock('../../packs/seam/rootCurrency', () => ({
  rootCurrency: {
    ask: (_: unknown, roots: readonly string[], currentForMs?: number) =>
      currentForMs === undefined
        ? askedCurrency.push([...roots])
        : soonerCurrency.push({ roots: [...roots], currentForMs }),
    askAfter: (_: unknown, roots: readonly string[], currentForMs: number) =>
      soonerCurrency.push({ roots: [...roots], currentForMs }),
    current: (_: unknown, root: string) => !edited.has(root),
    subscribe: () => () => {},
    // A new answer is a new version, as the real one's is: read again on the next draw.
    version: () => edited.size,
  },
}))
/** The verdict log's sending, faked: what a press flushes. What the server collects is its reply. */
const flushVerdicts = vi.fn(() => Promise.resolve())
vi.mock('../../data/verdictLog', async (importOriginal) => ({
  ...(await importOriginal<typeof VerdictLog>()),
  flushVerdicts: () => flushVerdicts(),
}))
/** A hand pick's check against the segmentation, faked: what it answers is the test's. */
const checkPick = vi.fn()
vi.mock('../../packs/seam/pickCheck', () => ({
  checkPick: (...args: unknown[]) => checkPick(...args),
}))
/** Reading where the neuron's tips went, faked: what it answers is the test's. */
const followEditFake = vi.fn()
/** Reading where a piece of the list went, faked the same way. */
const followPiecesFake = vi.fn()
vi.mock('../../packs/seam/followEdit', async (importOriginal) => ({
  ...(await importOriginal<typeof FollowEdit>()),
  followEdit: (...args: unknown[]) => followEditFake(...args),
  followPieces: (...args: unknown[]) => followPiecesFake(...args),
}))
vi.mock('./mergeSession', async (importOriginal) => ({
  // The record's held append is the real one: a follow writes through it.
  appendHeld: (await importOriginal<typeof MergeSession>()).appendHeld,
  STILL_OUT_NOTICE: 'A merge sent earlier has not answered yet.',
  openSubmit: (...args: unknown[]) => openSubmit(...args),
  closeSubmit: () => closeSubmit(),
  useSubmitState: () => submitState,
  submitStateOf: () => submitState,
  verdictsHeld: (await importOriginal<typeof MergeSession>()).verdictsHeld,
  useSubmitChecked: () => submitChecked,
}))

const TYPE = 'seam:proofreadMerges'

const NEURON = '720575940621522189'
/** The cursor on one of the neuron's own tips, as `current` holds it. */
const at = (endUid: number) => `${NEURON}|${endUid}`

const TIPS: TableValue = makeTable(
  tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('kind', 'str'),
    column('x', 'f64'),
    column('y', 'f64'),
    column('z', 'f64'),
    column('q', 'f64'),
    column('r', 'f64'),
    column('shown', 'bool'),
  ),
  {
    [ID_COLUMN_NAME]: ['720575940621522189', '720575940621522189'],
    end_uid: [11, 22],
    kind: ['tip', 'kink'],
    x: [1, 4],
    y: [2, 5],
    z: [3, 6],
    q: [0.91, 0.42],
    r: [0.95, 0.5],
    shown: [true, false],
  },
)

const CANDIDATES: TableValue = makeTable(
  tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('candidateId', 'str'),
    column('rank', 'i64'),
    column('vol_um3', 'f64'),
    column('n_l2', 'i64'),
    column('conf', 'f64'),
    column('contact_x', 'f64'),
    column('contact_y', 'f64'),
    column('contact_z', 'f64'),
    column('shown', 'bool'),
  ),
  {
    [ID_COLUMN_NAME]: ['720575940621522189', '720575940621522189', '720575940621522189'],
    end_uid: [11, 11, 22],
    candidateId: ['648518346368395605', '648518346356867476', '648518347608868926'],
    rank: [1, 2, 1],
    vol_um3: [0.25, 0.1, 3],
    // The chunk count of the whole object, which is what the card calls size.
    n_l2: [14, 2, 61],
    conf: [0.4, 0.12, 0.05],
    contact_x: [10, 11, 12],
    contact_y: [20, 21, 22],
    contact_z: [30, 31, 32],
    shown: [true, false, false],
  },
)

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 800 })
  // Node 26 shadows jsdom's `localStorage`, and the filter fold is remembered there.
  installStorageStub()
})
beforeEach(clearStorage)
afterEach(cleanup)

/**
 * Two neurons, **interleaved**, with the second neuron's tip the most confident of all — so a
 * card listing every neuron, or sorting before narrowing, puts tip 33 on top.
 */
const OTHER = '720575940630442210'
const TWO_TIPS: TableValue = makeTable(TIPS.schema, {
  [ID_COLUMN_NAME]: ['720575940621522189', OTHER, '720575940621522189'],
  end_uid: [11, 33, 22],
  kind: ['tip', 'tip', 'kink'],
  x: [1, 7, 4],
  y: [2, 8, 5],
  z: [3, 9, 6],
  q: [0.91, 0.99, 0.42],
  r: [0.95, 0.99, 0.5],
  shown: [true, true, false],
})
const TWO_CANDIDATES: TableValue = makeTable(CANDIDATES.schema, {
  ...CANDIDATES.data,
  [ID_COLUMN_NAME]: [...CANDIDATES.data[ID_COLUMN_NAME]!, OTHER],
  end_uid: [...CANDIDATES.data['end_uid']!, 33],
  candidateId: [...CANDIDATES.data['candidateId']!, '648518346300000001'],
  rank: [...CANDIDATES.data['rank']!, 1],
  vol_um3: [...CANDIDATES.data['vol_um3']!, 1],
  n_l2: [...CANDIDATES.data['n_l2']!, 5],
  conf: [...CANDIDATES.data['conf']!, 0.8],
  contact_x: [...CANDIDATES.data['contact_x']!, 13],
  contact_y: [...CANDIDATES.data['contact_y']!, 23],
  contact_z: [...CANDIDATES.data['contact_z']!, 33],
  shown: [...CANDIDATES.data['shown']!, true],
})

/** Whether `draw` wires the card's `Extended` back into a Find Merge Candidates node. */
let wiredBack = false

function draw(
  params: ParamValues = {},
  compact = true,
  candidates: TableValue = CANDIDATES,
  tips: TableValue = TIPS,
  dataset?: Value,
) {
  const def = requireNodeDef(TYPE)
  const graph = addNode(emptyGraph(), {
    id: 'r1',
    type: TYPE,
    position: { x: 0, y: 0 },
    params: defaultParams(def),
  })
  /*
   * With the dotted wire back to a Find Merge Candidates node where a test asks for it. The node the
   * card is drawn from carries the params, in the store too: Extend writes through the store.
   */
  const node = { ...graph.nodes[0]!, params: { ...defaultParams(def), ...params } }
  useGraphStore.setState({
    graph: {
      ...graph,
      nodes: [
        node,
        ...(wiredBack
          ? [
              {
                id: 's1',
                type: 'seam:findMergeCandidates',
                position: { x: 0, y: 0 },
                params: {},
              },
            ]
          : []),
      ],
      edges: wiredBack
        ? [
            {
              id: 'back',
              source: 'r1',
              sourceHandle: 'extended',
              target: 's1',
              targetHandle: 'review',
            },
          ]
        : [],
    },
  } as never)
  const written: Record<string, ParamValue> = {}
  const body = (
    over: { tips?: TableValue; candidates?: TableValue; params?: ParamValues } = {},
  ) => {
    const drawn = { ...node, params: { ...node.params, ...over.params } }
    return (
      <ReviewBody
        node={drawn}
        ctx={makeInferContext(def, drawn.params, {})}
        inputValues={{
          tips: over.tips ?? tips,
          candidates: over.candidates ?? candidates,
          dataset,
        }}
        compact={compact}
        setParam={(id, value) => {
          written[id] = value
        }}
        onError={() => {}}
      />
    )
  }
  const view = render(body())
  redraw = (over) => view.rerender(body(over))
  return written
}

/** The card `draw` last drew, drawn again over new tables or params — as a search publishing. */
let redraw: (over: {
  tips?: TableValue
  candidates?: TableValue
  params?: ParamValues
}) => void = () => {}

const rows = () => [...document.querySelectorAll('.review-row')]
/** The verdicts as the store holds them: a press writes through `setParams`, `recent` with it. */
const storedVerdicts = () => useGraphStore.getState().graph.nodes[0]!.params['verdicts']

describe('the review card', () => {
  /** The controls the card exists for. A body drawing only the fields it liked would hide them. */
  it('draws every card param, filters and sort included', () => {
    draw()
    const labels = [...document.querySelectorAll('.param__label')].map((n) => n.textContent)
    expect(labels).toEqual(
      expect.arrayContaining(['Min confidence', 'Min size', 'Sort by', 'Show accepted']),
    )
  })

  /**
   * The cursor, the candidate and the verdicts are set by gesture, so a text field saying `11`
   * on the card would be a control nobody can use. They stay real params in the inspector.
   */
  it('keeps its own state off the card', () => {
    draw()
    const labels = [...document.querySelectorAll('.param__label')].map((n) => n.textContent)
    expect(labels).not.toContain('Current tip')
    expect(labels).not.toContain('Candidate')
    expect(labels).not.toContain('Verdicts')
  })

  /** The queue is the card's job; the picture is one ⤢ away. */
  it('draws no viewer on the card', () => {
    draw({ current: at(11) })
    expect(document.querySelector('.review-body__viewer')).toBeNull()
    expect(document.querySelector('.review-list')).toBeTruthy()
  })

  /**
   * Expanded, the same four params are the overlay's own rail a few pixels above this body.
   * Drawing them here as well was the same controls twice.
   */
  it('draws no filter fields when expanded, where the rail already has them', () => {
    draw({}, false)
    expect(document.querySelector('.list-body__fields')).toBeNull()
    expect(document.querySelectorAll('.review-row')).toHaveLength(2)
  })

  /**
   * The queue keeps to a reading width only where something stands beside it. Once `Current`
   * drives a Neuroglancer node the card's own frame stands down, and a fixed column in a
   * full-width panel is a sliver in an empty room.
   */
  it('says whether anything stands beside the queue', () => {
    draw({}, false)
    // No published scene here (no registered source), so there is no viewer to stand beside.
    expect(document.querySelector('.review-body')?.getAttribute('data-viewer')).toBe('no')
    expect(document.querySelector('.review-body__viewer')).toBeNull()
  })

  /**
   * One row per candidate rather than per tip, which is the other way a reader works: when the
   * first candidate is clearly wrong and something further down is clearly right.
   */
  it('lists every candidate when asked, leading with each one’s own confidence', () => {
    draw({ mode: 'candidate' })
    // Two candidates on tip 11, one on tip 22.
    expect(rows()).toHaveLength(3)
    expect(rows()[0]!.textContent).toContain('0.400')
    expect(rows()[0]!.textContent).toContain('648518346368395605')
  })

  /**
   * **A published set carries no chunk count**, so the card falls back to the in-box volume —
   * and says so, because the two differ by orders of magnitude and a bare number would be the
   * one place a reader could carry one across to the other's `Min size`.
   */
  it('prints µm³ where the table has no chunk count', () => {
    const noChunks = selectTable(
      CANDIDATES,
      CANDIDATES.schema.columns.map((c) => c.name).filter((name) => name !== 'n_l2'),
    )
    draw({}, true, noChunks)
    expect(rows()[0]!.textContent).toContain('µm³')
    expect(rows()[0]!.textContent).not.toContain('L2 chunk')
  })

  /** Per candidate the row names its own rank, so clicking opens on that one rather than the first. */
  it('selects the clicked candidate’s rank, not the tip’s first', () => {
    const written = draw({ mode: 'candidate' })
    // 0.12 is tip 11's rank 2 — the second row once sorted by confidence.
    fireEvent.click(rows()[1]!.querySelector('.review-row__pick')!)
    expect(written).toEqual({ current: at(11), rank: 2 })
  })

  /** The per-candidate number is in the facts in both modes, so the two show the same things. */
  it('shows a candidate’s own confidence in the muted line per tip too', () => {
    draw()
    expect(rows()[0]!.querySelector('.review-row__facts')?.textContent).toContain('conf 0.400')
  })

  /** A per-surface convenience, so it never becomes an edit. */
  it('folds the card\u2019s filters away, and remembers', () => {
    draw()
    expect(document.querySelector('.list-body__fields')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    expect(document.querySelector('.list-body__fields')).toBeNull()
    cleanup()
    draw()
    expect(document.querySelector('.list-body__fields')).toBeNull()
  })

  it('lists one row per tip, highest confidence first', () => {
    draw()
    expect(rows()).toHaveLength(2)
    // `q`, which the list is ordered by, with `r` beneath it only as a rounded estimate.
    expect(rows()[0]!.querySelector('.review-row__score')!.textContent).toBe('0.910≥90%')
    expect(rows()[1]!.querySelector('.review-row__score')!.textContent).toBe('0.420≈50%')
    expect(rows()[0]!.textContent).toContain('648518346368395605')
    // The candidate's own facts, which are what a reader judges size and reach by.
    // The size the queue sorts and filters on, with its unit: a chunk count is of the whole
    // object where `vol_um3` is only the part inside the search box.
    expect(rows()[0]!.textContent).toContain('14 L2 chunks')
    expect(rows()[0]!.textContent).toContain('rank 1/2')
  })

  /**
   * The click target is a layer, not a wrapper — the row's three parts do not nest, since the
   * confidence spans both rows and the measurements run under the acts. What matters is that it
   * is still one real button per row, so the keyboard reaches a row in one tab stop and the row
   * has a name to read.
   */
  it('keeps one named button per row, with the content beside it', () => {
    draw()
    const row = rows()[0]!
    const pick = row.querySelector('.review-row__pick')!
    expect(pick.tagName).toBe('BUTTON')
    expect(pick.getAttribute('aria-label')).toMatch(
      /Show tip 11 and candidate 6485183463683956/,
    )
    // The text is the row's, not the button's: a wrapper could not hold all three parts.
    expect(pick.textContent).toBe('')
    expect(row.querySelector('.review-row__facts')?.textContent).toContain('rank 1/2')
  })

  /** Clicking is what moves the viewer, and it always opens on the suggestion. */
  it('selects a tip and resets to its first candidate', () => {
    const written = draw({ current: at(22), rank: 1 })
    fireEvent.click(rows()[0]!.querySelector('.review-row__pick')!)
    expect(written).toEqual({ current: at(11), rank: 1 })
  })

  it('pages through the current tip’s candidates, and stops at the ends', () => {
    const written = draw({ current: at(11), rank: 1 })
    const row = rows()[0]!
    const [back, forward] = [...row.querySelectorAll('.review-row__page')]
    // Rank 1 of 2: back is dead, forward moves.
    expect((back as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(forward!)
    expect(written['rank']).toBe(2)
  })

  it('offers the arrows only on the row being looked at', () => {
    draw({ current: at(11), rank: 1 })
    const other = rows()[1]!
    for (const button of other.querySelectorAll('.review-row__page')) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  /**
   * Keyed on the pair, and on the candidate **on screen**: a reader who paged to rank 2 and then
   * said "not a merge" means that one, not the tip's first.
   */
  it('records a verdict against the candidate being shown', () => {
    draw({ current: at(11), rank: 2 })
    fireEvent.click(rows()[0]!.querySelectorAll('.review-row__verdict')[1]!)
    expect(storedVerdicts()).toBe('720575940621522189/648518346356867476=r')
  })

  /**
   * The full work of the last ten neurons worked on (`reviewEviction.ts`, user, 2026-11-19): a
   * press on an eleventh clears the oldest's verdicts in the same edit.
   */
  it('clears the oldest neuron’s work as an eleventh is started', () => {
    const others = Array.from({ length: 10 }, (_, i) => `72057594000000000${i}`)
    draw({
      current: at(11),
      rank: 1,
      verdicts: others.map((id) => `${id}/648518346000000001=r`).join(';'),
      recent: others.join(';'),
    })
    fireEvent.click(rows()[0]!.querySelectorAll('.review-row__verdict')[1]!)
    const params = useGraphStore.getState().graph.nodes[0]!.params
    expect(String(params['verdicts'])).not.toContain(others[0])
    expect(String(params['verdicts'])).toContain(others[1])
    expect(String(params['recent']).split(';')).toEqual([...others.slice(1), NEURON])
    // Nothing on the card shows it went, so the status bar says so, and how to have it back.
    expect(useGraphStore.getState().notice).toMatch(
      /^Cleared the verdicts .* of 1 neuron .* back\.$/,
    )
  })

  /** The piece under the pointer in a neuroglancer frame (`segmentHover.ts`, user, 2026-11-19). */
  it('lights the rows showing the segment under the pointer in a viewer', () => {
    const frame = {}
    draw({ current: at(11), rank: 1 })
    const lit = () => rows().filter((row) => row.getAttribute('data-hovered') === 'yes')
    expect(lit()).toHaveLength(0)
    act(() => setHoveredSegment(frame, '648518346368395605'))
    expect(lit()).toEqual([rows()[0]])
    // The neuron itself, or anything the card does not list, lights nothing.
    act(() => setHoveredSegment(frame, NEURON))
    expect(lit()).toHaveLength(0)
    act(() => setHoveredSegment(frame, undefined))
  })

  /** Rows arriving while the search runs (user, 2026-11-19): the list holds still and says so. */
  describe('as rows arrive', () => {
    const arrivedRows = () =>
      rows()
        .filter((row) => row.getAttribute('data-arrived') === 'yes')
        .map(endOf)
    const endOf = (row: Element) => row.querySelector('.review-row__id')?.textContent ?? ''
    // The neuron's first tip alone, as a search that has scored one.
    const first = (table: TableValue, keep: (at: number) => boolean) =>
      makeTable(
        table.schema,
        Object.fromEntries(
          Object.entries(table.data).map(([name, cells]) => [
            name,
            (cells as CellValue[]).filter((_, at) => keep(at)),
          ]),
        ),
      )
    const ONE_TIP = first(TIPS, (at) => at === 0)
    const ONE_CANDIDATES = first(CANDIDATES, (at) => CANDIDATES.data['end_uid']![at] === 11)

    it('tints a row that arrives, and nothing that was there', () => {
      draw({}, true, ONE_CANDIDATES, ONE_TIP)
      expect(arrivedRows()).toEqual([])
      act(() => redraw({ tips: TIPS, candidates: CANDIDATES }))
      expect(rows()).toHaveLength(2)
      expect(rows()[1]!.getAttribute('data-arrived')).toBe('yes')
      expect(rows()[0]!.getAttribute('data-arrived')).toBeNull()
    })

    /** The usual arrival: a neuron's tips are listed first, and scored one by one. */
    it('tints a row listed already as it gets its candidate', () => {
      draw({}, true, ONE_CANDIDATES, TIPS)
      expect(rows()).toHaveLength(2)
      expect(arrivedRows()).toEqual([])
      act(() => redraw({ tips: TIPS, candidates: CANDIDATES }))
      const tinted = rows().filter((row) => row.getAttribute('data-arrived') === 'yes')
      expect(tinted).toHaveLength(1)
      expect(tinted[0]!.textContent).toContain('0.420')
    })

    it('tints nothing where the reader changed the view rather than the search the data', () => {
      draw({}, true, ONE_CANDIDATES, ONE_TIP)
      act(() => redraw({ tips: TIPS, candidates: CANDIDATES, params: { sortBy: 'size' } }))
      expect(rows()).toHaveLength(2)
      expect(arrivedRows()).toEqual([])
    })

    it('holds still as a row arrives above, and says how many came in up there', () => {
      // Tip 22 sorted above tip 11, the row at the top of the view.
      const above = makeTable(TIPS.schema, { ...TIPS.data, q: [0.42, 0.91] })
      draw(
        {},
        true,
        ONE_CANDIDATES,
        first(above, (at) => at === 0),
      )
      expect(document.querySelector('.review-body__new-above')).toBeNull()
      act(() => redraw({ tips: above, candidates: CANDIDATES }))
      const note = document.querySelector<HTMLButtonElement>('.review-body__new-above')!
      expect(note.textContent).toBe('↑ 1 new above')
      // Taken to the top, the note has done its job.
      act(() => note.click())
      expect(document.querySelector('.review-body__new-above')).toBeNull()
    })
  })

  it('clears a verdict when the same one is pressed again', () => {
    draw({
      current: at(11),
      rank: 1,
      verdicts: '720575940621522189/648518346368395605=accept',
    })
    fireEvent.click(rows()[0]!.querySelectorAll('.review-row__verdict')[0]!)
    expect(storedVerdicts()).toBe('')
  })

  it('narrows the list by confidence without touching the queue’s count', () => {
    draw({ minConfidence: '0.5' })
    expect(rows()).toHaveLength(1)
    expect(screen.getByText(/of 2 tips/)).toBeTruthy()
  })

  it('says so when the filters leave nothing', () => {
    draw({ minConfidence: '0.99' })
    expect(rows()).toHaveLength(0)
    expect(screen.getByText(/No tip passes the filters/)).toBeTruthy()
  })

  /** A filter set after the accept hid the row, and Submit merged a piece nobody could see. */
  it('lists a row with an accepted piece on it whatever the filters say', () => {
    draw({
      minConfidence: '0.99',
      // Tip 11's second candidate: the tip lists it, so the tip's row is kept (0 rows without).
      verdicts: '720575940621522189/648518346356867476=accept',
    })
    expect(rows()).toHaveLength(1)
  })

  /** The neuron the whole card is about, named even when there is nothing to choose between. */
  it('names its one neuron in a disabled list', () => {
    draw({ verdicts: '720575940621522189/648518346368395605=accept' })
    const select = screen.getByRole('combobox', { name: 'Neuron' }) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.selectedOptions[0]!.textContent).toBe(
      '720575940621522189 · 2 tips · 1 judged',
    )
  })

  /** Two neurons in, one listed: the first in the table, whatever the other's confidence. */
  it('lists only the first neuron’s tips until another is picked', () => {
    draw({}, true, TWO_CANDIDATES, TWO_TIPS)
    const select = screen.getByRole('combobox', { name: 'Neuron' }) as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect(select.value).toBe('720575940621522189')
    expect(rows()).toHaveLength(2)
    expect(
      rows()
        .map((row) => row.textContent)
        .join(),
    ).not.toContain('648518346300000001')
    expect(screen.getByText(/^2 tips$/)).toBeTruthy()
  })

  it('lists the picked neuron’s tips, and only those', () => {
    draw({ neuron: OTHER }, true, TWO_CANDIDATES, TWO_TIPS)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('648518346300000001')
    expect(screen.getByText(/^1 tip$/)).toBeTruthy()
  })

  /** The other neuron's verdicts are kept, but they are not this neuron's count. */
  it('counts only the picked neuron’s verdicts in the foot', () => {
    draw(
      {
        neuron: OTHER,
        verdicts: `720575940621522189/648518346368395605=accept;${OTHER}/648518346300000001=reject`,
      },
      true,
      TWO_CANDIDATES,
      TWO_TIPS,
    )
    expect(screen.getByText('1 judged')).toBeTruthy()
  })

  /**
   * The switch lands on the new neuron's top row, so the viewer moves with it — and it is **one**
   * edit, so a single undo puts the reader back where they were.
   */
  it('switches neuron and lands on its top row, in one step', () => {
    draw({ current: at(22), rank: 1 }, true, TWO_CANDIDATES, TWO_TIPS)
    const before = useGraphStore.getState().past.length
    fireEvent.change(screen.getByRole('combobox', { name: 'Neuron' }), {
      target: { value: OTHER },
    })
    const node = useGraphStore.getState().graph.nodes[0]!
    expect(node.params).toMatchObject({ neuron: OTHER, current: `${OTHER}|33`, rank: 1 })
    expect(useGraphStore.getState().past.length).toBe(before + 1)
  })

  /**
   * Every row is reachable, and only those in view are drawn — the old card stopped at 300 and
   * told a reader with no filters set to narrow them.
   */
  it('lists a whole neuron, drawing only the rows in view', () => {
    const n = 600
    const many = makeTable(TIPS.schema, {
      [ID_COLUMN_NAME]: Array.from({ length: n }, () => '720575940621522189'),
      end_uid: Array.from({ length: n }, (_, i) => 1000 + i),
      kind: Array.from({ length: n }, () => 'tip'),
      x: Array.from({ length: n }, () => 1),
      y: Array.from({ length: n }, () => 2),
      z: Array.from({ length: n }, () => 3),
      q: Array.from({ length: n }, (_, i) => 1 - i / n),
      r: Array.from({ length: n }, (_, i) => 1 - i / n),
      shown: Array.from({ length: n }, () => false),
    })
    draw({}, true, CANDIDATES, many)
    expect(screen.getByText(/^600 tips$/)).toBeTruthy()
    expect(screen.queryByText(/not listed/)).toBeNull()
    // A screenful and a margin, not 600 rows of buttons.
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(60)
    // The spacer below stands in for the rest, so the scrollbar is the whole list's.
    expect(document.querySelector('.review-list__spacer')).toBeTruthy()
    expect(rows()[0]!.getAttribute('aria-setsize')).toBe('600')
  })

  /** Per candidate a row is a candidate, so the foot counts candidates — never "3 of 2 tips". */
  it('counts candidates in the foot when a row is one', () => {
    draw({ mode: 'candidate' })
    expect(screen.getByText(/^3 candidates$/)).toBeTruthy()
  })
})

/**
 * Submit (phase 6 of `docs/seam-merge-plan.md`): the accepted pieces not yet merged, disabled with
 * its reason as the title, and the rows Submit has merged said so, their verdicts fixed.
 */
describe('Submit on the review card', () => {
  const FIRST = '648518346368395605'
  const SECOND = '648518347608868926'
  const ACCEPTED = {
    verdicts: `720575940621522189/${FIRST}=accept;720575940621522189/${SECOND}=accept`,
  }
  const CAVE_DATASET: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  const button = () => document.querySelector<HTMLButtonElement>('.review-body__submit')!
  /** One merge into the neuron, as the batch records it. */
  const MERGED = JSON.stringify([
    {
      deployment: DEFAULT_CAVE_SERVER,
      datastack: 'test_stack',
      reviewedRoot: '720575940621522189',
      candidateRoot: FIRST,
      endUid: 11,
      neuronRoot: '720575940621522189',
      neuron: { supervoxel: '11', positionNm: [1, 2, 3] },
      candidate: { supervoxel: '12', positionNm: [1, 2, 3] },
      at: '2026-11-16T10:00:00.000Z',
      outcome: 'merged',
      newRoot: '720575940700000001',
    },
  ])

  afterEach(() => {
    resetCredentials()
    openSubmit.mockReset()
    closeSubmit.mockReset()
    submitState = 'none'
    submitChecked = undefined
    edited.clear()
    askedCurrency.length = 0
  })

  it('counts the accepted pieces, and says why it is off with nothing wired', () => {
    draw(ACCEPTED)
    expect(button().textContent).toBe('Submit (2)')
    expect(button().disabled).toBe(true)
    expect(button().title).toMatch(/Wire a CAVE Dataset/)
  })

  it('asks for a sign-in on a CAVE dataset, and opens the session once signed in', () => {
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().title).toMatch(/Sign in to/)
    cleanup()
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().disabled).toBe(false)
    fireEvent.click(button())
    expect(openSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: useGraphStore.getState().activeTabId,
        nodeId: 'r1',
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        reviewedRoot: '720575940621522189',
      }),
    )
  })

  it.each<[SubmitState, string, RegExp]>([
    ['open', 'Submit open', /Submit is open/],
    ['running', 'Merging…', /being sent/],
    ['other', 'Submit (2)', /Another card/],
  ])('says where its Submit has got to: %s', (state, label, reason) => {
    submitState = state
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().textContent).toBe(label)
    expect(button().disabled).toBe(true)
    expect(button().title).toMatch(reason)
  })

  /** Nothing else is drawn while the check runs, so the button is how to stop it. */
  it('is the check’s Cancel while it runs', () => {
    submitState = 'planning'
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().textContent).toBe('Checking… (cancel)')
    expect(button().disabled).toBe(false)
    fireEvent.click(button())
    expect(closeSubmit).toHaveBeenCalled()
    expect(openSubmit).not.toHaveBeenCalled()
  })

  it('counts the pieces checked once the check reaches them', () => {
    submitState = 'planning'
    submitChecked = { done: 12, total: 1234 }
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().textContent).toBe('Checking 12 of 1,234… (cancel)')
    expect(button().disabled).toBe(false)
  })

  /** A sign-in in the Sources panel lifts the reason without anything else changing. */
  it('follows a sign-in', () => {
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().disabled).toBe(true)
    act(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
    expect(button().disabled).toBe(false)
  })

  it('leaves a merged piece out of the count, says so on its row and fixes its verdict', () => {
    draw(
      { ...ACCEPTED, merges: MERGED, mode: 'candidate' },
      true,
      CANDIDATES,
      TIPS,
      CAVE_DATASET,
    )
    expect(button().textContent).toBe('Submit (1)')
    const row = rows().find((r) => r.textContent?.includes(FIRST))!
    expect(row.getAttribute('data-merged')).toBe('merged')
    expect(row.querySelector('.review-row__merged')?.textContent).toBe('✓ merged')
    const verdicts = [...row.querySelectorAll<HTMLButtonElement>('.review-row__verdict')]
    expect(verdicts.every((b) => b.disabled)).toBe(true)
    const other = rows().find((r) => r.textContent?.includes(SECOND))!
    expect(other.querySelector<HTMLButtonElement>('.review-row__verdict')!.disabled).toBe(false)
  })
})

/**
 * Whether the neuron and its candidates are still current (`rootCurrency`): asked once a CAVE
 * dataset and a sign-in are there, of the neuron's root now and every candidate not merged; an
 * edited candidate is tagged, an edited neuron said in the foot and Submit kept off.
 */
describe('currency on the review card', () => {
  const FIRST = '648518346368395605'
  const NEURON = '720575940621522189'
  const CAVE_DATASET: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  const ACCEPTED = { verdicts: `${NEURON}/${FIRST}=accept`, mode: 'candidate' }
  const submit = () => document.querySelector<HTMLButtonElement>('.review-body__submit')!

  beforeEach(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
  afterEach(() => {
    resetCredentials()
    edited.clear()
    askedCurrency.length = 0
  })

  it('asks about the neuron and every candidate, and only once signed in', () => {
    resetCredentials()
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(askedCurrency).toEqual([])
    cleanup()
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(askedCurrency.at(-1)).toEqual([
      NEURON,
      '648518346368395605',
      '648518346356867476',
      '648518347608868926',
    ])
  })

  it('tags an edited candidate outdated', () => {
    edited.add(FIRST)
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    const row = rows().find((r) => r.textContent?.includes(FIRST))!
    expect(row.querySelector('.review-row__outdated')?.textContent).toBe('outdated')
    const other = rows().find((r) => r.textContent?.includes('648518347608868926'))!
    expect(other.querySelector('.review-row__outdated')).toBeNull()
  })

  it('says an edited neuron in the foot, and keeps Submit off', () => {
    edited.add(NEURON)
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(document.querySelector('.review-body__edited')?.textContent).toMatch(
      /query neuron edited since these suggestions were generated/,
    )
    expect(submit().disabled).toBe(true)
    expect(submit().title).toMatch(/edited since these suggestions were generated/)
  })

  /** A piece Submit merged is retired by that merge: "merged", never "outdated", and not asked. */
  it('neither asks about nor tags a merged piece, and follows the neuron to its root now', () => {
    const merges = JSON.stringify([
      {
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        reviewedRoot: NEURON,
        candidateRoot: FIRST,
        endUid: 11,
        neuronRoot: NEURON,
        neuron: { supervoxel: '11', positionNm: [1, 2, 3] },
        candidate: { supervoxel: '12', positionNm: [1, 2, 3] },
        at: '2026-11-16T10:00:00.000Z',
        outcome: 'merged',
        newRoot: '720575940700000001',
      },
    ])
    edited.add(FIRST)
    edited.add(NEURON)
    draw({ ...ACCEPTED, merges }, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(askedCurrency.at(-1)).toEqual([
      '720575940700000001',
      '648518346356867476',
      '648518347608868926',
    ])
    expect(document.querySelector('.review-row__outdated')).toBeNull()
    expect(document.querySelector('.review-body__edited')).toBeNull()
  })
})

/**
 * Following the neuron through an edit (`followEdit.ts`, `docs/seam-split-review-plan.md`): the
 * outdated neuron's button reads where its tips are, the follow goes into the record, and the tips
 * on the other part leave the list.
 */
describe('following an edited neuron', () => {
  const NEURON = '720575940621522189'
  const KEPT = '720575940800000001'
  const CAVE_DATASET: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  /** `TIPS` with the supervoxel each tip was found on. */
  const ANCHORED: TableValue = makeTable(
    tableSchema(...TIPS.schema.columns, column('tip_sv', 'str')),
    { ...TIPS.data, tip_sv: ['73747834149376601', '73747834149376602'] },
  )
  const entry = {
    kind: 'followed',
    deployment: DEFAULT_CAVE_SERVER,
    datastack: 'test_stack',
    reviewedRoot: NEURON,
    from: NEURON,
    to: KEPT,
    at: '2026-11-24T12:00:00.000Z',
    away: ['73747834149376602'],
    placed: ['73747834149376601', '73747834149376602'],
    kept: 1,
    others: [{ root: '720575940800000002', tips: 1 }],
    left: [],
  }

  beforeEach(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
  afterEach(() => {
    resetCredentials()
    edited.clear()
    followEditFake.mockReset()
  })

  it('reads the tips’ supervoxels from the neuron’s root now, and records the part followed', async () => {
    edited.add(NEURON)
    followEditFake.mockResolvedValue({ ok: true, entry })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    const button = screen.getByRole('button', { name: 'Follow the edit' })
    await act(async () => fireEvent.click(button))
    expect(followEditFake).toHaveBeenCalledTimes(1)
    expect(followEditFake.mock.calls[0]![0]).toMatchObject({
      reviewedRoot: NEURON,
      from: NEURON,
      anchors: { tips: ['73747834149376601', '73747834149376602'], pieces: [] },
    })
    const merges = useGraphStore.getState().graph.nodes[0]!.params['merges']
    expect(JSON.parse(String(merges))).toEqual([entry])
  })

  it('lists only the tips on the part followed, and says how many left', () => {
    edited.add(NEURON)
    draw(
      { mode: 'candidate', merges: JSON.stringify([entry]) },
      true,
      CANDIDATES,
      ANCHORED,
      CAVE_DATASET,
    )
    // The candidate of tip 22 is gone with its tip; tip 11's two remain.
    expect(rows().some((r) => r.textContent?.includes('648518347608868926'))).toBe(false)
    expect(rows().some((r) => r.textContent?.includes('648518346368395605'))).toBe(true)
    // The followed root is current, so the neuron is no longer said to be edited.
    expect(document.querySelector('.review-body__edited')).toBeNull()
    expect(document.querySelector('.list-body__foot')?.textContent).toMatch(
      /1 tip left with the part split off/,
    )
    // The other part holds as many tips as this one: either could be the neuron.
    expect(screen.getByRole('button', { name: 'follow the other part instead' })).toBeTruthy()
  })

  /** Said by the split gallery (`rootEdits.ts`): certain, so followed without a press. */
  it('follows at once where the split gallery says it split the neuron', async () => {
    followEditFake.mockResolvedValue({ ok: true, entry })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [NEURON],
        certain: true,
      }),
    )
    expect(followEditFake).toHaveBeenCalledTimes(1)
    // Another datastack's edit, or another root's, is not this card's.
    followEditFake.mockClear()
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'other',
        roots: [NEURON],
        certain: true,
      }),
    )
    expect(followEditFake).not.toHaveBeenCalled()
  })

  /** Read off a viewer's report — Neuroglancer's own multicut — so asked about before following. */
  it('asks about the neuron where a viewer only suggests it was split, and follows once it was', async () => {
    followEditFake.mockResolvedValue({ ok: true, entry })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    soonerCurrency.length = 0
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [NEURON],
        certain: false,
      }),
    )
    expect(soonerCurrency).toContainEqual({ roots: [NEURON], currentForMs: 0 })
    expect(followEditFake).not.toHaveBeenCalled()
    // The chunkedgraph's answer: outdated.
    edited.add(NEURON)
    redraw({})
    await act(async () => {})
    expect(followEditFake).toHaveBeenCalledTimes(1)
  })

  /** The same card drawn twice hears an edit twice: the second follow finds the record moved on. */
  it('writes no follow from a root the record has already moved past', async () => {
    const merges = JSON.stringify([entry])
    followEditFake.mockResolvedValue({ ok: true, entry })
    draw({ mode: 'candidate', merges }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    useGraphStore.setState((state) => ({
      graph: {
        ...state.graph,
        nodes: state.graph.nodes.map((one) =>
          one.id === 'r1' ? { ...one, params: { ...one.params, merges } } : one,
        ),
      },
    }))
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [KEPT],
        certain: true,
      }),
    )
    expect(followEditFake).toHaveBeenCalledTimes(1)
    expect(useGraphStore.getState().graph.nodes[0]!.params['merges']).toBe(merges)
  })

  /** An Undo pressed straight after the split: its edit arrives while the split's follow runs. */
  it('follows an edit said during a follow once that follow ends', async () => {
    let answer: (value: unknown) => void = () => {}
    followEditFake.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    followEditFake.mockResolvedValue({ ok: false, message: 'second' })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    const said = (roots: string[]) =>
      act(async () =>
        announceEdit({
          deployment: DEFAULT_CAVE_SERVER,
          datastack: 'test_stack',
          roots,
          certain: true,
        }),
      )
    await said([NEURON])
    await said([NEURON, KEPT])
    expect(followEditFake).toHaveBeenCalledTimes(1)
    await act(async () => answer({ ok: true, entry }))
    // The record now has the neuron at KEPT, which the second edit retired.
    redraw({
      params: { merges: String(useGraphStore.getState().graph.nodes[0]!.params['merges']) },
    })
    await act(async () => {})
    expect(followEditFake).toHaveBeenCalledTimes(2)
    expect(followEditFake.mock.calls[1]![0]).toMatchObject({ from: KEPT })
  })

  it('follows a suggested edit at once where the neuron is known to be outdated already', async () => {
    edited.add(NEURON)
    followEditFake.mockResolvedValue({ ok: true, entry })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [NEURON],
        certain: false,
      }),
    )
    expect(followEditFake).toHaveBeenCalledTimes(1)
  })

  /** Merged into another reviewed neuron: that one's card follows it, not this one. */
  it('follows nothing by itself where the neuron was merged into another under review', async () => {
    const intoOther = JSON.stringify([
      {
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        reviewedRoot: '720575940621522100',
        candidateRoot: NEURON,
        endUid: 1,
        neuronRoot: '720575940621522100',
        neuron: { supervoxel: '11', positionNm: [1, 2, 3] },
        candidate: { supervoxel: '12', positionNm: [1, 2, 3] },
        at: '2026-11-24T10:00:00.000Z',
        outcome: 'merged',
        newRoot: '720575940700000009',
      },
    ])
    draw({ mode: 'candidate', merges: intoOther }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: ['720575940700000009'],
        certain: true,
      }),
    )
    expect(followEditFake).not.toHaveBeenCalled()
  })

  it('asks nothing about a suggested edit when not signed in', async () => {
    resetCredentials()
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    soonerCurrency.length = 0
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [NEURON],
        certain: false,
      }),
    )
    expect(soonerCurrency).toEqual([])
  })

  it('asks again about the neuron and the candidate in view', () => {
    soonerCurrency.length = 0
    draw(
      { mode: 'candidate', current: `${NEURON}|11`, rank: 1 },
      true,
      CANDIDATES,
      ANCHORED,
      CAVE_DATASET,
    )
    expect(soonerCurrency).toContainEqual({
      roots: [NEURON, '648518346368395605'],
      currentForMs: 20_000,
    })
  })

  it('says why where the neuron cannot be followed, and writes nothing', async () => {
    edited.add(NEURON)
    followEditFake.mockResolvedValue({ ok: false, message: 'No supervoxels to read.' })
    draw({ mode: 'candidate' }, true, CANDIDATES, ANCHORED, CAVE_DATASET)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Follow the edit' })),
    )
    expect(useGraphStore.getState().notice).toBe('No supervoxels to read.')
    expect(useGraphStore.getState().graph.nodes[0]!.params['merges'] ?? '').toBe('')
  })
})

/**
 * Following a piece of the list through an edit (phase 4 of `docs/seam-split-review-plan.md`):
 * the outdated tag is a button, an edit said to the card naming a listed piece is followed, and
 * a followed piece is asked about, drawn and tagged at its new root, or read as merged where it
 * went into the neuron.
 */
describe('following an edited piece', () => {
  const NEURON = '720575940621522189'
  const FIRST = '648518346368395605'
  const TRIMMED = '720575940800000077'
  const CAVE_DATASET: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  /** `CANDIDATES` with each one's side of the contact. */
  const ANCHORED: TableValue = makeTable(
    tableSchema(...CANDIDATES.schema.columns, column('cand_sv', 'str')),
    {
      ...CANDIDATES.data,
      cand_sv: ['73747834149376701', '73747834149376702', '73747834149376703'],
    },
  )
  const pieceFollow = (to: string) => ({
    kind: 'piece-followed',
    deployment: DEFAULT_CAVE_SERVER,
    datastack: 'test_stack',
    reviewedRoot: NEURON,
    piece: FIRST,
    from: FIRST,
    to,
    at: '2026-11-25T12:00:00.000Z',
    supervoxel: '73747834149376701',
    away: [],
  })
  const ACCEPTED = { verdicts: `${NEURON}/${FIRST}=accept`, mode: 'candidate' }
  const rowOf = (id: string) => rows().find((r) => r.textContent?.includes(id))!

  beforeEach(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
  afterEach(() => {
    resetCredentials()
    edited.clear()
    askedCurrency.length = 0
    followPiecesFake.mockReset()
  })

  it('follows a piece when its outdated tag is pressed, keeping its verdict', async () => {
    edited.add(FIRST)
    followPiecesFake.mockResolvedValue({
      ok: true,
      entries: [pieceFollow(TRIMMED)],
      refused: [],
    })
    draw(ACCEPTED, true, ANCHORED, TIPS, CAVE_DATASET)
    const tag = rowOf(FIRST).querySelector<HTMLButtonElement>('button.review-row__outdated')!
    await act(async () => fireEvent.click(tag))
    expect(followPiecesFake).toHaveBeenCalledTimes(1)
    expect(followPiecesFake.mock.calls[0]![0]).toMatchObject({
      reviewedRoot: NEURON,
      pieces: [{ piece: FIRST, from: FIRST, contact: '73747834149376701', tips: [] }],
    })
    const params = useGraphStore.getState().graph.nodes[0]!.params
    expect(JSON.parse(String(params['merges']))).toEqual([pieceFollow(TRIMMED)])
    expect(String(params['verdicts'])).toContain(`${NEURON}/${FIRST}=accept`)
    expect(useGraphStore.getState().notice).toMatch(`Followed ${FIRST} to ${TRIMMED}`)
  })

  it('asks about a followed piece at its new root, and tags it followed', () => {
    draw(
      { ...ACCEPTED, merges: JSON.stringify([pieceFollow(TRIMMED)]) },
      true,
      ANCHORED,
      TIPS,
      CAVE_DATASET,
    )
    expect(askedCurrency.at(-1)).toContain(TRIMMED)
    expect(askedCurrency.at(-1)).not.toContain(FIRST)
    expect(rowOf(FIRST).querySelector('.review-row__followed')?.getAttribute('title')).toMatch(
      TRIMMED,
    )
  })

  it('reads a piece followed into the neuron as merged', () => {
    const MERGED = '720575940800000078'
    const neuronFollow = {
      kind: 'followed',
      deployment: DEFAULT_CAVE_SERVER,
      datastack: 'test_stack',
      reviewedRoot: NEURON,
      from: NEURON,
      to: MERGED,
      at: '2026-11-25T12:00:00.000Z',
      away: [],
      placed: [],
      kept: 0,
      others: [],
      left: [],
    }
    draw(
      { ...ACCEPTED, merges: JSON.stringify([neuronFollow, pieceFollow(MERGED)]) },
      true,
      ANCHORED,
      TIPS,
      CAVE_DATASET,
    )
    expect(rowOf(FIRST).querySelector('.review-row__merged')?.textContent).toBe('✓ merged')
    expect(rowOf(FIRST).querySelector('.review-row__followed')).toBeNull()
  })

  it('offers no follow of a piece while a Submit holds the card', () => {
    edited.add(FIRST)
    submitState = 'running'
    try {
      draw(ACCEPTED, true, ANCHORED, TIPS, CAVE_DATASET)
      const tag = rowOf(FIRST).querySelector<HTMLButtonElement>('button.review-row__outdated')!
      expect(tag.disabled).toBe(true)
    } finally {
      submitState = 'none'
    }
  })

  it('writes nothing where another copy of the card followed the piece already', async () => {
    edited.add(FIRST)
    followPiecesFake.mockResolvedValue({
      ok: true,
      entries: [pieceFollow(TRIMMED)],
      refused: [],
    })
    // The record holds the follow already; this answer was read from the root before it.
    const merges = JSON.stringify([pieceFollow(TRIMMED)])
    edited.add(TRIMMED)
    draw({ ...ACCEPTED, merges }, true, ANCHORED, TIPS, CAVE_DATASET)
    const tag = rowOf(FIRST).querySelector<HTMLButtonElement>('button.review-row__outdated')!
    await act(async () => fireEvent.click(tag))
    expect(useGraphStore.getState().graph.nodes[0]!.params['merges']).toBe(merges)
    expect(useGraphStore.getState().notice).toBe('The piece has been followed already.')
  })

  it('follows an edit said during a Submit only once the Submit ends', async () => {
    followPiecesFake.mockResolvedValue({
      ok: true,
      entries: [pieceFollow(TRIMMED)],
      refused: [],
    })
    submitState = 'open'
    try {
      draw(ACCEPTED, true, ANCHORED, TIPS, CAVE_DATASET)
      await act(async () =>
        announceEdit({
          deployment: DEFAULT_CAVE_SERVER,
          datastack: 'test_stack',
          roots: [FIRST],
          certain: true,
        }),
      )
      expect(followPiecesFake).not.toHaveBeenCalled()
    } finally {
      submitState = 'none'
    }
    redraw({})
    await act(async () => {})
    expect(followPiecesFake).toHaveBeenCalledTimes(1)
  })

  it('follows at once a listed piece the split gallery says it split', async () => {
    followPiecesFake.mockResolvedValue({
      ok: true,
      entries: [pieceFollow(TRIMMED)],
      refused: [],
    })
    draw(ACCEPTED, true, ANCHORED, TIPS, CAVE_DATASET)
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [FIRST],
        certain: true,
      }),
    )
    expect(followPiecesFake).toHaveBeenCalledTimes(1)
    expect(followPiecesFake.mock.calls[0]![0]).toMatchObject({ pieces: [{ piece: FIRST }] })
  })

  it('follows a piece a Neuroglancer card suggests once it is found outdated', async () => {
    followPiecesFake.mockResolvedValue({
      ok: true,
      entries: [pieceFollow(TRIMMED)],
      refused: [],
    })
    draw(ACCEPTED, true, ANCHORED, TIPS, CAVE_DATASET)
    soonerCurrency.length = 0
    await act(async () =>
      announceEdit({
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        roots: [FIRST],
        certain: false,
      }),
    )
    expect(soonerCurrency).toContainEqual({ roots: [FIRST], currentForMs: 0 })
    expect(followPiecesFake).not.toHaveBeenCalled()
    // The chunkedgraph's answer: outdated.
    edited.add(FIRST)
    redraw({})
    await act(async () => {})
    expect(followPiecesFake).toHaveBeenCalledTimes(1)
  })
})

/** Only Coda's own Neuroglancer tells the card what is under the pointer: anything else is said. */
describe('a viewer that reports nothing back', () => {
  const withViewer = (params: ParamValues) => {
    draw()
    const { graph } = useGraphStore.getState()
    act(() =>
      useGraphStore.setState({
        graph: {
          ...graph,
          nodes: [
            ...graph.nodes,
            { id: 'ng', type: NEUROGLANCER_TYPE, position: { x: 0, y: 0 }, params } as never,
          ],
          edges: [
            ...graph.edges,
            {
              id: 'w',
              source: 'r1',
              sourceHandle: 'current',
              target: 'ng',
              targetHandle: 'control',
            },
          ],
        },
      }),
    )
  }
  const said = () => document.querySelector('.review-body__viewer')

  it('is said in the foot where the only viewer wired is another', () => {
    withViewer({ viewerType: 'dataset' })
    expect(said()?.textContent).toMatch(/J, K and F are off/)
  })

  it('is not said for Coda’s own viewer, nor where none is wired', () => {
    withViewer({})
    expect(said()).toBeNull()
    cleanup()
    draw()
    expect(said()).toBeNull()
  })
})

describe('submitPress', () => {
  const ready = {
    docId: 'doc',
    nodeId: 'r1',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    queue: [],
    neuron: '720575940621522189',
    signedIn: true,
    absorbed: false,
    neuronEdited: false,
    accepted: 3,
    count: 3,
    submitting: 'none' as SubmitState,
  }

  it('hands over the request only where nothing stands in the way', () => {
    expect(submitPress(ready)).toEqual({
      request: {
        docId: 'doc',
        nodeId: 'r1',
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        sourceId: 'cave',
        datasetId: 'test_stack:1',
        queue: [],
        reviewedRoot: '720575940621522189',
      },
    })
  })

  it.each([
    ['nothing wired', { datasetId: undefined }, /Wire a CAVE Dataset/],
    ['a dataset that is not CAVE', { sourceId: 'neuprint' }, /Only a CAVE dataset/],
    ['a dataset id that is no datastack', { datasetId: 'nope' }, /Only a CAVE dataset/],
    ['a neuron merged into another', { absorbed: true }, /merged into another/],
    ['a neuron edited since', { neuronEdited: true }, /edited since these suggestions/],
    ['nothing accepted', { accepted: 0, count: 0 }, /Accept a piece/],
    ['every accepted piece merged', { count: 0 }, /Every accepted piece is merged/],
    ['its own Submit open', { submitting: 'open' }, /Submit is open/],
    ['merges being sent', { submitting: 'running' }, /being sent/],
    ['a merge sent earlier still out', { submitting: 'waiting' }, /has not answered yet/],
    ['another card’s Submit open', { submitting: 'other' }, /Another card/],
  ])('says why not with %s', (_, change, reason) => {
    expect(submitPress({ ...ready, ...change } as typeof ready)).toEqual({
      blocked: expect.stringMatching(reason),
    })
  })

  it('asks for a sign-in to the dataset’s own deployment', () => {
    expect(submitPress({ ...ready, signedIn: false })).toEqual({
      blocked: expect.stringMatching(/Sign in to global/),
    })
  })

  /** This card's own Submit is what the button shows; another card's comes after every fix. */
  it('puts this card’s Submit first and another card’s last', () => {
    expect(submitPress({ ...ready, submitting: 'open', sourceId: 'neuprint' })).toEqual({
      blocked: 'Submit is open.',
    })
    expect(submitPress({ ...ready, submitting: 'other', sourceId: 'neuprint' })).toEqual({
      blocked: expect.stringMatching(/Only a CAVE dataset/),
    })
  })
})

/**
 * Extending a neuron from the card (`docs/seam-extend-plan.md`, phase 5).
 *
 * The tables are what Find Merge Candidates publishes once a piece is extended: the piece's tips beneath
 * the neuron's, `ID` the piece and `seed` the neuron — and the piece's open end is **tip 11, the
 * same number as one of the neuron's**, so anything that reads a tip by its number alone shows
 * up here as two rows lit, or the wrong one written.
 */
describe('extending a neuron from the review card', () => {
  const PIECE = '648518346368395605'
  const SECOND = '648518347608868926'
  const NEXT = '648518346300000009'
  const grownTips = (searched: boolean | null): TableValue =>
    makeTable(
      tableSchema(
        ...TIPS.schema.columns,
        column('seed', 'str'),
        column('steps', 'i64'),
        column('junction', 'bool'),
        column('searched', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: [NEURON, NEURON, PIECE, PIECE],
        end_uid: [11, 22, 0, 11],
        kind: ['tip', 'kink', 'tip', 'tip'],
        x: [1, 4, 7, 8],
        y: [2, 5, 7, 8],
        z: [3, 6, 7, 8],
        q: [0.91, 0.42, null, 0.3],
        r: [0.95, 0.5, null, 0.3],
        shown: [true, false, null, true],
        seed: [NEURON, NEURON, NEURON, NEURON],
        steps: [0, 0, 1, 1],
        junction: [false, false, true, false],
        searched: [true, true, false, searched],
      },
    )
  /** The piece's end lists `candidateId`: a new piece by default, of `chunks` level-2 chunks. */
  const grownCandidates = (candidateId = NEXT, chunks = 3): TableValue =>
    makeTable(CANDIDATES.schema, {
      ...CANDIDATES.data,
      [ID_COLUMN_NAME]: [...CANDIDATES.data[ID_COLUMN_NAME]!, PIECE],
      end_uid: [...CANDIDATES.data['end_uid']!, 11],
      candidateId: [...CANDIDATES.data['candidateId']!, candidateId],
      rank: [...CANDIDATES.data['rank']!, 1],
      vol_um3: [...CANDIDATES.data['vol_um3']!, 1],
      n_l2: [...CANDIDATES.data['n_l2']!, chunks],
      conf: [...CANDIDATES.data['conf']!, 0.2],
      contact_x: [...CANDIDATES.data['contact_x']!, 14],
      contact_y: [...CANDIDATES.data['contact_y']!, 24],
      contact_z: [...CANDIDATES.data['contact_z']!, 34],
      shown: [...CANDIDATES.data['shown']!, true],
    })
  const ACCEPTED = `${NEURON}/${PIECE}=accept`
  const EXTENDED = { verdicts: ACCEPTED, extend: `${NEURON}/${PIECE}` }
  const runNode = vi.fn(async () => {})
  /** The search node's state as the card reads it. */
  let searchState = 'idle'
  const extendButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>('.review-row__extend'),
  ]
  const stored = () => useGraphStore.getState().graph.nodes[0]!.params
  const real = useGraphStore.getState()

  beforeEach(() => {
    wiredBack = true
    searchState = 'idle'
    runNode.mockClear()
    useGraphStore.setState({
      runNode,
      nodeInfo: (id: string) => (id === 's1' ? { state: searchState } : real.nodeInfo(id)),
    } as never)
  })
  afterEach(() => {
    wiredBack = false
    useGraphStore.setState({ runNode: real.runNode, nodeInfo: real.nodeInfo } as never)
  })

  it('offers Extend on an accepted row, and nowhere else', () => {
    draw({ verdicts: `${ACCEPTED};${NEURON}/${SECOND}=reject` })
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.querySelector('.review-row__extend')?.textContent).toBe('Extend')
    expect(rows()[1]!.querySelector('.review-row__extend')).toBeNull()
  })

  /** An accept starts nothing, and neither does drawing the card. */
  it('starts nothing until it is pressed', () => {
    draw({ verdicts: ACCEPTED })
    expect(runNode).not.toHaveBeenCalled()
    expect(stored()['extend']).toBe('')
  })

  it('writes the pair and runs the search it is wired back to, in one step', () => {
    draw({ verdicts: ACCEPTED })
    const before = useGraphStore.getState().past.length
    fireEvent.click(extendButtons()[0]!)
    expect(stored()['extend']).toBe(`${NEURON}/${PIECE}`)
    expect(useGraphStore.getState().past.length).toBe(before + 1)
    expect(runNode).toHaveBeenCalledTimes(1)
    expect(runNode).toHaveBeenCalledWith('s1')
  })

  it('is off, with the reason, where nothing is wired back', () => {
    wiredBack = false
    draw({ verdicts: ACCEPTED })
    const button = extendButtons()[0]!
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/Wire this card’s `Extended` output/)
    expect(button.title).toMatch(/published set cannot be extended/)
  })

  /** A gap (`min_dist_um`) per candidate row, which decides where a listed piece is hung. */
  const gapped = (table: TableValue, gaps: number[]): TableValue =>
    makeTable(tableSchema(...table.schema.columns, column('min_dist_um', 'f64')), {
      ...table.data,
      min_dist_um: gaps,
    })

  /** Listed under the neuron and, nearer, under an extended piece: accepted once, not twice. */
  it('takes J on a piece accepted at another tip to where it is accepted', async () => {
    const FRAME = {}
    draw(
      { ...EXTENDED, verdicts: `${ACCEPTED};${NEURON}/${SECOND}=accept` },
      true,
      gapped(grownCandidates(SECOND), [0.4, 0.3, 1, 0.5]),
      grownTips(true),
    )
    setHoveredSegment(FRAME, SECOND, [5000, 5000, 5000])
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }))
      })
      expect(decodeVerdicts(stored()['verdicts']).get(`${PIECE}/${SECOND}`)).toBeUndefined()
      expect(stored()['current']).toBe(`${NEURON}|22`)
      expect(useGraphStore.getState().notice).toMatch(/accepted already/)
    } finally {
      setHoveredSegment(FRAME, undefined)
    }
  })

  describe('Auto-extend', () => {
    const more = () =>
      rows()[0]!.querySelector<HTMLButtonElement>(
        '.review-row__split--extend .review-row__more',
      )!
    const PRESSED = { ...EXTENDED, autoRoots: `${NEURON}/${PIECE}` }

    it('is offered beside Extend, and writes the press and runs the search in one step', () => {
      // An edit with the same tag within 700 ms joins the last undo step: the test before's.
      useGraphStore.setState({ past: [] } as never)
      draw({ verdicts: ACCEPTED })
      const before = useGraphStore.getState().past.length
      fireEvent.click(more())
      expect(screen.getAllByRole('menuitemradio').map((one) => one.textContent)).toEqual([
        'Extend',
        'Auto-extend',
      ])
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto-extend/ }))
      expect(stored()['extend']).toBe(`${NEURON}/${PIECE}`)
      expect(stored()['autoRoots']).toBe(`${NEURON}/${PIECE}`)
      expect(useGraphStore.getState().past.length).toBe(before + 1)
      expect(runNode).toHaveBeenCalledTimes(1)
    })

    /** The piece's tip offers `NEXT`, which cleared the cutoff: Auto-extend took it. */
    it('lists what it took as accepted, marked as its own, and counts it', () => {
      draw(PRESSED, true, grownCandidates(), grownTips(true))
      const taken = rows().find((row) => row.textContent?.includes(NEXT))!
      expect(taken.querySelector('.review-row__auto')?.textContent).toBe('auto')
      expect(
        taken
          .querySelector('.review-row__verdict[data-verdict="accept"]')!
          .getAttribute('aria-pressed'),
      ).toBe('true')
      expect(document.body.textContent).toMatch(/1 by Auto-extend/)
      // Nothing was written: an Auto-extend accept is not the reader's verdict.
      expect(stored()['verdicts']).toBe(ACCEPTED)
    })

    /** As the Accept button does: Q on an `auto` row makes the accept the reader's own. */
    it('takes Q on what it took as the reader’s own accept', () => {
      draw(
        { ...PRESSED, current: `${PIECE}|11`, rank: 1 },
        true,
        grownCandidates(),
        grownTips(true),
      )
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }))
      })
      expect(stored()['verdicts']).toContain(`${PIECE}/${NEXT}=a`)
    })

    /** The chip takes the pointer for its title (`editor.css`), and a click on it still picks. */
    it('picks the row from a click on its chip', () => {
      const written = draw(PRESSED, true, grownCandidates(), grownTips(true))
      const taken = rows().find((row) => row.textContent?.includes(NEXT))!
      fireEvent.click(taken.querySelector('.review-row__auto')!)
      expect(written).toEqual({ current: `${PIECE}|11`, rank: 1 })
    })

    it('takes nothing where Auto-extend was not pressed', () => {
      draw(EXTENDED, true, grownCandidates(), grownTips(true))
      expect(document.querySelector('.review-row__auto')).toBeNull()
    })

    /** The `!` (user, 2026-11-21): a chain stopped on a piece too large to take. */
    it('marks where it stopped on a piece too large to take, and says why on hover', () => {
      draw(PRESSED, true, grownCandidates(NEXT, LARGE_PIECE_CHUNKS), grownTips(true))
      const row = rows().find((one) => one.textContent?.includes(NEXT))!
      expect(row.querySelector('.review-row__auto')).toBeNull()
      const mark = row.querySelector<HTMLElement>('.review-row__stopped')!
      expect(mark.textContent).toBe('!')
      expect(mark.title).toMatch(/^Auto-extend stopped here/)
      expect(mark.title).toContain(`${LARGE_PIECE_CHUNKS} L2 chunks`)
      expect(mark.getAttribute('aria-label')).toBe(mark.title)
      // One mark, on that row alone.
      expect(document.querySelectorAll('.review-row__stopped')).toHaveLength(1)
    })

    it('marks nothing where Auto-extend was not pressed', () => {
      draw(EXTENDED, true, grownCandidates(NEXT, LARGE_PIECE_CHUNKS), grownTips(true))
      expect(document.querySelector('.review-row__stopped')).toBeNull()
    })
  })

  /*
   * `Auto-extend listed` (user, 2026-11-19): the neuron's end 11 clears the cutoff and its first
   * candidate is `PIECE`; end 22 does not. One press, one edit, one run.
   */
  describe('Auto-extend listed', () => {
    const button = () =>
      screen.getByRole('button', { name: /Auto-extend listed/ }) as HTMLButtonElement

    it('presses Auto-extend on each listed row that clears, in one step', () => {
      useGraphStore.setState({ past: [] } as never)
      draw({}, true, grownCandidates(), grownTips(true))
      expect(button().textContent).toBe('Auto-extend listed (1)')
      const before = useGraphStore.getState().past.length
      fireEvent.click(button())
      expect(stored()['extend']).toBe(`${NEURON}/${PIECE}`)
      expect(stored()['autoRoots']).toBe(`${NEURON}/${PIECE}`)
      // No verdict of the reader's is written: the accept is Auto-extend's.
      expect(stored()['verdicts'] ?? '').toBe('')
      expect(useGraphStore.getState().past.length).toBe(before + 1)
      expect(runNode).toHaveBeenCalledTimes(1)
    })

    it('marks and counts what it took as Auto-extend’s, and has nothing left to take', () => {
      const TAKEN = `${NEURON}/${PIECE}`
      draw({ extend: TAKEN, autoRoots: TAKEN }, true, grownCandidates(), grownTips(true))
      const piece = rows().find((row) => row.textContent?.startsWith(`0.910`))!
      expect(piece.querySelector('.review-row__auto')?.getAttribute('title')).toMatch(
        /Auto-extend listed/,
      )
      // The piece, and `NEXT`, which Auto-extend took beyond it.
      expect(document.body.textContent).toMatch(/2 by Auto-extend/)
      expect(button().disabled).toBe(true)
    })

    it('leaves out a row the reader turned down', () => {
      draw({ verdicts: `${NEURON}/${PIECE}=unsure` }, true, grownCandidates(), grownTips(true))
      expect(button().disabled).toBe(true)
      expect(button().textContent).toBe('Auto-extend listed (0)')
    })

    it('says what to wire where nothing searches', () => {
      wiredBack = false
      draw({}, true, grownCandidates(), grownTips(true))
      expect(button().disabled).toBe(true)
      expect(button().title).toMatch(/Wire this card’s `Extended` output/)
    })

    it('leaves a piece you extended by hand as it is', () => {
      draw(
        { verdicts: ACCEPTED, extend: `${NEURON}/${PIECE}` },
        true,
        grownCandidates(),
        grownTips(true),
      )
      // The neuron's end lists PIECE (extended by hand); the piece's own end lists NEXT.
      fireEvent.click(button())
      expect(stored()['autoRoots']).toBe(`${PIECE}/${NEXT}`)
      expect(stored()['extend']).toBe(`${PIECE}/${NEXT};${NEURON}/${PIECE}`)
    })

    it('is off, with the reason, where the search has no cutoff', () => {
      const tips = grownTips(true)
      const bare = makeTable(
        tableSchema(...tips.schema.columns.filter((one) => one.name !== 'shown')),
        Object.fromEntries(Object.entries(tips.data).filter(([name]) => name !== 'shown')),
      )
      draw({}, true, grownCandidates(), bare)
      expect(button().disabled).toBe(true)
      expect(button().title).toMatch(/Assessor/)
    })
  })

  describe('Start over', () => {
    const button = () => screen.getByRole('button', { name: /Start over/ }) as HTMLButtonElement
    const work = {
      ...EXTENDED,
      verdicts: `${ACCEPTED};${NEURON}/${OTHER}=reject`,
      autoRoots: `${NEURON}/${PIECE}`,
      autoRefused: `${NEURON}/${OTHER}`,
      merges: '[]',
      current: `${NEURON}|11`,
    }

    it('is off where nothing is stored', () => {
      draw({}, true, grownCandidates(), grownTips(true))
      expect(button().disabled).toBe(true)
    })

    it('asks first, and Cancel clears nothing', () => {
      draw(work, true, grownCandidates(), grownTips(true))
      fireEvent.click(button())
      expect(document.querySelector('.review-body__ask')?.textContent).toBe(
        'Clear 2 verdicts and 1 extended piece on every neuron? The merge record stays.',
      )
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(stored()['verdicts']).toBe(work.verdicts)
      expect(button()).toBeTruthy()
    })

    it('clears the review work in one undo step, keeping the merge record and the cursor', () => {
      useGraphStore.setState({ past: [] } as never)
      draw(work, true, grownCandidates(), grownTips(true))
      fireEvent.click(button())
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      for (const id of ['verdicts', 'extend', 'autoRoots', 'autoRefused']) {
        expect(stored()[id]).toBe('')
      }
      expect(stored()['merges']).toBe('[]')
      expect(stored()['current']).toBe(`${NEURON}|11`)
      expect(runNode).not.toHaveBeenCalled()
      expect(useGraphStore.getState().past.length).toBe(1)
      useGraphStore.getState().undo()
      expect(stored()['verdicts']).toBe(work.verdicts)
      expect(stored()['extend']).toBe(work.extend)
    })

    /*
     * A piece is double-clicked into the viewer to be picked by hand, and that is kept on the
     * viewer's card: Start over takes it too, or it stays on screen as nobody's (user, 2026-11-20).
     */
    it('clears the double-clicks of the Neuroglancer cards it is wired to, in the same step', () => {
      useGraphStore.setState({ past: [] } as never)
      draw(work, true, grownCandidates(), grownTips(true))
      const { graph } = useGraphStore.getState()
      const both = ['+648518347595637224', '-648518347459229211']
      const viewer = (id: string, selectionEdits: string[]) =>
        ({
          id,
          type: NEUROGLANCER_TYPE,
          position: { x: 0, y: 0 },
          params: { selectionEdits },
        }) as never
      const wire = (target: string) => ({
        id: `w-${target}`,
        source: 'r1',
        sourceHandle: 'layers',
        target,
        targetHandle: 'layers',
      })
      act(() =>
        useGraphStore.setState({
          graph: {
            ...graph,
            nodes: [
              ...graph.nodes,
              viewer('ng', both),
              viewer('bare', []),
              viewer('elsewhere', both),
            ],
            edges: [...graph.edges, wire('ng'), wire('bare')],
          },
        } as never),
      )
      const viewerNode = (id: string) =>
        useGraphStore.getState().graph.nodes.find((one) => one.id === id)!
      const edits = (id: string) => viewerNode(id).params['selectionEdits']
      const bare = viewerNode('bare')
      fireEvent.click(button())
      // It says what it will clear beyond the card: the one wired viewer holding double-clicks.
      expect(document.querySelector('.review-body__ask')?.textContent).toMatch(
        /, and the double-clicks in 1 Neuroglancer card\? The merge record stays\.$/,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expect(edits('ng')).toEqual([])
      // One with nothing to clear is not written; one not wired to this card is somebody else's.
      expect(viewerNode('bare')).toBe(bare)
      expect(edits('elsewhere')).toHaveLength(2)
      expect(stored()['verdicts']).toBe('')
      expect(useGraphStore.getState().past.length).toBe(1)
      useGraphStore.getState().undo()
      expect(edits('ng')).toHaveLength(2)
      expect(stored()['verdicts']).toBe(work.verdicts)
    })

    it('is on where only a wired viewer holds double-clicks', () => {
      draw({}, true, grownCandidates(), grownTips(true))
      expect(button().disabled).toBe(true)
      const { graph } = useGraphStore.getState()
      act(() =>
        useGraphStore.setState({
          graph: {
            ...graph,
            nodes: [
              ...graph.nodes,
              {
                id: 'ng',
                type: NEUROGLANCER_TYPE,
                position: { x: 0, y: 0 },
                params: { selectionEdits: ['+648518347595637224'] },
              },
            ],
            edges: [
              ...graph.edges,
              {
                id: 'w',
                source: 'r1',
                sourceHandle: 'current',
                target: 'ng',
                targetHandle: 'control',
              },
            ],
          },
        } as never),
      )
      expect(button().disabled).toBe(false)
    })
  })

  describe('with Extend on accept on', () => {
    const accept = (row: Element) =>
      row.querySelector<HTMLButtonElement>('.review-row__verdict[data-verdict="accept"]')!

    it('is a field on the card, off unless asked for', () => {
      draw()
      const labels = [...document.querySelectorAll('.param__label')].map((n) => n.textContent)
      expect(labels).toContain('Extend on accept')
      expect(stored()['extendOnAccept']).toBe(false)
    })

    it('extends a piece as it is accepted: one edit, and the search is run', () => {
      draw({ extendOnAccept: true })
      const before = useGraphStore.getState().past.length
      fireEvent.click(accept(rows()[0]!))
      expect(stored()['verdicts']).toBe(`${NEURON}/${PIECE}=a`)
      expect(stored()['extend']).toBe(`${NEURON}/${PIECE}`)
      expect(useGraphStore.getState().past.length).toBe(before + 1)
      expect(runNode).toHaveBeenCalledTimes(1)
      expect(runNode).toHaveBeenCalledWith('s1')
    })

    /** Switching it on is not a press on Accept. */
    it('starts nothing for a piece accepted earlier, which keeps its button', () => {
      draw({ extendOnAccept: true, verdicts: ACCEPTED })
      expect(runNode).not.toHaveBeenCalled()
      expect(stored()['extend']).toBe('')
      expect(extendButtons()[0]!.textContent).toBe('Extend')
    })

    /** 61 chunks: accepted, and left to its button, which says why. */
    it('leaves a large piece to its button', () => {
      draw({ extendOnAccept: true })
      fireEvent.click(accept(rows()[1]!))
      expect(storedVerdicts()).toBe(`${NEURON}/${SECOND}=a`)
      expect(stored()['extend']).toBe('')
      expect(runNode).not.toHaveBeenCalled()
      cleanup()
      draw({ extendOnAccept: true, verdicts: `${NEURON}/${SECOND}=accept` })
      expect(extendButtons()[0]!.textContent).toBe('Extend (large)')
      expect(extendButtons()[0]!.title).toMatch(
        /Extend on accept leaves a piece this size to this button/,
      )
    })

    it('extends nothing where nothing is wired back', () => {
      wiredBack = false
      draw({ extendOnAccept: true })
      fireEvent.click(accept(rows()[0]!))
      expect(storedVerdicts()).toBe(`${NEURON}/${PIECE}=a`)
      expect(stored()['extend']).toBe('')
      expect(runNode).not.toHaveBeenCalled()
    })
  })

  /**
   * By confidence the piece's end (0.30) sorts below both of the neuron's tips (0.91, 0.42). It
   * is drawn straight under the row its piece was accepted on, a step in.
   */
  it('lists the piece’s open end beneath the row the piece was accepted on, a step in', () => {
    draw(EXTENDED, true, grownCandidates(), grownTips(true))
    // The neuron's two tips and the piece's one open end; the end it joins by is not listed.
    expect(rows()).toHaveLength(3)
    expect(rows().map((row) => row.getAttribute('data-depth'))).toEqual(['0', '1', '0'])
    expect(rows()[0]!.textContent).toContain(PIECE)
    const piece = rows()[1]!
    expect(piece.textContent).toContain(NEXT)
    expect((piece as HTMLElement).style.getPropertyValue('--depth')).toBe('1')
    // Where it sits says which piece it is on; the row's name still says it in words.
    expect(piece.querySelector('.review-row__facts')?.textContent).not.toContain('on piece')
    expect(piece.querySelector('.review-row__pick')?.getAttribute('aria-label')).toBe(
      `Show tip 11 of piece ${PIECE} and candidate ${NEXT}`,
    )
    expect(screen.getByText('1 piece extended')).toBeTruthy()
    expect(screen.getByText('3 tips')).toBeTruthy()
  })

  /**
   * Accepted at rank 2 and extended: with the cursor elsewhere a tip's row shows its first
   * candidate — except here, where the rows beneath it would otherwise be about a piece the row
   * above them does not name.
   */
  it('shows the extended piece on the row its ends hang beneath, and opens on it', () => {
    const LOWER = '648518346356867476'
    const tips = grownTips(true)
    const lower: TableValue = makeTable(tips.schema, {
      ...tips.data,
      [ID_COLUMN_NAME]: [NEURON, NEURON, LOWER, LOWER],
    })
    const candidates = grownCandidates()
    const written = draw(
      { verdicts: `${NEURON}/${LOWER}=accept`, extend: `${NEURON}/${LOWER}` },
      true,
      makeTable(candidates.schema, {
        ...candidates.data,
        [ID_COLUMN_NAME]: [NEURON, NEURON, NEURON, LOWER],
      }),
      lower,
    )
    expect(rows().map((row) => row.getAttribute('data-depth'))).toEqual(['0', '1', '0'])
    expect(rows()[0]!.querySelector('.review-row__id')?.textContent).toContain(LOWER)
    expect(rows()[0]!.querySelector('.review-row__extend')?.textContent).toBe('1 end searched')
    fireEvent.click(rows()[0]!.querySelector('.review-row__pick')!)
    expect(written).toEqual({ current: at(11), rank: 2 })
  })

  /** Both roots have a tip 11. The cursor is on one of them. */
  it('lights the one row the cursor is on, and writes the root with the number', () => {
    const written = draw(
      { ...EXTENDED, current: `${PIECE}|11` },
      true,
      grownCandidates(),
      grownTips(true),
    )
    const lit = rows().filter((row) => row.getAttribute('data-current') === 'yes')
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toContain(NEXT)
    fireEvent.click(lit[0]!.querySelector('.review-row__pick')!)
    expect(written).toEqual({ current: `${PIECE}|11`, rank: 1 })
    // And a verdict there is about the piece and its candidate, not the neuron and it.
    fireEvent.click(lit[0]!.querySelector('.review-row__verdict')!)
    // (The piece's id sorts before the neuron's, and the param is written sorted.)
    expect(storedVerdicts()).toBe(`${PIECE}/${NEXT}=a;${NEURON}/${PIECE}=a`)
  })

  /**
   * The card's own part: the search node's state and the rows that have arrived. The wording of
   * every state is `extendLabel`'s, held in `reviewQueue.test.ts`.
   */
  it.each<[string, string, TableValue | undefined, string]>([
    ['its tips not in yet', 'running', undefined, 'waiting…'],
    ['a search stopped part way', 'idle', grownTips(null), '0 of 1 end searched'],
    ['every end searched', 'ok', grownTips(true), '1 end searched'],
  ])('says how far the search has got, with %s', (_, state, tips, label) => {
    searchState = state
    draw(EXTENDED, true, grownCandidates(), tips ?? TIPS)
    const button = extendButtons()[0]!
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toBe(label)
  })

  it('stops extending on a second press, running nothing, and the rows go at once', () => {
    draw(EXTENDED, true, grownCandidates(), grownTips(true))
    const button = extendButtons()[0]!
    expect(button.title).toMatch(
      /Press to stop extending it, which takes its ends off the list/,
    )
    fireEvent.click(button)
    expect(stored()['extend']).toBe('')
    expect(runNode).not.toHaveBeenCalled()
    cleanup()
    // The same tables, the search not having run again: the piece's rows are not listed.
    draw({ verdicts: ACCEPTED }, true, grownCandidates(), grownTips(true))
    expect(rows()).toHaveLength(2)
    expect(document.body.textContent).not.toContain(NEXT)
  })

  it('takes a piece out of the extended ones when it is un-accepted, and says so first', () => {
    draw(
      {
        ...EXTENDED,
        verdicts: `${ACCEPTED};${PIECE}/${NEXT}=accept`,
        extend: `${NEURON}/${PIECE};${PIECE}/${NEXT}`,
      },
      true,
      grownCandidates(),
      grownTips(true),
    )
    const row = rows().find(
      (r) => r.textContent?.includes(PIECE) && !r.textContent.includes(NEXT),
    )!
    const reject = row.querySelectorAll<HTMLButtonElement>('.review-row__verdict')[1]!
    expect(reject.title).toMatch(
      /changing its verdict takes its ends, and those of the 1 piece extended beyond it, off the list/,
    )
    const before = useGraphStore.getState().past.length
    fireEvent.click(reject)
    expect(stored()['verdicts']).toBe(`${PIECE}/${NEXT}=a;${NEURON}/${PIECE}=r`)
    // The piece beyond keeps its entry, unreachable until this one is extended again.
    expect(stored()['extend']).toBe(`${PIECE}/${NEXT}`)
    expect(useGraphStore.getState().past.length).toBe(before + 1)
    expect(runNode).not.toHaveBeenCalled()
  })

  /** A second accept of one piece would be a second merge of it. */
  it('marks a candidate that is in the neuron already, and fixes its verdict', () => {
    draw(
      { ...EXTENDED, verdicts: `${ACCEPTED};${NEURON}/${SECOND}=accept` },
      true,
      // The piece's end lists the piece already accepted on the neuron's tip 22.
      grownCandidates(SECOND),
      grownTips(true),
    )
    const row = rows().find((r) => r.getAttribute('data-depth') === '1')!
    expect(row.querySelector('.review-row__merged')?.textContent).toBe('in this neuron')
    const verdicts = [...row.querySelectorAll<HTMLButtonElement>('.review-row__verdict')]
    expect(verdicts.every((button) => button.disabled)).toBe(true)
    expect(row.querySelector('.review-row__extend')).toBeNull()
    // Where it was accepted, it is an ordinary accepted row.
    const own = rows().find((r) => r.textContent?.includes('kink'))!
    expect(own.querySelector('.review-row__merged')).toBeNull()
    expect(own.querySelector<HTMLButtonElement>('.review-row__verdict')!.disabled).toBe(false)
  })

  /** Submit takes a neuron grown piece by piece as it takes any other: the plan is a tree. */
  it('offers Submit for a neuron with extended pieces', () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    const dataset: Value = {
      kind: 'dataset',
      sourceId: 'cave',
      datasetId: 'test_stack:1',
      label: 'test',
    }
    draw(EXTENDED, true, grownCandidates(), grownTips(true), dataset)
    const submit = document.querySelector<HTMLButtonElement>('.review-body__submit')!
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    // The whole live queue goes with it: the piece's tips are part of this neuron's.
    const request = openSubmit.mock.calls.at(-1)![0] as {
      reviewedRoot: string
      queue: unknown[]
    }
    expect(request.reviewedRoot).toBe(NEURON)
    expect(request.queue).toHaveLength(3)
    resetCredentials()
    openSubmit.mockReset()
  })
})

/**
 * Reject, Ends and Unsure share one split button (user, 2026-11-18): the face is a verdict in one
 * press — the row's own where it is one of the three, else Reject — and the ▾ the menu of all three.
 */
describe('the split verdict button', () => {
  const face = () => rows()[0]!.querySelectorAll<HTMLButtonElement>('.review-row__verdict')[1]!
  const more = () => rows()[0]!.querySelector<HTMLButtonElement>('.review-row__more')!
  const item = (name: string) => screen.getByRole('menuitemradio', { name: new RegExp(name) })
  /** The keys (user, 2026-11-22), named where the reader looks for what a button does. */
  it('names each verdict’s key in its title, and none where the press is refused', () => {
    draw({ current: at(11), rank: 1 })
    const accept = rows()[0]!.querySelectorAll<HTMLButtonElement>('.review-row__verdict')[0]!
    expect(accept.title).toMatch(
      / Key: Q, which also moves on to the next row without a verdict\.$/,
    )
    expect(face().title).toMatch(/ Key: W,/)
    expect(more().title).toBe('Reject (W), Ends (T), Unsure (Y) or Ignore (U)')
    fireEvent.click(more())
    expect(item('Ignore').getAttribute('title')).toMatch(/ Key: U,/)
    cleanup()
    render(
      <VerdictButtons
        said={undefined}
        press={() => ({ title: 'Merged by Submit.', disabled: true })}
        onJudge={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Accept' }).title).toBe('Merged by Submit.')
  })

  it('reads Reject on a row with no verdict, and gives it in one press', () => {
    draw({ current: at(11), rank: 1 })
    expect(face().textContent).toBe('Reject')
    fireEvent.click(face())
    expect(storedVerdicts()).toBe('720575940621522189/648518346368395605=r')
  })

  it('opens Reject, Ends, Unsure and Ignore, and records the one picked', () => {
    draw({ current: at(11), rank: 1 })
    fireEvent.click(more())
    expect(screen.getAllByRole('menuitemradio').map((one) => one.textContent)).toEqual([
      'Reject',
      'Ends',
      'Unsure',
      'Ignore',
    ])
    fireEvent.click(item('Ends'))
    expect(storedVerdicts()).toBe('720575940621522189/648518346368395605=e')
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    fireEvent.click(more())
    fireEvent.click(item('Ignore'))
    expect(storedVerdicts()).toBe('720575940621522189/648518346368395605=i')
  })

  it('closes its menu from ▾ as well as from outside', () => {
    draw({ current: at(11), rank: 1 })
    fireEvent.click(more())
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
    // The press as a browser sends it: pointerdown first, then the click.
    fireEvent.pointerDown(more())
    fireEvent.click(more())
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    fireEvent.click(more())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  it('takes the keyboard into the menu, and down it with the arrows', () => {
    draw({ current: at(11), rank: 1 })
    fireEvent.click(more())
    expect(document.activeElement).toBe(item('Reject'))
    fireEvent.keyDown(item('Reject'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Ends'))
    fireEvent.keyDown(item('Ends'), { key: 'ArrowUp' })
    fireEvent.keyDown(item('Reject'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Ignore'))
  })

  it('shows the row’s own verdict on the face, ticked in the menu, and on the row', () => {
    draw({ current: at(11), rank: 1, verdicts: '720575940621522189/648518346368395605=ends' })
    expect(face().textContent).toBe('Ends')
    expect(face().getAttribute('aria-pressed')).toBe('true')
    expect(rows()[0]!.getAttribute('data-verdict')).toBe('ends')
    fireEvent.click(more())
    expect(item('Ends').getAttribute('aria-checked')).toBe('true')
  })

  it('takes Ends back when the face is pressed again', () => {
    draw({
      current: at(11),
      rank: 1,
      verdicts: '720575940621522189/648518346368395605=ends',
    })
    fireEvent.click(face())
    expect(storedVerdicts()).toBe('')
  })
})

/**
 * A press sends the verdict to SEAM, where the reader opted in (`verdictLog.ts`). Only the press:
 * the network half is faked here, and what the press queued is read off the log's own state.
 */
describe('sending verdicts to SEAM', () => {
  const CAVE: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  const LABELLED: TableValue = makeTable(
    tableSchema(...TIPS.schema.columns, column('source', 'str')),
    { ...TIPS.data, source: ['set:rv4-ad75ed161bb6', 'set:rv4-ad75ed161bb6'] },
  )
  const queued = () =>
    JSON.parse(window.localStorage.getItem('coda.verdictQueue') ?? '[]') as {
      target: { datastack: string }
      record: Record<string, unknown>
    }[]
  const reject = () =>
    fireEvent.click(rows()[0]!.querySelectorAll<HTMLButtonElement>('.review-row__verdict')[1]!)
  /** Drawn, and the server's answer about what it collects let in. */
  async function drawSharing(params: ParamValues = {}, tips = LABELLED, dataset = CAVE) {
    draw({ current: at(11), rank: 1, ...params }, true, CANDIDATES, tips, dataset)
    await act(async () => {})
  }

  /** The server's list of what it collects, the one request the card itself makes. */
  const collecting = (datastacks: readonly string[]) =>
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ collecting: true, datastacks })),
    )

  beforeEach(() => {
    resetVerdictLog()
    flushVerdicts.mockClear()
    collecting(['test_stack'])
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends nothing while the reader has not turned it on', async () => {
    await drawSharing()
    reject()
    expect(queued()).toEqual([])
    expect(flushVerdicts).not.toHaveBeenCalled()
  })

  it('sends a press, with the tip, the candidate and the word, and flushes', async () => {
    writeSharing({ on: true, name: 'A Reader', email: '' })
    await drawSharing()
    reject()
    const [one] = queued()
    expect(one!.target.datastack).toBe('test_stack')
    expect(one!.record).toMatchObject({
      source: 'set:rv4-ad75ed161bb6',
      neuron: '720575940621522189',
      piece: '720575940621522189',
      end_uid: 11,
      candidate: '648518346368395605',
      rank: 1,
      q: 0.91,
      r: 0.95,
      verdict: 'reject',
      name: 'A Reader',
    })
    expect(flushVerdicts).toHaveBeenCalled()
  })

  it('sends a verdict taken back as cleared', async () => {
    writeSharing({ on: true, name: '', email: '' })
    await drawSharing({ verdicts: '720575940621522189/648518346368395605=reject' })
    reject()
    expect(queued()[0]!.record['verdict']).toBe('cleared')
  })

  it('sends nothing for a tip whose source is not SEAM’s', async () => {
    writeSharing({ on: true, name: '', email: '' })
    await drawSharing({}, TIPS)
    reject()
    expect(queued()).toEqual([])
  })

  it('sends nothing for a datastack the server does not collect, and says so', async () => {
    writeSharing({ on: true, name: '', email: '' })
    collecting(['other_stack'])
    await drawSharing()
    reject()
    expect(queued()).toEqual([])
    expect(screen.getByText(/Not collected for test_stack/)).toBeTruthy()
  })

  it('turns sending on from the switch in the foot, and counts what is sent', async () => {
    await drawSharing()
    fireEvent.click(screen.getByLabelText('Help improve'))
    expect(verdictLogState().sharing.on).toBe(true)
    expect(screen.getByText(/0 sent/)).toBeTruthy()
  })

  it('keeps the name and email from the panel', async () => {
    await drawSharing()
    fireEvent.click(screen.getByLabelText('What Help improve sends, and your name and email'))
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'reader@example.org' },
    })
    expect(verdictLogState().sharing.email).toBe('reader@example.org')
  })
})

describe('hand picks on the review card', () => {
  const FRAME = {}
  /** Tip 11's second candidate: listed, and not accepted. */
  const LISTED = '648518346356867476'
  const PICKED = '648518346399999999'
  const CAVE: Value = {
    kind: 'dataset',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    label: 'test',
  }
  const stored = () => useGraphStore.getState().graph.nodes[0]!.params
  const notice = () => useGraphStore.getState().notice
  /** `J` with the pointer on `segment`, in a frame, and whatever the check does after it. */
  const pick = async (segment: string) => {
    setHoveredSegment(FRAME, segment, [5000, 5000, 5000])
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }))
    })
  }

  beforeEach(() => useGraphStore.setState({ past: [], notice: undefined } as never))
  afterEach(() => {
    setHoveredSegment(FRAME, undefined)
    resetCredentials()
    checkPick.mockReset()
  })

  it('accepts a piece the list holds where it is listed, and moves there, in one step', async () => {
    draw({ current: at(22), rank: 1 })
    await pick(LISTED)
    expect(decodeVerdicts(stored()['verdicts']).get(`${NEURON}/${LISTED}`)).toBe('accept')
    expect(stored()['current']).toBe(at(11))
    expect(stored()['rank']).toBe(2)
    expect(stored()['picks']).toBe('')
    expect(useGraphStore.getState().past.length).toBe(1)
    expect(checkPick).not.toHaveBeenCalled()
  })

  /** A followed piece is drawn as its new root: picking that is picking the piece listed. */
  it('takes a pick on a followed piece’s new root for the piece listed', async () => {
    const FOLLOWED = '720575940800000077'
    const merges = JSON.stringify([
      {
        kind: 'piece-followed',
        deployment: DEFAULT_CAVE_SERVER,
        datastack: 'test_stack',
        reviewedRoot: NEURON,
        piece: LISTED,
        from: LISTED,
        to: FOLLOWED,
        at: '2026-11-25T12:00:00.000Z',
        supervoxel: '73747834149376702',
        away: [],
      },
    ])
    draw({ current: at(22), rank: 1, merges }, true, CANDIDATES, TIPS, CAVE)
    await pick(FOLLOWED)
    expect(decodeVerdicts(stored()['verdicts']).get(`${NEURON}/${LISTED}`)).toBe('accept')
    expect(stored()['picks']).toBe('')
    expect(checkPick).not.toHaveBeenCalled()
  })

  it('says what it needs before checking a piece the list does not hold', async () => {
    draw()
    await pick(PICKED)
    expect(notice()).toMatch(/needs a CAVE dataset/)
    draw({}, true, CANDIDATES, TIPS, CAVE)
    await pick(PICKED)
    expect(notice()).toMatch(/Sign in to/)
    expect(checkPick).not.toHaveBeenCalled()
    expect(useGraphStore.getState().past.length).toBe(0)
  })

  it('checks a new piece, then lists and accepts it, in one step', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    checkPick.mockResolvedValue({
      ok: true,
      root: NEURON,
      contactNm: [5000, 5000, 5000],
      gapUm: 0.3,
      l2Chunks: 3,
    })
    draw({}, true, CANDIDATES, TIPS, CAVE)
    await pick(PICKED)
    expect(checkPick).toHaveBeenCalledWith(
      expect.objectContaining({
        datastack: 'test_stack',
        segment: PICKED,
        positionNm: [5000, 5000, 5000],
        seed: NEURON,
        neuronRoot: NEURON,
      }),
      expect.objectContaining({ deployment: DEFAULT_CAVE_SERVER }),
    )
    expect(decodePicks(stored()['picks'])).toEqual([
      {
        n: 1,
        seed: NEURON,
        root: NEURON,
        candidateId: PICKED,
        contactNm: [5000, 5000, 5000],
        gapUm: 0.3,
        l2Chunks: 3,
      },
    ])
    expect(decodeVerdicts(stored()['verdicts']).get(`${NEURON}/${PICKED}`)).toBe('accept')
    // No tip within 2 µm of it: a tip of its own.
    expect(stored()['current']).toBe(at(-1))
    expect(stored()['rank']).toBe(1)
    expect(useGraphStore.getState().past.length).toBe(1)
    expect(notice()).toMatch(/^Added .* by hand and accepted it/)
  })

  /*
   * A second hop by hand (user, 2026-11-20): a piece accepted and never extended counts as the
   * neuron's for the check, and the pick's row stays on it — before, the check looked for the
   * neuron alone, and a row on a piece outside the tree was dropped with that piece's tips.
   */
  it('takes a pick touching a piece accepted and not extended, and lists it on that piece', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    checkPick.mockResolvedValue({
      ok: true,
      root: LISTED,
      contactNm: [5000, 5000, 5000],
      gapUm: 0.4,
      l2Chunks: 2,
    })
    draw({ verdicts: `${NEURON}/${LISTED}=a` }, true, CANDIDATES, TIPS, CAVE)
    await pick(PICKED)
    expect(checkPick).toHaveBeenCalledWith(
      expect.objectContaining({ pieces: expect.arrayContaining([LISTED]) }),
      expect.anything(),
    )
    expect(decodePicks(stored()['picks'])[0]).toMatchObject({
      root: LISTED,
      candidateId: PICKED,
    })
    expect(decodeVerdicts(stored()['verdicts']).get(`${LISTED}/${PICKED}`)).toBe('accept')
    // The cursor on the pick's own tip on that piece: a row the list holds.
    expect(stored()['current']).toBe(`${LISTED}|-1`)
    expect(notice()).toMatch(/^Added .* by hand and accepted it/)
    // Drawn again from what was written: the row is there, beneath the piece it touches.
    cleanup()
    draw({ ...stored() }, true, CANDIDATES, TIPS, CAVE)
    expect(rows().map((row) => row.querySelector('.review-row__id')?.textContent)).toContain(
      `${PICKED}by hand`,
    )
  })

  it('checks once for two presses before the first answers', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    let answer: (value: unknown) => void = () => {}
    checkPick.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    draw({}, true, CANDIDATES, TIPS, CAVE)
    setHoveredSegment(FRAME, PICKED, [5000, 5000, 5000])
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }))
    })
    await act(async () =>
      answer({
        ok: true,
        root: NEURON,
        contactNm: [5000, 5000, 5000],
        gapUm: 0.3,
        l2Chunks: 3,
      }),
    )
    expect(checkPick).toHaveBeenCalledTimes(1)
    expect(decodePicks(stored()['picks'])).toHaveLength(1)
  })

  it('writes nothing for a pick the check refuses, and says why', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    checkPick.mockResolvedValue({ ok: false, message: 'That is the neuron itself.' })
    draw({}, true, CANDIDATES, TIPS, CAVE)
    await pick(PICKED)
    expect(notice()).toBe('That is the neuron itself.')
    expect(useGraphStore.getState().past.length).toBe(0)
  })

  it('draws a hand pick first, marked, with none of SEAM’s numbers', () => {
    draw({
      picks: encodePicks([
        {
          n: 1,
          seed: NEURON,
          root: NEURON,
          candidateId: PICKED,
          contactNm: [9000, 9000, 9000],
          gapUm: 0.3,
          l2Chunks: 3,
        },
      ]),
    })
    expect(rows()).toHaveLength(3)
    const first = rows()[0]!
    expect(first.querySelector('.review-row__id')?.textContent).toBe(`${PICKED}by hand`)
    expect(first.querySelector('.review-row__score')?.textContent).toBe('—')
  })
})

/** The verdict keys (user, 2026-11-22): Q W T Y U judge the row under the cursor; G moves on. */
describe('the verdict keys', () => {
  const stored = () => useGraphStore.getState().graph.nodes[0]!.params
  const notice = () => useGraphStore.getState().notice
  // As the frame hands a key back: the position only.
  const press = (code: string, mods: KeyboardEventInit = {}) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, ...mods }))
    })
  const FIRST = `${NEURON}/648518346368395605`
  const OTHER = `${NEURON}/648518347608868926`

  beforeEach(() => useGraphStore.setState({ past: [], notice: undefined } as never))

  it('judges the row under the cursor and moves to the next without a verdict, in one step', () => {
    draw({ current: at(11), rank: 1 })
    press('KeyQ')
    expect(decodeVerdicts(stored()['verdicts']).get(FIRST)).toBe('accept')
    expect(stored()['current']).toBe(at(22))
    expect(stored()['rank']).toBe(1)
    expect(useGraphStore.getState().past.length).toBe(1)
  })

  it('gives each key its verdict, and starts from the top past the last row', () => {
    draw({ current: at(22), rank: 1 })
    press('KeyU')
    expect(decodeVerdicts(stored()['verdicts']).get(OTHER)).toBe('ignore')
    expect(stored()['current']).toBe(at(11))
  })

  it('never takes a verdict back, where the button would', () => {
    draw({ current: at(11), rank: 1, verdicts: `${FIRST}=accept` })
    press('KeyQ')
    expect(decodeVerdicts(stored()['verdicts']).get(FIRST)).toBe('accept')
    expect(stored()['current']).toBe(at(22))
  })

  it('moves on without a verdict on G, and says so where every row has one', () => {
    draw({ current: at(11), rank: 1 })
    press('KeyG')
    expect(stored()['verdicts'] ?? '').toBe('')
    expect(stored()['current']).toBe(at(22))
    draw({ current: at(22), rank: 1, verdicts: `${FIRST}=reject;${OTHER}=unsure` })
    press('KeyG')
    expect(stored()['current']).toBe(at(22))
    expect(notice()).toBe('No other listed row is left to review.')
  })

  it('leaves a key pressed with a modifier alone', () => {
    draw({ current: at(11), rank: 1 })
    press('KeyQ', { shiftKey: true })
    press('KeyW', { metaKey: true })
    expect(stored()['verdicts'] ?? '').toBe('')
    expect(stored()['current']).toBe(at(11))
  })

  /** A verdict changed under a plan being confirmed or sent is not the one merged (review). */
  it('waits while a Submit window is up, this card’s or another’s', () => {
    for (const state of ['open', 'running', 'other'] as const) {
      submitState = state
      draw({ current: at(11), rank: 1 })
      press('KeyQ')
      expect(stored()['verdicts'] ?? '').toBe('')
      expect(stored()['current']).toBe(at(11))
      expect(notice()).toMatch(/Close the Submit window first/)
    }
    submitState = 'none'
  })

  /** The check reads the verdicts once, when it starts: one changed after is not in the plan. */
  it('holds verdicts, but not Skip, while Submit is checking', () => {
    submitState = 'planning'
    try {
      draw({ current: at(11), rank: 1 })
      press('KeyQ')
      expect(stored()['verdicts'] ?? '').toBe('')
      expect(notice()).toMatch(/Submit is checking/)
      const accept = rows()[0]!.querySelector<HTMLButtonElement>('[data-verdict="accept"]')
      expect(accept?.disabled).toBe(true)
      press('KeyG')
      expect(stored()['current']).not.toBe(at(11))
    } finally {
      submitState = 'none'
    }
  })

  it('stands down during a tour, and in an open menu', () => {
    draw({ current: at(11), rank: 1 })
    act(() => useGraphStore.setState({ screenMapOpen: true }))
    press('KeyQ')
    expect(stored()['verdicts'] ?? '').toBe('')
    act(() => useGraphStore.setState({ screenMapOpen: false }))
    // The ▾ menu open, its first item focused: Q there is not a verdict on the row behind.
    fireEvent.click(rows()[0]!.querySelector<HTMLButtonElement>('.review-row__more')!)
    const item = screen.getAllByRole('menuitemradio')[0]!
    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }))
    })
    expect(stored()['verdicts'] ?? '').toBe('')
  })

  it('asks for a row first where the cursor is on none', () => {
    draw({ current: '', rank: 1 })
    press('KeyW')
    expect(stored()['verdicts'] ?? '').toBe('')
    expect(notice()).toMatch(/Click a row first/)
  })
})
