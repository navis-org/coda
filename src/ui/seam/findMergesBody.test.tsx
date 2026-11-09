// @vitest-environment jsdom

/**
 * Find Merges' card.
 *
 * Two failures here are silent on screen. A body replaces the generic param rows outright, so a
 * control it forgets to draw exists only in the inspector — which looks exactly like a control
 * nobody added; `Score cutoff` is the one that matters, since finding a cutoff is the whole
 * reason this body exists. And the histogram is read out of the node's **own output**, which a
 * body reaches only by subscribing to the run tick: without that the card shows whatever the
 * table was when it mounted and never updates, which reads as "the model found nothing".
 *
 * The arithmetic is `mergeSummary.test.ts`'. What is pinned here is that the card asks for it,
 * draws it, and writes the cutoff back as a param.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import type { ParamValue, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { windowTable } from '../../packs/seam/mergeTables'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import '../../nodes'
import { FindMergesBody } from './FindMergesBody'
import { NODE_BODIES } from '../nodes/nodeBodies'

const TYPE = 'seam:findMerges'

const scored = (scores: number[]) =>
  windowTable(
    scores.map((score, i) => ({
      neuronId: 'a',
      cell: i,
      centreNm: [0, 0, 0] as const,
      score,
      logit: 0,
      points: 100,
      balance: i === 0 ? 0.4 : 0,
    })),
  )

beforeAll(() => installJsdomStubs({ width: 1000, height: 700 }))
beforeEach(clearStorage)
afterEach(cleanup)

function draw(params: ParamValues = {}, output?: ReturnType<typeof windowTable>) {
  const def = requireNodeDef(TYPE)
  const graph = addNode(emptyGraph(), {
    id: 'n1',
    type: TYPE,
    position: { x: 0, y: 0 },
    params: defaultParams(def),
  })
  useGraphStore.setState({
    graph,
    // The scheduler never runs in jsdom — there is no GPU and no Pyodide — so the one thing the
    // body needs of it is stubbed at the seam it actually reads.
    nodeOutput: (_nodeId: string, portId: string) =>
      portId === 'windows' ? output : undefined,
  } as never)
  const node = { ...graph.nodes[0]!, params: { ...defaultParams(def), ...params } }
  const written: Record<string, ParamValue> = {}
  render(
    <FindMergesBody
      node={node}
      ctx={makeInferContext(def, node.params, {})}
      compact
      setParam={(id, value) => {
        written[id] = value
      }}
      onError={() => {}}
    />,
  )
  return written
}

describe('the Find Merges card', () => {
  it('is registered as this node’s body, and offers the overlay', () => {
    expect(NODE_BODIES[TYPE]?.Component).toBe(FindMergesBody)
    expect(NODE_BODIES[TYPE]?.expandable).toBe(true)
  })

  /** The control the body exists for. A body that drew the fields it liked would hide it. */
  it('draws every card param, Score cutoff included', () => {
    draw()
    expect(screen.getByTitle(/line drawn on the card/i)).toBeTruthy()
  })

  it('says so before a run rather than drawing an empty histogram', () => {
    draw()
    expect(screen.getByText(/not run yet/i)).toBeTruthy()
    expect(document.querySelector('.merge-hist')).toBeNull()
  })

  it('reads the cells, the fragments and the scores out of the run’s own table', () => {
    draw({}, scored([0.1, 0.5, 0.95]))
    expect(screen.getByText('3 cells')).toBeTruthy()
    // One cell was cut, so there is one more fragment than there are cells.
    expect(screen.getByText('4 fragments')).toBeTruthy()
    expect(screen.getByText('0.10 · 0.50 · 0.95')).toBeTruthy()
  })

  it('counts what is at or above a cutoff without re-running anything', () => {
    draw({ cutoff: '0.5' }, scored([0.1, 0.5, 0.95]))
    expect(screen.getByText('≥ 0.5: 2')).toBeTruthy()
  })

  /**
   * jsdom lays nothing out, so the histogram's box is zero wide. A click there must do nothing
   * rather than read as a deliberate cutoff of 0 — which is a real cutoff, and would be written
   * back as one.
   */
  it('ignores a click it cannot place', () => {
    const written = draw({}, scored([0.1, 0.9]))
    fireEvent.click(document.querySelector('.merge-hist')!)
    expect(written).toEqual({})
  })
})
