// @vitest-environment jsdom

/**
 * The Explore widget.
 *
 * What is worth pinning here is the *split* that makes it feel like a browser: typing filters
 * the list from the widget's own copy of the index, immediately, while the committed query
 * reaches the node as a param only after a debounce — and paging never touches the node's
 * staleness at all. Get that wrong in either direction and the thing is either laggy or it
 * re-runs the whole graph on every keystroke.
 *
 * The mock source stands in for neuPrint, which is the point of the mock: the same code path
 * runs, with no token and no network.
 */

import { useState } from 'react'

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeInferContext } from '../../core/node'
import type { ParamValue, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import type { PopulationFilter } from '../../core/types'
import { T } from '../../core/types'
import { MockSource } from '../../data/mock/MockSource'
import type { Value } from '../../core/values'
import { makeTable } from '../../core/values'
import { column, tableSchema } from '../../core/types'
import { SELECT_ALL_WARN } from '../../nodes/query/explore'
import { cacheGet, cacheKeys, cacheSet, resetCache } from '../../data/cache'
import { resetMediaForTest } from '../mediaQuery'
import { getConnectome } from '../../data/mock/generate'
import { resetIndexLoads } from '../../data/neuronIndex'
import type { DataSource } from '../../data/source'
import { registerSource } from '../../data/source'
import '../../nodes'
import { clearStorage, installJsdomStubs, pointerEvent } from '../../test/jsdomStubs'
import { App } from '../../App'
import { useGraphStore } from '../../store/graphStore'
import { resetNeuronIndexState } from '../useNeuronIndex'
import { ExploreBody } from './ExploreBody'
import { NeuronThumbnail } from './NeuronThumbnail'
import * as rotationModule from './rotation'
import { NeuronRow } from './NeuronRow'
import { rowFields } from './rowFields'
import { encodeChip, encodeColumn } from './rowColumns'
import { resetThumbnailCache } from './NeuronThumbnail'

const DATASET = 'optic-lobe-mini'

/**
 * A source whose index is one neuron past the select-all warning.
 *
 * The mock connectomes are a few hundred neurons — the point of them — so the only way to see
 * what the widget does with a result too big to select is to hand it one.
 *
 * Built by delegation rather than by subclassing: `MockSource.id` is the literal `'mock'`, and
 * a source registered under that id would replace the real mock for every other test in the
 * file. Everything not named here still runs the mock's own implementation.
 */
function oversizedSource(): DataSource {
  const rows = SELECT_ALL_WARN + 1
  const index = makeTable(
    tableSchema(column('neuronId', 'i64'), column('type', 'str')),
    {
      neuronId: Array.from({ length: rows }, (_, i) => 1000 + i),
      type: Array.from({ length: rows }, (_, i) => (i % 2 ? 'KCg' : 'PN')),
    },
    'neurons',
  )
  const base: DataSource = new MockSource({ latencyMs: 0 })
  return Object.assign(Object.create(base) as DataSource, {
    id: 'mock-huge',
    neuronIndex: async () => index,
  })
}

beforeAll(() => {
  installJsdomStubs({ width: 520, height: 400 })
  registerSource(new MockSource({ latencyMs: 0 }))
  registerSource(oversizedSource())
})

beforeEach(() => {
  clearStorage()
  resetCache()
  resetIndexLoads()
  // The index state is module-level now, shared by every widget that asks for one — so it
  // outlives a test unless it is dropped here, and a later case would silently assert against
  // an earlier one's table.
  resetNeuronIndexState()
  resetThumbnailCache()
  // The editor test at the bottom mounts the real App, where the start page would otherwise
  // open over it and answer `findByRole('dialog')` first.
  useGraphStore.getState().closeStartPage()
})

afterEach(cleanup)

/**
 * Render the widget against a live mock dataset, holding params in local state the way the
 * store would, so a param write is visible on the next render.
 */
function setup(
  initial: ParamValues = {},
  sourceId = 'mock',
  inputValues?: Record<string, Value | undefined>,
  /** The chain's schema on the dataset *type* — present the moment the wire is drawn. */
  chainSchema?: TableSchema,
  /** The dataset node's population checkboxes, which this card reads off the type. See below. */
  population?: PopulationFilter[],
) {
  const def = requireNodeDef('neuron.explore')
  const params: ParamValues = { ...defaults(def.params), ...initial }
  const writes: Array<[string, ParamValue]> = []
  /** What the body sent to the status bar. `onError` is the notice channel, not only errors. */
  const notices: string[] = []
  /** Stands in for undo, a loaded file, or the inspector writing the param directly. */
  let external: (paramId: string, value: ParamValue) => void = () => {}

  function Harness() {
    const [current, setCurrent] = useState(params)
    external = (paramId, value) => setCurrent((held) => ({ ...held, [paramId]: value }))
    const ctx = makeInferContext(def, current, {
      dataset: T.dataset(sourceId, DATASET, chainSchema, false, population),
    })
    return (
      <ExploreBody
        node={{ id: 'n1', type: 'neuron.explore', position: { x: 0, y: 0 }, params: current }}
        ctx={ctx}
        compact={false}
        {...(inputValues ? { inputValues } : {})}
        setParam={(id, value) => {
          writes.push([id, value])
          setCurrent((held) => ({ ...held, [id]: value }))
        }}
        onError={(message) => notices.push(message)}
      />
    )
  }

  render(<Harness />)
  return {
    writes,
    notices,
    external: (id: string, value: ParamValue) => act(() => external(id, value)),
  }
}

function defaults(
  defs: readonly { id: string; default: ParamValue }[] | undefined,
): ParamValues {
  const out: ParamValues = {}
  for (const p of defs ?? []) out[p.id] = Array.isArray(p.default) ? [...p.default] : p.default
  return out
}

async function ready() {
  await waitFor(() => expect(screen.queryByText(/Loading this dataset/)).toBeNull())
}

function rows() {
  return document.querySelectorAll('.explore-row')
}

function searchBox() {
  return screen.getByLabelText('Search neurons') as HTMLInputElement
}

/**
 * How many neurons the caption says matched.
 *
 * Synchronous, so it can be the body of a `waitFor` as well as a read after one: three tests
 * were parsing this one caption with three regexes, and the widest of them accepted the
 * *empty*-query wording too.
 */
function matched(): number {
  const caption = screen.getByText(/[\d,]+ of [\d,]+/)
  return Number(caption.textContent!.split(' of ')[0]!.replace(/,/g, ''))
}

/** Type into the search box and let the debounce elapse. */
async function type(value: string) {
  fireEvent.change(searchBox(), { target: { value } })
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

describe('ExploreBody', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the whole dataset before anything is typed', async () => {
    setup()
    await ready()
    // The promise of the widget: an empty box is not an empty list.
    expect(rows().length).toBeGreaterThan(0)
    expect(screen.getByText(/\d+ neurons/)).toBeTruthy()
  })

  it('filters the list as you type, without waiting for a run', async () => {
    setup()
    await ready()
    const total = Number(
      /(\d+) neurons/.exec(screen.getByText(/\d+ neurons/).textContent ?? '')?.[1],
    )
    expect(total).toBeGreaterThan(0)

    await type('LC')
    // Row count is the wrong measure — a full page stays a full page — so check the hit count
    // and that every row shown actually matches.
    await waitFor(() => {
      const hits = matched()
      expect(hits).toBeLessThan(total)
      expect(hits).toBeGreaterThan(0)
    })
    for (const row of rows()) {
      expect(row.textContent).toMatch(/LC/i)
    }
  })

  it('commits the query to the node, but only after the debounce', async () => {
    const { writes } = setup()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'LC' } })
    // A param write per keystroke would mark the node stale — and with it everything
    // downstream — on every letter.
    expect(writes.filter(([id]) => id === 'query')).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(writes.filter(([id]) => id === 'query')).toEqual([['query', 'LC']])
  })

  it('reports how many of the whole dataset matched', async () => {
    setup()
    await ready()
    await type('LC')
    await waitFor(() => expect(screen.getByText(/\d+ of \d+/)).toBeTruthy())
  })

  it('says so when it has fallen back to approximate matches', async () => {
    setup()
    await ready()
    // No substring hit, but a subsequence one — the widget must admit it widened the search
    // rather than silently reporting a hit count for a different question.
    await type('LPL1')
    await waitFor(() => expect(screen.queryByText(/showing similar/)).toBeTruthy())
  })

  it('anchors a slash-prefixed term where a plain one cannot', async () => {
    /*
     * The widget's own half of the bare-regex rule: the box hands `parseSearch` whatever was
     * typed, so the thing worth pinning here is that a slash survives the debounce and the
     * param write rather than being read as a stray character. `LC` is a substring of `LPLC1`
     * and `/^LC` is not, which is a difference visible in the hit count.
     */
    setup()
    await ready()
    await type('LC')
    const substring = matched()
    await type('/^LC')
    const anchored = matched()
    expect(anchored).toBeGreaterThan(0)
    expect(anchored).toBeLessThan(substring)
  })

  it('reports an empty result rather than an empty panel', async () => {
    setup()
    await ready()
    await type('zzzznothing')
    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeTruthy())
  })

  it('pages without marking the node stale', async () => {
    const { writes } = setup({ pageSize: 5 })
    await ready()
    expect(rows()).toHaveLength(5)
    const first = rows()[0]!.textContent

    fireEvent.click(screen.getByLabelText('Next page'))
    await waitFor(() => expect(rows()[0]!.textContent).not.toBe(first))
    // `page` is presentational, so this write is excluded from the provenance key. The check
    // that matters is that browsing writes nothing else.
    expect(writes.map(([id]) => id)).toEqual(['page'])
  })

  it('clamps the page when a search shrinks the result set', async () => {
    // Otherwise a node parked on page 40 shows an empty list after a search and looks broken.
    setup({ pageSize: 5, page: 6 })
    await ready()
    await type('LC')
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
  })

  it('writes ticked neurons to the selection param', async () => {
    const { writes } = setup()
    await ready()
    const checkbox = within(rows()[0] as HTMLElement).getByRole('checkbox')
    fireEvent.click(checkbox)

    const selection = writes.filter(([id]) => id === 'selection').at(-1)
    expect(selection?.[1]).toHaveLength(1)
    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeTruthy())
  })

  it('writes a wide root id exactly, where a double would round it', async () => {
    /*
     * Invariant 8, in the widget. This was `Number(cell)`: an eighteen-digit CAVE root id went
     * into the param as `…857200` and `rowsWithIds` matched it against nothing, so `Selected`
     * came out empty while `Hits` — which never goes through the selection — worked. The
     * checkbox looked right throughout, because the widget compared its own rounded id against
     * its own rounded id and only the value crossing to `evaluate` was wrong.
     */
    const WIDE = '720575940628857210'
    registerSource(
      Object.assign(Object.create(new MockSource({ latencyMs: 0 })) as DataSource, {
        id: 'mock-wide',
        neuronIndex: async () =>
          makeTable(
            tableSchema(column('neuronId', 'str'), column('type', 'str')),
            { neuronId: [WIDE, '720575940628857211'], type: ['LC4', 'LC6'] },
            'neurons',
          ),
      }),
    )

    const { writes } = setup({}, 'mock-wide')
    await waitFor(() => expect(rows().length).toBe(2))
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('checkbox'))

    const selection = writes.filter(([id]) => id === 'selection').at(-1)?.[1] as string[]
    expect(selection).toEqual([WIDE])
    // Not merely "18 digits": the rounded form differs in the last two, so an assertion on
    // length or on a prefix would pass against the bug.
    expect(selection[0]).not.toBe(String(Number(WIDE)))
  })

  it('selects every neuron on the page', async () => {
    const { writes } = setup({ pageSize: 5 })
    await ready()
    fireEvent.click(screen.getByTitle('Select every neuron on this page'))

    expect(writes.filter(([id]) => id === 'selection').at(-1)?.[1]).toHaveLength(5)
  })

  it('selects every neuron the search matched, not just the page in front of you', async () => {
    // The whole point of the button: the hit set is what you filtered to, and it is almost
    // never one page long.
    const { writes } = setup({ pageSize: 5 })
    await ready()
    await type('LC')
    const hits = matched()
    expect(hits).toBeGreaterThan(5)

    fireEvent.click(screen.getByText('+ all'))
    expect(writes.filter(([id]) => id === 'selection').at(-1)?.[1]).toHaveLength(hits)
  })

  it('adds to the selection rather than replacing it', async () => {
    const { writes } = setup({ pageSize: 5, selection: ['999999'] })
    await ready()
    fireEvent.click(screen.getByText('+ all'))

    const selection = writes.filter(([id]) => id === 'selection').at(-1)?.[1] as string[]
    expect(selection).toContain('999999')
  })

  it('selects a result too big to be comfortable, and says what that costs', async () => {
    /*
     * A selection is provenance: it lands in the saved file and in every downstream cache key,
     * so an unbounded one makes an unrelated edit stringify megabytes. That was a *disabled
     * button* until it was pointed out what it said to somebody asking for every VPN in the
     * dataset — that the answer was too big to have. It is never truncated, though: "+ all"
     * that quietly took the first 10,000 would be a lie told by a button.
     */
    const { writes, notices } = setup({ pageSize: 5 }, 'mock-huge')
    await ready()
    const button = screen.getByText('+ all') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.title).toMatch(/every downstream cache key/)

    fireEvent.click(button)
    expect(writes.filter(([id]) => id === 'selection').at(-1)?.[1]).toHaveLength(
      SELECT_ALL_WARN + 1,
    )
    expect(notices.join(' ')).toMatch(/editing this graph will feel slower/)
  })

  it('says nothing about an ordinary-sized select-all', async () => {
    const { writes, notices } = setup({ pageSize: 5 }, 'mock-huge')
    await ready()
    await type('neuronId==1000')

    const button = screen.getByText('+ all') as HTMLButtonElement
    await waitFor(() => expect(button.title).toMatch(/Select all 1 /))
    fireEvent.click(button)
    expect(writes.filter(([id]) => id === 'selection').at(-1)?.[1]).toEqual(['1000'])
    expect(notices).toEqual([])
  })

  it('keeps the selection when the search changes', async () => {
    // Selection is resolved against the whole index, not the current hits, so refining a
    // search must not silently drop neurons already chosen.
    const { writes } = setup()
    await ready()
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('checkbox'))
    await type('LC')

    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeTruthy())
    expect(writes.filter(([id]) => id === 'selection')).toHaveLength(1)
  })

  it('rasterises thumbnails above the size they are drawn at', async () => {
    // Supersampling: the backing store is 4x the CSS box, so the downscale antialiases. Four
    // rather than two because two *is* the device resolution at `devicePixelRatio` 2 — the tile
    // was 1:1 on every Retina screen, which looks exactly like the constant working. The literal
    // is deliberate: a test that read `RASTER_SCALE` back would assert nothing about its value.
    // jsdom cannot show what was drawn, but the two sizes are the part that has to disagree,
    // and by how much.
    setup({ pageSize: 5 })
    await ready()

    const canvas = await waitFor(() => {
      const found = document.querySelector('canvas.explore-thumb') as HTMLCanvasElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(canvas.width).toBe(4 * parseFloat(canvas.style.width))
    expect(canvas.height).toBe(4 * parseFloat(canvas.style.height))
  })

  it('adopts a query changed from outside, such as by undo', async () => {
    const { external } = setup()
    await ready()
    await type('LC')

    external('query', 'DNp')
    await waitFor(() => expect(searchBox().value).toBe('DNp'))
  })

  it('does not let its own committed write clobber newer typing', async () => {
    /*
     * The debounced write comes straight back as a changed `query` param. If that echo were
     * adopted, anything typed between the write and the re-render would be silently reverted —
     * the user watches letters disappear.
     */
    const { writes } = setup()
    await ready()
    await type('LC')
    expect(searchBox().value).toBe('LC')

    fireEvent.change(searchBox(), { target: { value: 'LC4' } })
    // The echo of the earlier commit arrives around here; the newer text must survive it.
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(searchBox().value).toBe('LC4')

    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(writes.filter(([id]) => id === 'query').at(-1)).toEqual(['query', 'LC4'])
  })

  it('offers completions for field names and values', async () => {
    setup()
    await ready()
    fireEvent.change(searchBox(), { target: { value: 'stat' } })
    await waitFor(() => expect(screen.getByText('status==')).toBeTruthy())

    fireEvent.pointerDown(screen.getByText('status=='))
    await waitFor(() => expect(searchBox().value).toBe('status=='))
  })

  it('accepts the highlighted completion with Enter', async () => {
    setup()
    await ready()
    fireEvent.change(searchBox(), { target: { value: 'stat' } })
    await waitFor(() => expect(screen.getByText('status==')).toBeTruthy())

    fireEvent.keyDown(searchBox(), { key: 'Enter' })
    await waitFor(() => expect(searchBox().value).toBe('status=='))
  })

  it('swallows keystrokes so the canvas does not act on them', () => {
    /*
     * The canvas binds Space to the command palette and Backspace to node deletion. Without
     * stopPropagation, typing a search term with a space in it opens the palette and a
     * correction deletes the node being typed into.
     */
    setup()
    const seen: string[] = []
    document.addEventListener('keydown', (event) => seen.push(event.key))
    fireEvent.keyDown(searchBox(), { key: ' ', bubbles: true })
    fireEvent.keyDown(searchBox(), { key: 'Backspace', bubbles: true })
    expect(seen).toEqual([])
  })

  it('asks for a dataset instead of failing when nothing is connected', () => {
    const def = requireNodeDef('neuron.explore')
    render(
      <ExploreBody
        node={{
          id: 'n1',
          type: 'neuron.explore',
          position: { x: 0, y: 0 },
          params: defaults(def.params),
        }}
        ctx={makeInferContext(def, defaults(def.params), {})}
        compact
        setParam={() => {}}
        onError={() => {}}
      />,
    )
    expect(screen.getByText(/Connect a Dataset/)).toBeTruthy()
  })
})

