// @vitest-environment jsdom

/**
 * The Review Suggestions card.
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
import type { TableValue, Value } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import '../../nodes'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import type { SubmitState } from './mergeSession'
import { ReviewBody, submitPress } from './ReviewBody'

/** Submit's session, faked: the card only reads its state and opens it. */
const openSubmit = vi.fn()
const closeSubmit = vi.fn()
let submitState: SubmitState = 'none'
/** The currency check, faked: roots in `edited` are outdated, and what was asked is kept. */
const edited = new Set<string>()
const askedCurrency: string[][] = []
vi.mock('../../packs/seam/rootCurrency', () => ({
  rootCurrency: {
    ask: (_: unknown, roots: readonly string[]) => askedCurrency.push([...roots]),
    current: (_: unknown, root: string) => !edited.has(root),
    subscribe: () => () => {},
    version: () => 0,
  },
}))
vi.mock('./mergeSession', () => ({
  openSubmit: (...args: unknown[]) => openSubmit(...args),
  closeSubmit: () => closeSubmit(),
  useSubmitState: () => submitState,
}))

const TYPE = 'seam:review'

const TIPS: TableValue = makeTable(
  tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('end_uid', 'i64'),
    column('kind', 'str'),
    column('x', 'f64'),
    column('y', 'f64'),
    column('z', 'f64'),
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
    r: [0.91, 0.42],
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
  r: [0.91, 0.99, 0.42],
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
  useGraphStore.setState({ graph } as never)
  const node = { ...graph.nodes[0]!, params: { ...defaultParams(def), ...params } }
  const written: Record<string, ParamValue> = {}
  const inputValues: Record<string, Value | undefined> = { tips, candidates, dataset }
  render(
    <ReviewBody
      node={node}
      ctx={makeInferContext(def, node.params, {})}
      inputValues={inputValues}
      compact={compact}
      setParam={(id, value) => {
        written[id] = value
      }}
      onError={() => {}}
    />,
  )
  return written
}

const rows = () => [...document.querySelectorAll('.review-row')]

describe('the review card', () => {
  /** The controls the card exists for. A body drawing only the fields it liked would hide them. */
  it('draws every card param, filters and sort included', () => {
    draw()
    const labels = [...document.querySelectorAll('.param__label')].map((n) => n.textContent)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Min confidence',
        'Min size',
        'Only SEAM’s shown set',
        'Sort by',
        'Show accepted',
      ]),
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
    draw({ current: '11' })
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
    expect(written).toEqual({ current: '11', rank: 2 })
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
    expect(rows()[0]!.textContent).toContain('0.910')
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
    const written = draw({ current: '22', rank: 1 })
    fireEvent.click(rows()[0]!.querySelector('.review-row__pick')!)
    expect(written).toEqual({ current: '11', rank: 1 })
  })

  it('pages through the current tip’s candidates, and stops at the ends', () => {
    const written = draw({ current: '11', rank: 1 })
    const row = rows()[0]!
    const [back, forward] = [...row.querySelectorAll('.review-row__page')]
    // Rank 1 of 2: back is dead, forward moves.
    expect((back as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(forward!)
    expect(written['rank']).toBe(2)
  })

  it('offers the arrows only on the row being looked at', () => {
    draw({ current: '11', rank: 1 })
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
    const written = draw({ current: '11', rank: 2 })
    fireEvent.click(rows()[0]!.querySelectorAll('.review-row__verdict')[1]!)
    expect(written['verdicts']).toBe('11:648518346356867476=reject')
  })

  it('clears a verdict when the same one is pressed again', () => {
    const written = draw({ current: '11', rank: 1, verdicts: '11:648518346368395605=accept' })
    fireEvent.click(rows()[0]!.querySelectorAll('.review-row__verdict')[0]!)
    expect(written['verdicts']).toBe('')
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

  /** The neuron the whole card is about, named even when there is nothing to choose between. */
  it('names its one neuron in a disabled list', () => {
    draw({ verdicts: '11:648518346368395605=accept' })
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
      { neuron: OTHER, verdicts: '11:648518346368395605=accept;33:648518346300000001=reject' },
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
    draw({ current: '22', rank: 1 }, true, TWO_CANDIDATES, TWO_TIPS)
    const before = useGraphStore.getState().past.length
    fireEvent.change(screen.getByRole('combobox', { name: 'Neuron' }), {
      target: { value: OTHER },
    })
    const node = useGraphStore.getState().graph.nodes[0]!
    expect(node.params).toMatchObject({ neuron: OTHER, current: '33', rank: 1 })
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
  const ACCEPTED = { verdicts: `11:${FIRST}=accept;22:${SECOND}=accept` }
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

  /** A sign-in in the Sources panel lifts the reason without anything else changing. */
  it('follows a sign-in', () => {
    draw(ACCEPTED, true, CANDIDATES, TIPS, CAVE_DATASET)
    expect(button().disabled).toBe(true)
    act(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
    expect(button().disabled).toBe(false)
  })

  it('leaves a merged piece out of the count, says so on its row and fixes its verdict', () => {
    draw({ ...ACCEPTED, merges: MERGED, mode: 'candidate' })
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
  const ACCEPTED = { verdicts: `11:${FIRST}=accept`, mode: 'candidate' }
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

describe('submitPress', () => {
  const ready = {
    docId: 'doc',
    nodeId: 'r1',
    sourceId: 'cave',
    datasetId: 'test_stack:1',
    queue: [],
    neuron: '720575940621522189',
    signedIn: true,
    filling: false,
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
    ['a search still running', { filling: true }, /still running/],
    ['a neuron merged into another', { absorbed: true }, /merged into another/],
    ['a neuron edited since', { neuronEdited: true }, /edited since these suggestions/],
    ['nothing accepted', { accepted: 0, count: 0 }, /Accept a piece/],
    ['every accepted piece merged', { count: 0 }, /Every accepted piece is merged/],
    ['its own Submit open', { submitting: 'open' }, /Submit is open/],
    ['merges being sent', { submitting: 'running' }, /being sent/],
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
