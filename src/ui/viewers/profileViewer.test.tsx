// @vitest-environment jsdom

/**
 * The Profile widget.
 *
 * What is worth asserting here is everything the headless suite cannot see: that a tile with
 * nothing to say is *absent* rather than full of dashes, that the pager clamps instead of
 * showing an empty card, that the threshold reaches the headings, and that the card and the
 * overlay differ only where they are meant to. The bars themselves are geometry over numbers
 * `profileStats.test.ts` already pins.
 *
 * The source is stubbed rather than mocked through MockSource so a test can decide what each
 * fetch returns — including making one hang, which is the only way to see the loading state.
 */

import { readFileSync } from 'node:fs'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { CellValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { DataSource, DatasetInfo } from '../../data/source'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ProfileViewer } from './ProfileViewer'
import { clearProfileCache } from './useNeuronProfile'

const NEURONS = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('instance', 'str'),
  column('status', 'str'),
  column('class', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

const CONNECTIVITY = tableSchema(
  column('neuronId', 'i64'),
  column('neuronType', 'str'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

const ROI_COUNTS = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('roi', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

function neurons(extra: Array<Record<string, CellValue>> = []) {
  return tableFromRows(
    NEURONS,
    [
      {
        neuronId: 1,
        type: 'CT1',
        instance: 'CT1_L',
        status: 'Traced',
        class: 'optic',
        pre: 90,
        post: 40,
      },
      {
        neuronId: 2,
        type: 'Tm9',
        instance: 'Tm9_R',
        status: 'Traced',
        class: 'optic',
        pre: 10,
        post: 30,
      },
      {
        neuronId: 3,
        type: 'T4a',
        instance: 'T4a_R',
        status: 'Traced',
        class: 'optic',
        pre: 5,
        post: 7,
      },
      ...extra,
    ],
    'neurons',
  )
}

const INPUTS = tableFromRows(CONNECTIVITY, [
  { neuronId: 1, neuronType: 'CT1', partnerId: 10, partnerType: 'Tm9', weight: 30 },
  { neuronId: 1, neuronType: 'CT1', partnerId: 11, partnerType: 'Tm9', weight: 20 },
  { neuronId: 1, neuronType: 'CT1', partnerId: 12, partnerType: 'Tm1', weight: 3 },
])

const OUTPUTS = tableFromRows(CONNECTIVITY, [
  { neuronId: 1, neuronType: 'CT1', partnerId: 20, partnerType: 'T5a', weight: 70 },
])

const REGIONS = tableFromRows(ROI_COUNTS, [
  { neuronId: 1, type: 'CT1', roi: 'LO(R)', pre: 60, post: 30 },
  { neuronId: 1, type: 'CT1', roi: 'ME(L)', pre: 20, post: 10 },
  // The parent of LO(R). Present in roiInfo and absent from primaryRois, so it must not be
  // summed — this is the row that makes the double-counting visible if the filter is dropped.
  { neuronId: 1, type: 'CT1', roi: 'OL(R)', pre: 60, post: 30 },
])

const DATASET: DatasetInfo = {
  id: 'test:v1',
  label: 'test',
  rois: ['LO(R)', 'ME(L)', 'OL(R)'],
  primaryRois: ['LO(R)', 'ME(L)'],
  statuses: ['Traced'],
}

let hang = false

function stubSource(overrides: Partial<DataSource> = {}): DataSource {
  const never = () => new Promise<never>(() => {})
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: {
      rawQuery: false,
      skeletons: false,
      meshes: false,
      synapses: false,
      neuronIndex: false,
      viewerScene: false,
    },
    schemas: {
      neurons: NEURONS,
      connectivity: CONNECTIVITY,
      roiCounts: ROI_COUNTS,
      morphology: NEURONS,
      synapses: CONNECTIVITY,
    },
    listDatasets: async () => [DATASET],
    peekDatasets: () => [DATASET],
    peekDataset: () => DATASET,
    findNeurons: async () => neurons(),
    fetchConnectivity: async (req) =>
      hang ? await never() : req.direction === 'inputs' ? INPUTS : OUTPUTS,
    fetchAdjacency: async () => {
      throw new Error('not used')
    },
    fetchRoiCounts: async () => (hang ? await never() : REGIONS),
    ...overrides,
  } as DataSource
}

/** The pager row, for queries that must not also match the all-attributes list. */
function pager(container: HTMLElement): HTMLElement {
  const found = container.querySelector('.profile__pager')
  if (!found) throw new Error('no pager rendered')
  return found as HTMLElement
}

function view(props: Partial<React.ComponentProps<typeof ProfileViewer>> = {}) {
  return render(
    <ProfileViewer
      neurons={neurons()}
      sourceId="stub"
      datasetId="test:v1"
      page={0}
      onPage={() => {}}
      pinned={[]}
      onPin={() => {}}
      minWeight={1}
      topN={10}
      compact
      {...props}
    />,
  )
}

beforeAll(() => {
  installJsdomStubs({ width: 600, height: 600 })
  registerSource(stubSource())
})

beforeEach(() => {
  hang = false
  clearProfileCache()
})

afterEach(cleanup)

describe('empty states', () => {
  it('asks for a table rather than rendering an empty dashboard', () => {
    view({ neurons: undefined })
    expect(screen.getByText(/Connect a table of neurons/)).toBeTruthy()
  })

  it('says the table is empty rather than showing neuron 1 of 0', () => {
    view({ neurons: tableFromRows(NEURONS, []) })
    expect(screen.getByText(/No neurons in the incoming table/)).toBeTruthy()
  })
})

describe('the pager', () => {
  it('shows the position and the neuron it is on', () => {
    const { container } = view()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    // Scoped to the pager: the type also appears in the identity tile and again in the
    // all-attributes list, which is correct and makes a bare getByText ambiguous.
    expect(within(pager(container)).getByText('CT1')).toBeTruthy()
  })

  it('clamps a page past the end instead of showing nothing', () => {
    // An upstream search that shrinks the table would otherwise leave the node parked on a
    // row that no longer exists, showing an empty profile with nothing to blame.
    const { container } = view({ page: 99 })
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(within(pager(container)).getByText('T4a')).toBeTruthy()
  })

  it('clamps a negative page too', () => {
    view({ page: -5 })
    expect(screen.getByText('1 / 3')).toBeTruthy()
  })

  it('disables the ends rather than wrapping', () => {
    view({ page: 0 })
    expect(screen.getByLabelText('Previous neuron').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Next neuron').hasAttribute('disabled')).toBe(false)
  })

  it('writes the page through onPage, and nothing else', () => {
    const onPage = vi.fn()
    const onPin = vi.fn()
    view({ page: 1, onPage, onPin })
    screen.getByLabelText('Next neuron').click()
    expect(onPage).toHaveBeenCalledWith(2)
    // Paging must not touch the pin: that is the whole browse-free/pin-to-commit split.
    expect(onPin).not.toHaveBeenCalled()
  })
})

describe('pinning', () => {
  it('pins the shown neuron, replacing whatever was pinned', () => {
    const onPin = vi.fn()
    view({ page: 1, pinned: ['1'], onPin })
    screen.getByRole('button', { name: /Pin/ }).click()
    // Replaces rather than accumulates: Current is singular by intent, and a pin that built
    // up a list would make the port's meaning drift as you browsed.
    expect(onPin).toHaveBeenCalledWith(['2'])
  })

  it('unpins when the shown neuron is the pinned one', () => {
    const onPin = vi.fn()
    view({ page: 0, pinned: ['1'], onPin })
    screen.getByRole('button', { name: /Pinned/ }).click()
    expect(onPin).toHaveBeenCalledWith([])
  })

  it('marks the pinned state on the control, not only in its label', () => {
    view({ page: 0, pinned: ['1'] })
    expect(screen.getByRole('button', { name: /Pinned/ }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })
})

describe('tiles', () => {
  it('rolls partners up by type, with the share', async () => {
    view()
    await waitFor(() => expect(screen.getByTitle(/Tm9 — 50 synapses/)).toBeTruthy())
    expect(screen.getByTitle(/across 2 partners/)).toBeTruthy()
  })

  it('leaves the transmitter tile out where the dataset publishes none', () => {
    // hemibrain has no transmitter columns at all. A tile of dashes says less than no tile.
    view()
    expect(screen.queryByText('Transmitter')).toBeNull()
  })

  it('shows the transmitter tile where the columns exist', () => {
    const schema = tableSchema(
      column('neuronId', 'i64'),
      column('type', 'str'),
      column('consensusNt', 'str'),
      column('ntGabaProb', 'f64'),
    )
    view({
      neurons: tableFromRows(schema, [
        { neuronId: 1, type: 'CT1', consensusNt: 'gaba', ntGabaProb: 0.66 },
      ]),
    })
    const tile = screen.getByText('Transmitter').closest('.tile')
    expect(tile).toBeTruthy()
    expect(within(tile as HTMLElement).getByText('gaba')).toBeTruthy()
  })

  it('filters regions to the primary list, so the totals do not double-count', async () => {
    view()
    await waitFor(() => expect(screen.getByTitle(/LO\(R\)/)).toBeTruthy())
    // OL(R) is the parent of LO(R): present in roiInfo, absent from primaryRois. Summing both
    // reports twice the synapses the neuron has.
    expect(screen.queryByTitle(/OL\(R\)/)).toBeNull()
  })

  it('says so when the primary region list has not arrived', async () => {
    registerSource(stubSource({ peekDataset: () => ({ ...DATASET, primaryRois: undefined }) }))
    view()
    await waitFor(() => expect(screen.getByText(/may double-count/)).toBeTruthy())
    registerSource(stubSource())
  })

  it('lists every attribute the schema carries, so nothing is silently invisible', () => {
    view()
    expect(screen.getByText(/All 7 attributes/)).toBeTruthy()
  })
})

describe('the threshold', () => {
  it('is silent at 1 and named on every heading above it', async () => {
    const { unmount } = view({ minWeight: 1 })
    await waitFor(() => expect(screen.getByText('Connectivity')).toBeTruthy())
    expect(screen.queryByText(/\+ syn/)).toBeNull()
    unmount()

    view({ minWeight: 5 })
    // A count that differs from what the Connectivity node reports has to say why.
    await waitFor(() => expect(screen.getAllByText('5+ syn').length).toBeGreaterThan(0))
  })

  it('drops weak partners from the roll-up without refetching', async () => {
    view({ minWeight: 5 })
    await waitFor(() => expect(screen.getByTitle(/Tm9 — 50 synapses/)).toBeTruthy())
    // Tm1's only connection is weight 3.
    expect(screen.queryByTitle(/^Tm1/)).toBeNull()
  })
})

describe('card versus overlay', () => {
  it('draws the silhouette on the card and offers a way to the real thing', () => {
    view({ compact: true, onExpand: () => {} })
    expect(screen.getByText('Shape')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open 3D/ })).toBeTruthy()
  })

  it('shows partner lists only in the overlay, where there is room', async () => {
    const { unmount } = view({ compact: true })
    expect(screen.queryByText('Top input partners')).toBeNull()
    unmount()

    view({ compact: false })
    await waitFor(() => expect(screen.getByText('Top input partners')).toBeTruthy())
  })
})

describe('the 3D tile', () => {
  it('is 2x2 in the overlay, where it holds a live frame', () => {
    const { container } = view({ compact: false })
    const tile = screen.getByText('3D').closest('.tile')
    expect(tile?.getAttribute('data-span')).toBe('2')
    // Nothing else claims the extra tracks: a grid of 2x2 tiles is not a grid.
    expect(container.querySelectorAll('[data-span="2"]').length).toBe(1)
  })

  it('is an ordinary tile on the card, where it holds a 104px image', () => {
    // Spanning 2x2 for a silhouette would be a tile of whitespace around a thumbnail.
    view({ compact: true })
    expect(screen.getByText('Shape').closest('.tile')?.hasAttribute('data-span')).toBe(false)
  })
})

/**
 * jsdom performs no layout, so the tile's actual box cannot be measured. What can be checked
 * is the declaration that decides it — and the height half of this is easy to lose, because
 * the span alone widens the tile without making it any taller and looks like it worked.
 */
describe('the 3D tile rule', () => {
  function spanRule(): string {
    // Read from source rather than a stylesheet object: vitest never applies the CSS. Path is
    // relative to the repo root, which is vitest's working directory.
    const css = readFileSync('src/ui/editor.css', 'utf8')
    const start = css.indexOf(".tile[data-span='2'] {")
    expect(start).toBeGreaterThan(-1)
    // Through the end of the following rule, which carries the height half.
    const end = css.indexOf('}', css.indexOf('> .viewer', start))
    return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('spans two tracks in both directions', () => {
    const rule = spanRule()
    expect(rule).toMatch(/grid-column:\s*span 2/)
    expect(rule).toMatch(/grid-row:\s*span 2/)
  })

  it('sets a height floor, because auto-sized rows would resolve to one card tall', () => {
    // Rows here are auto-sized from their content. Spanning two of them next to tiles that
    // are five lines of text tall gives about the height of one card — so without a floor the
    // tile gets wider and no taller, which is the exact complaint the span was meant to fix.
    expect(spanRule()).toMatch(/min-height:\s*4\d\dpx/)
  })
})

describe('loading', () => {
  it('keeps every tile heading while the fetches are in flight', async () => {
    hang = true
    view()
    // The grid must not reflow as three requests land — a layout that reshuffles on every
    // page turn is far more distracting than a moment of "Loading…".
    expect(screen.getByText('Connectivity')).toBeTruthy()
    expect(screen.getByText('Top input types')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0))
  })
})
