// @vitest-environment jsdom

/**
 * Submit's confirm overlay (`docs/seam-merge-plan.md`, phase 4). The viewer is stubbed — jsdom has
 * no WebGL — and records the scene it was handed, so what is pinned is what the reader is shown
 * and what the button hands on: the ticked merges, in plan order, and nothing on Enter.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { NgScene } from '../../data/neuroglancer/scene'
import { parseSceneUrl, selectionChanges } from '../../data/neuroglancer/scene'
import type { MergeProgress } from '../../packs/seam/mergeRecord'
import type { PlannedMerge, ReadyPlan } from '../../packs/seam/mergePlan'
import type { Candidate } from '../../packs/seam/reviewQueue'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { Modal } from '../Modal'
import { MergeConfirm } from './MergeConfirm'

/** The URLs the stubbed viewer was handed, newest last, and its latest props. */
const shown: string[] = []
interface ViewerProps {
  url: string
  onSelectionEdits?: (next: string[]) => void
  extraLayers?: number
  focus?: readonly number[]
  focusWidth?: number
}
let viewer: Partial<ViewerProps> = {}
vi.mock('../viewers/NeuroglancerViewer', () => ({
  NeuroglancerViewer: (props: ViewerProps) => {
    shown.push(props.url)
    viewer = props
    return <div data-testid="viewer" />
  },
}))

beforeAll(() => installJsdomStubs())
afterEach(() => {
  cleanup()
  shown.length = 0
})

const NEURON = '720575940621522189'
const PUBLISHED: NgScene = {
  dimensions: { x: [16e-9, 'm'], y: [16e-9, 'm'], z: [45e-9, 'm'] },
  layers: [
    { type: 'segmentation', name: 'seg', source: 'graphene://https://h/segmentation/table/t' },
  ],
}

function candidate(id: string): Candidate {
  return {
    candidateId: id,
    rank: 1,
    geoRank: undefined,
    volumeUm3: undefined,
    l2Chunks: 12,
    minDistUm: 0.02,
    contactNm: [100, 200, 450],
    pCand: undefined,
    conf: undefined,
    shown: true,
  }
}

function merge(id: string, joinsNeuron = false): PlannedMerge {
  const row = { neuronId: NEURON, endUid: 7, candidate: candidate(id) }
  return {
    candidateRoot: id,
    rows: [row],
    used: row,
    neuron: { supervoxel: `${id}1`, positionNm: [96, 192, 427.5] },
    candidate: { supervoxel: `${id}2`, positionNm: [112, 208, 472.5] },
    joinsNeuron,
  }
}

const PLAN: ReadyPlan = {
  ok: true,
  datastack: 'wclee_aedes_brain',
  graphene: { server: 'https://h', table: 't', base: 'https://h/segmentation/table/t' },
  reviewedRoot: NEURON,
  currentRoot: NEURON,
  merges: [merge('648518346000000001'), merge('648518346000000002', true)],
  rejected: [
    {
      candidateRoot: '648518346000000003',
      rows: [],
      reason: 'outdated',
      message: 'This piece has been edited since it was suggested.',
    },
  ],
}

function open(over: Partial<Parameters<typeof MergeConfirm>[0]> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <MergeConfirm
      plan={PLAN}
      plannedAt={0}
      published={PUBLISHED}
      datasetId="wclee_aedes_brain"
      viewerSite={undefined}
      onConfirm={onConfirm}
      onClose={onClose}
      {...over}
    />,
  )
  return { onConfirm, onClose }
}

const go = () => screen.getByRole('button', { name: /^Merge \d+ piece/ })

