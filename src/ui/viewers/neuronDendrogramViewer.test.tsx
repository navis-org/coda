// @vitest-environment jsdom
/**
 * The Neuron Dendrogram card, mounted against a fake source.
 *
 * jsdom lays nothing out and its canvas is a stub, so what is checked here is the wiring: that the
 * card fetches and draws, that a click on a drawn branch writes the point it stands for, that the
 * Distal tab counts what lies beyond it, and that the Partners port lights through the list's own
 * vocabulary. The geometry itself is `arborPlot.test.ts`' and the layouts' own tests'.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import type { DataSource } from '../../data/source'
import { registerSource } from '../../data/source'
import { rectangularLayout } from '../../nodes/lib/arborLayout'
import { buildArbor, keyTree, landmarkDistances } from '../../nodes/lib/arborOps'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { fitTransform, toScreen } from './arborPlot'
import type { ArborSettings } from './NeuronDendrogramViewer'
import { NeuronDendrogramViewer } from './NeuronDendrogramViewer'
import { clearTopologyCache } from './useNeuronTopology'

/** A Y: 0 ─ 1 ─ 2 ─ 3, with 2 ─ 4, a micrometre an edge. No radii, as CATMAID sends. */
function skeleton(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '1001',
        positions: new Float32Array([
          0, 0, 0, 1000, 0, 0, 2000, 0, 0, 3000, 0, 0, 2000, 1000, 0,
        ]),
        radii: new Float32Array(5),
        parents: new Int32Array([-1, 0, 1, 2, 2]),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1001'] }),
    bounds: { min: [0, 0, 0], max: [3000, 1000, 0] },
    units: 'nm',
  }
}

/** An input at the root and an output at the tip of the long branch. */
function synapses(): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array([0, 0, 0, 3000, 0, 0]),
    attributes: tableFromRows(
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
    ),
    bounds: { min: [0, 0, 0], max: [3000, 0, 0] },
    units: 'nm',
  }
}

