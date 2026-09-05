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
import { MAX_AUTO_MEMBERS, clearProfileCache } from './useNeuronProfile'

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
/** Counted so the deferral test can assert that nothing was asked for, not merely not shown. */
let fetches = 0

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
    fetchConnectivity: async (req) => {
      fetches += 1
      return hang ? await never() : req.direction === 'inputs' ? INPUTS : OUTPUTS
    },
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

/**
 * The element, apart from `render`, so a `rerender` can reuse the same defaults.
 *
 * Split out when a test needed to step the pager: spelling the twelve props out again at the
 * call site is how a rerender comes to run under different defaults from every other test here.
 */
function card(props: Partial<React.ComponentProps<typeof ProfileViewer>> = {}) {
  return (
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
    />
  )
}

function view(props: Partial<React.ComponentProps<typeof ProfileViewer>> = {}) {
  return render(card(props))
}

beforeAll(() => {
  installJsdomStubs({ width: 600, height: 600 })
  registerSource(stubSource())
})

beforeEach(() => {
  hang = false
  fetches = 0
  clearProfileCache()
  /*
   * The plain stub back, every test.
   *
   * `registerSource` replaces by id, and three tests below register an override whose
   * `fetchConnectivity` does not count — so without this, every test *after* one of those
   * silently ran against somebody else's stub. It cost an afternoon: the card rendered
   * perfectly and only the fetch counter was wrong, which reads as the cache working.
   */
  registerSource(stubSource())
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

  it('reports the confidence beside the call, which the card is where you read it', () => {
    // Lost once already: the tile moved onto the subject roll-up and quietly stopped showing a
    // row the ungrouped card had always had, with nothing in the docs to say it was a decision.
    const { container } = view({
      neurons: tableFromRows(
        tableSchema(
          column('neuronId', 'i64'),
          column('type', 'str'),
          column('predictedNt', 'str'),
          column('predictedNtProb', 'f64'),
        ),
        [{ neuronId: 1, type: 'CT1', predictedNt: 'gaba', predictedNtProb: 0.87 }],
        'neurons',
      ),
    })
    expect(container.textContent).toContain('confidence')
    expect(container.textContent).toContain('0.87')
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

describe('the annotation chain', () => {
  /** Annotations over the same table — only the provenance key is read here. */
  function chain(key: string) {
    return { key, table: INPUTS }
  }

  it('rides along to the source, so a partner’s type is the one the ports carry', async () => {
    const seen: unknown[] = []
    registerSource(
      stubSource({
        fetchConnectivity: async (req) => {
          seen.push(req.annotations)
          return req.direction === 'inputs' ? INPUTS : OUTPUTS
        },
      }),
    )
    const annotations = chain('flytable|main|info')
    view({ annotations })
    await waitFor(() => expect(screen.getByTitle(/Tm9 — 50 synapses/)).toBeTruthy())

    // Both directions, or half the card would name types from the datastack and half from the
    // chain — which is worse than either on its own.
    expect(seen).toEqual([annotations, annotations])
  })

  it('keys the cache by the chain, so two datasets do not share one answer', async () => {
    let calls = 0
    registerSource(
      stubSource({
        fetchConnectivity: async (req) => {
          calls += 1
          return req.direction === 'inputs' ? INPUTS : OUTPUTS
        },
      }),
    )

    const first = view({ annotations: chain('a') })
    await waitFor(() => expect(screen.getByTitle(/Tm9 — 50 synapses/)).toBeTruthy())
    const after = calls
    first.unmount()

    // Same source, same dataset, same neuron — a different chain. Without the chain in the key
    // this answers from the first one's cache and shows the wrong labels for the session.
    view({ annotations: chain('b') })
    await waitFor(() => expect(screen.getByTitle(/Tm9 — 50 synapses/)).toBeTruthy())
    expect(calls).toBeGreaterThan(after)
  })
})

// ---------------------------------------------------------------------------
// Cell-type profiles
// ---------------------------------------------------------------------------

/** Two LC4s and a Tm9, so a group of two sits beside a group of one. */
function grouped() {
  return tableFromRows(
    NEURONS,
    [
      {
        neuronId: 1,
        type: 'LC4',
        instance: 'LC4_L',
        status: 'Traced',
        class: 'optic',
        pre: 90,
        post: 40,
      },
      {
        neuronId: 2,
        type: 'LC4',
        instance: 'LC4_R',
        status: 'Traced',
        class: 'optic',
        pre: 10,
        post: 30,
      },
      {
        neuronId: 3,
        type: 'Tm9',
        instance: 'Tm9_R',
        status: 'Traced',
        class: 'optic',
        pre: 5,
        post: 7,
      },
    ],
    'neurons',
  )
}

describe('grouping', () => {
  it('pages groups rather than rows, and says how many neurons one holds', () => {
    const { container } = view({ neurons: grouped(), groupBy: 'type' })
    // Two subjects, not three rows.
    expect(within(pager(container)).getByText('1 / 2')).toBeTruthy()
    expect(within(pager(container)).getByText('LC4')).toBeTruthy()
    expect(within(pager(container)).getByText('2 neurons')).toBeTruthy()
  })

  it('pins every member, which is what lets the control stay presentational', async () => {
    // The group is resolved to ids here, so `selection` carries neurons either way and the
    // node's `evaluate` never learns that grouping exists.
    const onPin = vi.fn()
    const { container } = view({ neurons: grouped(), groupBy: 'type', onPin })
    within(pager(container)).getByText('Pin').click()
    expect(onPin).toHaveBeenCalledWith(['1', '2'])
  })

  it('reads a pin as a set, so a reloaded graph still shows it pinned', () => {
    // `selection` comes back off a stored graph in whatever order it was written. Comparing
    // sequences left Pin unlit, and a second press then cleared a pin that looked unset.
    const { container } = view({ neurons: grouped(), groupBy: 'type', pinned: ['2', '1'] })
    expect(within(pager(container)).getByText('Pinned')).toBeTruthy()
  })

  it('keeps the spread out of the list rows, where it starves the bar', async () => {
    /*
     * The value column of a bar row is one `auto` grid track sharing a row with the bar. Printing
     * `4.2±5.3` there — and `39% · 1.5±2` beside it — took roughly half the width of the track on
     * a tile column, so the one thing the list is for, comparing lengths, got worse the moment
     * you grouped. The figures live in the tooltip and the whisker now.
     */
    const { container } = view({ neurons: grouped(), groupBy: 'type' })
    await waitFor(() => expect(container.textContent).toContain('26.5 ± 37.5'))

    const bars = container.querySelectorAll('.tile__bar-value')
    expect(bars.length).toBeGreaterThan(0)
    for (const value of bars) expect(value.textContent).not.toContain('±')

    // The spread is drawn instead — one whisker per bar whose subject has more than one member.
    expect(container.querySelectorAll('.tile__bar-spread').length).toBeGreaterThan(0)
  })

  it('draws no whisker for a subject of one, which has no spread', async () => {
    const { container } = view({ neurons: grouped(), groupBy: 'type', page: 1 })
    await waitFor(() => expect(container.textContent).toContain('Top input types'))
    expect(container.querySelectorAll('.tile__bar-spread')).toHaveLength(0)
  })

  it('reports a mean and a spread, over every member and not only the ones that connect', async () => {
    // Only neuron 1 has rows in the fixture: 53 input synapses against neuron 2's nothing.
    // A mean over the members that connect would say 53; the mean over the type is 26.5, and
    // the spread is what says the two cells are nothing like each other.
    const { container } = view({ neurons: grouped(), groupBy: 'type' })
    await waitFor(() => expect(container.textContent).toContain('26.5 ± 37.5'))
    expect(container.textContent).toContain('Mean ± sd across 2 neurons')
  })

  it('prints no spread for a group of one, because one measurement has none', async () => {
    const { container } = view({ neurons: grouped(), groupBy: 'type', page: 1 })
    await waitFor(() => expect(within(pager(container)).getByText('Tm9')).toBeTruthy())
    expect(container.textContent).not.toContain('±')
  })

  it('counts the answers where the group disagrees rather than showing one member’s', () => {
    // `instance` differs per neuron by construction. Naming the type after whichever member
    // sorted first is the quiet lie this exists to avoid.
    const { container } = view({ neurons: grouped(), groupBy: 'type' })
    expect(container.textContent).toContain('2 values')
    // A field they agree on is still just the value.
    expect(container.textContent).toContain('Traced')
  })

  it('leaves a disagreement out of the chips, where there is no room to explain it', () => {
    const { container } = view({ neurons: grouped(), groupBy: 'type', chips: ['class'] })
    const chips = container.querySelectorAll('.explore-chip')
    // `class` agrees across both, so it draws; nothing draws "2 values" as a chip.
    expect([...chips].map((c) => c.textContent)).toContain('optic')
    expect([...chips].some((c) => c.textContent?.includes('values'))).toBe(false)
  })

  it('falls back to one neuron at a time when the column is not in the schema', () => {
    // A picker pointed at a column a Select removed must not empty the card.
    const { container } = view({ neurons: grouped(), groupBy: 'hemilineage' })
    expect(within(pager(container)).getByText('1 / 3')).toBeTruthy()
    // And it must not *label* those rows as groups either. `profileSubjects` decides the
    // fallback, so the viewer reads its answer rather than re-deriving one from the param —
    // otherwise a single neuron is drawn with a member count and a "mean ± sd across 1 neuron".
    expect(container.textContent).not.toContain('1 neuron')
    expect(container.textContent).not.toContain('Mean ± sd')
  })
})

describe('a subject too large to fetch on a page turn', () => {
  /** One type, one neuron past the ceiling — read from the constant so a change to it lands here. */
  const OVER = MAX_AUTO_MEMBERS + 1

  function big() {
    return tableFromRows(
      NEURONS,
      Array.from({ length: OVER }, (_, i) => ({
        neuronId: i + 1,
        type: 'LC4',
        instance: `LC4_${i}`,
        status: 'Traced',
        class: 'optic',
        pre: 1,
        post: 1,
      })),
      'neurons',
    )
  }

  it('asks before fetching, and asks nothing of the backend until it is answered', async () => {
    const { container } = view({ neurons: big(), groupBy: 'type' })
    await waitFor(() => expect(container.textContent).toContain(`LC4 has ${OVER} neurons`))
    // Not merely hidden: the point of the deferral is that no query was issued.
    expect(fetches).toBe(0)
  })

  it('fetches once asked, which is what makes it a deferral rather than a refusal', async () => {
    const { container } = view({ neurons: big(), groupBy: 'type' })
    await waitFor(() => screen.getByText('Load anyway'))
    screen.getByText('Load anyway').click()
    await waitFor(() => expect(fetches).toBeGreaterThan(0))
    expect(container.textContent).not.toContain('Load anyway')
  })

  it('does not re-ask for a subject already in hand', async () => {
    // The gate is about work a browsing gesture would incur, and a cache hit incurs none. Paging
    // away from an approved type and back used to re-show the banner, because the approval is
    // this component's state and the answer is the module's cache.
    const first = view({ neurons: big(), groupBy: 'type' })
    await waitFor(() => screen.getByText('Load anyway'))
    screen.getByText('Load anyway').click()
    await waitFor(() => expect(fetches).toBeGreaterThan(0))
    first.unmount()

    const { container } = view({ neurons: big(), groupBy: 'type' })
    await waitFor(() => expect(container.textContent).toContain('Connectivity'))
    expect(screen.queryByText('Load anyway')).toBeNull()
  })

  it('approves one subject at a time, not the pager', async () => {
    // Approving LC4 must not approve whatever the next › lands on — each is its own decision —
    // and it must not un-approve LC4 either, which one stored key would.
    const two = tableFromRows(
      NEURONS,
      Array.from({ length: OVER * 2 }, (_, i) => ({
        neuronId: i + 1,
        type: i < OVER ? 'LC4' : 'LPLC2',
        instance: `n${i}`,
        status: 'Traced',
        class: 'optic',
        pre: 1,
        post: 1,
      })),
      'neurons',
    )
    const { rerender } = render(card({ neurons: two, groupBy: 'type' }))
    await waitFor(() => screen.getByText('Load anyway'))
    screen.getByText('Load anyway').click()
    await waitFor(() => expect(fetches).toBeGreaterThan(0))

    // The second group is a decision of its own, so the banner is back.
    rerender(card({ neurons: two, groupBy: 'type', page: 1 }))
    await waitFor(() => expect(screen.getByText('Load anyway')).toBeTruthy())
    // And returning to the first does not ask again.
    rerender(card({ neurons: two, groupBy: 'type', page: 0 }))
    await waitFor(() => expect(screen.queryByText('Load anyway')).toBeNull())
  })

  it('leaves a subject under the ceiling alone', async () => {
    view({ neurons: grouped(), groupBy: 'type' })
    await waitFor(() => expect(fetches).toBeGreaterThan(0))
    expect(screen.queryByText('Load anyway')).toBeNull()
  })
})