/**
 * The widget inside the real editor.
 *
 * Everything above renders `ExploreBody` directly, which cannot see whether it is reachable:
 * the custom-body registry, the node card's width override and the expand path are all wiring
 * that fails silently — the node would simply render as a bare header with no list and nothing
 * would throw.
 */
/**
 * What the thumbnail cache is allowed to remember.
 *
 * The distinction these pin is that a mask is a fact about the geometry while a refusal is a
 * verdict from a policy, and policy changes when the code does. Persisting a refusal outlived
 * raising the byte ceiling from 128 kB to 2 MB: every neuron the old one turned down stayed a
 * placeholder through any number of reloads, because nothing asked again.
 */
/**
 * The annotation chain reaching the widget.
 *
 * It reaches the node's *ports* through `evaluate`, which has the values. The widget has only
 * the inferred types, so the chain arrives one Run later — a labelling difference on a datastack
 * with a neuron table, and the difference between working and not on one without, where the
 * chain *is* the list.
 */
describe('an annotated dataset', () => {
  const CHAIN = {
    key: 'seaTable:base=main&table=info',
    table: makeTable(
      tableSchema(column('neuronId', 'i64'), column('lab', 'str')),
      { neuronId: [1, 2], lab: ['ours', 'theirs'] },
      'neurons',
    ),
  }

  function annotatedSource(id: string): DataSource {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    return Object.assign(Object.create(base) as DataSource, {
      id,
      // Answers only when the chain arrives — a datastack with no neuron table of its own.
      neuronIndex: async (req: { annotations?: typeof CHAIN }) => {
        if (!req.annotations) throw new Error('publishes no table listing its neurons')
        return req.annotations.table
      },
    })
  }

  it('lists the chain’s neurons on a datastack that has none of its own', async () => {
    registerSource(annotatedSource('mock-bare'))
    setup({}, 'mock-bare', {
      dataset: {
        kind: 'dataset',
        sourceId: 'mock-bare',
        datasetId: DATASET,
        label: 'bare',
        annotations: CHAIN,
      },
    })
    await waitFor(() => expect(screen.getByText(/2 neurons/)).toBeTruthy())
  })

  it('waits for the Run rather than downloading a list it is about to replace', async () => {
    /*
     * The type says a chain is wired the moment the wire is drawn; only the value carries its
     * table. Loading anyway fetches the whole index under the unannotated key and again under
     * the annotated one the instant a Run lands — and the first list carries the backend's
     * labels, which is the gap the chain was wired to close.
     */
    let asked = 0
    registerSource(
      Object.assign(Object.create(new MockSource({ latencyMs: 0 })) as DataSource, {
        id: 'mock-waits',
        neuronIndex: async () => {
          asked += 1
          return makeTable(
            tableSchema(column('neuronId', 'str')),
            { neuronId: ['1'] },
            'neurons',
          )
        },
      }),
    )

    setup(
      {},
      'mock-waits',
      undefined,
      tableSchema(column('neuronId', 'str'), column('lab', 'str')),
    )
    await waitFor(() => expect(screen.getByText(/Press Run/)).toBeTruthy())
    // Nothing fetched, and no refusal shown — this is a state, not a fault.
    expect(asked).toBe(0)
    expect(screen.queryByText(/publishes no table listing/)).toBeNull()
  })
})

