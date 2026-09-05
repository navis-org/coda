// @vitest-environment jsdom

/**
 * The Neuron Topology widget.
 *
 * What is worth asserting here is what the headless suite cannot see: that the measurements the
 * card prints are the ones `topologyOps` computed off the fetched skeleton, that the pager clamps
 * rather than showing an empty card, and — the one that would otherwise ship broken and silent —
 * that **the split does not run until something on screen needs it**. That gate is the difference
 * between a card that draws instantly and one that downloads ten megabytes to show a cable length.
 *
 * WebGL is deliberately absent under jsdom, so the 3D stage is stubbed below and everything
 * asserted here is the rail — which is the half that has any layout to get wrong.
 *
 * The source is stubbed rather than driven through MockSource so a test can decide what each
 * fetch returns — `profileViewer.test.tsx`'s call, for its reason.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { MeshesValue, PointsValue, SkeletonsValue, TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import type { DataSource } from '../../data/source'
import type { PartnerGrouping } from '../../nodes/lib/profileStats'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { currentMode, sequentialColor } from '../colors'

/** Relative luminance of a `#rrggbb`, for asserting that a ramp actually runs somewhere. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const to = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * to((n >> 16) & 255) + 0.7152 * to((n >> 8) & 255) + 0.0722 * to(n & 255)
}
import { TopologyViewer } from './TopologyViewer'

/*
 * The 3D stage is stubbed. jsdom has no WebGL, so mounting it constructs a `THREE.WebGLRenderer`
 * that throws asynchronously — an unhandled rejection that vitest reports against whichever test
 * happened to be running, which is worse than useless. `liveRenderers.test.tsx` covers the fact
 * that a viewer mounts at all; this file is about the rail, which is the half with layout to get
 * wrong.
 */
import { clearTopologyCache } from './useNeuronTopology'
import { clearSynapseLinksCache } from './useSynapseLinks'

let sceneProps: Record<string, unknown> | undefined
vi.mock('./LazyViewers', () => ({
  LazyViewer3D: (props: Record<string, unknown>) => {
    sceneProps = props
    return <div data-testid="stage" />
  },
  LazyNetworkViewer: () => null,
}))

