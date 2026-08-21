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

import { availableColumns, makeInferContext } from '../../core/node'
import type { ParamValue, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T } from '../../core/types'
import { MockSource } from '../../data/mock/MockSource'
import type { Value } from '../../core/values'
import { makeTable } from '../../core/values'
import { column, tableSchema } from '../../core/types'
import { MAX_SELECT_ALL } from '../../nodes/query/explore'
import { cacheGet, cacheSet, resetCache } from '../../data/cache'
import { getConnectome } from '../../data/mock/generate'
import { resetIndexLoads } from '../../data/neuronIndex'
import type { DataSource } from '../../data/source'
import { registerSource } from '../../data/source'
import '../../nodes'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { App } from '../../App'
import { useGraphStore } from '../../store/graphStore'
import { resetNeuronIndexState } from '../useNeuronIndex'
import { ExploreBody } from './ExploreBody'
import { NeuronThumbnail } from './NeuronThumbnail'
import { NeuronRow } from './NeuronRow'
import { rowFields } from './rowFields'
import { resetThumbnailCache } from './NeuronThumbnail'

const DATASET = 'hemibrain-mini'

/**
 * A source whose index is one neuron past the select-all ceiling.
 *
 * The mock connectomes are a few hundred neurons — the point of them — so the only way to see
 * what the widget does with a result too big to select is to hand it one.
 *
 * Built by delegation rather than by subclassing: `MockSource.id` is the literal `'mock'`, and
 * a source registered under that id would replace the real mock for every other test in the
 * file. Everything not named here still runs the mock's own implementation.
 */
function oversizedSource(): DataSource {
  const rows = MAX_SELECT_ALL + 1
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
) {
  const def = requireNodeDef('neuron.explore')
  const params: ParamValues = { ...defaults(def.params), ...initial }
  const writes: Array<[string, ParamValue]> = []
  /** Stands in for undo, a loaded file, or the inspector writing the param directly. */
  let external: (paramId: string, value: ParamValue) => void = () => {}

  function Harness() {
    const [current, setCurrent] = useState(params)
    external = (paramId, value) => setCurrent((held) => ({ ...held, [paramId]: value }))
    const ctx = makeInferContext(def, current, { dataset: T.dataset(sourceId, DATASET) })
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
        onError={() => {}}
      />
    )
  }

  render(<Harness />)
  return { writes, external: (id: string, value: ParamValue) => act(() => external(id, value)) }
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

    await type('KC')
    // Row count is the wrong measure — a full page stays a full page — so check the hit count
    // and that every row shown actually matches.
    await waitFor(() => {
      const hits = Number(
        /([\d,]+) of/.exec(screen.getByText(/of \d/).textContent ?? '')?.[1]?.replace(/,/g, ''),
      )
      expect(hits).toBeLessThan(total)
      expect(hits).toBeGreaterThan(0)
    })
    for (const row of rows()) {
      expect(row.textContent).toMatch(/KC/i)
    }
  })

  it('commits the query to the node, but only after the debounce', async () => {
    const { writes } = setup()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'KC' } })
    // A param write per keystroke would mark the node stale — and with it everything
    // downstream — on every letter.
    expect(writes.filter(([id]) => id === 'query')).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(writes.filter(([id]) => id === 'query')).toEqual([['query', 'KC']])
  })

  it('reports how many of the whole dataset matched', async () => {
    setup()
    await ready()
    await type('KC')
    await waitFor(() => expect(screen.getByText(/\d+ of \d+/)).toBeTruthy())
  })

  it('says so when it has fallen back to approximate matches', async () => {
    setup()
    await ready()
    // No substring hit, but a subsequence one — the widget must admit it widened the search
    // rather than silently reporting a hit count for a different question.
    await type('KCabc')
    await waitFor(() => expect(screen.queryByText(/showing similar/)).toBeTruthy())
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
    await type('KC')
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
    await type('KC')
    const hits = Number(
      /(\d+) of/.exec(screen.getByText(/of \d+ neurons|\d+ of \d+/).textContent ?? '')?.[1],
    )
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

  it('refuses to select all of a result too big to be a selection', async () => {
    // A selection is provenance: it lands in the saved file and in every downstream cache key,
    // so an unbounded one makes an unrelated edit stringify megabytes. Refused rather than
    // truncated — "+ all" that quietly took the first 10,000 would be a lie told by a button.
    const { writes } = setup({ pageSize: 5 }, 'mock-huge')
    await ready()
    const button = screen.getByText('+ all') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/Narrow the search/)

    fireEvent.click(button)
    expect(writes.filter(([id]) => id === 'selection')).toHaveLength(0)
  })

  it('offers select-all again once the search is under the ceiling', async () => {
    // Still rendered while refused, so the limit reads as a limit rather than as a feature
    // that is missing on big datasets.
    const { writes } = setup({ pageSize: 5 }, 'mock-huge')
    await ready()
    await type('neuronId==1000')

    const button = screen.getByText('+ all') as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect(writes.filter(([id]) => id === 'selection').at(-1)?.[1]).toEqual(['1000'])
  })

  it('keeps the selection when the search changes', async () => {
    // Selection is resolved against the whole index, not the current hits, so refining a
    // search must not silently drop neurons already chosen.
    const { writes } = setup()
    await ready()
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('checkbox'))
    await type('KC')

    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeTruthy())
    expect(writes.filter(([id]) => id === 'selection')).toHaveLength(1)
  })

  it('rasterises thumbnails above the size they are drawn at', async () => {
    // Supersampling: the backing store is 2x the CSS box, so the downscale antialiases and a
    // HiDPI screen is not upscaling a 76px tile. jsdom paints nothing — there is no 2D context
    // — but the two sizes are exactly the part that has to disagree, and by how much.
    setup({ pageSize: 5 })
    await ready()

    const canvas = await waitFor(() => {
      const found = document.querySelector('canvas.explore-thumb') as HTMLCanvasElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(canvas.width).toBe(2 * parseFloat(canvas.style.width))
    expect(canvas.height).toBe(2 * parseFloat(canvas.style.height))
  })

  it('adopts a query changed from outside, such as by undo', async () => {
    const { external } = setup()
    await ready()
    await type('KC')

    external('query', 'MBON')
    await waitFor(() => expect(searchBox().value).toBe('MBON'))
  })

  it('does not let its own committed write clobber newer typing', async () => {
    /*
     * The debounced write comes straight back as a changed `query` param. If that echo were
     * adopted, anything typed between the write and the re-render would be silently reverted —
     * the user watches letters disappear.
     */
    const { writes } = setup()
    await ready()
    await type('KC')
    expect(searchBox().value).toBe('KC')

    fireEvent.change(searchBox(), { target: { value: 'KCab' } })
    // The echo of the earlier commit arrives around here; the newer text must survive it.
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(searchBox().value).toBe('KCab')

    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(writes.filter(([id]) => id === 'query').at(-1)).toEqual(['query', 'KCab'])
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
    kind: 'annotations' as const,
    sources: ['seaTable:base=main&table=info'],
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
      dataset: { kind: 'dataset', sourceId: 'mock-bare', datasetId: DATASET, label: 'bare', annotations: CHAIN },
    })
    await waitFor(() => expect(screen.getByText(/2 neurons/)).toBeTruthy())
  })

  it('asks for a Run rather than reporting the source’s refusal as a fault', async () => {
    registerSource(annotatedSource('mock-bare2'))
    // What the card looks like before anything has run: the dataset value carries no chain yet.
    setup({}, 'mock-bare2')
    await waitFor(() => expect(screen.getByText(/Press Run/)).toBeTruthy())
    // The raw sentence would send somebody to look at the dataset, where the fix is a keypress.
    expect(screen.queryByText(/publishes no table listing/)).toBeNull()
  })
})