/**
 * Capture what actually reaches the canvas.
 *
 * The 2D stub is deliberately not a recording spy (`jsdomStubs.ts` says why), so the recorder
 * is put on for this one describe and taken off again. What it records is real output — the
 * RGBA bytes the paint produced — rather than a transcript of calls into a fake.
 */
function recordPaints(): { frames: ImageData[]; restore: () => void } {
  const frames: ImageData[] = []
  const original = HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, kind: string) {
      const context = (original as (kind: string) => CanvasRenderingContext2D | null).call(
        this,
        kind,
      )
      if (!context) return null
      return Object.assign(context, {
        putImageData: (image: ImageData) => frames.push(image),
      })
    },
  })
  return {
    frames,
    restore: () => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: original,
      })
    },
  }
}

/**
 * A source whose neuron table carries annotations, which the plain mock deliberately does not.
 *
 * `class` on every neuron and `dimorphism` on one in five, which is the split the layout is
 * about: the first earns a column, the second is chip material. Ten rows, so the fill rates are
 * exactly 1.0 and 0.2 against `FILL_MIN`.
 */
const ANNOTATED = makeTable(
  tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('class', 'str'),
    column('dimorphism', 'str'),
  ),
  {
    neuronId: Array.from({ length: 10 }, (_, i) => 1000 + i),
    type: Array.from({ length: 10 }, (_, i) => (i === 3 ? '' : `T${i}`)),
    class: Array.from({ length: 10 }, () => 'descending'),
    dimorphism: Array.from({ length: 10 }, (_, i) => (i < 2 ? 'male-specific' : '')),
  },
  'neurons',
)

function richSource(id: string): DataSource {
  const base: DataSource = new MockSource({ latencyMs: 0 })
  const source = Object.assign(Object.create(base) as DataSource, {
    id,
    neuronIndex: async () => ANNOTATED,
  })
  registerSource(source)
  return source
}

/**
 * The row menu in the expanded view.
 *
 * Its commands act on the *index*, not on the page — `Select all of this type` is the one worth
 * pinning for that, since a version that ticked only the visible rows would look right on a
 * single-page dataset and be silently wrong on every real one.
 */
/** A pointer event of a given `pointerType` — see `pointerEvent` for why `fireEvent` cannot. */
function pointer(target: Element, type: 'pointerover' | 'pointerout', pointerType: string) {
  fireEvent(target, pointerEvent(type, pointerType))
}

/**
 * Rest on a mark until its preview opens, read the preview's legend row by row, and leave.
 *
 * Every row, the foot included, as its cells' text — so an assertion reads like the panel does.
 */
async function hoverMark(cell: Element): Promise<string[][]> {
  pointer(cell, 'pointerover', 'mouse')
  const panel = await waitFor(() => {
    const found = document.querySelector('.explore-mark-preview')
    if (!found) throw new Error('no mark preview yet')
    return found
  })
  const rows = [...panel.querySelectorAll('.explore-mark-preview__legend tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent ?? ''),
  )
  pointer(cell, 'pointerout', 'mouse')
  await waitFor(() => expect(document.querySelector('.explore-mark-preview')).toBeNull())
  return rows
}

/**
 * The expanded view's aligned half.
 *
 * jsdom performs no layout, so *where* a column lands is the browser probe's business and the
 * `rowTemplate` doc's. What is checkable here is the shape: that a header exists, that it names
 * the same fields the rows draw, and that a card gets neither.
 */
describe('aligned columns', () => {
  /** Every column's label, marks included — each mark is a track of its own now. */
  const head = () =>
    [...document.querySelectorAll('.explore-head > .explore-head__cell')].map(
      (e) => e.textContent,
    )
  const markHead = () =>
    [...document.querySelectorAll('.explore-head > .explore-head__cell--mark')].map(
      (e) => e.textContent,
    )
  /** A row's column cells, in grid order: text, figures, marks and empty mark boxes alike. */
  const columnCells = (row: Element) =>
    row.querySelectorAll(
      ':scope > .explore-cell, :scope > .explore-stat, :scope > .explore-mark, :scope > .explore-mark--empty',
    )

  async function ready() {
    await waitFor(() => expect(document.querySelector('.explore-head')).not.toBeNull())
  }

  it('aligns the well-filled field and leaves the sparse one as a chip', async () => {
    richSource('mock-rich')
    setup({}, 'mock-rich')
    await ready()
    // `class`, on every neuron, earns a column; `dimorphism`, on one in five, does not.
    expect(head()).toContain('class')
    expect(head()).not.toContain('dimorphism')
    const chips = [...document.querySelectorAll('.explore-chip')].map((c) =>
      c.getAttribute('title'),
    )
    expect(chips).toContain('dimorphism')
  })

  it('draws one header cell per column and per figure', async () => {
    richSource('mock-rich2')
    setup({}, 'mock-rich2')
    await ready()
    const row = document.querySelectorAll('.explore-row')[0]!
    /*
     * The header and the rows are one grid; a count that disagreed would put every label a track
     * off the values it names. Where they land is the browser probe's business.
     *
     * **One cell per label, always** — this used to assert `drawn <= labels` for the marks, which
     * passes precisely when the bug is present: the grid places children in order, so a row that
     * skipped a mark it had no value for would slide every later column under the wrong label, and
     * `regions` is absent for the whole settle of every page. The track is reserved from what the
     * *dataset* can answer and filled when it does.
     */
    expect(markHead()).toContain('regions')
    expect(columnCells(row)).toHaveLength(head().length)
  })

  it('keeps a slot for a mark it has no value for yet, so labels stay over their marks', async () => {
    /*
     * The region query settles after the row is drawn, so for the first stretch of every page
     * there is a supported mark with nothing in it. Dropping the child packs the later marks left
     * under earlier labels — browser-only, since jsdom reports no layout, which is why this
     * counts children rather than measuring them.
     */
    richSource('mock-rich-slots')
    setup({}, 'mock-rich-slots')
    await ready()
    const row = document.querySelectorAll('.explore-row')[0]!
    const drawn = row.querySelectorAll(':scope > .explore-mark').length
    const empty = row.querySelectorAll(':scope > .explore-mark--empty').length
    // At least one mark has no value this early, which is the case worth having.
    expect(empty).toBeGreaterThan(0)
    expect(drawn + empty).toBe(markHead().length)
  })

  it('draws an em dash for a value the dataset never annotated', async () => {
    /*
     * The half a chip cannot do. An absent chip is invisible; an empty cell sits at the same
     * position as every other value in its column and says nobody filled this one in.
     */
    richSource('mock-rich3')
    setup({}, 'mock-rich3')
    await ready()
    const empty = document.querySelectorAll('.explore-cell[data-empty]')
    for (const cell of empty) {
      expect(cell.textContent).toBe('—')
      expect(cell.getAttribute('title')).toMatch(/not annotated$/)
    }
  })

  it('gives a card no columns and no header — it has no width to align in', async () => {
    richSource('mock-rich4')
    const def = requireNodeDef('neuron.explore')
    const params: ParamValues = { ...defaults(def.params) }
    function Card() {
      const ctx = makeInferContext(def, params, {
        dataset: T.dataset('mock-rich4', DATASET, undefined, false),
      })
      return (
        <ExploreBody
          node={{ id: 'n1', type: 'neuron.explore', position: { x: 0, y: 0 }, params }}
          ctx={ctx}
          compact
          setParam={() => {}}
          onError={() => {}}
        />
      )
    }
    render(<Card />)
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(2),
    )
    expect(document.querySelector('.explore-head')).toBeNull()
    expect(document.querySelector('.explore-cell')).toBeNull()
    // The annotations are still there, as chips — which is the card's whole shape.
    expect(document.querySelectorAll('.explore-chip').length).toBeGreaterThan(0)
  })
})

/**
 * The header is editable: a column is fields plus a renderer, and the header is where both change.
 *
 * What is pinned is the param each gesture writes, since that is what survives a save — and that
 * the first edit writes the **whole** list, which is what turns the automatic columns into stored
 * ones rather than leaving one hand-made column appended to a list that still moves by itself.
 */
