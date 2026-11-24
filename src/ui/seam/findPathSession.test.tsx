// @vitest-environment jsdom

/**
 * Coda's find path (`findPathSession.ts`) and its key (`F`, in `splitKey.ts`), with the reads and
 * the frame faked — nothing here reaches a server. Pinned: the first press marks the start and
 * draws it; a second over the same neuron in the same card reads the route and draws it, step by
 * step; a press over another neuron or card starts again there and clears the old card; a newer
 * press drops an older one's late answer; a chunkedgraph without affinities is said as one; and
 * an F the card takes is not also Coda's fullscreen.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { NoAffinitiesError } from '../../data/cave/subgraph'
import type { FrameLayerMessage } from '../../data/neuroglancer/frameMessage'
import {
  FIND_PATH_KEY_CODE,
  frameKeyInit,
  isFrameLayerMessage,
} from '../../data/neuroglancer/frameMessage'
import { FANC_LAYOUT, toyNeuron } from '../../packs/seam/__fixtures__/splitToy'
import type { PathStep } from '../../packs/seam/findPath'
import { FIND_PATH_LAYER } from '../../packs/seam/findPath'
import type { Skeleton } from '../../packs/seam/skeletonThickness'
import { clearStorage, installStorageStub } from '../../test/jsdomStubs'
import { useGraphStore } from '../../store/graphStore'
import { useAppShortcuts } from '../appShortcuts'
import { StatusNotice } from '../StatusNotice'
import { dismissNotice } from '../noticeDismiss'
import { resetPackSwitchesForTest, switchPack } from '../packSwitches'
import { setHoveredSegment } from '../viewers/segmentHover'
import { SPLIT_INPUT, SPLIT_ROOT } from './__fixtures__/splitServices'
import type { FindPathServices } from './findPathSession'
import { pressFindPath, resetFindPathForTests, summaryOf } from './findPathSession'
import { useSplitKey } from './splitKey'
import type { SplitMesh, SplitRequest } from './splitSession'

const toggleFullscreen = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('../fullscreen', () => ({ appElement: () => document.body, toggleFullscreen }))

const TARGET = { deployment: 'https://cave.example', datastack: 'toy' }
const NEURON = toyNeuron(SPLIT_INPUT, SPLIT_ROOT)
const at = (pointNm: SplitRequest['pointNm'], root = SPLIT_ROOT): SplitRequest => ({
  ...TARGET,
  root,
  pointNm,
})
// Chain A of the toy runs along x at y = 0, chunk k at k µm; FANC's grid cells are 2.2 µm wide.
const FROM = at([0, 0, 0])
const TO = at([4100, 0, 0])

const contact = (from: string, to: string, affinity: number): PathStep => ({
  from,
  to,
  kind: 'contact',
  affinity,
  area: 10,
})

function fakeServices() {
  const posts: Array<{ frame: object; message: FrameLayerMessage }> = []
  const services = {
    chunkedgraph: vi.fn(() =>
      Promise.resolve({
        graphene: { server: 's', table: 't', base: 's/t' },
        layout: FANC_LAYOUT,
        base: 'gs://toy',
      }),
    ),
    neuron: vi.fn(() => Promise.resolve(NEURON)),
    steps: vi.fn((_graph: unknown, _root: string, _neuron: unknown, route: readonly string[]) =>
      Promise.resolve(route.slice(1).map((to, i) => contact(route[i]!, to, 0.9 - i * 0.1))),
    ),
    // A mesh that never arrives: the straight lines stay (the surface has its own tests).
    mesh: vi.fn(() => new Promise<SplitMesh>(() => undefined)),
    // A skeleton that never arrives, unless a test gives one.
    skeleton: vi.fn(() => new Promise<Skeleton>(() => undefined)),
    post: (frame: object, message: FrameLayerMessage) => posts.push({ frame, message }),
  } satisfies FindPathServices
  return { services, posts }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const notice = () => useGraphStore.getState().notice
const lines = (message: FrameLayerMessage | undefined) =>
  ((message?.layer?.['annotations'] as Array<Record<string, unknown>>) ?? []).filter(
    (a) => a['type'] === 'line',
  )

let fake: ReturnType<typeof fakeServices>

beforeAll(installStorageStub)

beforeEach(() => {
  clearStorage()
  resetPackSwitchesForTest()
  switchPack('seam', true)
  fake = fakeServices()
  resetFindPathForTests(fake.services)
  useGraphStore.getState().setNotice(undefined)
  toggleFullscreen.mockClear()
})

afterEach(() => {
  cleanup()
  resetFindPathForTests()
})

describe('find path', () => {
  it('marks the start, then draws the route step by step on the second press', async () => {
    const frame = {}
    pressFindPath(FROM, frame)
    expect(fake.posts).toHaveLength(1)
    const start = fake.posts[0]!.message
    expect(isFrameLayerMessage(start)).toBe(true)
    expect(start.name).toBe(FIND_PATH_LAYER)
    expect(lines(start)).toHaveLength(0)
    expect(notice()).toMatch(/start set on .*Press F at the other end/)

    pressFindPath(TO, frame)
    // Both points at once, before anything is read.
    const points = (
      fake.posts.at(-1)!.message.layer?.['annotations'] as Array<{ id: string }>
    ).map((a) => a.id)
    expect(points).toEqual(['start', 'end'])
    await settle()
    expect(fake.services.steps).toHaveBeenCalledTimes(1)
    const route = fake.services.steps.mock.calls[0]![3]
    expect(route[0]).toBe('A0')
    expect(route.at(-1)).toBe('A4')
    const drawn = fake.posts.at(-1)!
    expect(drawn.frame).toBe(frame)
    expect(lines(drawn.message)).toHaveLength(route.length - 1)
    expect(notice()).toMatch(/4 steps\. Weakest: step 4, mean affinity 0\.60/)
  })

  it('starts again over another neuron, and in another card clears the old one', () => {
    const one = {}
    const two = {}
    pressFindPath(FROM, one)
    pressFindPath(at([500, 0, 0], '720575940000000002'), one)
    expect(notice()).toMatch(/started again on 720575940000000002/)
    expect(fake.services.steps).not.toHaveBeenCalled()

    pressFindPath(FROM, two)
    // The first card's start is taken away, and the second's drawn.
    expect(fake.posts.at(-2)).toEqual({
      frame: one,
      message: expect.objectContaining({ layer: null }),
    })
    expect(fake.posts.at(-1)!.frame).toBe(two)
  })

  it('clears the route when its notice is dismissed — not when another notice replaces it', async () => {
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    const posted = fake.posts.length
    // Another notice in its place, then dismissed; or the notice cleared by a load: the route stays.
    useGraphStore.getState().setNotice('Something else happened.')
    dismissNotice()
    expect(fake.posts).toHaveLength(posted)
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    const again = fake.posts.length
    useGraphStore.getState().setNotice(undefined)
    expect(fake.posts).toHaveLength(again)

    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    // The reader's ×: the layer goes, and the next press starts afresh.
    dismissNotice()
    expect(fake.posts.at(-1)).toEqual({
      frame,
      message: expect.objectContaining({ layer: null }),
    })
    pressFindPath(TO, frame)
    expect(notice()).toMatch(/start set/)
  })

  it('drops what is still being read when the notice is dismissed meanwhile', async () => {
    let release: (steps: PathStep[]) => void = () => undefined
    fake.services.steps.mockImplementationOnce(
      () => new Promise<PathStep[]>((resolve) => (release = resolve)),
    )
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    dismissNotice()
    const posted = fake.posts.length
    release([contact('A0', 'A1', 0.5)])
    await settle()
    expect(fake.posts).toHaveLength(posted)
  })

  it('drops an older press’s late answer', async () => {
    let release: (steps: PathStep[]) => void = () => undefined
    fake.services.steps.mockImplementationOnce(
      () => new Promise<PathStep[]>((resolve) => (release = resolve)),
    )
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    // A new start meanwhile: the route read for the old one must not land over it.
    pressFindPath(FROM, frame)
    const posted = fake.posts.length
    release([contact('A0', 'A1', 0.5)])
    await settle()
    expect(fake.posts).toHaveLength(posted)
    expect(notice()).toMatch(/start set/)
  })

  it('draws the route unweighed on a chunkedgraph without affinities, and says why', async () => {
    fake.services.steps.mockImplementationOnce(() =>
      Promise.reject(
        new NoAffinitiesError('This chunkedgraph answers its subgraph without affinities.'),
      ),
    )
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    const drawn = lines(fake.posts.at(-1)!.message)
    expect(drawn).toHaveLength(4)
    expect(drawn.every((l) => String(l['description']).endsWith('not read'))).toBe(true)
    expect(notice()).toMatch(
      /4 steps, drawn unweighed: toy's chunkedgraph publishes no affinities/,
    )
  })

  it('cancels what an older press is still reading', async () => {
    fake.services.steps.mockImplementationOnce(() => new Promise<PathStep[]>(() => undefined))
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    const call = fake.services.steps.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
      { signal?: AbortSignal },
    ]
    const signal = call[4].signal
    expect(signal?.aborted).toBe(false)
    pressFindPath(FROM, frame)
    expect(signal?.aborted).toBe(true)
  })

  it('says where it is drawn through grid-cell centres, on a datastack with no L2 cache', async () => {
    fake.services.neuron.mockImplementation(() =>
      Promise.resolve({ ...NEURON, placed: 'cells' }),
    )
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await settle()
    expect(notice()).toMatch(
      /4 steps\..*Drawn through grid-cell centres: toy has no level-2 cache/,
    )
  })

  /** A strip along chain A (y 0–50 nm), each vertex's nearest chunk by x: A0 … A5. */
  function stripMesh(): SplitMesh {
    const xs = Array.from({ length: 51 }, (_, i) => i * 100)
    const positions = new Float32Array(xs.flatMap((x) => [x, 0, 0, x, 50, 0]))
    const indices = new Uint32Array(
      xs
        .slice(1)
        .flatMap((_, i) => [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2]),
    )
    const chunkIndex = (x: number) =>
      NEURON.chunks.indexOf(`A${Math.min(5, Math.round(x / 1000))}`)
    const nearest = Int32Array.from(xs.flatMap((x) => [chunkIndex(x), chunkIndex(x)]))
    return { positions, indices, nearest, chunks: NEURON.chunks }
  }

  it('redraws the route along the mesh once it is in', async () => {
    fake.services.mesh.mockImplementation(() => Promise.resolve(stripMesh()))
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    // The surface is searched after a pause for the browser: a timer, not a microtask.
    await vi.waitFor(() => expect(lines(fake.posts.at(-1)!.message).length).toBeGreaterThan(4))
    const drawn = lines(fake.posts.at(-1)!.message)
    expect(drawn.every((l) => String(l['id']).startsWith('piece-'))).toBe(true)
    // Along x from the start to the end, as the strip runs.
    expect(drawn[0]!['pointA']).toEqual([0, 0, 0])
    expect(drawn.at(-1)!['pointB']).toEqual([4100, 0, 0])
  })

  it('builds no skeleton while the colour is affinity', async () => {
    fake.services.mesh.mockImplementation(() => Promise.resolve(stripMesh()))
    const frame = {}
    pressFindPath(FROM, frame)
    pressFindPath(TO, frame)
    await vi.waitFor(() => expect(lines(fake.posts.at(-1)!.message).length).toBeGreaterThan(4))
    expect(fake.services.skeleton).not.toHaveBeenCalled()
  })

  it('reads thickness down the neuron’s skeleton once asked: thin where it is thin', async () => {
    // No mesh: the skeleton's route does not wait on it.
    // A skeleton along chain A every 100 nm: 200 nm thick, a neck of 40 nm at x 2–3 µm.
    const xs = Array.from({ length: 51 }, (_, i) => i * 100)
    let release: (skeleton: Skeleton) => void = () => undefined
    fake.services.skeleton.mockImplementation(
      () => new Promise<Skeleton>((resolve) => (release = resolve)),
    )
    render(<StatusNotice />)
    const frame = {}
    act(() => {
      pressFindPath(FROM, frame)
      pressFindPath(TO, frame)
    })
    await act(settle)
    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: /Colour by/ }), {
        target: { value: 'thickness' },
      })
    })
    expect(fake.services.skeleton).toHaveBeenCalledTimes(1)
    expect(notice()).toMatch(/Measuring thickness along the neuron’s skeleton/)
    // The reader's choice stays chosen while affinity is drawn in the meantime.
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('thickness')
    await act(async () => {
      release({
        points: Float32Array.from(xs.flatMap((x) => [x, 0, 0])),
        radii: Float32Array.from(xs.map((x) => (x >= 2000 && x <= 3000 ? 40 : 200))),
        parents: Int32Array.from(xs.map((_, i) => i - 1)),
      })
      await settle()
    })
    // The search pauses for the browser before each bridge width: a timer, not a microtask.
    await act(() =>
      vi.waitFor(() => expect(notice()).toMatch(/Measured along the neuron’s skeleton/)),
    )
    const drawn = lines(fake.posts.at(-1)!.message)
    expect(drawn.every((l) => String(l['id']).startsWith('piece-'))).toBe(true)
    const radiusAt = (line: Record<string, unknown>) => {
      const ids = (
        fake.posts.at(-1)!.message.layer!['annotationProperties'] as Array<{ id: string }>
      ).map((p) => p.id)
      return (line['props'] as number[])[ids.indexOf('radius')]
    }
    const thin = drawn.filter((l) => radiusAt(l) === 40)
    const thick = drawn.filter((l) => radiusAt(l) === 200)
    expect(thin.length).toBeGreaterThan(0)
    expect(thick.length).toBeGreaterThan(thin.length)
    expect(notice()).toMatch(/Thinnest: radius 40 nm.*Measured along the neuron’s skeleton/)
    // Asked once: switching back and forth reads nothing again.
    act(() => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'affinity' } })
    })
    act(() => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'thickness' } })
    })
    expect(fake.services.skeleton).toHaveBeenCalledTimes(1)
  })

  it('says when the skeleton’s thickness cannot be had', async () => {
    fake.services.skeleton.mockImplementation(() =>
      Promise.reject(new Error('Pyodide is down')),
    )
    render(<StatusNotice />)
    const frame = {}
    act(() => {
      pressFindPath(FROM, frame)
      pressFindPath(TO, frame)
    })
    await act(settle)
    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: /Colour by/ }), {
        target: { value: 'thickness' },
      })
    })
    await act(settle)
    expect(notice()).toMatch(
      /Thickness could not be measured along the skeleton: Pyodide is down/,
    )
    // Asked again when thickness is chosen again: a failure may have passed.
    act(() => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'affinity' } })
    })
    act(() => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'thickness' } })
    })
    expect(fake.services.skeleton).toHaveBeenCalledTimes(2)
  })

  it('draws affinity until the skeleton’s thickness is in: no chunk radius stands in', async () => {
    render(<StatusNotice />)
    const frame = {}
    act(() => {
      pressFindPath(FROM, frame)
      pressFindPath(TO, frame)
    })
    await act(settle)
    const select = screen.getByRole('combobox', { name: /Colour by/ }) as HTMLSelectElement
    expect(select.value).toBe('affinity')
    expect(String(fake.posts.at(-1)!.message.layer?.['shader'])).toMatch(/prop_affinity/)
    act(() => {
      fireEvent.change(select, { target: { value: 'thickness' } })
    })
    // The skeleton never arrives here: affinity stays drawn, and the notice says why.
    expect(String(fake.posts.at(-1)!.message.layer?.['shader'])).toMatch(/prop_affinity/)
    expect(notice()).toMatch(/Weakest: .*Measuring thickness along the neuron’s skeleton/)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('thickness')
  })

  it('offers thickness on any route, with no level-2 cache: the skeleton gives it', async () => {
    render(<StatusNotice />)
    const frame = {}
    act(() => {
      pressFindPath(FROM, frame)
      pressFindPath(TO, frame)
    })
    await act(settle)
    const thickness = screen.getByRole('option', { name: 'thickness' }) as HTMLOptionElement
    expect(thickness.disabled).toBe(false)
  })

  it('counts the steps a merge alone joins and the steps not read', () => {
    const text = summaryOf({
      steps: [
        contact('a', 'b', 0.7),
        { from: 'b', to: 'c', kind: 'userMerge', affinity: Number.NaN, area: 0 },
        { from: 'c', to: 'd', kind: 'unread', affinity: Number.NaN, area: 0 },
      ],
      positions: new Map(),
    })
    expect(text).toMatch(/3 steps\. Weakest: step 1, mean affinity 0\.70/)
    expect(text).toMatch(/1 step joined by a proofreader’s merge only\. 1 step not read\./)
  })
})

