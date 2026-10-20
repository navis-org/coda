// @vitest-environment jsdom
/**
 * Skeleton to Points' hand placement: a click on a drawn branch stores the point where it landed
 * on that edge — not the nearest node — and the list edits what is stored, per neuron.
 *
 * jsdom lays nothing out, so the click is aimed as the split editor's test aims its own: at where
 * the stubbed 800 × 480 stage draws the branch. The 3D half is a stand-in that records its props;
 * whether it frames the neuron well is a browser question.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { EMPTY_BOUNDS, makeTable } from '../../core/values'
import { DAYLIGHT_PASSES, equalAngleLayout } from '../../nodes/lib/arborLayout'
import { buildArbor, keyTree, landmarkDistances } from '../../nodes/lib/arborOps'
import { ySkeleton } from '../../nodes/lib/__fixtures__/ySkeleton'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import {
  MANUAL_PARAM,
  readManualPoints,
  writeManualPoint,
} from '../../nodes/lib/skeletonPoints'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { fitTransform, toScreen } from './arborPlot'
import { PointsEditor } from './PointsEditor'

let sceneProps: Record<string, unknown> | undefined
vi.mock('./LazyViewers', () => ({
  LazyViewer3D: (props: Record<string, unknown>) => {
    sceneProps = props
    return <div data-testid="scene" />
  },
}))

function value(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      { ...ySkeleton(), id: '1001' },
      { ...ySkeleton(), id: '1002' },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'str'), column('type', 'str')), {
      neuronId: ['1001', '1002'],
      type: ['LC4', 'LC6'],
    }),
    bounds: EMPTY_BOUNDS,
    units: 'nm',
  }
}

/** Where the stub's stage draws a point `along` the piece ending at `leaf`; the split test's aim. */
function onBranch(along: number, leaf = 3): { clientX: number; clientY: number } {
  const arbor = buildArbor(ySkeleton(), 0)
  const tree = keyTree(arbor)
  const shape = equalAngleLayout(tree, landmarkDistances(tree, arbor.geodesic), DAYLIGHT_PASSES)
  const k = tree.nodes.indexOf(leaf)
  const [x, y] = toScreen(
    fitTransform(shape, 800, 480),
    shape.x0[k]! + along * (shape.x1[k]! - shape.x0[k]!),
    shape.y0[k]! + along * (shape.y1[k]! - shape.y0[k]!),
  )
  const zoom = 800 / 1200
  return { clientX: x * zoom, clientY: y * zoom }
}

const settle = () => act(async () => {})

function renderEditor(points: ManualPoint[] = []) {
  const onParamChange = vi.fn()
  render(
    <PointsEditor
      skeletons={value()}
      points={points.map(writeManualPoint)}
      viewerKey="w:n"
      onParamChange={onParamChange}
    />,
  )
  return onParamChange
}

function written(onParamChange: ReturnType<typeof vi.fn>): ManualPoint[] {
  const [paramId, next] = onParamChange.mock.calls.at(-1)!
  expect(paramId).toBe(MANUAL_PARAM)
  return readManualPoints(next)
}

const theirs: ManualPoint = { neuron: '1002', at: [1000, 0, 0] }

beforeEach(() => {
  installJsdomStubs()
  sceneProps = undefined
})
afterEach(cleanup)

describe('PointsEditor', () => {
  it('stores a click where it landed on the edge, beside other neurons’ points', async () => {
    const onParamChange = renderEditor([theirs])
    await settle()
    fireEvent.click(
      screen.getByLabelText('LC4: click to place a point').parentElement!,
      onBranch(0.5),
    )
    const next = written(onParamChange)
    expect(next[0]).toEqual(theirs)
    expect(next[1]!.neuron).toBe('1001')
    // Halfway along the edge 2 → 3: between x = 2000 and 3000, not on either node.
    expect(next[1]!.at[0]).toBeCloseTo(2500, 0)
    expect(next[1]!.at[1]).toBeCloseTo(0, 6)
  })

  it('lists this neuron’s points by path distance, and says which no longer land', () => {
    renderEditor([
      { neuron: '1001', at: [2000, 1500, 0] },
      { neuron: '1001', at: [9000, 9000, 0] },
      theirs,
    ])
    const items = [...document.querySelectorAll('.split-editor__list li')].map((li) =>
      li.textContent?.replace('✕', ''),
    )
    expect(items).toEqual(['3.5 µm', 'not on the cable'])
  })

  it('removes one point, or clears this neuron and keeps the others', () => {
    const point: ManualPoint = { neuron: '1001', at: [2000, 1500, 0] }
    const onParamChange = renderEditor([point, theirs])
    fireEvent.click(screen.getByLabelText('Remove point 1'))
    expect(written(onParamChange)).toEqual([theirs])
    fireEvent.click(screen.getByText('Clear this neuron'))
    expect(written(onParamChange)).toEqual([theirs])
  })

  it('names a point from its row, committed on Enter, and leaves the others as they were', () => {
    const point: ManualPoint = { neuron: '1001', at: [2000, 1500, 0] }
    const onParamChange = renderEditor([point, theirs])
    const field = screen.getByLabelText('Name of point 1')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'input A' } })
    expect(onParamChange).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field, { target: { value: 'input A' } })
    expect(written(onParamChange)).toEqual([{ ...point, name: 'input A' }, theirs])
  })

  it('shows the neuron and its points in 3D, this neuron only', () => {
    renderEditor([{ neuron: '1001', at: [2000, 1500, 0] }, theirs])
    const skeletons = sceneProps?.skeletons as SkeletonsValue
    const points = sceneProps?.points as PointsValue
    expect(skeletons.items.map((s) => s.id)).toEqual(['1001'])
    expect(Array.from(points.positions)).toEqual([2000, 1500, 0])
  })
})