describe('the editable header', () => {
  /** fish2's shape: four compartment counts that only a merged column can say anything with. */
  const COMPARTMENTS = makeTable(
    tableSchema(
      column('neuronId', 'i64'),
      column('type', 'str'),
      column('pre', 'i64'),
      column('post', 'i64'),
      column('axonIn', 'i64'),
      column('axonOut', 'i64'),
      column('dendriteIn', 'i64'),
      column('dendriteOut', 'i64'),
    ),
    {
      neuronId: Array.from({ length: 10 }, (_, i) => 2000 + i),
      type: Array.from({ length: 10 }, (_, i) => `T${i}`),
      pre: Array.from({ length: 10 }, (_, i) => 100 + i),
      post: Array.from({ length: 10 }, (_, i) => 50 + i),
      axonIn: Array.from({ length: 10 }, (_, i) => 5 + i),
      axonOut: Array.from({ length: 10 }, (_, i) => 90 + i),
      dendriteIn: Array.from({ length: 10 }, () => 45),
      dendriteOut: Array.from({ length: 10 }, (_, i) => i),
    },
    'neurons',
  )

  /*
   * The schema is declared as well as the table, because the node infers its outputs and resolves
   * its pickers against what the dataset *says* it publishes (`schemasFor`), and the mock's own
   * schema has no `axonIn` — a fixture whose declared and loaded schemas disagree about the very
   * fields under test.
   */
  function compartmentSource(id: string) {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    const schemas = { ...base.schemas, neurons: COMPARTMENTS.schema }
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        neuronIndex: async () => COMPARTMENTS,
        schemas,
        schemasFor: () => schemas,
      }),
    )
  }

  const head = () =>
    [...document.querySelectorAll('.explore-head > .explore-head__cell')].map(
      (e) => e.textContent,
    )

  async function ready() {
    await waitFor(() => expect(document.querySelector('.explore-head')).not.toBeNull())
    await waitFor(() => expect(document.querySelectorAll('.explore-row').length).toBe(10))
  }

  /** Tick a field in the editor — the checkbox inside the row naming it. */
  function tick(dialog: HTMLElement, name: string) {
    const label = within(dialog).getByText(name).closest('label')!
    fireEvent.click(label.querySelector('input')!)
  }

  const lastParam = (writes: Array<[string, ParamValue]>, param: string) =>
    writes.filter(([id]) => id === param).at(-1)?.[1]
  const lastLayout = (writes: Array<[string, ParamValue]>) => lastParam(writes, 'layout')
  const chipsOf = (field: string) =>
    document.querySelectorAll(`.explore-chip[data-field="${field}"]`).length

  it('adds a merged column from the +, and writes the whole list', async () => {
    compartmentSource('mock-fish-add')
    const { writes } = setup({}, 'mock-fish-add')
    await ready()
    const before = head()

    fireEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Add a field' })).getByRole('button', {
        name: 'Combine several fields into one column…',
      }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Add a column' })
    for (const name of ['axonIn', 'axonOut', 'dendriteIn', 'dendriteOut']) tick(dialog, name)
    // A merge says what it is a share of before it is committed to.
    expect(within(dialog).getByText(/share of their sum/)).toBeTruthy()
    fireEvent.click(within(dialog).getByLabelText('Donut'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add column' }))

    const stored = lastLayout(writes) as string[]
    expect(stored).toHaveLength(before.length + 1)
    expect(stored.at(-1)).toBe(
      encodeColumn({
        render: 'donut',
        fields: ['axonIn', 'axonOut', 'dendriteIn', 'dendriteOut'],
      }),
    )
    expect(head()).toEqual([...before, 'axonIn/axonOut/dendriteIn/dendriteOut'])
    expect(screen.queryByRole('dialog')).toBeNull()

    // And every row draws it, and a rest on the ring names each part with its count and share.
    const row = document.querySelectorAll('.explore-row')[0]!
    const legend = await hoverMark([...row.querySelectorAll(':scope > .explore-mark')].at(-1)!)
    expect(legend).toContainEqual(['', 'dendriteOut', '0', '0.0%'])
  })

  it('changes how a column draws from its own header cell', async () => {
    compartmentSource('mock-fish-edit')
    const { writes } = setup({}, 'mock-fish-edit')
    await ready()
    expect(head()).toContain('pre')

    fireEvent.click(screen.getByRole('button', { name: 'pre' }))
    const dialog = screen.getByRole('dialog', { name: 'Column · pre' })
    fireEvent.click(within(dialog).getByLabelText('Rank in dataset'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    expect(head()).toContain('pre rank')
    expect(head()).not.toContain('pre')
    expect(lastLayout(writes)).toContain(encodeColumn({ render: 'rank', fields: ['pre'] }))
  })

  it('renames a column, and the header still says what it reads', async () => {
    compartmentSource('mock-fish-name')
    const { writes } = setup({}, 'mock-fish-name')
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'pre' }))
    const dialog = screen.getByRole('dialog', { name: 'Column · pre' })
    // The placeholder is the name it would get anyway, so an empty field reads as automatic.
    const field = within(dialog).getByLabelText('Column name') as HTMLInputElement
    expect(field.placeholder).toBe('pre')
    fireEvent.change(field, { target: { value: '  outputs ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    const renamed = screen.getByRole('button', { name: 'outputs' })
    expect(renamed.getAttribute('title')).toBe('outputs: pre')
    expect(lastLayout(writes)).toContain(
      encodeColumn({ render: 'number', fields: ['pre'], label: 'outputs', readable: true }),
    )
  })

  it('draws merged numbers as a line of text, or as bars side by side', async () => {
    compartmentSource('mock-fish-shapes')
    setup(
      {
        layout: [
          encodeColumn({ render: 'text', fields: ['pre', 'post'] }),
          encodeColumn({ render: 'bars', fields: ['pre', 'post'] }),
        ],
      },
      'mock-fish-shapes',
    )
    await ready()
    const row = [...document.querySelectorAll('.explore-row')].find((r) =>
      r.textContent?.includes('2000'),
    )!
    // Neuron 2000: pre 100, post 50.
    const text = row.querySelector('.explore-cell--values')!
    expect(text.textContent).toBe('100 / 50')
    expect(text.getAttribute('title')).toBe('pre: 100\npost: 50')
    // Two bars on one baseline, and a rest on them lists each with its share of the pair.
    const bars = row.querySelector('svg.explore-plot')!
    expect(bars.querySelectorAll('rect')).toHaveLength(3)
    // The native tooltip is gone: it arrived a second after the preview, on top of it.
    expect(bars.querySelector('title')).toBeNull()
    expect(await hoverMark(bars.closest('.explore-mark')!)).toEqual([
      ['', 'pre', '100', '67%'],
      ['', 'post', '50', '33%'],
      ['', 'Sum of these', '150', '100%'],
    ])
  })

  it('places a field from the + as a column or a chip, shows where each is, and hides it', async () => {
    compartmentSource('mock-fish-place')
    const { writes } = setup({}, 'mock-fish-place')
    await ready()
    const before = head()

    fireEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    const menu = () => screen.getByRole('dialog', { name: 'Add a field' })
    const choice = (name: string) => within(menu()).getByRole('button', { name })
    // `pre` is a figure already, so its pressed half is "column" — and its own column wins over
    // the merged `pre/post` bar it is also in, or its pair would be locked.
    expect(choice('Show pre as a column').getAttribute('aria-pressed')).toBe('true')
    expect((choice('Show pre as a chip') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(choice('Show axonIn as a chip'))
    /*
     * One list, written whole: the automatic columns as they were drawn, then the chip. That is what
     * makes it explicit — under the automatic list the fill rule would class a field on every
     * neuron straight back to a column, the opposite of what was just asked.
     */
    const stored = lastLayout(writes) as string[]
    expect(stored).toHaveLength(before.length + 1)
    expect(stored.at(-1)).toBe(encodeChip('axonIn'))
    expect(chipsOf('axonIn')).toBe(10)
    expect(head()).toEqual(before)

    fireEvent.click(choice('Show axonOut as a column'))
    expect(head()).toEqual([...before, 'axonOut'])
    // The menu stays open for the next field, and now says where both went.
    expect(choice('Show axonIn as a chip').getAttribute('aria-pressed')).toBe('true')
    expect(choice('Show axonOut as a column').getAttribute('aria-pressed')).toBe('true')

    // The highlighted half again hides the field — from either place.
    fireEvent.click(choice('Show axonOut as a column'))
    fireEvent.click(choice('Show axonIn as a chip'))
    expect(head()).toEqual(before)
    expect(chipsOf('axonIn')).toBe(0)
    expect(choice('Show axonIn as a chip').getAttribute('aria-pressed')).toBe('false')
  })

  it('promotes a chip to a column from the row it is on, or hides it', async () => {
    compartmentSource('mock-fish-promote')
    setup(
      {
        layout: [
          encodeColumn({ render: 'number', fields: ['pre'] }),
          encodeChip('axonIn'),
          encodeChip('axonOut'),
        ],
      },
      'mock-fish-promote',
    )
    await ready()
    expect(chipsOf('axonIn')).toBe(10)

    fireEvent.contextMenu(document.querySelector('.explore-chip[data-field="axonIn"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Show “axonIn” as a column' }))
    expect(head()).toEqual(['pre', 'axonIn'])
    expect(chipsOf('axonIn')).toBe(0)

    fireEvent.contextMenu(document.querySelector('.explore-chip[data-field="axonOut"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Hide “axonOut”' }))
    expect(chipsOf('axonOut')).toBe(0)
    expect(head()).toEqual(['pre', 'axonIn'])
  })

  it('offers no chip row on a right-click that missed the chips', async () => {
    compartmentSource('mock-fish-nochip')
    setup({}, 'mock-fish-nochip')
    await ready()
    fireEvent.contextMenu(document.querySelectorAll('.explore-row')[0]!)
    expect(screen.queryByRole('button', { name: /as a column/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeTruthy()
  })

  it('shows a column as a chip instead, from its own menu', async () => {
    compartmentSource('mock-fish-demote')
    const { writes } = setup(
      {
        layout: [
          encodeColumn({ render: 'number', fields: ['pre'] }),
          encodeColumn({ render: 'number', fields: ['post'] }),
        ],
      },
      'mock-fish-demote',
    )
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'post' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show as chip instead' }))
    expect(head()).toEqual(['pre'])
    expect(lastLayout(writes)).toEqual([
      encodeColumn({ render: 'number', fields: ['pre'] }),
      encodeChip('post'),
    ])
    expect(chipsOf('post')).toBe(10)
  })

  it('removes any column outright, and only the last field shown stays', async () => {
    richSource('mock-rich-remove')
    setup(
      {
        layout: [
          encodeColumn({ render: 'text', fields: ['class'] }),
          encodeColumn({ render: 'text', fields: ['dimorphism'] }),
        ],
      },
      'mock-rich-remove',
    )
    await waitFor(() => expect(document.querySelectorAll('.explore-row').length).toBe(10))
    fireEvent.click(screen.getByRole('button', { name: 'class' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove column' }))
    // Gone, not moved: `class` is a default field, and under an edited list a field is shown only
    // if the list holds it.
    expect(head()).toEqual(['dimorphism'])
    expect(chipsOf('class')).toBe(0)

    // An empty list is the automatic one, so the last field cannot go.
    fireEvent.click(screen.getByRole('button', { name: 'dimorphism' }))
    expect(
      (screen.getByRole('button', { name: 'Remove column' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('draws the list on a card too: its text columns as chips, then its chips', async () => {
    richSource('mock-rich-card')
    const def = requireNodeDef('neuron.explore')
    const params: ParamValues = {
      ...defaults(def.params),
      layout: [encodeColumn({ render: 'text', fields: ['dimorphism'] }), encodeChip('class')],
    }
    function Card() {
      const ctx = makeInferContext(def, params, {
        dataset: T.dataset('mock-rich-card', DATASET, undefined, false),
      })
      return (
        <ExploreBody
          node={{ id: 'n1', type: 'neuron.explore', position: { x: 0, y: 0 }, params }}
          ctx={ctx}
          compact
          setParam={() => {}}
          onError={() => {}}
        />
      )
    }
    render(<Card />)
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(2),
    )
    expect(document.querySelector('.explore-head')).toBeNull()
    // Neuron 1000 carries both; the card has no header to align `dimorphism` under.
    const row = [...document.querySelectorAll('.explore-row')].find((r) =>
      r.textContent?.includes('1000'),
    )!
    expect(
      [...row.querySelectorAll('.explore-chip')].map((c) => c.getAttribute('data-field')),
    ).toEqual(['dimorphism', 'class'])
  })

  it('adds a figure exact, and keeps an automatic one human-readable until told', async () => {
    compartmentSource('mock-fish-readable')
    const { writes } = setup({}, 'mock-fish-readable')
    await ready()

    // A field added now prints its digits: the new column carries no readable flag.
    fireEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Add a field' })).getByRole('button', {
        name: 'Show axonOut as a column',
      }),
    )
    const stored = lastLayout(writes) as string[]
    expect(stored.at(-1)).toBe(encodeColumn({ render: 'number', fields: ['axonOut'] }))
    // The automatic figures were written as they were drawn, so the first edit changed no digits.
    expect(stored).toContain(
      encodeColumn({ render: 'number', fields: ['pre'], readable: true }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'pre' }))
    const dialog = screen.getByRole('dialog', { name: 'Column · pre' })
    const box = () =>
      within(dialog).queryByLabelText(/Human-readable formatting/) as HTMLInputElement
    expect(box().checked).toBe(true)
    // A rank has no digits to format, so the box leaves with the figure.
    fireEvent.click(within(dialog).getByLabelText('Rank in dataset'))
    expect(box()).toBeNull()
    fireEvent.click(within(dialog).getByLabelText('Number'))
    fireEvent.click(box())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(lastLayout(writes)).toContain(encodeColumn({ render: 'number', fields: ['pre'] }))
  })

  it('moves and removes a column, and a reset hands the list back', async () => {
    compartmentSource('mock-fish-move')
    const { writes } = setup(
      {
        layout: [
          encodeColumn({ render: 'number', fields: ['pre'] }),
          encodeColumn({ render: 'number', fields: ['post'] }),
        ],
      },
      'mock-fish-move',
    )
    await ready()
    expect(head()).toEqual(['pre', 'post'])

    fireEvent.click(screen.getByRole('button', { name: 'post' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move left' }))
    expect(head()).toEqual(['post', 'pre'])

    fireEvent.click(screen.getByRole('button', { name: 'post' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove column' }))
    expect(head()).toEqual(['pre'])

    // The last column cannot go — an empty list is the automatic one, which is Reset's job.
    fireEvent.click(screen.getByRole('button', { name: 'pre' }))
    expect(
      (screen.getByRole('button', { name: 'Remove column' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to automatic fields' }))
    expect(lastLayout(writes)).toEqual([])
    expect(head()).toContain('pre/post')
  })

  it('keeps a text field it placed in a column out of the chip tail', async () => {
    richSource('mock-rich-placed')
    setup(
      { layout: [encodeColumn({ render: 'text', fields: ['dimorphism'] })] },
      'mock-rich-placed',
    )
    await waitFor(() => expect(document.querySelector('.explore-head')).not.toBeNull())
    await waitFor(() => expect(document.querySelectorAll('.explore-row').length).toBe(10))
    expect(head()).toEqual(['dimorphism'])
    const chips = [...document.querySelectorAll('.explore-chip')].map((c) =>
      c.getAttribute('title'),
    )
    expect(chips).not.toContain('dimorphism')
  })
})

/**
 * Paging faster than the thumbnails can load.
 *
 * The queue behind `MAX_CONCURRENT` used to be strict FIFO, so clicking through five pages put
 * every earlier page's work ahead of the one actually on screen — the page you stopped on filled
 * last, after a hundred requests nobody was looking at any more.
 */
describe('thumbnail queue under fast paging', () => {
  /** A source whose geometry never resolves on its own, so the queue can be inspected. */
  function stalledSource(id: string) {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    const asked: string[] = []
    const release: Array<() => void> = []
    const source = Object.assign(Object.create(base) as DataSource, {
      id,
      fetchCoarseGeometry: (req: { neuronId: string }) => {
        asked.push(req.neuronId)
        return new Promise((resolve) => release.push(() => resolve(undefined)))
      },
    })
    registerSource(source)
    return { asked, release }
  }

  it('serves the page the reader stopped on before the ones they clicked past', async () => {
    const { asked, release } = stalledSource('mock-queue')
    // One page exactly fills the concurrency gate, so every later page is queued behind it.
    setup({ pageSize: 4 }, 'mock-queue')
    await waitFor(() => expect(asked.length).toBe(4))
    const firstPage = [...asked]

    // Click past three pages without waiting, as somebody hunting for a row does.
    for (let click = 0; click < 3; click++) {
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Next page'))
      })
    }
    await waitFor(() => expect(document.querySelectorAll('.explore-row').length).toBe(4))

    // Nothing new can start until a slot frees.
    expect(asked.length).toBe(4)
    const onScreen = [...document.querySelectorAll('.explore-row__id')].map(
      (e) => e.textContent!,
    )

    // Free every slot at once and see which page the queue reaches for.
    await act(async () => {
      for (const done of release.splice(0)) done()
    })
    await waitFor(() => expect(asked.length).toBeGreaterThan(4))

    const next = asked.slice(firstPage.length, firstPage.length + 4)
    expect(next.sort()).toEqual([...onScreen].sort())
  })

  it('still fills a page in its own order, not backwards', async () => {
    /*
     * The half a plain LIFO would break. Serving the newest batch first fixes the across-page
     * problem; popping the stack would also reverse the rows *within* a page, so a screenful
     * would fill bottom-up. Newest batch, first waiter in it.
     */
    const { asked, release } = stalledSource('mock-queue-order')
    setup({ pageSize: 4 }, 'mock-queue-order')
    await waitFor(() => expect(asked.length).toBe(4))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Next page'))
    })
    await waitFor(() => expect(document.querySelectorAll('.explore-row').length).toBe(4))
    const onScreen = [...document.querySelectorAll('.explore-row__id')].map(
      (e) => e.textContent!,
    )

    await act(async () => {
      for (const done of release.splice(0)) done()
    })
    await waitFor(() => expect(asked.length).toBe(8))
    // Top row first, exactly as the list is read.
    expect(asked.slice(4)).toEqual(onScreen)
  })
})

describe('row context menu', () => {
  /** jsdom has no clipboard, and `copyText` reports that rather than throwing into the void. */
  function stubClipboard() {
    const written: string[] = []
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    return {
      written,
      restore: () => {
        if (original) Object.defineProperty(navigator, 'clipboard', original)
        else Reflect.deleteProperty(navigator, 'clipboard')
      },
    }
  }

  const menu = () => document.querySelector('.context-menu')

  function row(at = 0) {
    return document.querySelectorAll('.explore-row')[at]!
  }

  async function openMenu(at = 0) {
    await screen.findAllByText(/neurons$/)
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(2),
    )
    fireEvent.contextMenu(row(at))
    await waitFor(() => expect(menu()).not.toBeNull())
  }

  it('opens on a right-click and names the neuron it landed on', async () => {
    setup()
    await screen.findAllByText(/neurons$/)
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(2),
    )
    // `fireEvent` reports whether the default was prevented — the browser's own menu offers
    // nothing about a neuron, and leaving it is how one gesture comes to mean two things.
    expect(fireEvent.contextMenu(row(0))).toBe(false)
    await waitFor(() => expect(menu()).not.toBeNull())
    const id = row(0).querySelector('.explore-row__id')!.textContent
    expect(menu()!.querySelector('.context-menu__caption')!.textContent).toContain(id!)
  })

  it('puts the id on the clipboard as text', async () => {
    const clipboard = stubClipboard()
    try {
      setup()
      await openMenu()
      const id = row(0).querySelector('.explore-row__id')!.textContent!
      fireEvent.click(within(menu() as HTMLElement).getByText('Copy ID'))
      await waitFor(() => expect(clipboard.written).toEqual([id]))
      // Text, verbatim — a wide root id does not survive a round trip through a double, which is
      // why nothing here reads the cell as a number. See invariant 8.
      expect(clipboard.written[0]).toBe(id)
    } finally {
      clipboard.restore()
    }
  })

  it('offers the selection as a second row, disabled until something is ticked', async () => {
    const clipboard = stubClipboard()
    try {
      const { external } = setup()
      await openMenu()
      const disabled = within(menu() as HTMLElement).getByText(/Copy selected/)
      expect(disabled.closest('button')!.hasAttribute('disabled')).toBe(true)

      // Two ticked, as the checkboxes would leave it.
      fireEvent.click(document.querySelector('.context-menu')!)
      external('selection', ['1047397108', '1047397435'])
      await openMenu()
      fireEvent.click(within(menu() as HTMLElement).getByText(/Copy selected/))
      // `joinIds`' default separator, so this and the Copy IDs node agree.
      await waitFor(() => expect(clipboard.written).toEqual(['1047397108\n1047397435']))
    } finally {
      clipboard.restore()
    }
  })

  it('selects every hit of the row’s type, not just the page', async () => {
    const { writes } = setup({ pageSize: 3 })
    await openMenu()
    const label = row(0).querySelector('strong')!.textContent!
    fireEvent.click(within(menu() as HTMLElement).getByText(/Select all of this type/))

    const written = writes.filter(([id]) => id === 'selection').at(-1)
    const chosen = written?.[1] as string[]
    // More than the three on screen, and every one of them really is that type.
    expect(chosen.length).toBeGreaterThan(3)
    expect(label.length).toBeGreaterThan(0)
  })

  it('searches for the type, which re-runs the list', async () => {
    setup()
    await openMenu()
    const label = row(0).querySelector('strong')!.textContent!
    fireEvent.click(within(menu() as HTMLElement).getByText('Search for this type'))
    await waitFor(() =>
      expect((screen.getByLabelText('Search neurons') as HTMLInputElement).value).toBe(label),
    )
  })

  it('is the overlay’s alone — a card row has no menu', async () => {
    /*
     * Through a whole `ExploreBody` with `compact`, because the gate is there and not on the row:
     * a test that renders `NeuronRow` without an `onContextMenu` prop asserts nothing about who
     * decides to pass one, and passes just as happily with the gate removed. Checked by removing
     * it.
     */
    const def = requireNodeDef('neuron.explore')
    const params: ParamValues = { ...defaults(def.params) }
    function Card() {
      const ctx = makeInferContext(def, params, {
        dataset: T.dataset('mock', DATASET, undefined, false),
      })
      return (
        <ExploreBody
          node={{ id: 'n1', type: 'neuron.explore', position: { x: 0, y: 0 }, params }}
          ctx={ctx}
          compact
          setParam={() => {}}
          onError={() => {}}
        />
      )
    }
    render(<Card />)
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(2),
    )
    fireEvent.contextMenu(row(0))
    expect(menu()).toBeNull()
  })
})

describe('thumbnail ink', () => {
  const BODY = getConnectome(DATASET)!.neurons[0]!.neuronId

  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  /** The first painted pixel's colour, which is the ink — the mask supplies only its alpha. */
  function inkOf(frame: ImageData): [number, number, number] {
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i + 3]! > 0) {
        return [frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!]
      }
    }
    throw new Error('nothing painted')
  }

  it('repaints on a theme flip, because nothing else ever re-renders a row', async () => {
    document.documentElement.dataset.theme = 'dark'
    const paints = recordPaints()
    try {
      render(
        <NeuronThumbnail
          sourceId="mock"
          datasetId={DATASET}
          neuronId={String(BODY)}
          size={76}
        />,
      )
      await waitFor(() => expect(paints.frames.length).toBe(1))
      // White on the dark card — `CHART_INK.dark.primary`.
      expect(inkOf(paints.frames[0]!)).toEqual([255, 255, 255])

      // The flip the user makes from the toolbar. Explore fetches for itself and its rows
      // subscribe to no graph state, so without the observer this is the last paint there is
      // and dark-mode ink stays on a light card for as long as the list is open.
      act(() => {
        document.documentElement.dataset.theme = 'light'
      })
      await waitFor(() => expect(paints.frames.length).toBe(2))
      // Inverted, from the one mask — `CHART_INK.light.primary`.
      expect(inkOf(paints.frames[1]!)).toEqual([11, 11, 11])
    } finally {
      paints.restore()
    }
  })
})

/**
 * The hover preview.
 *
 * jsdom performs no layout — every element reports the same rect from `installJsdomStubs` — so
 * where the preview lands is `previewPlacement`'s test and not this one. What is checkable here
 * is the half that is about events: that it waits, that it is a mouse gesture, that it leaves,
 * and that it reaches a card's row as well as the overlay's.
 */
describe('thumbnail hover preview', () => {
  const BODY = getConnectome(DATASET)!.neurons[0]!.neuronId

  const preview = () => document.querySelector('.explore-thumb-preview')

  async function drawTile(hoverPreview: boolean) {
    render(
      <NeuronThumbnail
        sourceId="mock"
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
        hoverPreview={hoverPreview}
      />,
    )
    const slot = await waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
    return slot
  }

  it('opens an enlarged copy of the mask the tile already has', async () => {
    const slot = await drawTile(true)
    expect(preview()).toBeNull()

    pointer(slot, 'pointerover', 'mouse')
    // Not immediately: the delay is what stops a pointer swept down 25 rows opening 25 previews.
    expect(preview()).toBeNull()

    await waitFor(() => expect(preview()).not.toBeNull())
    /*
     * It opens on the tile's own 304px mask — no wait — and swaps to the 640px one the finer
     * fetch brings back. Both are drawn at `PREVIEW_SIZE`, which is the assertion that matters:
     * a stand-in at its own size would make the picture jump rather than sharpen when the fetch
     * lands.
     */
    const canvas = () => preview()!.querySelector('canvas') as HTMLCanvasElement
    expect(canvas().style.width).toBe('320px')
    await waitFor(() => expect(canvas().width).toBe(640))
    expect(canvas().style.width).toBe('320px')

    pointer(slot, 'pointerout', 'mouse')
    await waitFor(() => expect(preview()).toBeNull())
  })

  /**
   * A source that records what detail each call asked for, and can be told to have nothing finer.
   *
   * Delegation, not a subclass, for the reason `oversizedSource` gives: `MockSource.id` is the
   * literal `'mock'` and registering that id would replace the real mock for every other case in
   * this file.
   */
  function recordingSource(id: string, finer = true): DataSource {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    const asked: Array<string | undefined> = []
    const source = Object.assign(Object.create(base) as DataSource, {
      id,
      asked,
      async fetchCoarseGeometry(req: { detail?: string }) {
        asked.push(req.detail)
        if (!finer && req.detail === 'fine') return undefined
        return base.fetchCoarseGeometry!(req as never)
      },
    })
    registerSource(source)
    return source as DataSource & { asked: Array<string | undefined> }
  }

  it('asks for the coarsest body for a tile and a finer one only once the preview opens', async () => {
    const source = recordingSource('mock-detail') as DataSource & {
      asked: Array<string | undefined>
    }
    render(
      <NeuronThumbnail
        sourceId="mock-detail"
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
        hoverPreview
      />,
    )
    const slot = await waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
    // The tile alone. A row that nobody rests on costs one coarse body and nothing else.
    expect(source.asked).toEqual(['coarsest'])

    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(preview()).not.toBeNull())
    await waitFor(() => expect(source.asked).toEqual(['coarsest', 'fine']))
  })

  it('keeps the tile mask when the source has nothing finer to give', async () => {
    /*
     * CATMAID hands back the whole traced arbor already and CAVE's chunk-graph route has no
     * finer level, so `undefined` here is the ordinary answer rather than a failure — and the
     * preview must stay up on the tile's own mask. Written as a wait on the refusal having been
     * asked for and answered, since the fallback is the *absence* of a swap.
     */
    const source = recordingSource('mock-nofiner', false) as DataSource & {
      asked: Array<string | undefined>
    }
    render(
      <NeuronThumbnail
        sourceId="mock-nofiner"
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
        hoverPreview
      />,
    )
    const slot = await waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(source.asked).toEqual(['coarsest', 'fine']))

    const canvas = preview()!.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.width).toBe(304)
    // Still drawn at the full preview size, which is the whole of what those two sources get.
    expect(canvas.style.width).toBe('320px')
  })

  it('ignores touch, which has no gesture that would close it', async () => {
    const slot = await drawTile(true)
    pointer(slot, 'pointerover', 'touch')
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(preview()).toBeNull()
  })

  /*
   * The dismissal is a watch on the tile's rect, not a `scroll` listener, because a node card is
   * moved by a `transform` on React Flow's pane and fires no event at all. jsdom reports one
   * constant rect for every element, so the watch is reachable here only by making *this* tile
   * answer differently — which is the whole mechanism: scrolling the list is one way for that to
   * happen and panning the canvas is another.
   */
  it('closes when the tile moves, the neuron under the pointer now being a different one', async () => {
    const slot = await drawTile(true)
    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(preview()).not.toBeNull())

    // Defined rather than assigned: the stub puts a non-writable `getBoundingClientRect` on
    // `HTMLElement.prototype`, so a plain assignment throws under strict mode.
    const before = slot.getBoundingClientRect()
    Object.defineProperty(slot, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...before, top: before.top - 40 }) as DOMRect,
    })

    await waitFor(() => expect(preview()).toBeNull())
  })

  it('stays up while the tile does not move, or a rested pointer would flicker', async () => {
    const slot = await drawTile(true)
    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(preview()).not.toBeNull())

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(preview()).not.toBeNull()
  })

  /*
   * The sweep, at the only layer jsdom can reach.
   *
   * What is checkable here is the plumbing — that one fetch serves both the mask and the frames,
   * that nothing is built for a row nobody rested on, and that a reader asking for less motion
   * pays for none of it. Whether it *looks* like a rotation is `rotation.test.ts` for the
   * arithmetic and the browser probe for the picture.
   */
  it('builds the sweep from the same body the mask was drawn from, not a second fetch', async () => {
    const source = recordingSource('mock-sweep') as DataSource & {
      asked: Array<string | undefined>
    }
    await hover('mock-sweep', BODY)
    // One coarse body for the tile, one fine body serving both the static mask and every frame.
    await waitFor(() => expect(source.asked).toEqual(['coarsest', 'fine']))
  })

  it('builds nothing for a row the pointer only passes over', async () => {
    const source = recordingSource('mock-sweep-pass') as DataSource & {
      asked: Array<string | undefined>
    }
    render(
      <NeuronThumbnail
        sourceId="mock-sweep-pass"
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
        hoverPreview
      />,
    )
    const slot = await waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
    // In and straight out again, inside `PREVIEW_DELAY_MS`.
    pointer(slot, 'pointerover', 'mouse')
    pointer(slot, 'pointerout', 'mouse')
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(preview()).toBeNull()
    expect(source.asked).toEqual(['coarsest'])
  })

  it('frees the frames when the preview closes, and rebuilds them on the next look', async () => {
    /*
     * The whole cost model in one assertion. Sixteen masks are 6.3 MB and ~22 ms to rasterise
     * from a cached mesh, so they are cheap to rebuild and expensive to keep — the geometry is
     * what `loadFineGeometry` holds, and the frames live only while the pointer is on the row.
     *
     * Observed through `createRotation` being reached twice for one neuron, because the frames
     * themselves are not visible from the DOM: drop the gate on the preview being open and the
     * build effect stops re-running, the frames stay in state, and this is called once.
     */
    const built = vi.spyOn(rotationModule, 'createRotation')
    try {
      await hover('mock', BODY)
      await waitFor(() => expect(built).toHaveBeenCalledTimes(1))

      const slot = document.querySelector('.explore-thumb-slot')!
      pointer(slot, 'pointerout', 'mouse')
      await waitFor(() => expect(preview()).toBeNull())

      pointer(slot, 'pointerover', 'mouse')
      await waitFor(() => expect(preview()).not.toBeNull())
      await waitFor(() => expect(built).toHaveBeenCalledTimes(2))
    } finally {
      built.mockRestore()
    }
  })

  it('builds no frames at all under prefers-reduced-motion', async () => {
    /*
     * Not "built and not played". The frames are the whole cost — 6.3 MB and a rasterisation
     * pass — so a reader who has asked for less motion should not be paying for an animation they
     * will never see. Asserted through `createRotation` never being reached, since the drawn
     * picture is the static mask either way and the two are indistinguishable from the DOM.
     *
     * `resetMediaForTest` is what makes the swap take: `ui/mediaQuery.ts` keeps one
     * `MediaQueryList` per query in a module registry, so a suite that replaces `matchMedia`
     * without dropping the registry keeps being answered by the list belonging to the one it
     * replaced — which is exactly what that seam exists for.
     */
    const built = vi.spyOn(rotationModule, 'createRotation')
    const media = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    resetMediaForTest()
    try {
      await hover('mock', BODY)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(built).not.toHaveBeenCalled()
      // And it still draws the sharp still picture, which is the *only* thing `fine` is for now:
      // where the rock runs, rasterising it would just delay the centre frame that replaces it.
      expect((preview()!.querySelector('canvas') as HTMLCanvasElement).width).toBe(640)
    } finally {
      built.mockRestore()
      window.matchMedia = media
      resetMediaForTest()
    }
  })

  /**
   * Hover a tile and wait for the finer mask to land, returning the recording source.
   *
   * Takes the neuron so the eviction case can walk a page of them.
   */
  async function hover(sourceId: string, neuronId: number) {
    render(
      <NeuronThumbnail
        sourceId={sourceId}
        datasetId={DATASET}
        neuronId={String(neuronId)}
        size={76}
        hoverPreview
      />,
    )
    const slot = await waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(preview()).not.toBeNull())
    // Both the static fine mask and every rotation frame are 640, so this waits for "the finer
    // body has landed" either way. Under reduced motion there is no sweep to wait past.
    await waitFor(() =>
      expect((preview()!.querySelector('canvas') as HTMLCanvasElement).width).toBe(640),
    )
  }

  it('persists a tile mask and never a preview mask', async () => {
    await hover('mock', BODY)

    // The tile's, written as it always was. `cacheGet` returning it is what makes a second visit
    // to a dataset cheap.
    expect(
      await cacheGet<{ coverage: Uint8Array }>(`thumb:mock:${DATASET}:${BODY}:304`, {
        fingerprint: 'coverage-8bit-1',
      }),
    ).toBeDefined()

    /*
     * The preview's, deliberately absent. 400 KiB an entry against the tile's 90 kB, earned by
     * resting a pointer rather than by scrolling — and `cache.ts` evicts nothing and this caller
     * passes no `maxAgeMs`, so a write here is a write forever.
     */
    expect(
      await cacheGet<{ coverage: Uint8Array }>(`thumb:mock:${DATASET}:${BODY}:640`, {
        fingerprint: 'coverage-8bit-1',
      }),
    ).toBeUndefined()
    // And nothing at the preview raster was written under any spelling. The preview's mask has
    // no cache namespace at all now — it is derived from the body `fineGeometry` holds.
    expect((await cacheKeys()).filter((k) => k.includes(':640'))).toEqual([])
  })

  it('still remembers a preview for the session, so re-hovering does not refetch', async () => {
    const source = recordingSource('mock-session') as DataSource & {
      asked: Array<string | undefined>
    }
    await hover('mock-session', BODY)
    expect(source.asked).toEqual(['coarsest', 'fine'])

    cleanup()
    await hover('mock-session', BODY)
    // Memory-only is about surviving a *reload*. Within the session the map still answers, or
    // every pass down a list would re-fetch the finer body.
    expect(source.asked).toEqual(['coarsest', 'fine'])
  })

  it('forgets the oldest body past the cap, because memory-only is not bounded', async () => {
    /*
     * `MAX_FINE_GEOMETRY` is 3. The bound moved down a layer when the preview's mask stopped
     * having a cache of its own: the mask is derived from the body, so the body is the only thing
     * worth capping, and without a cap the session holds ~0.5 MB per neuron ever hovered until
     * the tab closes.
     */
    const source = recordingSource('mock-evict') as DataSource & {
      asked: Array<string | undefined>
    }
    const bodies = getConnectome(DATASET)!
      .neurons.slice(0, 4)
      .map((n) => n.neuronId)
    const first = bodies[0]!

    for (const body of bodies) {
      await hover('mock-evict', body)
      cleanup()
    }
    const before = source.asked.filter((d) => d === 'fine').length
    expect(before).toBe(4)

    await hover('mock-evict', first)
    // Asked again: four distinct bodies do not fit in three.
    expect(source.asked.filter((d) => d === 'fine').length).toBe(before + 1)
  })

  /*
   * Asked through a whole row rather than of the prop, because the prop is not the wire.
   *
   * The default is `false` — `ProfileViewer`'s shape tile wants it that way — so a test handing
   * the component `hoverPreview` by hand says nothing about whether a *row* passes it. Both
   * modes are asked because for a while only one of them did, and the compact tile is the one
   * with something to go wrong: it is 56px on a pane React Flow has scaled, and the preview it
   * opens is portalled out to `document.body` at viewport coordinates.
   */
  function renderRow(compact: boolean) {
    const table = makeTable(
      tableSchema(column('neuronId', 'i64'), column('type', 'str')),
      { neuronId: [BODY], type: ['DNp01'] },
      'neurons',
    )
    render(
      <NeuronRow
        table={table}
        row={0}
        fields={rowFields(table.schema)}
        sourceId="mock"
        datasetId={DATASET}
        selected={false}
        onToggle={() => {}}
        compact={compact}
        mode="dark"
      />,
    )
    return waitFor(() => {
      const found = document.querySelector('.explore-thumb-slot')
      if (!found) throw new Error('no tile yet')
      return found
    })
  }

  it('reaches a row in the overlay', async () => {
    const slot = await renderRow(false)
    pointer(slot, 'pointerover', 'mouse')
    await waitFor(() => expect(preview()).not.toBeNull())
  })

  it('reaches a row on a card too, at the same preview size off a smaller tile', async () => {
    const slot = await renderRow(true)
    expect(slot.getAttribute('style')).toContain('56px')
    pointer(slot, 'pointerover', 'mouse')
    const shown = await waitFor(() => {
      const found = preview()
      if (!found) throw new Error('no preview yet')
      return found
    })
    // Portalled out of the row, which is what escapes `.coda-node`'s clip and the list's.
    expect(shown.parentElement).toBe(document.body)
    // The stand-in is the 224px tile mask, but it is drawn at the full preview size on both.
    const canvas = shown.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.style.width).toBe('320px')
  })
})