const CONNECTIVITY = tableSchema(
  column('neuronId', 'i64'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

function install(over: Partial<DataSource> = {}): void {
  const source: Partial<DataSource> = {
    id: 'arbor-test',
    label: 'Arbor test',
    capabilities: { skeletons: true, synapses: true } as never,
    synapseUnits: ['sites'] as never,
    fetchSkeletons: (async () => skeleton()) as never,
    fetchSynapses: (async () => synapses()) as never,
    fetchConnectivity: (async (req: { direction?: string }) =>
      tableFromRows(
        CONNECTIVITY,
        req.direction === 'inputs'
          ? [{ neuronId: 1001, partnerId: 3001, partnerType: 'Tm3', weight: 1 }]
          : [{ neuronId: 1001, partnerId: 2001, partnerType: 'DNp02', weight: 1 }],
      )) as never,
    peekDataset: (() => undefined) as never,
    ...over,
  }
  registerSource(source as DataSource)
}

/** neuPrint's shape: the site cloud names no partner, and a second query does. */
function installNeuprintLike(id: string) {
  const fetchSynapseLinks = vi.fn(async () => synapses())
  const plain: PointsValue = {
    ...synapses(),
    attributes: tableFromRows(
      tableSchema(column('neuronId', 'str'), column('polarity', 'str')),
      [
        { neuronId: '1001', polarity: 'post' },
        { neuronId: '1001', polarity: 'pre' },
      ],
    ),
  }
  install({
    id,
    label: 'neuPrint-like',
    fetchSynapses: (async () => plain) as never,
    fetchSynapseLinks: fetchSynapseLinks as never,
    fetchConnectivity: (async () => tableFromRows(CONNECTIVITY, [])) as never,
  })
  return fetchSynapseLinks
}

/**
 * Where on the page the stub's 800 × 480 box draws a point `along` the branch 2 → 3. The stubs
 * report that box against an `offsetWidth` of 1200 — a card React Flow has drawn at two thirds —
 * so the point is scaled by that zoom. Without dividing it back out, which the first browser run
 * of this card found missing, every click misses.
 */
function onBranch(along: number): { clientX: number; clientY: number } {
  const arbor = buildArbor(skeleton().items[0]!, 0)
  const tree = keyTree(arbor)
  const shape = rectangularLayout(tree, landmarkDistances(tree, arbor.geodesic))
  const leaf = tree.nodes.indexOf(3)
  const [x, y] = toScreen(
    fitTransform(shape, 800, 480),
    shape.x0[leaf]! + along * (shape.x1[leaf]! - shape.x0[leaf]!),
    shape.y1[leaf]!,
  )
  const zoom = 800 / 1200
  return { clientX: x * zoom, clientY: y * zoom }
}

const SETTINGS: ArborSettings = {
  layout: 'rectangular',
  metric: 'geodesic',
  rm: 20_800,
  ri: 266,
  root: 'source',
  rootNode: -1,
  order: 'balanced',
  minTwig: 0,
  angleChange: 45,
  angleDecrease: 0,
  daylight: 0,
  colorBy: 'polarity',
  branchColor: 'flat',
  branchPalette: 'red',
  partnersChosen: false,
  widthBy: 'uniform',
  lineWidth: 1.2,
  synapseSize: 5,
  unlitOpacity: 0.4,
  grouping: 'type',
  direction: 'outputs',
  partnerQuery: '',
  focus: '',
  tab: 'partners',
  railOpen: true,
}

function renderCard(
  over: Partial<ArborSettings> = {},
  extra: { partnerIds?: string[]; sourceId?: string } = {},
) {
  const onSetting = vi.fn()
  render(
    <NeuronDendrogramViewer
      neurons={tableFromRows(tableSchema(column('neuronId', 'i64'), column('type', 'str')), [
        { neuronId: 1001, type: 'LC4' },
      ])}
      sourceId="arbor-test"
      datasetId="test:v1"
      page={0}
      onPage={vi.fn()}
      pinned={[]}
      onPin={vi.fn()}
      partners={[]}
      settings={{ ...SETTINGS, ...over }}
      colorOptions={[{ value: 'polarity', label: 'Input / output' }]}
      onSetting={onSetting}
      {...extra}
    />,
  )
  return onSetting
}

beforeEach(() => {
  installJsdomStubs()
  install()
  clearTopologyCache()
})
afterEach(cleanup)

describe('NeuronDendrogramViewer', () => {
  it('draws the neuron once its skeleton lands', async () => {
    renderCard()
    expect(await screen.findByLabelText('LC4 arbour')).toBeTruthy()
    expect(screen.getByText('1001')).toBeTruthy()
  })

  it('says why electrotonic distance cannot be drawn, and draws geodesic instead', async () => {
    renderCard({ metric: 'electrotonic' })
    expect(
      await screen.findByText('Electrotonic distance needs radii, and this skeleton has none.'),
    ).toBeTruthy()
    expect(screen.getByLabelText('LC4 arbour')).toBeTruthy()
  })

  it('writes the point a click on a branch stands for, and opens the Distal tab', async () => {
    const onSetting = renderCard()
    const plot = (await screen.findByLabelText('LC4 arbour')).parentElement!
    fireEvent.click(plot, onBranch(0.5))
    expect(onSetting).toHaveBeenCalledWith('focus', '1001:3:0.5000')
    expect(onSetting).toHaveBeenCalledWith('tab', 'distal')
  })

  it('counts what lies beyond the clicked point', async () => {
    renderCard({ focus: '1001:2:1.0000', tab: 'distal' })
    // The output at the tip of 2 → 3 is beyond the branch point; the input at the root is not.
    expect(await screen.findByText(/0 inputs and 1 output lie beyond it/)).toBeTruthy()
    expect(screen.getByText('DNp02')).toBeTruthy()
  })

  it('lights the Partners port’s neurons by their type, the list’s own grouping', async () => {
    renderCard({}, { partnerIds: ['2001'] })
    expect(await screen.findByText(/1 synapse lit — DNp02/)).toBeTruthy()
  })

  it('names a hovered synapse: its partner, its side and how far out it is', async () => {
    renderCard()
    const plot = (await screen.findByLabelText('LC4 arbour')).parentElement!
    // The output sits at the tip of the branch 2 → 3, 3 µm from the root.
    fireEvent.pointerMove(plot, onBranch(1))
    // Scoped to the tooltip: the partner list names DNp02 too.
    const tip = within(await screen.findByRole('status'))
    expect(tip.getByText('DNp02')).toBeTruthy()
    expect(tip.getByText('Output (presynaptic)')).toBeTruthy()
    expect(tip.getByText(/3 µm from the root/)).toBeTruthy()
  })

  it('offers the picture for download', async () => {
    renderCard()
    await screen.findByLabelText('LC4 arbour')
    expect(screen.getByLabelText(/^Download/)).toBeTruthy()
  })

  it('rolls the Distal tab up by partner type even with nothing lit, fetching partners if it must', async () => {
    const fetchSynapseLinks = installNeuprintLike('arbor-np')
    renderCard({ focus: '1001:2:1.0000', tab: 'distal' }, { sourceId: 'arbor-np' })
    expect(await screen.findByText('DNp02')).toBeTruthy()
    expect(fetchSynapseLinks).toHaveBeenCalled()
    expect(screen.queryByText('all synapses')).toBeNull()
  })

  it('names a hovered synapse’s partner on a source whose rows do not, by asking for them', async () => {
    const fetchSynapseLinks = installNeuprintLike('arbor-np-hover')
    renderCard({}, { sourceId: 'arbor-np-hover' })
    const plot = (await screen.findByLabelText('LC4 arbour')).parentElement!
    expect(fetchSynapseLinks).not.toHaveBeenCalled()
    fireEvent.pointerMove(plot, onBranch(1))
    // The partner rows arrive, the tooltip re-points at the same tick, and names it.
    expect(await within(await screen.findByRole('status')).findByText('DNp02')).toBeTruthy()
    expect(fetchSynapseLinks).toHaveBeenCalledTimes(1)
  })

  it('stops seeding from the Partners port once a partner has been toggled, an empty list included', async () => {
    renderCard({ partnersChosen: true }, { partnerIds: ['2001'] })
    await screen.findByLabelText('LC4 arbour')
    // Chosen and empty: nothing is lit, whatever the port says.
    expect(screen.queryByText(/synapse lit/)).toBeNull()
  })
})