describe('thumbnail caching', () => {
  const BODY = getConnectome(DATASET)!.neurons[0]!.neuronId
  /** Displayed at 76, rasterised at 2x — the key carries the raster size. */
  const KEY = `thumb:mock:${DATASET}:${BODY}:152`

  function renderThumb(sourceId = 'mock') {
    render(<NeuronThumbnail sourceId={sourceId} datasetId={DATASET} neuronId={String(BODY)} size={76} />)
  }

  it('ignores an entry written by an older encoder, refusals included', async () => {
    // Exactly what the old code left in a real browser: an empty mask, no fingerprint, no
    // expiry. Read back verbatim it is indistinguishable from "this neuron has no thumbnail".
    await cacheSet(KEY, { size: 152, coverage: new Uint8Array(0) })

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
    expect(await cacheGet(`thumb:mock-refuses:${DATASET}:${BODY}:152`)).toBeUndefined()
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
describe('the Tags param', () => {
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

  it('shows a field chosen in the inspector, even one the automatic list would never pick', async () => {
    setup({ chips: ['status'] })
    await ready()
    expect(chipTexts()).toHaveLength(1)
    expect(rows()[0]!.querySelector('.explore-chip')?.getAttribute('title')).toBe('status')
  })

  it('ignores a chosen field this dataset does not have', async () => {
    // Through `ctx.columns`, which filters against the live schema — the param outlives the
    // dataset it was set on, and a stale name must not become an empty tag.
    setup({ chips: ['superclass', 'status'] })
    await ready()
    expect(chipTexts()).toHaveLength(1)
  })

  it('lives in the inspector and not on the card, and stales nothing', () => {
    // `advanced` keeps it off the node body — a multi-select above a list of neurons would
    // spend the widget's width on its own configuration. `presentational` keeps it out of the
    // provenance key, because it cannot change what either port carries.
    const param = requireNodeDef('neuron.explore').params?.find((p) => p.id === 'chips')
    expect(param?.advanced).toBe(true)
    expect(param?.presentational).toBe(true)
  })

  it('offers the dataset’s own columns as options, not a fixed list', async () => {
    // A Dataset socket carries a source id rather than a schema, so without the node's own
    // lookup the picker would come up empty and the control would look broken.
    const def = requireNodeDef('neuron.explore')
    const param = def.params?.find((p) => p.id === 'chips')
    expect(param?.kind).toBe('columns')
    expect(
      availableColumns(param as never, { dataset: T.dataset('mock', DATASET) }, {}),
    ).toContain('status')
  })
})

describe('Explore in the editor', () => {
  it('renders its search box inside the node card', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadStarter({
        nodeType: 'dataset.mock.hemibrain',
        label: 'Hemibrain (mini)',
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
        nodeType: 'dataset.mock.hemibrain',
        label: 'Hemibrain (mini)',
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
        nodeType: 'dataset.mock.hemibrain',
        label: 'Hemibrain (mini)',
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