/**
 * What a blank tile says, and why it is worth saying anything.
 *
 * A tile with no picture used to mean one thing — "nothing cheap here" — and now means two, told
 * apart at `readKey`: the dataset never meshed this neuron, or it has a mesh and the byte ceiling
 * turned it down. On a flat mesh store the second is the *common* case rather than the rare one
 * (fish2's median body is 0.54 MB against a 12 MB ceiling), and the two are actionable in
 * opposite directions, so the tile carries the reason.
 *
 * Asserted on the hook and not on the sentence: `data-blank` is stable where the tooltip's prose
 * is the thing most likely to be reworded, and its wording proves nothing.
 */
describe('a blank tile says which kind of blank', () => {
  const BODY = getConnectome(DATASET)!.neurons[0]!.neuronId

  /** A source answering exactly one way, for a neuron the mock connectome really has. */
  function answering(
    id: string,
    answer: Awaited<ReturnType<NonNullable<DataSource['fetchCoarseGeometry']>>>,
  ) {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        async fetchCoarseGeometry() {
          return answer
        },
      }),
    )
  }

  async function tile(sourceId: string) {
    render(
      <NeuronThumbnail
        sourceId={sourceId}
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
        hoverPreview
      />,
    )
    return waitFor(() => {
      const found = document.querySelector('.explore-thumb--empty')
      if (!found) throw new Error('no blank tile yet')
      return found
    })
  }

  it('marks a body the ceiling refused, and says so where a reader can ask', async () => {
    answering('mock-refused', { kind: 'refused', reason: 'too-large' })
    const blank = await tile('mock-refused')
    expect(blank.getAttribute('data-blank')).toBe('too-large')
    expect(blank.getAttribute('title')).toMatch(/larger than/)
    // Announced, because this is a fact no other part of the row carries.
    expect(blank.getAttribute('aria-label')).toMatch(/too large/)
  })

  it('leaves an ordinary absence unmarked and unannounced', async () => {
    answering('mock-nothing', undefined)
    const blank = await tile('mock-nothing')
    expect(blank.getAttribute('data-blank')).toBeNull()
    expect(blank.getAttribute('title')).toMatch(/no cheap geometry/)
    /*
     * Decorative on purpose: it says what the row already says. A dataset that publishes no cheap
     * geometry at all makes *every* row this tile, and announcing each one spends a screen
     * reader's attention on nothing.
     */
    expect(blank.getAttribute('aria-hidden')).toBe('true')
    expect(blank.getAttribute('aria-label')).toBeNull()
  })

  /*
   * A thin body is a picture, not a blank — the coverage floor's own case, and the one it got
   * backwards.
   *
   * Every shape is fitted to fill the tile, so what a coverage fraction measures is how *thin* a
   * shape is. The floor was 0.002, and on `neuprint-fish2` it blanked about one real neuron in ten
   * — a soma and a long axon across a square tile — while the dataset's smallest fragments scored
   * 17–58% and sailed past it. This bar is 500 long and 3 tall in a box 1000 wide, which covers
   * 0.00146 of the 304 raster and 0.00197 of the 224: under the old floor at both sizes, and in
   * the same band as the two reported bodies (0.00159, 0.00193). Both sizes, because the old floor
   * also disagreed with itself between the card and the overlay.
   */
  it('draws a long thin body rather than calling it empty, at both tile sizes', async () => {
    // A bar, plus one tiny triangle far off that stretches the box the way an arbor's far end does.
    answering('mock-thin', {
      kind: 'mesh',
      positions: new Float32Array([
        0, 0, 0, 500, 0, 0, 500, 3, 0, 0, 3, 0, 1000, 1000, 0, 1001, 1000, 0, 1000, 1001, 0,
      ]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
    })
    render(
      <>
        <NeuronThumbnail
          sourceId="mock-thin"
          datasetId={DATASET}
          neuronId={String(BODY)}
          size={76}
        />
        <NeuronThumbnail
          sourceId="mock-thin"
          datasetId={DATASET}
          neuronId={String(BODY)}
          size={56}
        />
      </>,
    )
    await waitFor(() => {
      const settled =
        document.querySelectorAll('canvas.explore-thumb').length +
        document.querySelectorAll('.explore-thumb--empty').length
      if (settled < 2) throw new Error('tiles still loading')
    })
    expect(document.querySelectorAll('.explore-thumb--empty')).toHaveLength(0)
    expect(document.querySelectorAll('canvas.explore-thumb')).toHaveLength(2)
  })

  it('does not offer a preview for a tile with no picture behind it', async () => {
    // The hover machinery hangs off `.explore-thumb-slot`, which a blank never renders — so a
    // refused body cannot be hovered into fetching the very mesh the ceiling just declined.
    answering('mock-refused-hover', { kind: 'refused', reason: 'too-large' })
    await tile('mock-refused-hover')
    expect(document.querySelector('.explore-thumb-slot')).toBeNull()
  })
})