describe('the confirm overlay', () => {
  it('names what it sends: how many pieces, into which root, on which datastack', () => {
    open()
    expect(go().textContent).toBe(`Merge 2 pieces into ${NEURON} on wclee_aedes_brain`)
  })

  it('hands on the ticked merges in plan order, and recounts as boxes are unticked', () => {
    const { onConfirm } = open()
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(go().textContent).toMatch(/^Merge 1 piece into/)
    fireEvent.click(go())
    expect(onConfirm).toHaveBeenCalledWith([PLAN.merges[1]])
  })

  /**
   * A neuron grown piece by piece: the second piece was accepted on the first, and is merged
   * onto it. What is ticked can always be sent.
   */
  it('unticks what was accepted beyond a piece with it, and ticks the piece before with one', () => {
    const [first, second] = PLAN.merges
    const tree: ReadyPlan = {
      ...PLAN,
      merges: [
        first!,
        { ...second!, parent: first!.candidateRoot, needs: first!.candidateRoot },
      ],
    }
    const { onConfirm } = open({ plan: tree })
    const boxes = () =>
      screen.getAllByRole<HTMLInputElement>('checkbox').map((box) => box.checked)
    // The row says what it is merged onto.
    expect(document.body.textContent).toContain(`onto ${first!.candidateRoot}`)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(boxes()).toEqual([false, false])
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(boxes()).toEqual([true, true])
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(boxes()).toEqual([true, false])
    fireEvent.click(go())
    expect(onConfirm).toHaveBeenCalledWith([tree.merges[0]])
  })

  it('cannot confirm nothing', () => {
    open()
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    expect((go() as HTMLButtonElement).disabled).toBe(true)
  })

  it('is not pressed by Enter', () => {
    const { onConfirm } = open()
    // `fireEvent` answers false when the default was prevented.
    expect(fireEvent.keyDown(go(), { key: 'Enter' })).toBe(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  /** A double click must not start two batches against a shared server. */
  it('hands its merges on once, however often it is pressed', () => {
    const { onConfirm } = open()
    const button = go()
    // Both clicks before React redraws: the second must not read the state the first set too late.
    act(() => {
      button.click()
      button.click()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('marks a merge that joins two reviewed neurons, and lists what will not be merged', () => {
    open()
    expect(screen.getAllByText('joins two reviewed neurons')).toHaveLength(1)
    expect(screen.getByText('1 not merged')).toBeTruthy()
    expect(screen.getByText('outdated')).toBeTruthy()
  })

  /*
   * A tick changes the segments alone, which the viewer sets in place; the lines are the whole
   * plan's, since a changed line layer would rebuild every layer and re-centre the camera.
   */
  it('shows the neuron and the ticked pieces, with a line per planned merge between its points', () => {
    open()
    const before = parseSceneUrl(shown.at(-1)!)!
    expect(segmentsOf(before, 'neuron')).toEqual([NEURON])
    expect(segmentsOf(before)).toEqual(['648518346000000001', '648518346000000002'])
    expect(linesOf(before)[0]).toMatchObject({
      type: 'line',
      pointA: [96, 192, 427.5],
      pointB: [112, 208, 472.5],
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    const after = parseSceneUrl(shown.at(-1)!)!
    expect(segmentsOf(after)).toEqual(['648518346000000002'])
    expect(segmentsOf(after, 'neuron')).toEqual([NEURON])
    expect(linesOf(after)).toEqual(linesOf(before))
    // What the viewer itself asks to set a change in place rather than re-navigating.
    expect(selectionChanges(before, after)).toBeDefined()
  })

  /*
   * Each line is linked to its piece and drawn only while that piece is shown — which is how an
   * unticked merge's line goes with its piece without the line layer changing at all.
   */
  it('links each line to its piece, so neuroglancer draws it only while the piece is shown', () => {
    open()
    const scene = parseSceneUrl(shown.at(-1)!)!
    const merges = layersOf(scene).find((layer) => layer['name'] === 'merges')!
    expect(merges['linkedSegmentationLayer']).toEqual({ segments: 'seg' })
    expect(merges['filterBySegmentation']).toEqual(['segments'])
    expect(linesOf(scene).map((line) => line['segments'])).toEqual([
      ['648518346000000001'],
      ['648518346000000002'],
    ])
    // The neuron's layer and the line layer are the overlay's own: a re-navigation replaces them.
    expect(viewer.extraLayers).toBe(2)
  })

  it('unticks a piece hidden in the viewer, so the list and the view agree', () => {
    open()
    act(() => viewer.onSelectionEdits!(['-648518346000000001']))
    expect(go().textContent).toMatch(/^Merge 1 piece into/)
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false)
  })

  /**
   * A tree in the viewer: hiding the first piece takes the one made onto it along, and showing
   * that one again brings the first back — the view and the list agree both ways.
   */
  it('follows the tree when pieces are hidden and shown in the viewer', () => {
    const [first, second] = PLAN.merges
    const tree: ReadyPlan = {
      ...PLAN,
      merges: [
        first!,
        { ...second!, parent: first!.candidateRoot, needs: first!.candidateRoot },
      ],
    }
    open({ plan: tree })
    const boxes = () =>
      screen.getAllByRole<HTMLInputElement>('checkbox').map((box) => box.checked)
    act(() => viewer.onSelectionEdits!([`-${first!.candidateRoot}`]))
    expect(boxes()).toEqual([false, false])
    act(() => viewer.onSelectionEdits!([`+${second!.candidateRoot}`]))
    expect(boxes()).toEqual([true, true])
  })

  /** Re-check can make a refused piece plannable; the reader has not looked at it yet. */
  it('keeps the ticks across a Re-check, and leaves a piece new to the plan unticked', () => {
    const props = {
      plannedAt: 0,
      published: PUBLISHED,
      datasetId: 'wclee_aedes_brain',
      viewerSite: undefined,
      onConfirm: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<MergeConfirm plan={PLAN} {...props} />)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    const rechecked: ReadyPlan = {
      ...PLAN,
      merges: [...PLAN.merges, merge('648518346000000003')],
      rejected: [],
    }
    rerender(<MergeConfirm plan={rechecked} {...props} />)
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([false, true, false])
    expect(go().textContent).toMatch(/^Merge 1 piece into/)
  })

  it('closes on Cancel and on Escape before anything is sent', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  /** Phase 5's batch, shown in the same overlay. */
  it('while the batch runs: progress per row, boxes locked, Stop and no way out', () => {
    const onStop = vi.fn()
    const progress = new Map<string, MergeProgress>([
      ['648518346000000001', { state: 'merged' }],
      ['648518346000000002', { state: 'sending' }],
    ])
    const { onClose } = open({
      running: true,
      progress,
      onStop,
      neuronRoot: '720575940000000009',
    })
    expect(screen.getByText('✓ merged')).toBeTruthy()
    expect(screen.getByText('sending')).toBeTruthy()
    expect(
      screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled),
    ).toBe(true)
    expect(screen.queryByRole('button', { name: /^Merge \d+ piece/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this merge' }))
    expect(onStop).toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    // The viewer follows the neuron to the root the batch has made, and a piece already merged
    // into it is no longer drawn as its own (retired) root.
    const scene = parseSceneUrl(shown.at(-1)!)!
    expect(segmentsOf(scene, 'neuron')).toEqual(['720575940000000009'])
    expect(segmentsOf(scene)).toEqual(['648518346000000002'])
  })

  /*
   * The neuron in a see-through layer of its own (user, 2026-11-16), so the pieces about to join
   * it stand out; a copy of the dataset's layer, so it is the same segmentation. A merge changes
   * only its segment list, which the viewer sets in place.
   */
  it('draws the neuron see-through in its own layer, set in place as it moves on', () => {
    const props = {
      plan: PLAN,
      plannedAt: 0,
      published: PUBLISHED,
      datasetId: 'wclee_aedes_brain',
      viewerSite: undefined,
      onConfirm: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<MergeConfirm {...props} />)
    const before = parseSceneUrl(shown.at(-1)!)!
    const neuron = layersOf(before).find((layer) => layer['name'] === 'neuron')!
    const seg = layersOf(before).find((layer) => layer['name'] === 'seg')!
    expect(neuron).toMatchObject({
      type: 'segmentation',
      source: seg['source'],
      objectAlpha: 0.2,
    })
    expect(seg['objectAlpha']).toBeUndefined()
    rerender(
      <MergeConfirm
        {...props}
        neuronRoot="720575940000000009"
        progress={new Map([['648518346000000001', { state: 'merged' }]])}
        running
      />,
    )
    const after = parseSceneUrl(shown.at(-1)!)!
    expect(segmentsOf(after, 'neuron')).toEqual(['720575940000000009'])
    expect(selectionChanges(before, after)).toBeDefined()
  })

  /** The whole neuron, from its tips and the merges' points, rather than the published zoom. */
  it('frames the whole neuron', () => {
    open({
      extentNm: [
        [0, 0, 0],
        [40_000, 10_000, 4_500],
      ],
    })
    // The box's middle in voxels (16 × 16 × 45 nm), its widest span over the coarsest axis.
    expect(viewer.focus).toEqual([1250, 312.5, 50])
    expect(viewer.focusWidth).toBeCloseTo((40_000 * 1.15) / 45)
  })

  /** Escape during a batch must not fall through and close what the overlay was opened from. */
  it('keeps Escape from a surface underneath while the batch runs', () => {
    const outer = vi.fn()
    // The surface underneath is open first and the overlay arrives later, as in the app.
    const { rerender } = render(
      <Modal className="overlay__panel" onClose={outer}>
        {null}
      </Modal>,
    )
    rerender(
      <Modal className="overlay__panel" onClose={outer}>
        <MergeConfirm
          plan={PLAN}
          plannedAt={0}
          published={PUBLISHED}
          datasetId="wclee_aedes_brain"
          viewerSite={undefined}
          running
          progress={new Map()}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      </Modal>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(outer).not.toHaveBeenCalled()
  })

  /** Between the press and the batch starting, the merges are already on their way. */
  it('cannot be closed between Merge and the batch starting', () => {
    const { onClose } = open()
    fireEvent.click(go())
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('unlocks and says why when the batch cannot start, so it can be tried again', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('no edit permission')))
    open({ onConfirm: failing })
    await act(async () => {
      fireEvent.click(go())
    })
    expect(screen.getByText('Not started: no edit permission')).toBeTruthy()
    fireEvent.click(go())
    expect(failing).toHaveBeenCalledTimes(2)
    const throwing = vi.fn(() => {
      throw new Error('no token')
    })
    cleanup()
    open({ onConfirm: throwing })
    fireEvent.click(go())
    expect(screen.getByText('Not started: no token')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  /** A frame report moves no tick on most reports — a pan, a stray edit — and must cost nothing. */
  it('rebuilds nothing on a viewer report that moves no tick', () => {
    open()
    const before = shown.length
    act(() => viewer.onSelectionEdits!(['+999']))
    expect(shown.length).toBe(before)
  })
})

function layersOf(scene: NgScene): Record<string, unknown>[] {
  return (scene['layers'] as Record<string, unknown>[]) ?? []
}

/** The segments in one layer: the dataset's (`seg`, the pieces) unless another is named. */
function segmentsOf(scene: NgScene, layer = 'seg'): string[] {
  const found = layersOf(scene).find((l) => l['name'] === layer)
  return ((found?.['segments'] as string[]) ?? []).map(String)
}

function linesOf(scene: NgScene): Record<string, unknown>[] {
  const merges = layersOf(scene).find((layer) => layer['name'] === 'merges')
  return (merges?.['annotations'] as Record<string, unknown>[]) ?? []
}