const NEURONS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
const CONNECTIVITY = tableSchema(
  column('neuronId', 'i64'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

/** Four nodes in a line then a fork — 4 edges of 1 µm each, one branch point, two ends. */
function skeleton(): SkeletonsValue {
  const parents = new Int32Array([-1, 0, 1, 2, 2])
  const positions = new Float32Array([
    0, 0, 0, 1000, 0, 0, 2000, 0, 0, 3000, 0, 0, 2000, 1000, 0,
  ])
  return {
    kind: 'skeletons',
    items: [{ id: '1001', positions, radii: new Float32Array(5), parents }],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1001'] }),
    bounds: { min: [0, 0, 0], max: [3000, 1000, 0] },
    units: 'nm',
  }
}

/**
 * Synapses as a source on the **canonical** schema returns them — partner columns included.
 *
 * The first version of this fixture carried only `neuronId` and `polarity`, which is neuPrint's
 * narrowed schema rather than the canonical one. Every assertion about highlighting then passed
 * without exercising it: the swatch colour comes from the selection list and does not need the
 * data, so the test agreed with itself while the scene was still colouring by polarity.
 */
function synapses(): PointsValue {
  const attributes = tableFromRows(
    tableSchema(
      column('neuronId', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('polarity', 'str'),
    ),
    [
      { neuronId: '1001', partnerId: '3001', partnerType: 'Tm3', polarity: 'post' },
      { neuronId: '1001', partnerId: '2001', partnerType: 'DNp02', polarity: 'pre' },
    ],
  )
  return {
    kind: 'points',
    positions: new Float32Array([0, 0, 0, 3000, 0, 0]),
    attributes,
    bounds: { min: [0, 0, 0], max: [3000, 0, 0] },
    units: 'nm',
  }
}

/**
 * A connectivity table big enough for the list to have to *choose* what it draws.
 *
 * Sixty-two output partners against a fifty-row cap, with `RARE` deliberately last and weakest.
 * That neuron is the whole point of the filter: before it existed a partner outside the top rows
 * could not be reached at all, however well you knew its name.
 */
function connectivity(direction: string) {
  if (direction === 'inputs') {
    return tableFromRows(CONNECTIVITY, [
      { neuronId: 1001, partnerId: 3001, partnerType: 'Tm3', weight: 42 },
      { neuronId: 1001, partnerId: 3002, partnerType: 'Tm9', weight: 7 },
    ])
  }
  const rows = [{ neuronId: 1001, partnerId: 2001, partnerType: 'DNp02', weight: 500 }]
  for (let i = 1; i <= 60; i++) {
    rows.push({
      neuronId: 1001,
      partnerId: 2100 + i,
      partnerType: `OUT${String(i).padStart(3, '0')}`,
      weight: 100 - i,
    })
  }
  rows.push({ neuronId: 1001, partnerId: 2999, partnerType: 'RARE001', weight: 1 })
  return tableFromRows(CONNECTIVITY, rows)
}

const fetchSkeletons = vi.fn()
const fetchSynapses = vi.fn()

/**
 * Register a source for one describe block, and reset the two shared fetch mocks.
 *
 * Parameterised rather than copied. Four blocks wanted the same eight-key shape with a different
 * id, a different synapse cloud and a different connectivity table — CAVE's id-only cloud, the
 * grouping fixture's typed one — and written out each time a new required field on `DataSource`
 * is four edits, with four independently drifting casts.
 */
function install(over: Partial<InstallOptions> = {}): void {
  const { id = 'topo-test', points, links, units = 'sites' } = over
  fetchSkeletons.mockReset().mockResolvedValue(skeleton())
  fetchSynapses.mockReset().mockResolvedValue(points ?? synapses())
  const source: Partial<DataSource> = {
    id,
    label: 'Topology test',
    capabilities: { skeletons: true, synapses: true } as never,
    synapseUnits: [units] as never,
    fetchSkeletons: fetchSkeletons as never,
    fetchSynapses: fetchSynapses as never,
    fetchConnectivity: (async (req: { direction?: string }) =>
      links ?? connectivity(req.direction ?? 'outputs')) as never,
    peekDataset: (() => undefined) as never,
  }
  registerSource(source as DataSource)
}

interface InstallOptions {
  id: string
  /** The synapse cloud, when the block is about a schema `synapses()` does not have. */
  points: PointsValue
  /** One connectivity table for both directions, where the block does not care which. */
  links: TableValue
  units: 'sites' | 'links'
}

const PROPS = {
  neurons: tableFromRows(NEURONS, [
    { neuronId: 1001, type: 'LC4' },
    { neuronId: 1002, type: 'LC4' },
  ]),
  sourceId: 'topo-test',
  datasetId: 'test:v1',
  page: 0,
  onPage: vi.fn(),
  pinned: [] as string[],
  onPin: vi.fn(),
  colorBy: 'flat',
  onColorBy: vi.fn(),
  showMesh: true,
  showSkeleton: true,
  showSynapses: true,
  onLayer: vi.fn(),
  partners: [] as string[],
  onPartners: vi.fn(),
  grouping: 'type' as PartnerGrouping,
  onGrouping: vi.fn(),
  direction: 'outputs',
  onDirection: vi.fn(),
  partnerQuery: '',
  onPartnerQuery: vi.fn(),
  tab: 'morphology',
  onTab: vi.fn(),
  railOpen: true,
  onRailOpen: vi.fn(),
  split: false,
  onSplit: vi.fn(),
  flowThresh: 0.9,
  splitVal: 1,
  onSplitParam: vi.fn(),
  pointSize: 6,
  skeletonWidth: 2,
  skeletonOpacity: 1,
  dimOpacity: 0.2,
  meshOpacity: 0.15,
  skeletonColor: '#000000',
  onSkeletonColor: vi.fn(),
  onVisual: vi.fn(),
}

beforeEach(() => {
  // Reset, or `waitFor(() => sceneProps?.points)` is satisfied instantly by the *previous*
  // test's render and the assertion that follows reads props from a component that is gone.
  sceneProps = undefined
  installJsdomStubs()
  clearTopologyCache()
  install()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('TopologyViewer', () => {
  it('measures the fetched skeleton and prints it in micrometres', async () => {
    render(<TopologyViewer {...PROPS} />)
    // Four 1 µm edges. Printed as cable, not as the nanometres the wire carries.
    await waitFor(() => expect(screen.getByText('4 µm')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Branch points')).toBeTruthy()
    // One fork, two tips.
    const nodes = screen.getByText('Nodes').nextElementSibling
    expect(nodes?.textContent).toBe('5')
  })

  it('does not fetch until the page has settled, then fetches once', async () => {
    render(<TopologyViewer {...PROPS} />)
    expect(fetchSkeletons).not.toHaveBeenCalled()
    await waitFor(() => expect(fetchSkeletons).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })

  it('clamps a page past the end rather than drawing an empty card', async () => {
    // A search upstream that shrinks the table parks the node on a row that no longer exists.
    render(<TopologyViewer {...PROPS} page={99} />)
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  it('lists partners in the chosen direction', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
  })

  it('leaves the split alone until something on screen needs it', async () => {
    /*
     * The gate that matters. `useCompartments` dynamically imports the Pyodide bridge, which is
     * where the ~10 MB download lives — so a card showing cable length must never reach it. jsdom
     * has no Worker, so if this regressed the import itself would throw and the assertion below
     * would see an error state rather than a quiet idle one.
     */
    render(<TopologyViewer {...PROPS} tab="morphology" colorBy="flat" />)
    await waitFor(() => expect(fetchSkeletons).toHaveBeenCalled(), { timeout: 3000 })
    expect(screen.queryByText('Splitting…')).toBeNull()
    expect(screen.queryByText('splitting…')).toBeNull()
  })

  it('says the split is for this neuron only until it is put in the port', async () => {
    // The Order/Colour line, said in words: what the card shows is free, what the port carries
    // is data. A reader who cannot tell those apart trusts the wrong one.
    render(<TopologyViewer {...PROPS} tab="compartments" />)
    await waitFor(
      () => expect(screen.getByText(/Add compartment columns to Morphometrics/)).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('folds the rail away entirely rather than hiding it', () => {
    /*
     * Unmounted, not `visibility: hidden` — the rule `AddMenu` records. jsdom computes no styles,
     * so a hidden-but-present rail would pass a query-based test while shipping a tab order full
     * of controls nobody can see.
     */
    const { container } = render(<TopologyViewer {...PROPS} railOpen={false} />)
    expect(container.querySelector('.topo__rail')).toBeNull()
    expect(container.querySelector('.topo')?.getAttribute('data-rail')).toBe('closed')
  })
})

describe('partner highlighting', () => {
  /**
   * The rule that makes the feature legible: the swatch in the list and the dot on the arbour are
   * the same colour, from one map. Two independently-ranked palettes would put a partner's bar in
   * one colour and its synapses in another, which is worse than no highlight at all — the reader
   * would trust it.
   */
  it('pins the lit partner to one colour that the list and the scene share', async () => {
    const { container } = render(
      <TopologyViewer {...PROPS} tab="partners" partners={['DNp02']} />,
    )
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
    const row = container.querySelector('.topo__partner[data-on]')
    expect(row).toBeTruthy()
    const swatch = row?.querySelector('i') as HTMLElement | null
    const bar = row?.querySelector('.topo__partner-track > span') as HTMLElement | null
    // Same colour, and not the muted fallback an unlit row gets.
    expect(swatch?.style.background).toBeTruthy()
    expect(bar?.style.background).toBe(swatch?.style.background)
    expect(swatch?.style.background).not.toBe('var(--text-muted)')
  })

  it('says so when the dataset cannot name a synapse’s partner', async () => {
    /*
     * A cloud with **neither** partner column, which is CATMAID's shape: its synapse schema
     * declines `partnerId` on purpose, because naming the far end of a connector costs a second
     * POST per connector set. There is nothing to join, so the refusal is real and a list that
     * looked clickable and silently did nothing is what this sentence replaces.
     *
     * Not neuPrint, which this comment used to name: neuPrint drops both columns too, but has
     * `fetchSynapseLinks` to answer with instead, so it takes the other branch.
     */
    fetchSynapses.mockResolvedValue({
      kind: 'points',
      positions: new Float32Array([0, 0, 0]),
      attributes: tableFromRows(
        tableSchema(column('neuronId', 'str'), column('polarity', 'str')),
        [{ neuronId: '1001', polarity: 'pre' }],
      ),
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      units: 'nm',
    })
    /*
     * Its own `datasetId`, which is not cosmetic. `useNeuronTopology`'s cache is keyed on the
     * dataset and the neuron, and a fetch already in flight when the previous test ended resolves
     * *after* `clearTopologyCache()` has run — repopulating the cache under the shared key, so
     * the next test reads this partner-less cloud instead of its own. A distinct key is the only
     * thing that makes these two independent.
     */
    render(<TopologyViewer {...PROPS} tab="partners" datasetId="test:no-partners" />)
    await waitFor(
      () => expect(screen.getByText(/carry no partner on the far side/)).toBeTruthy(),
      {
        timeout: 3000,
      },
    )
  })

  it('offers the size controls without re-running anything', async () => {
    render(<TopologyViewer {...PROPS} tab="visuals" />)
    expect(screen.getByText('Synapse size')).toBeTruthy()
    expect(screen.getByText('Line width')).toBeTruthy()
    // Presentational params only: the panel must not be able to reach a data param.
    expect(screen.queryByText(/marks the graph stale/)).toBeNull()
  })
})

describe('synapse size', () => {
  /**
   * The unit, pinned. `PointCloud` draws with `sizeAttenuation`, so this number is *nanometres*
   * of world space — it shipped once as a "pixel" size of 5, which drew every synapse at a
   * hundredth of a pixel and looked exactly like a cloud that had not loaded. Nothing throws when
   * this is wrong, which is why it is asserted rather than left to the eye.
   */
  it('reads the size in pixels, which is the unit this card draws in', () => {
    render(<TopologyViewer {...PROPS} tab="visuals" pointSize={6} />)
    expect(screen.getByText('6 px')).toBeTruthy()
  })

  it('asks the renderer for screen-space dots, not world-space ones', async () => {
    /*
     * The whole of the fix. `PointCloud` attenuates by default, so a size means nanometres —
     * which is why this card's dots were once drawn at a hundredth of a pixel. Asserted through
     * the prop because nothing about a wrong answer here throws, and jsdom cannot see a pixel.
     *
     * Awaited because the scene is not mounted at all until the skeleton lands — before that the
     * stage draws "Loading geometry…", so a synchronous read here sees no props rather than the
     * wrong ones.
     */
    render(<TopologyViewer {...PROPS} />)
    await waitFor(() => expect(sceneProps).toBeTruthy(), { timeout: 3000 })
    expect(sceneProps?.pointSizeAttenuation).toBe(false)
  })
})

describe('which cloud the scene draws', () => {
  /**
   * The scene reads the cloud that names partners; everything that *measures* reads the site
   * cloud. On a source whose ordinary synapses already carry `partnerType` these are the same
   * object, which is why this is asserted through the colour channel rather than by identity.
   */
  it('colours the cloud by partner while one is lit', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" partners={['DNp02']} />)
    // Waits for the condition being asserted, not for a proxy of it: `points` appears on the
    // render before the partner column has been read off it.
    await waitFor(
      () =>
        expect((sceneProps?.pointColor as { column?: string } | undefined)?.column).toBe(
          'codaHighlight',
        ),
      { timeout: 3000 },
    )
    const spec = sceneProps?.pointColor as {
      column?: string
      overrides?: Record<string, string>
    }
    /*
     * A closed map: the lit partner plus one `other`. The version this replaced built an entry
     * per value found in the data, which is what let an untyped partner slip through it.
     */
    expect(Object.keys(spec.overrides ?? {}).sort()).toEqual(['DNp02', 'other'])
  })

  it('falls back to polarity when nothing is lit', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(() => expect(sceneProps?.points).toBeTruthy(), { timeout: 3000 })
    const spec = sceneProps?.pointColor as { column?: string; overrides?: unknown }
    expect(spec.column).toBe('polarity')
    expect(spec.overrides).toBeUndefined()
  })
})

describe('the lit count', () => {
  /**
   * The number that makes a wrong highlight visible.
   *
   * The fixture's outgoing partner DNp02 has exactly one synapse, and its incoming partner Tm3
   * has one. Selecting DNp02 while showing *outputs* must light one; selecting it while showing
   * *inputs* must light none, because the polarity does not match — that second case is the bug
   * where a type name appearing on both sides lit the wrong synapses.
   */
  it('counts only the selected partner in the selected direction', async () => {
    render(
      <TopologyViewer {...PROPS} tab="partners" direction="outputs" partners={['DNp02']} />,
    )
    await waitFor(() => expect(screen.getByText(/1 synapse lit/)).toBeTruthy(), {
      timeout: 3000,
    })
  })

  it('lights nothing when the partner is on the other side', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" direction="inputs" partners={['DNp02']} />)
    await waitFor(() => expect(screen.getByText(/0 synapses lit/)).toBeTruthy(), {
      timeout: 3000,
    })
  })
})

describe('finding the lit synapses in a dense cloud', () => {
  /**
   * On body 10003 a typical partner is a few dozen synapses among 57,034. Colour alone does not
   * separate them — same size, same opacity, and the eye has nothing to search on — so the scene
   * is asked for two more channels. Asserted through the props because jsdom draws nothing.
   */
  it('emphasises exactly the lit rows and pushes the rest back', async () => {
    render(
      <TopologyViewer
        {...PROPS}
        tab="partners"
        direction="outputs"
        partners={['DNp02']}
        dimOpacity={0.2}
      />,
    )
    await waitFor(() => expect(sceneProps?.pointEmphasis).toBeInstanceOf(Function), {
      timeout: 3000,
    })
    const emphasis = sceneProps?.pointEmphasis as (row: number) => boolean
    // The fixture's row 1 is the DNp02 output; row 0 is a Tm3 input.
    expect(emphasis(1)).toBe(true)
    expect(emphasis(0)).toBe(false)
    expect(sceneProps?.pointDimOpacity).toBe(0.2)
  })

  it('asks for no emphasis at all when nothing is lit', async () => {
    // A scene with no selection must draw one uniform cloud, not a fully-dimmed one.
    render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(() => expect(sceneProps?.points).toBeTruthy(), { timeout: 3000 })
    expect(sceneProps?.pointEmphasis).toBeUndefined()
  })

  it('offers the fade as a control, since the right value depends on the cell', async () => {
    render(<TopologyViewer {...PROPS} tab="visuals" dimOpacity={0.2} />)
    /*
     * The label is asserted, not just the readout, and it is asserted as this *text*. It read
     * "Others" for a while — accurate beside the note that explains it and meaningless in a
     * column of labels between "Synapse size" and "Line width", which is where a reader meets
     * it. Scoped to the slider's own label because the note names the control too.
     */
    expect(screen.getByText('Unlit synapses', { selector: '.topo__slider-label' })).toBeTruthy()
    expect(screen.getByText('20%')).toBeTruthy()
  })
})

describe('finding a partner that is not in the top rows', () => {
  /**
   * The list draws at most `PARTNER_ROWS`. Before the filter existed that cap *was* the list, so
   * a weak partner — which is most of them on a real cell — was unreachable however well you knew
   * its name. The fixture's `RARE001` is last and weakest for exactly this assertion.
   */
  it('reaches a partner the cap would otherwise hide', async () => {
    const { rerender } = render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByText('RARE001')).toBeNull()

    rerender(<TopologyViewer {...PROPS} tab="partners" partnerQuery="RARE" />)
    expect(screen.getByText('RARE001')).toBeTruthy()
    expect(screen.queryByText('DNp02')).toBeNull()
  })

  it('says how much of the list it is not showing', async () => {
    // A cap that hid rows silently is what made the old list a leaderboard. 62 partners, 50 drawn.
    render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(
      () => expect(screen.getByText(/Showing the 50 strongest of 62 matches/)).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('takes a pattern when it is opted into with a slash', async () => {
    // Explore's grammar, via the Heatmap's `parseLabelFilter` — one reader of that rule, not two.
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="/^OUT00[12]$" />)
    await waitFor(() => expect(screen.getByText('OUT001')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('OUT002')).toBeTruthy()
    expect(screen.queryByText('OUT003')).toBeNull()
  })

  it('treats a bare term as a literal, not a pattern', async () => {
    // `RARE001` contains no metacharacters, but a box that compiled everything would read a
    // partner called `LC4(R)` as a group — the reason the opt-in exists at all.
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="OUT00" />)
    await waitFor(() => expect(screen.getByText('OUT001')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByText('DNp02')).toBeNull()
  })

  it('excludes with a leading !', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="!OUT" />)
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('RARE001')).toBeTruthy()
    expect(screen.queryByText('OUT001')).toBeNull()
  })

  it('keeps a lit partner visible even when the filter excludes it', async () => {
    /*
     * Otherwise the only control that can un-light it has just been hidden by the search, and the
     * picture keeps a highlight with no way back except clearing the box.
     */
    render(
      <TopologyViewer {...PROPS} tab="partners" partners={['DNp02']} partnerQuery="OUT00" />,
    )
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
  })

  it('says so when nothing matches, rather than looking empty', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="zzzz" />)
    await waitFor(
      () => expect(screen.getByText(/No partner matches that filter/)).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('leaves the list whole when a pattern will not compile', async () => {
    // A half-typed `/^LC[` must not empty the list — `parseLabelFilter`'s rule, surfaced here.
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="/^OUT[" />)
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText(/showing every partner/)).toBeTruthy()
  })
})

describe('what the counts say', () => {
  it('describes the whole list when nothing is filtering it', async () => {
    render(<TopologyViewer {...PROPS} tab="partners" />)
    await waitFor(
      () => expect(screen.getByText(/62 partner neurons across 62 types/)).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('describes the match, not the whole list, once a filter is up', async () => {
    // Otherwise the sentence is about a list nobody is looking at: "62 types" over four rows.
    render(<TopologyViewer {...PROPS} tab="partners" partnerQuery="OUT00" />)
    await waitFor(() => expect(screen.getByText(/9 of 62 partner types match/)).toBeTruthy(), {
      timeout: 3000,
    })
  })
})

describe('the skeleton colour', () => {
  it('hands the chosen colour to the scene as a literal', async () => {
    /*
     * A literal hex, not a palette slot. `constantColor` used to parse anything that was not
     * `black`/`white`/`muted` as a slot number, so a picked `#3b7a2f` came back `NaN` → slot 0,
     * a plausible blue that looked like a colour somebody had chosen.
     */
    render(<TopologyViewer {...PROPS} skeletonColor="#3b7a2f" />)
    await waitFor(() => expect(sceneProps?.skeletonColor).toBeTruthy(), { timeout: 3000 })
    expect((sceneProps?.skeletonColor as { constant?: string }).constant).toBe('#3b7a2f')
  })

  it('offers a picker on the Visuals tab', () => {
    const { container } = render(<TopologyViewer {...PROPS} tab="visuals" />)
    const picker = container.querySelector('input[type="color"]') as HTMLInputElement
    expect(picker).toBeTruthy()
    expect(picker.value).toBe('#000000')
    // The hex is printed beside it: a swatch alone gives no way to write the value down.
    expect(screen.getByText('#000000')).toBeTruthy()
  })

  it('writes the picked colour back as a presentational param', () => {
    const onSkeletonColor = vi.fn()
    const { container } = render(
      <TopologyViewer {...PROPS} tab="visuals" onSkeletonColor={onSkeletonColor} />,
    )
    const picker = container.querySelector('input[type="color"]') as HTMLInputElement
    fireEvent.change(picker, { target: { value: '#ff0000' } })
    expect(onSkeletonColor).toHaveBeenCalledWith('#ff0000')
  })
})

/**
 * The partner-resolved cloud, fetched from a source that is a **class**.
 *
 * Every backend is one, and `NeuPrintSource.fetchSynapseLinks` reaches for `this.discover`,
 * `this.scaleFor`, `this.options` and `this.frame` before it does anything else. The rest of this
 * file stubs sources as object literals whose methods are `vi.fn()`s, and a `vi.fn()` never reads
 * `this` — so lifting a method off its receiver (`const f = source.fetchSynapseLinks`) passed
 * every test here while failing against all four real backends, reported to the user as "could
 * not load partner-resolved synapses" as though the query had come back empty.
 *
 * So this stub is deliberately a class that *uses* `this`. A detached call throws, exactly as a
 * real source does.
 */
class LinkSource {
  readonly id = 'topo-links'
  readonly label = 'Links test'
  readonly capabilities = { skeletons: true, synapses: true } as never
  readonly synapseUnits = ['sites'] as never

  /** Read by `fetchSynapseLinks`, so an unbound call cannot reach it. */
  private readonly partnersOf = ['DNp02', 'DNp02', 'Tm3']

  async fetchSkeletons(): Promise<SkeletonsValue> {
    return skeleton()
  }

  /** neuPrint's shape: no partner columns on the ordinary cloud. */
  async fetchSynapses(): Promise<PointsValue> {
    return {
      kind: 'points',
      positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
      attributes: tableFromRows(
        tableSchema(column('neuronId', 'str'), column('polarity', 'str')),
        [
          { neuronId: '1001', polarity: 'pre' },
          { neuronId: '1001', polarity: 'pre' },
          { neuronId: '1001', polarity: 'post' },
        ],
      ),
      bounds: { min: [0, 0, 0], max: [2000, 0, 0] },
      units: 'nm',
    }
  }

  async fetchSynapseLinks(): Promise<PointsValue> {
    // `this.partnersOf` is the whole point: unbound, this line throws.
    const rows = this.partnersOf.map((partnerType, i) => ({
      neuronId: '1001',
      partnerId: String(2000 + i),
      partnerType,
      polarity: partnerType === 'Tm3' ? 'post' : 'pre',
    }))
    return {
      kind: 'points',
      positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
      attributes: tableFromRows(
        tableSchema(
          column('neuronId', 'str'),
          column('partnerId', 'str'),
          column('partnerType', 'str'),
          column('polarity', 'str'),
        ),
        rows,
      ),
      bounds: { min: [0, 0, 0], max: [2000, 0, 0] },
      units: 'nm',
    }
  }

  async fetchConnectivity(req: { direction?: string }): Promise<TableValue> {
    return connectivity(req.direction ?? 'outputs')
  }

  peekDataset(): undefined {
    return undefined
  }
}

describe('the partner-resolved cloud, from a class-based source', () => {
  const LINK_PROPS = { ...PROPS, sourceId: 'topo-links', datasetId: 'links:v1' }

  beforeEach(() => {
    registerSource(new LinkSource() as unknown as DataSource)
    clearSynapseLinksCache()
  })

  it('calls fetchSynapseLinks as a method, so `this` survives', async () => {
    /*
     * The regression guard. Lifted off its receiver this rejects on `this.partnersOf`, the hook
     * lands in `error`, and the rail shows "Could not load partner-resolved synapses".
     */
    render(<LinkSource_Viewer partners={['DNp02']} />)
    await waitFor(() => expect(screen.getByText(/2 synapses lit/)).toBeTruthy(), {
      timeout: 3000,
    })
    expect(screen.queryByText(/Could not load partner-resolved synapses/)).toBeNull()
  })

  it('colours the scene by the partner the second query supplied', async () => {
    render(<LinkSource_Viewer partners={['DNp02']} />)
    await waitFor(
      () =>
        expect((sceneProps?.pointColor as { column?: string } | undefined)?.column).toBe(
          'codaHighlight',
        ),
      { timeout: 3000 },
    )
  })

  it('offers highlighting before anything has been clicked', async () => {
    // `canHighlight` has to be true on a source whose *site* cloud names no partner, or the rail
    // says highlighting is impossible on exactly the backend where the second query exists.
    render(<LinkSource_Viewer partners={[]} />)
    await waitFor(() => expect(screen.getByText('DNp02')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByText(/carry no partner on the far side/)).toBeNull()
  })

  function LinkSource_Viewer({ partners }: { partners: string[] }) {
    return (
      <TopologyViewer {...LINK_PROPS} tab="partners" direction="outputs" partners={partners} />
    )
  }
})

/**
 * The two knobs on the Compartments tab.
 *
 * navis's own, and the reason they are on the card rather than only in the inspector is that the
 * honest way to set either is to move it and look at the arbour. `pnpm probe:split` checks the
 * *answers* against navis at both the default and a moved setting; what is checkable here is the
 * wiring, and two halves of it fail silently.
 */
describe('tuning the split', () => {
  // A spy of its own per test. The shared `PROPS` mocks are never cleared between tests in this
  // file, so a call-count assertion written against one of them counts every earlier test too.
  let onSplitParam = vi.fn()
  beforeEach(() => {
    onSplitParam = vi.fn()
  })

  function tab(overrides: { flowThresh?: number; splitVal?: number } = {}) {
    // The split itself cannot run under jsdom — no Worker — so this panel is in its error state
    // throughout, which is exactly the state a reader reaches for these controls in.
    return render(
      <TopologyViewer
        {...PROPS}
        tab="compartments"
        onSplitParam={onSplitParam}
        flowThresh={overrides.flowThresh ?? PROPS.flowThresh}
        splitVal={overrides.splitVal ?? PROPS.splitVal}
      />,
    )
  }

  it('offers both knobs even though the split itself could not run', async () => {
    /*
     * The regression this pins: `CompartmentPanel` used to return early on a failed split, and
     * the obvious place to put a tuning control is inside the body that early-returns. Then the
     * knobs vanish precisely when the split failed with the defaults — the case they exist for.
     */
    tab()
    await waitFor(() => expect(screen.getByLabelText(/Linker threshold/i)).toBeTruthy(), {
      timeout: 3000,
    })
    expect(screen.getByLabelText(/Axon threshold/i)).toBeTruthy()
  })

  it('writes the param when the drag ends, not on every step of it', async () => {
    /*
     * Each distinct value is a separate crossing of the Python bridge and a fresh split of the
     * whole arbour, so a slider wired straight through queues one per step of the drag. Nothing
     * about that is visible — the last answer still wins — which is why it is asserted rather
     * than left to a comment.
     */
    tab()
    const slider = await screen.findByLabelText(/Linker threshold/i, undefined, {
      timeout: 3000,
    })
    fireEvent.change(slider, { target: { value: '0.75' } })
    fireEvent.change(slider, { target: { value: '0.7' } })
    expect(onSplitParam).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider)
    expect(onSplitParam).toHaveBeenCalledTimes(1)
    expect(onSplitParam).toHaveBeenCalledWith('flowThresh', 0.7)
  })

  it('shows the track moving while the drag is still in progress', async () => {
    // The other half of deferring: the readout has to follow the thumb, or the control reads as
    // broken for the length of the gesture.
    tab()
    const slider = await screen.findByLabelText(/Axon threshold/i, undefined, { timeout: 3000 })
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect((slider as HTMLInputElement).value).toBe('0.5')
    expect(screen.getByText('0.50')).toBeTruthy()
  })

  it('offers a way back to navis’s defaults only once something has moved', async () => {
    tab()
    await waitFor(() => expect(screen.getByLabelText(/Linker threshold/i)).toBeTruthy(), {
      timeout: 3000,
    })
    expect(screen.queryByText(/Back to navis defaults/)).toBeNull()

    cleanup()
    tab({ flowThresh: 0.6 })
    const reset = await screen.findByText(/Back to navis defaults/, undefined, {
      timeout: 3000,
    })

    fireEvent.click(reset)
    // Only what moved. Writing both would put a `splitVal` edit in the provenance key of a graph
    // whose author never touched it — which, with the split checkbox on, marks it stale.
    expect(onSplitParam).toHaveBeenCalledTimes(1)
    expect(onSplitParam).toHaveBeenCalledWith('flowThresh', 0.9)
  })
})

/**
 * The mesh layer.
 *
 * The one layer toggle on this card that is a *fetch* gate rather than a visibility flag, and
 * that difference is invisible: a build that downloaded a mesh for every neuron paged to and then
 * hid it would draw exactly the same picture as this one. So the gate is what is asserted here,
 * along with the two things that would otherwise quietly revert to constants.
 */
describe('colouring by Strahler order', () => {
  /**
   * Strahler order is ordinal, and it was drawn with the *categorical* palette.
   *
   * Two failures, both of which draw a perfectly plausible neuron. The hues carried no order, so
   * nothing in the picture said which way the numbers ran; and `seriesColor` folds past its
   * eighth slot onto the achromatic residual, so on a cell with more than eight orders every
   * high order — the trunk — came out the same grey. Asserted through the node colour callback,
   * because jsdom draws nothing and this is the one thing about the channel that is arithmetic.
   */
  function nodeColorFn(): (item: number, node: number) => string | undefined {
    return sceneProps?.skeletonNodeColor as (i: number, n: number) => string | undefined
  }

  it('runs the ramp in one direction, so the colours carry the order', async () => {
    render(<TopologyViewer {...PROPS} colorBy="strahler" />)
    await waitFor(() => expect(nodeColorFn()).toBeInstanceOf(Function), { timeout: 3000 })
    const at = nodeColorFn()

    // Every node of the fixture, bucketed by the colour it was given. A sequential ramp over a
    // handful of orders gives a handful of colours; what matters is that they are ordered, which
    // is checked by luminance below rather than by naming hexes the palette owns.
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const c = at(0, i)
      if (c) seen.add(c)
    }
    expect(seen.size).toBeGreaterThan(1)

    const lum = [...seen].map(luminance).sort((a, b) => a - b)
    // A real spread, not eight hues that happen to differ. Two adjacent categorical slots can sit
    // at the same lightness; two stops of a sequential ramp cannot.
    expect(lum[lum.length - 1]! - lum[0]!).toBeGreaterThan(0.15)
  })

  it('gives no node the achromatic residual the categorical palette folds onto', async () => {
    /*
     * The fold is the half that silently ate the trunk. It only bites past eight orders, which no
     * jsdom fixture has — so this asserts the property that makes it impossible instead: every
     * colour the channel produces is on the ramp, and the ramp has no grey slot.
     */
    render(<TopologyViewer {...PROPS} colorBy="strahler" />)
    await waitFor(() => expect(nodeColorFn()).toBeInstanceOf(Function), { timeout: 3000 })
    const at = nodeColorFn()
    const mode = currentMode()
    const ramp = new Set(
      Array.from({ length: 21 }, (_, i) => sequentialColor(i / 20, mode).toLowerCase()),
    )
    for (let i = 0; i < 40; i++) {
      const c = at(0, i)
      if (c) expect(ramp.has(c.toLowerCase())).toBe(true)
    }
  })
})

describe('skeleton opacity', () => {
  it('offers it on the Visuals tab and hands it to the scene', async () => {
    render(<TopologyViewer {...PROPS} tab="visuals" skeletonOpacity={0.4} />)
    expect(
      screen.getByText('Skeleton opacity', { selector: '.topo__slider-label' }),
    ).toBeTruthy()
    await waitFor(() => expect(sceneProps?.skeletonOpacity).toBe(0.4), { timeout: 3000 })
  })

  it('writes it back as a presentational param', () => {
    const onVisual = vi.fn()
    render(<TopologyViewer {...PROPS} tab="visuals" onVisual={onVisual} />)
    const slider = screen.getByLabelText(/Skeleton opacity/)
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(onVisual).toHaveBeenCalledWith('skeletonOpacity', 0.5)
  })

  it('stays opaque unless somebody asks, unlike the mesh', () => {
    /*
     * The arbour is the subject on this card; the reason to fade it is to see something it
     * stands in front of. A default below 1 would also put every existing scene into three's
     * transparent bucket, which is depth-sorted — a different picture for every caller of
     * `Viewer3D`, none of whom asked.
     */
    render(<TopologyViewer {...PROPS} tab="visuals" />)
    expect(screen.getByLabelText(/Skeleton opacity/)).toHaveProperty('value', '1')
  })
})

describe('the mesh layer', () => {
  const fetchMeshes = vi.fn()

  function mesh(): MeshesValue {
    return {
      kind: 'meshes',
      items: [
        {
          id: '1001',
          positions: new Float32Array([0, 0, 0, 1000, 0, 0, 1000, 1000, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      ],
      attributes: tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: '1001' }]),
      bounds: { min: [0, 0, 0], max: [1000, 1000, 0] },
      units: 'nm',
    }
  }

  beforeEach(() => {
    fetchMeshes.mockReset().mockResolvedValue(mesh())
    registerSource({
      id: 'topo-mesh',
      label: 'Mesh test',
      capabilities: { skeletons: true, synapses: true, meshes: true },
      synapseUnits: ['sites'],
      fetchSkeletons: async () => skeleton(),
      fetchSynapses: async () => synapses(),
      fetchMeshes,
      fetchConnectivity: async (req: { direction?: string }) =>
        connectivity(req.direction ?? 'outputs'),
      peekDataset: () => undefined,
    } as unknown as DataSource)
  })

  const MESH_PROPS = { ...PROPS, sourceId: 'topo-mesh', datasetId: 'mesh:v1' }

  it('fetches nothing at all while the layer is off', async () => {
    /*
     * The rule the whole hook exists for. Skeleton and synapses are already in hand, so those two
     * toggles only decide what is drawn — this one decides whether megabytes are fetched, once
     * per neuron paged to. Wired as a visibility flag instead, nothing anywhere would look wrong.
     */
    render(<TopologyViewer {...MESH_PROPS} showMesh={false} />)
    await waitFor(() => expect(sceneProps?.skeletons).toBeTruthy(), { timeout: 3000 })
    expect(fetchMeshes).not.toHaveBeenCalled()
    expect((sceneProps?.shown as { meshes?: boolean } | undefined)?.meshes).toBe(false)
  })

  it('fetches a shell rather than the Meshes node’s full detail', async () => {
    render(<TopologyViewer {...MESH_PROPS} showMesh />)
    await waitFor(() => expect(fetchMeshes).toHaveBeenCalled(), { timeout: 3000 })
    const req = fetchMeshes.mock.calls[0]?.[0] as {
      triangleBudget?: number
      neuronIds?: string[]
    }
    expect(req.neuronIds).toEqual(['1001'])
    // A translucent shell behind an opaque skeleton: detail here is spent on something nobody
    // can see through 15% alpha, and the budget is what picks the LOD *before* the download.
    expect(req.triangleBudget).toBeLessThan(1_500_000)
  })

  it('draws the mesh only once it has arrived', async () => {
    render(<TopologyViewer {...MESH_PROPS} showMesh />)
    await waitFor(
      () => expect((sceneProps?.shown as { meshes?: boolean } | undefined)?.meshes).toBe(true),
      { timeout: 3000 },
    )
    expect(sceneProps?.meshes).toBeTruthy()
  })

  it('hands the opacity to the scene as the param, not as a constant', async () => {
    // It shipped as a hardcoded 0.25. A revert is invisible except by looking at a neuron.
    render(<TopologyViewer {...MESH_PROPS} showMesh meshOpacity={0.4} />)
    await waitFor(() => expect(sceneProps?.meshOpacity).toBe(0.4), { timeout: 3000 })
  })

  it('greys the button out on a dataset with no meshes rather than dropping it', async () => {
    /*
     * `topo-test` publishes no meshes. A button that is simply absent reads as a build without
     * the feature; a disabled one with a reason says which of the two it is.
     */
    render(<TopologyViewer {...PROPS} />)
    const button = await screen.findByRole('button', { name: 'Mesh' }, { timeout: 3000 })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toMatch(/no neuron meshes/)
    // Not pressed, even though `showMesh` is true in the params: a layer toggle that reports
    // itself on while nothing is drawn is the one appearance it must never have, and jsdom
    // computes no styles, so the CSS half of that is invisible to this suite.
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })
})

/**
 * A CAVE-shaped cloud: partners named by **id**, with the type only in the connectivity table.
 *
 * Reported against the `wclee_aedes_brain` datastack, whose cell types come from a FlyTable sheet
 * wired to the dataset node. The card said "this dataset's synapses do not name their partner"
 * while the partner list beside it was full of real type names — a refusal that was true of the
 * column it looked for and false of the data. `cave/schema.ts` narrows the canonical synapse
 * schema to four columns because a CAVE synapse table carries a root id on each side and no type,
 * and `fetchConnectivity` resolves those ids through `typeLookup`, which reads the annotations.
 */
describe('a dataset that names partners by id', () => {
  const CAVE_SYNAPSES = tableSchema(
    column('neuronId', 'str'),
    column('partnerId', 'str'),
    column('polarity', 'str'),
    column('weight', 'f64'),
  )

  const CAVE_PROPS = {
    ...PROPS,
    sourceId: 'topo-cave',
    datasetId: 'cave:v1',
    direction: 'inputs',
  }

  beforeEach(() => {
    install({
      id: 'topo-cave',
      units: 'links',
      points: {
        kind: 'points',
        positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
        attributes: tableFromRows(CAVE_SYNAPSES, [
          // Two from the same partner, one from another, all inputs.
          { neuronId: '1001', partnerId: '900', polarity: 'post', weight: 1 },
          { neuronId: '1001', partnerId: '901', polarity: 'post', weight: 1 },
          { neuronId: '1001', partnerId: '902', polarity: 'post', weight: 1 },
        ]),
        bounds: { min: [0, 0, 0], max: [2000, 0, 0] },
        units: 'nm',
      },
      // The type lives here and only here — as it does on CAVE, via the attached annotations.
      links: tableFromRows(CONNECTIVITY, [
        { neuronId: '1001', partnerId: 900, partnerType: 'AN10B021', weight: 2 },
        { neuronId: '1001', partnerId: 901, partnerType: 'AN10B021', weight: 1 },
        { neuronId: '1001', partnerId: 902, partnerType: 'Tm3', weight: 5 },
      ]),
    })
  })

  it('does not claim the synapses fail to name their partner', async () => {
    render(<TopologyViewer {...CAVE_PROPS} tab="partners" />)
    await waitFor(() => expect(screen.getByText('AN10B021')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByText(/carry no partner on the far side/)).toBeNull()
  })

  it('lights exactly the synapses of the chosen type, joined through the id', async () => {
    /*
     * The count is the assertion: partner `AN10B021` is two of the three rows, and it is reached
     * only by mapping each synapse's `partnerId` through the connectivity table. A join that
     * matched on the id *string* against a type name would light nothing and still look like a
     * working control.
     */
    render(<TopologyViewer {...CAVE_PROPS} tab="partners" partners={['AN10B021']} />)
    await waitFor(() => expect(screen.getByText(/2 synapses lit/)).toBeTruthy(), {
      timeout: 3000,
    })
  })

  it('colours the scene by the joined column rather than by polarity', async () => {
    render(<TopologyViewer {...CAVE_PROPS} tab="partners" partners={['Tm3']} />)
    await waitFor(
      () =>
        expect((sceneProps?.pointColor as { column?: string } | undefined)?.column).toBe(
          'codaHighlight',
        ),
      { timeout: 3000 },
    )
    const emphasis = sceneProps?.pointEmphasis as (row: number) => boolean
    // Row 2 is the Tm3 synapse; the other two belong to AN10B021.
    expect(emphasis(2)).toBe(true)
    expect(emphasis(0)).toBe(false)
  })
})

/**
 * Grouping the partner list, and the one property that has to survive it.
 *
 * A row's label is what gets stored in `partners` and what `highlightColumn` matches against, so
 * the list and the arbour have to spell a partner the same way. `partnerKey` is the single rule
 * both read; these tests are about the *seam*, which is the half a headless test cannot see.
 */
describe('grouping the partner list', () => {
  const SYNAPSES = tableSchema(
    column('neuronId', 'str'),
    column('partnerId', 'str'),
    column('partnerType', 'str'),
    column('polarity', 'str'),
  )

  beforeEach(() => {
    install({
      id: 'topo-group',
      points: {
        kind: 'points',
        positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0, 3000, 0, 0]),
        attributes: tableFromRows(SYNAPSES, [
          { neuronId: '1001', partnerId: '900', partnerType: 'Tm3', polarity: 'post' },
          { neuronId: '1001', partnerId: '901', partnerType: 'Tm3', polarity: 'post' },
          { neuronId: '1001', partnerId: '902', partnerType: null, polarity: 'post' },
          { neuronId: '1001', partnerId: '903', partnerType: null, polarity: 'post' },
        ]),
        bounds: { min: [0, 0, 0], max: [3000, 0, 0] },
        units: 'nm',
      },
      links: tableFromRows(CONNECTIVITY, [
        { neuronId: '1001', partnerId: 900, partnerType: 'Tm3', weight: 1 },
        { neuronId: '1001', partnerId: 901, partnerType: 'Tm3', weight: 1 },
        { neuronId: '1001', partnerId: 902, partnerType: null, weight: 1 },
        { neuronId: '1001', partnerId: 903, partnerType: null, weight: 1 },
      ]),
    })
  })

  const GROUP_PROPS = {
    ...PROPS,
    sourceId: 'topo-group',
    datasetId: 'group:v1',
    tab: 'partners',
    direction: 'inputs',
  }

  it('offers the three settings as one control, not as two checkboxes', async () => {
    render(<TopologyViewer {...GROUP_PROPS} />)
    const select = await screen.findByLabelText('Group partners by', undefined, {
      timeout: 3000,
    })
    expect((select as HTMLSelectElement).value).toBe('type')
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'type',
      'typed',
      'neuron',
    ])
    fireEvent.change(select, { target: { value: 'neuron' } })
    expect(GROUP_PROPS.onGrouping).toHaveBeenCalledWith('neuron')
  })

  it('lumps the untyped under one row by default', async () => {
    render(<TopologyViewer {...GROUP_PROPS} />)
    await waitFor(() => expect(screen.getByText('Tm3')).toBeTruthy(), { timeout: 3000 })
    // One `—` row standing for both untyped partners, which is the thing the toggles open up.
    expect(screen.getAllByText('—')).toHaveLength(1)
    expect(screen.queryByText('902')).toBeNull()
  })

  it('splits the untyped apart under `typed`, leaving the typed bucket whole', async () => {
    render(<TopologyViewer {...GROUP_PROPS} grouping="typed" />)
    await waitFor(() => expect(screen.getByText('902')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('903')).toBeTruthy()
    expect(screen.getByText('Tm3')).toBeTruthy()
    expect(screen.queryByText('900')).toBeNull()
  })

  it('lights one neuron rather than its whole type, once ungrouped', async () => {
    /*
     * The seam. `900` and `901` are both Tm3, so under `type` grouping picking Tm3 lights two
     * synapses; picking the neuron `900` must light exactly one. A cloud still labelled by type
     * while the list had moved on to ids would light *nothing* here — a plausible-looking list
     * whose every click does nothing, which is this card's recurring failure.
     */
    render(<TopologyViewer {...GROUP_PROPS} grouping="neuron" partners={['900']} />)
    await waitFor(() => expect(screen.getByText(/1 synapse lit/)).toBeTruthy(), {
      timeout: 3000,
    })

    cleanup()
    render(<TopologyViewer {...GROUP_PROPS} partners={['Tm3']} />)
    await waitFor(() => expect(screen.getByText(/2 synapses lit/)).toBeTruthy(), {
      timeout: 3000,
    })
  })

  it('keeps the type beside an id-keyed row, and lets the filter find it', async () => {
    render(<TopologyViewer {...GROUP_PROPS} grouping="neuron" partnerQuery="Tm3" />)
    // Filtering by a type the labels no longer carry still reaches the two Tm3 neurons.
    await waitFor(() => expect(screen.getByText('900')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('901')).toBeTruthy()
    expect(screen.queryByText('902')).toBeNull()
    // …and the type is on screen, so the ids are not eighteen digits of nothing.
    expect(screen.getAllByText('Tm3').length).toBeGreaterThan(0)
  })
})