describe('thumbnail caching', () => {
  const BODY = getConnectome(DATASET)!.neurons[0]!.neuronId
  /**
   * Displayed at 76, rasterised at `RASTER_SCALE` — the key carries the raster size, and the
   * detail beside it, since a preview asks the same source for a finer body at 640.
   */
  const KEY = `thumb:mock:${DATASET}:${BODY}:304`

  function renderThumb(sourceId = 'mock') {
    render(
      <NeuronThumbnail
        sourceId={sourceId}
        datasetId={DATASET}
        neuronId={String(BODY)}
        size={76}
      />,
    )
  }

  it('ignores an entry written by an older encoder, refusals included', async () => {
    // Exactly what the old code left in a real browser: an empty mask, no fingerprint, no
    // expiry. Read back verbatim it is indistinguishable from "this neuron has no thumbnail".
    await cacheSet(KEY, { size: 304, coverage: new Uint8Array(0) })

    renderThumb()
    // A canvas means it went and fetched rather than trusting what it found.
    await waitFor(() => expect(document.querySelector('canvas.explore-thumb')).not.toBeNull())
  })

  it('persists a mask, so a reload does not re-fetch what it already drew', async () => {
    renderThumb()
    await waitFor(() => expect(document.querySelector('canvas.explore-thumb')).not.toBeNull())

    const stored = await cacheGet<{ coverage: Uint8Array }>(KEY, {
      fingerprint: 'coverage-8bit-1',
    })
    expect(stored?.coverage.length).toBeGreaterThan(0)
  })

  it('does not persist a refusal, so a raised ceiling reaches the neurons it was raised for', async () => {
    // The source refuses, as one does for a body over the byte cap. Nothing about that verdict
    // may reach IndexedDB, or the next deploy cannot change it.
    const base: DataSource = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id: 'mock-refuses',
        fetchCoarseGeometry: async () => undefined,
      }),
    )

    renderThumb('mock-refuses')
    await waitFor(() => expect(document.querySelector('.explore-thumb--empty')).not.toBeNull())
    expect(await cacheGet(`thumb:mock-refuses:${DATASET}:${BODY}:304`)).toBeUndefined()
  })
})

