// @vitest-environment jsdom

/**
 * The split gallery's session (`splitSession.ts`) and key (`splitKey.ts`), with the reads faked —
 * nothing here reaches a server. Pinned: a press reads, then offers the candidates; reads are kept,
 * so a second press in the same box reads nothing; a chunkedgraph without affinities is refused at
 * once from then on; nothing reads ahead until the key has been used; a newer press drops an older
 * one's late answer; and the key goes to the card whose frame the pointer is in.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { NoAffinitiesError } from '../../data/cave/subgraph'
import type { SplitGalleryInput } from '../../packs/seam/splitGallery'
import { MANY_SPLITS, toy, toyNeuron } from '../../packs/seam/__fixtures__/splitToy'
import { SPLIT_KEY_CODE } from '../../data/neuroglancer/frameMessage'
import { clearStorage, installStorageStub } from '../../test/jsdomStubs'
import { useGraphStore } from '../../store/graphStore'
import { resetPackSwitchesForTest, switchPack } from '../packSwitches'
import { REST_MS, setHoveredSegment } from '../viewers/segmentHover'
import { useSplitKey } from './splitKey'
import { settle, SPLIT_INPUT, SPLIT_ROOT, toyServices } from './__fixtures__/splitServices'
import type { SplitCard, SplitRequest, SplitTarget } from './splitSession'
import {
  closeSplit,
  regenerateSplit,
  resetSplitSessionForTests,
  splitExact,
  splitMesh,
  splitPointer,
  splitSession,
  startSplit,
} from './splitSession'

const TARGET: SplitTarget = {
  deployment: 'https://cave.example',
  datastack: 'toy',
}
// The toy's points are all near the origin, so on FANC's grid every press is in one box.
const INPUT = SPLIT_INPUT
const NEURON = toyNeuron(INPUT, SPLIT_ROOT)
const press = (pointNm: SplitRequest['pointNm'] = [2000, 250, 0]): SplitRequest => ({
  ...TARGET,
  root: NEURON.root,
  pointNm,
})

let services: ReturnType<typeof toyServices>

beforeAll(installStorageStub)

beforeEach(() => {
  // The split key is the SEAM pack's, which is off until somebody turns it on.
  clearStorage()
  resetPackSwitchesForTest()
  switchPack('seam', true)
  services = toyServices()
  resetSplitSessionForTests(services)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetSplitSessionForTests()
})

describe('the split session', () => {
  it('reads, then offers the candidates, nearest first', async () => {
    startSplit(press())
    expect(splitSession()?.phase).toBe('reading')
    await settle()
    const session = splitSession()
    expect(session?.phase).toBe('ready')
    const candidates = session && 'candidates' in session ? session.candidates : []
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0]!.cut.map((e) => [e.source, e.sink].sort().join('-'))).toEqual([
      'A2.0-B2.0',
    ])
  })

  it('reads the mesh beside the candidates, each vertex given its nearest chunk', async () => {
    services.mesh.mockImplementation(() =>
      Promise.resolve({
        positions: new Float32Array([2000, 10, 0]),
        indices: new Uint32Array(),
      }),
    )
    startSplit(press())
    expect(splitMesh()).toEqual({ status: 'loading' })
    await settle()
    const mesh = splitMesh()
    expect(mesh?.status).toBe('ready')
    const nearest = mesh?.status === 'ready' ? mesh.mesh.nearest[0]! : -1
    expect(NEURON.chunks[nearest]).toBe('A2')
    closeSplit()
    expect(splitMesh()).toBeUndefined()
  })

  it('reads the segmentation only in cells where a tile has both sides, and places vertices there', async () => {
    // One neuron, weak inside its chunk A2: the split cuts through that chunk.
    const input = toy({
      chains: { A: { length: 6, y: 0 } },
      inside: [['A2', 12, 0.05]],
      wide: [1, 4],
      inner: [2, 3],
      click: [2000, 0, 0],
      svs: 24,
    })
    services.box.mockImplementation(() => Promise.resolve(input))
    services.neuron.mockImplementation(() => Promise.resolve(toyNeuron(input, NEURON.root)))
    startSplit(press([2000, 0, 0]))
    await settle()
    expect(splitSession()?.phase).toBe('ready')
    expect(services.labels).toHaveBeenCalledTimes(1)
    // A2's point (2 µm) is in FANC's first cell along x (2.2 µm wide).
    expect((services.labels.mock.calls[0] as unknown[])[1]).toEqual([0, 0, 0])
    expect(splitExact()).toBeDefined()
  })

  /**
   * Two branches side by side share grid cells with no chunk cut (648518347493136877's islands):
   * a vertex there nearer the other branch's chunk point would be drawn on the wrong side.
   */
  it('reads the cells two sides share though the cut runs through none of their chunks', async () => {
    startSplit(press())
    await settle()
    expect(splitSession()?.phase).toBe('ready')
    // Chains A and B, half a micrometre apart, in FANC's cells 0, 1 and 2 along x.
    const cells = services.labels.mock.calls.map((call) => (call as unknown[])[1])
    expect(cells).toEqual(
      expect.arrayContaining([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    )
    // The chunks there outside the box read for the press have their supervoxels asked, once.
    expect(services.chunkSupervoxels).toHaveBeenCalledTimes(1)
    expect(
      [...((services.chunkSupervoxels.mock.calls[0] as unknown[])[1] as string[])].sort(),
    ).toEqual(['A0', 'A5', 'B0', 'B5'])
    expect(splitExact()).toBeDefined()
  })

  it('places a vertex on the supervoxel under it, a chunk outside the box included', async () => {
    // The one vertex, at the origin, sits on supervoxel 5 — of chunk A0, outside the box.
    services.chunkSupervoxels.mockImplementation(() =>
      Promise.resolve(new Map([['A0', ['5']]])),
    )
    services.labels.mockImplementation(() =>
      Promise.resolve({
        box: { labels: new BigUint64Array([5n]), index: new Uint16Array([0]), size: [1, 1, 1] },
        lo: [0, 0, 0],
        resolution: [32, 32, 45],
      }),
    )
    startSplit(press())
    await settle()
    const exact = splitExact()
    expect(exact?.supervoxelOf.get(0)).toBe('5')
    expect(exact?.chunkOf.get('5')).toBe('A0')
  })

  it('still reads the cells where the supervoxels outside the box could not be asked', async () => {
    services.chunkSupervoxels.mockImplementation(() => Promise.reject(new Error('429')))
    startSplit(press())
    await settle()
    expect(services.labels.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(splitExact()).toBeDefined()
  })

  it('keeps the placement through a Regenerate, and reads no cell twice', async () => {
    const input = toy(MANY_SPLITS)
    services.box.mockImplementation(() => Promise.resolve(input))
    services.neuron.mockImplementation(() => Promise.resolve(toyNeuron(input, NEURON.root)))
    startSplit(press())
    await settle()
    const before = splitExact()
    expect(before).toBeDefined()
    regenerateSplit()
    await settle()
    const session = splitSession()
    expect(session && 'round' in session ? session.round : 0).toBe(2)
    expect(splitExact()?.supervoxelOf).toBe(before?.supervoxelOf)
    const cells = services.labels.mock.calls.map((call) => String((call as unknown[])[1]))
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('reads a neuron and a box once, however often the key is pressed in it', async () => {
    startSplit(press())
    await settle()
    startSplit(press([2100, 250, 0]))
    await settle()
    expect(services.neuron).toHaveBeenCalledTimes(1)
    expect(services.box).toHaveBeenCalledTimes(1)
    // But the walk starts from the new point.
    const session = splitSession()
    expect(session?.request.pointNm).toEqual([2100, 250, 0])
  })

  it('says a chunkedgraph without affinities cannot split, and then says so without asking', async () => {
    services.box.mockImplementation(() =>
      Promise.reject(
        new NoAffinitiesError(
          'This chunkedgraph answers its subgraph without affinities (pychunkedgraph 1.x, as FlyWire runs), so there is nothing to weigh a cut by.',
        ),
      ),
    )
    startSplit(press())
    await settle()
    expect(splitSession()).toMatchObject({ phase: 'failed' })
    expect((splitSession() as { message: string }).message).toMatch(/without affinities/)
    startSplit(press([9e6, 9e6, 9e6]))
    expect(splitSession()).toMatchObject({ phase: 'failed' })
    expect(services.box).toHaveBeenCalledTimes(1)
  })

  it('drops an older press’s late answer', async () => {
    let release: (value: SplitGalleryInput) => void = () => undefined
    services.box.mockImplementationOnce(
      () => new Promise<SplitGalleryInput>((resolve) => (release = resolve)),
    )
    startSplit(press())
    await settle()
    closeSplit()
    release(INPUT)
    await settle()
    expect(splitSession()).toBeUndefined()
  })

  it('reads nothing ahead until the key has been used, then the box under a resting pointer', async () => {
    vi.useFakeTimers()
    splitPointer(press([5e6, 5e6, 5e6]))
    await vi.advanceTimersByTimeAsync(REST_MS * 2)
    expect(services.box).not.toHaveBeenCalled()

    startSplit(press())
    await vi.advanceTimersByTimeAsync(0)
    expect(services.box).toHaveBeenCalledTimes(1)
    splitPointer(press([5e6, 5e6, 5e6]))
    await vi.advanceTimersByTimeAsync(REST_MS - 1)
    expect(services.box).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(services.box).toHaveBeenCalledTimes(2)
  })
})

describe('reading ahead', () => {
  it('reads one neuron ahead at a time: the latest rest once the read in flight lands', async () => {
    vi.useFakeTimers()
    startSplit(press())
    await vi.advanceTimersByTimeAsync(0)
    let release: (value: SplitGalleryInput) => void = () => undefined
    services.box.mockImplementationOnce(
      () => new Promise<SplitGalleryInput>((resolve) => (release = resolve)),
    )
    splitPointer(press([5e6, 5e6, 5e6]))
    await vi.advanceTimersByTimeAsync(REST_MS)
    expect(services.box).toHaveBeenCalledTimes(2)
    // Another neuron rests while that read is out: nothing of it is read until that read lands.
    splitPointer({ ...press([9e6, 9e6, 9e6]), root: '720575940000000002' })
    await vi.advanceTimersByTimeAsync(REST_MS)
    expect(services.neuron).toHaveBeenCalledTimes(1)
    expect(services.box).toHaveBeenCalledTimes(2)
    release(INPUT)
    await vi.advanceTimersByTimeAsync(0)
    expect(services.neuron).toHaveBeenCalledTimes(2)
    expect(services.box).toHaveBeenCalledTimes(3)
  })

  it('drops a rest still waiting once the pointer leaves', async () => {
    vi.useFakeTimers()
    startSplit(press())
    await vi.advanceTimersByTimeAsync(0)
    let release: (value: SplitGalleryInput) => void = () => undefined
    services.box.mockImplementationOnce(
      () => new Promise<SplitGalleryInput>((resolve) => (release = resolve)),
    )
    splitPointer(press([5e6, 5e6, 5e6]))
    await vi.advanceTimersByTimeAsync(REST_MS)
    splitPointer(press([9e6, 9e6, 9e6]))
    await vi.advanceTimersByTimeAsync(REST_MS)
    splitPointer(undefined)
    release(INPUT)
    await vi.advanceTimersByTimeAsync(0)
    expect(services.box).toHaveBeenCalledTimes(2)
  })
})

describe('the split key', () => {
  /** The dataset's own layer in the card's scene. */
  const LAYER = 'toy'
  function Card({
    frame,
    target,
    card,
  }: {
    frame: object
    target: SplitTarget | undefined
    card?: SplitCard
  }) {
    useSplitKey(
      () => frame,
      target,
      () => LAYER,
      card,
    )
    return null
  }
  const pressK = () =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: SPLIT_KEY_CODE, bubbles: true }),
      )
    })

  it('splits the segment under the pointer, in the card whose frame it is in', () => {
    const mine = {}
    const other = {}
    render(
      <>
        <Card frame={other} target={{ ...TARGET, datastack: 'other' }} />
        <Card frame={mine} target={TARGET} />
      </>,
    )
    setHoveredSegment(mine, NEURON.root, [1, 2, 3], LAYER)
    pressK()
    expect(splitSession()?.request).toEqual({
      ...TARGET,
      root: NEURON.root,
      pointNm: [1, 2, 3],
    })
    setHoveredSegment(mine, undefined)
  })

  /** So a split written from the press can show its pieces in the card it was pressed over. */
  it('names the card it was pressed over on the press', () => {
    const frame = {}
    const card = { docId: 'doc', nodeId: 'ng' }
    render(<Card frame={frame} target={TARGET} card={card} />)
    setHoveredSegment(frame, NEURON.root, [1, 2, 3], LAYER)
    pressK()
    expect(splitSession()?.request.card).toEqual(card)
    setHoveredSegment(frame, undefined)
  })

  it('reads ahead where the pointer rests over a card, once the key has been used', async () => {
    vi.useFakeTimers()
    const frame = {}
    render(<Card frame={frame} target={TARGET} />)
    setHoveredSegment(frame, NEURON.root, [5e6, 5e6, 5e6], LAYER)
    await vi.advanceTimersByTimeAsync(REST_MS * 2)
    expect(services.box).not.toHaveBeenCalled()
    pressK()
    await vi.advanceTimersByTimeAsync(0)
    expect(services.box).toHaveBeenCalledTimes(1)
    // Elsewhere on the same segment: a move, not a new segment, and still read ahead.
    setHoveredSegment(frame, NEURON.root, [9e6, 9e6, 9e6], LAYER)
    await vi.advanceTimersByTimeAsync(REST_MS)
    expect(services.box).toHaveBeenCalledTimes(2)
    setHoveredSegment(frame, undefined)
  })

  it('takes no segment from another segmentation layer of the scene', () => {
    const frame = {}
    render(<Card frame={frame} target={TARGET} />)
    setHoveredSegment(frame, NEURON.root, [1, 2, 3], 'other-dataset')
    pressK()
    expect(splitSession()).toBeUndefined()
    expect(useGraphStore.getState().notice).toMatch(/"other-dataset"/)
    setHoveredSegment(frame, undefined)
  })

  it('reads nothing while the SEAM pack is switched off, and says what to switch on', () => {
    act(() => switchPack('seam', false))
    const frame = {}
    render(<Card frame={frame} target={TARGET} />)
    setHoveredSegment(frame, NEURON.root, [1, 2, 3], LAYER)
    pressK()
    expect(splitSession()).toBeUndefined()
    expect(services.box).not.toHaveBeenCalled()
    expect(useGraphStore.getState().notice).toMatch(/SEAM plugin/)
    setHoveredSegment(frame, undefined)
  })

  it('does nothing over a card that cannot split, or with the pointer nowhere', () => {
    const frame = {}
    render(<Card frame={frame} target={undefined} />)
    pressK()
    expect(splitSession()).toBeUndefined()
    setHoveredSegment(frame, NEURON.root, [1, 2, 3], LAYER)
    pressK()
    expect(splitSession()).toBeUndefined()
    setHoveredSegment(frame, undefined)
  })
})