describe('the find-path key', () => {
  const LAYER = 'toy'
  function Card({ frame }: { frame: object }) {
    useSplitKey(
      () => frame,
      TARGET,
      () => LAYER,
    )
    return null
  }
  function App() {
    useAppShortcuts()
    return null
  }
  // At the page, as a key pressed in Coda's document is: the window's capture phase comes first.
  const pressF = () =>
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent(
          'keydown',
          // As a card hands back a key its frame claimed: the same event as one pressed here.
          frameKeyInit({
            type: 'coda:ng-key',
            code: FIND_PATH_KEY_CODE,
            key: 'f',
            altKey: false,
          }),
        ),
      )
    })

  it('over a card, finds a path from the point under the pointer — and is not fullscreen', () => {
    const frame = {}
    // The app's shortcuts first, as in Coda: its listener is bound before any card's.
    render(
      <>
        <App />
        <Card frame={frame} />
      </>,
    )
    setHoveredSegment(frame, SPLIT_ROOT, [500, 0, 0], LAYER)
    pressF()
    expect(fake.posts).toHaveLength(1)
    expect(fake.posts[0]!.frame).toBe(frame)
    expect(toggleFullscreen).not.toHaveBeenCalled()
    setHoveredSegment(frame, undefined)
  })

  it('off every card, is still fullscreen', () => {
    render(
      <>
        <App />
        <Card frame={{}} />
      </>,
    )
    pressF()
    expect(fake.posts).toHaveLength(0)
    expect(toggleFullscreen).toHaveBeenCalledTimes(1)
  })

  it('with the SEAM pack off, presses neuroglancer’s own find path into the card — not fullscreen', () => {
    switchPack('seam', false)
    const postMessage = vi.fn()
    const frame = { contentWindow: { postMessage } }
    render(
      <>
        <App />
        <Card frame={frame} />
      </>,
    )
    setHoveredSegment(frame, SPLIT_ROOT, [500, 0, 0], LAYER)
    pressF()
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'coda:ng-press', code: FIND_PATH_KEY_CODE, key: 'f' },
      window.location.origin,
    )
    expect(fake.posts).toHaveLength(0)
    expect(notice()).toBeUndefined()
    expect(toggleFullscreen).not.toHaveBeenCalled()
    setHoveredSegment(frame, undefined)
  })
})