/**
 * The chip markup, which no test above can reach: the mock connectomes carry the canonical
 * seven columns and none of them is a chip field, so a row rendered against the mock has no
 * chips at all. A typo in the attribute name would lose every colour with nothing failing.
 */
describe('annotation chips', () => {
  const table = makeTable(
    tableSchema(
      column('neuronId', 'i64'),
      column('type', 'str'),
      column('class', 'str'),
      column('somaSide', 'str'),
      column('rootSide', 'str'),
    ),
    { neuronId: [1], type: ['DNp01'], class: ['descending'], somaSide: ['L'], rootSide: ['R'] },
    'neurons',
  )

  function renderRow(compact = false, schema = table.schema, data = table) {
    render(
      <NeuronRow
        table={data}
        row={0}
        fields={rowFields(schema)}
        sourceId={undefined}
        datasetId={undefined}
        selected={false}
        onToggle={() => {}}
        compact={compact}
        mode="dark"
      />,
    )
    return Array.from(document.querySelectorAll('.explore-chip')) as HTMLElement[]
  }

  it('carries the palette slot into the markup, where CSS resolves it', () => {
    const slots = renderRow().map((chip) => chip.dataset.slot)
    expect(slots).toHaveLength(3)
    expect(slots.every((slot) => slot !== undefined)).toBe(true)
    // Distinct, or two chips in one row would be painted the same colour.
    expect(new Set(slots).size).toBe(3)
  })

  it('shows the same tags in a card as in the overlay', () => {
    // There was a cap here, and it cut the seventh chip — so on male-CNS `consensusNt` was in
    // the default list and invisible in the node card, which is where the list is read. A card
    // is smaller, not a different set of fields; chips wrap.
    const maleCns = makeTable(
      tableSchema(
        column('neuronId', 'i64'),
        column('type', 'str'),
        ...[
          'class',
          'subclass',
          'superclass',
          'somaSide',
          'rootSide',
          'itoleeHl',
          'consensusNt',
        ].map((n) => column(n, 'str')),
      ),
      {
        neuronId: [1],
        type: ['DNp01'],
        class: ['descending'],
        subclass: ['DN'],
        superclass: ['central'],
        somaSide: ['L'],
        rootSide: ['R'],
        itoleeHl: ['DL1'],
        consensusNt: ['acetylcholine'],
      },
      'neurons',
    )
    const titles = (compact: boolean) =>
      renderRow(compact, maleCns.schema, maleCns).map((chip) => chip.title)

    expect(titles(false)).toContain('consensusNt')
    cleanup()
    expect(titles(true)).toContain('consensusNt')
  })

  it('names the field in the title, since the colour cannot be read aloud', () => {
    expect(renderRow().map((chip) => chip.title)).toEqual(['class', 'somaSide', 'rootSide'])
  })

  it('spells out which side is which', () => {
    // Both values are a single letter. Without the key the row shows `L` and `R` with nothing
    // but a hue and a tooltip to say which is the soma and which the root.
    const chips = renderRow()
    expect(chips[1]!.textContent).toBe('somaL')
    expect(chips[2]!.textContent).toBe('rootR')
  })
})

