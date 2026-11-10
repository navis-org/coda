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

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import type { ParamValue, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { TableValue, Value } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import '../../nodes'
import { ReviewBody } from './ReviewBody'

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

function draw(params: ParamValues = {}, compact = true) {
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
  const inputValues: Record<string, Value | undefined> = { tips: TIPS, candidates: CANDIDATES }
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
    expect(rows()[0]!.textContent).toContain('µm³')
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
})