/**
 * The `chips` param — which fields the list shows as tags.
 *
 * Driven through the widget rather than through `rowFields` alone, because the wiring is the
 * part that can break: the list has to arrive via `ctx.columns` (so it is filtered against the
 * schema in front of it) and it has to reach the row. The mock's schema has none of the fields
 * the automatic list looks for, which makes it the ideal witness — any chip in these rows got
 * there by being asked for.
 */
describe('the Fields list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function chipTexts() {
    return Array.from(rows()[0]!.querySelectorAll('.explore-chip')).map((c) => c.textContent)
  }

  it('shows no tags when the dataset has nothing the automatic list wants', async () => {
    setup()
    await ready()
    expect(chipTexts()).toEqual([])
  })

  /** Every annotation a row draws, chip or aligned cell, by the field it names. */
  function annotations(): string[] {
    const row = rows()[0]!
    return [...row.querySelectorAll('.explore-chip, .explore-cell')].map(
      (el) => (el.getAttribute('title') ?? '').split(':')[0]!,
    )
  }

  it('shows a field placed as a chip, even one the automatic list would never pick', async () => {
    setup({ layout: [encodeChip('status')] })
    await ready()
    expect(annotations()).toEqual(['status'])
  })

  it('ignores a placed field this dataset does not have', async () => {
    // The list outlives the dataset it was built on, and a stale name must not become an empty tag.
    setup({
      layout: [encodeChip('superclass'), encodeChip('status')],
    })
    await ready()
    expect(annotations()).toEqual(['status'])
  })

  it('lives in the inspector and not on the card, and stales nothing', () => {
    // `advanced` keeps it off the node body; `presentational` keeps it out of the provenance key,
    // because it cannot change what either port carries.
    const param = requireNodeDef('neuron.explore').params?.find((p) => p.id === 'layout')
    expect(param?.advanced).toBe(true)
    expect(param?.presentational).toBe(true)
  })

  it('replaced the Fields picker and its mode, rather than sitting beside them', () => {
    // Two controls over one row is how the chips and the header came to disagree.
    const ids = requireNodeDef('neuron.explore').params?.map((p) => p.id)
    expect(ids).not.toContain('chips')
    expect(ids).not.toContain('fieldsMode')
  })
})

describe('Explore in the editor', () => {
  it('renders its search box inside the node card', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadStarter({
        nodeType: 'dataset.mock.opticlobe',
        label: 'Demo Data',
      })
    })

    const box = await screen.findByLabelText('Search neurons')
    // Inside the card, not floating somewhere in the app shell.
    expect(box.closest('.coda-node')).not.toBeNull()
    await waitFor(() =>
      expect(document.querySelectorAll('.explore-row').length).toBeGreaterThan(0),
    )
  })

  it('widens the card rather than using the default node width', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadStarter({
        nodeType: 'dataset.mock.opticlobe',
        label: 'Demo Data',
      })
    })

    const box = await screen.findByLabelText('Search neurons')
    const card = box.closest('.coda-node') as HTMLElement
    // jsdom does no layout, so the declaration is the only checkable artefact — as with the
    // run ring. 232px would leave the list unusable before anyone opens it full size.
    expect(card.style.getPropertyValue('--node-width')).toBe('520px')
  })

  it('expands into the overlay showing the same widget, not a viewer of its output', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadStarter({
        nodeType: 'dataset.mock.opticlobe',
        label: 'Demo Data',
      })
    })
    await screen.findByLabelText('Search neurons')

    // Expand is offered before the node has ever run, which is most of the point.
    const expand = screen.getAllByLabelText('Expand output')[0]!
    fireEvent.click(expand)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Search neurons')).toBeTruthy()
    await waitFor(() =>
      expect(dialog.querySelectorAll('.explore-row').length).toBeGreaterThan(0),
    )
  })
})

/**
 * The population checkboxes, read off the dataset **type**.
 *
 * The card is the surface this matters most on and the one where it is easiest to get wrong. It
 * loads independently of any Run — that is its whole point — so the filters have to come from
 * the type; taken from the value they would be absent on a fresh session and present after a
 * Run, and the card would list 186,061 neurons before somebody pressed the button and a fraction
 * of that afterwards.
 *
 * The narrowing is applied to the *shared* index rather than to the fetch. Two Explore cards on
 * one dataset share a single cached table by design, so a card that filtered at the source would
 * hand its own narrowed copy to the other one.
 */
describe('the population checkboxes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function total(): number {
    const text = screen.getByText(/[\d,]+ neurons/).textContent ?? ''
    return Number(/([\d,]+) neurons/.exec(text)?.[1]?.replace(/,/g, ''))
  }

  async function countWith(population?: PopulationFilter[]): Promise<number> {
    setup({}, 'mock', undefined, undefined, population)
    await ready()
    const n = total()
    cleanup()
    return n
  }

  it('lists fewer neurons than the same dataset unfiltered', async () => {
    const whole = await countWith()
    const traced = await countWith(['traced'])
    expect(traced).toBeGreaterThan(0)
    expect(traced).toBeLessThan(whole)
  })

  /*
   * The counter-intuitive half, on the surface where somebody actually sees it: a second box
   * lets *more* rows through. If the card ever ANDed them this is the assertion that fails.
   */
  it('unions the filters rather than intersecting them', async () => {
    const whole = await countWith()
    const traced = await countWith(['traced'])
    const both = await countWith(['traced', 'typed'])

    expect(traced).toBeLessThan(whole)
    /*
     * Every neuron in the mock connectome carries a type, so `traced OR typed` is the whole
     * dataset — where `traced AND typed` would be the traced subset. That gap is the assertion:
     * an AND here would read `both === traced`, and the two numbers are far apart.
     */
    expect(both).toBe(whole)
  })

  it('shows only proofread rows under Traced only', async () => {
    setup({ layout: [encodeChip('status')] }, 'mock', undefined, undefined, ['traced'])
    await ready()
    expect(rows().length).toBeGreaterThan(0)
    for (const row of rows()) expect(row.textContent).not.toMatch(/Anchor|Assign/)
  })
})
