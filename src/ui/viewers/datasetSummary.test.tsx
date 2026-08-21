// @vitest-environment jsdom

/**
 * The Dataset Summary widget.
 *
 * The arithmetic is pinned in `nodes/lib/datasetStats.test.ts`; what is worth asserting here is
 * everything the headless suite cannot see — which tiles are *absent* rather than dashed, that
 * the caption names the population every count is over, and that the card and the overlay differ
 * only where they are meant to.
 *
 * The source is stubbed rather than driven through `MockSource` so a case can decide what each
 * fetch returns, including making one hang, which is the only way to observe a loading tile.
 */

import { readFileSync } from 'node:fs'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { resetCache } from '../../data/cache'
import { resetIndexLoads } from '../../data/neuronIndex'
import type { DataSource, DatasetInfo } from '../../data/source'
import {
  ROI_COMPLETENESS_SCHEMA,
  ROI_CONNECTIVITY_SCHEMA,
  registerSource,
} from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { resetNeuronIndexState } from '../useNeuronIndex'
import { DatasetSummaryViewer } from './DatasetSummaryViewer'
import { ValuePreview } from './ValuePreview'
import '../../nodes'

const DATASET = 'hemibrain:v1.2.1'

const NEURONS = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('status', 'str'),
  column('class', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

function index(rows: Array<Record<string, CellValue>>): TableValue {
  return tableFromRows(NEURONS, rows, 'neurons')
}

const INDEX = index([
  { neuronId: 1, type: 'LC4', status: 'Traced', class: 'optic', pre: 90, post: 40 },
  { neuronId: 2, type: 'LC4', status: 'Traced', class: 'optic', pre: 10, post: 30 },
  { neuronId: 3, type: 'Tm9', status: 'Traced', class: 'central', pre: 5, post: 7 },
  { neuronId: 4, type: null, status: 'Assign', class: null, pre: 1, post: 1 },
])

const COMPLETENESS = tableFromRows(ROI_COMPLETENESS_SCHEMA, [
  {
    roi: 'AL(R)',
    pre: 90,
    post: 30,
    totalPre: 100,
    totalPost: 100,
    preCompleteness: 0.9,
    postCompleteness: 0.3,
    primary: true,
  },
  {
    roi: 'AL-DA1(R)',
    pre: 40,
    post: 10,
    totalPre: 50,
    totalPost: 40,
    preCompleteness: 0.8,
    postCompleteness: 0.25,
    // Nested inside AL(R) — must not be totalled, and must not be ranked beside its own parent.
    primary: false,
  },
  {
    roi: 'EB',
    pre: 10,
    post: 5,
    totalPre: 100,
    totalPost: 50,
    preCompleteness: 0.1,
    postCompleteness: 0.1,
    primary: true,
  },
])

const CONNECTIVITY = tableFromRows(ROI_CONNECTIVITY_SCHEMA, [
  { source: 'AL(R)', target: 'EB', count: 12, weight: 3.5 },
  { source: 'EB', target: 'AL(R)', count: 4, weight: 1.5 },
])

const INFO: DatasetInfo = {
  id: DATASET,
  label: 'Hemibrain',
  species: 'Drosophila melanogaster',
  version: 'v1.2.1',
  rois: ['AL(R)', 'EB', 'AL-DA1(R)'],
  primaryRois: ['AL(R)', 'EB'],
  statuses: ['Traced', 'Assign'],
}

interface Stub {
  index?: TableValue | 'hang'
  completeness?: TableValue | 'hang' | 'unsupported'
  connectivity?: TableValue | 'hang'
  info?: DatasetInfo | undefined
}

let stub: Stub = {}
/** Fetches the stub actually received, so "the card does not ask for this" is checkable. */
let fetched: string[] = []

function answer<T>(value: T | 'hang' | undefined): Promise<T> {
  if (value === 'hang') return new Promise<T>(() => {})
  if (value === undefined) return Promise.reject(new Error('not stubbed'))
  return Promise.resolve(value)
}

beforeAll(() => {
  installJsdomStubs({ width: 560, height: 620 })
  const source = {
    id: 'stub',
    label: 'Stub',
    capabilities: {
      rawQuery: false,
      skeletons: false,
      meshes: false,
      synapses: false,
      neuronIndex: true,
      paths: false,
      viewerScene: false,
      get roiSummary() {
        return stub.completeness !== 'unsupported'
      },
    },
    schemas: { neurons: NEURONS } as never,
    listDatasets: () => Promise.resolve([INFO]),
    peekDatasets: () => [INFO],
    peekDataset: () => ('info' in stub ? stub.info : INFO),
    neuronIndex: () => {
      fetched.push('index')
      return answer(stub.index ?? INDEX)
    },
    fetchRoiCompleteness: () => {
      fetched.push('completeness')
      return answer(
        stub.completeness === 'unsupported' ? undefined : (stub.completeness ?? COMPLETENESS),
      )
    },
    fetchRoiConnectivity: () => {
      fetched.push('connectivity')
      return answer(stub.connectivity ?? CONNECTIVITY)
    },
  } as unknown as DataSource
  registerSource(source)
})

beforeEach(() => {
  stub = {}
  fetched = []
  resetCache()
  resetIndexLoads()
  resetNeuronIndexState()
})

afterEach(cleanup)

function show(props: Partial<Parameters<typeof DatasetSummaryViewer>[0]> = {}) {
  return render(
    <DatasetSummaryViewer
      sourceId="stub"
      datasetId={DATASET}
      status=""
      attributes={[]}
      topTypes={20}
      measure="post"
      onMeasure={vi.fn()}
      sort="value"
      onSort={vi.fn()}
      compact
      onExpand={vi.fn()}
      {...props}
    />,
  )
}

/** Column keys of the completeness chart, in drawn order. */
function regionKeys(): Array<string | null> {
  return [...(tile('Region completeness')?.querySelectorAll('.tile__column-key') ?? [])].map(
    (k) => k.textContent,
  )
}

/** Bar keys of a ranked tile, in drawn order. */
function barKeys(el: HTMLElement): Array<string | null> {
  return [...el.querySelectorAll('.tile__bar-key')].map((k) => k.textContent)
}

/** The tile whose heading starts with `label`, or undefined when it is not drawn at all. */
function tile(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll('.tile')].find((t) =>
    t.querySelector('.tile__label')?.textContent?.startsWith(label),
  ) as HTMLElement | undefined
}

describe('the caption', () => {
  it('names the population every count is over', async () => {
    // The index carries every `:Neuron`, not the Traced subset every query node defaults to —
    // so a dataset-wide count with no stated population is the number that ends up quoted.
    show()
    await waitFor(() => expect(document.querySelector('.viewer__caption')).toBeTruthy())
    await waitFor(() =>
      expect(document.querySelector('.viewer__caption')?.textContent).toContain('all statuses'),
    )
    const caption = document.querySelector('.viewer__caption')?.textContent ?? ''
    expect(caption).toContain('4 neurons')
    expect(caption).toContain('2 cell types')
  })

  it('names the status when one is chosen, and counts only those neurons', async () => {
    show({ status: 'Assign' })
    await waitFor(() =>
      expect(document.querySelector('.viewer__caption')?.textContent).toContain('1 neurons'),
    )
    expect(document.querySelector('.viewer__caption')?.textContent).toContain('Assign')
  })

  it('says how many regions were summed, so a subset never passes as a total', async () => {
    show()
    await waitFor(() =>
      expect(document.querySelector('.viewer__caption')?.textContent).toContain(
        '2 primary regions',
      ),
    )
  })
})

describe('tiles', () => {
  it('draws a chart per attribute the dataset actually has', async () => {
    show()
    await waitFor(() => expect(tile('class')).toBeTruthy())
    const chart = tile('class')!
    expect(within(chart).getByText('optic')).toBeTruthy()
    expect(within(chart).getByText('central')).toBeTruthy()
    // `type` has thousands of values on a real dataset and gets its own top-N tile instead.
    expect(tile('type')).toBeUndefined()
    expect(tile('Top cell types')).toBeTruthy()
  })

  it('leaves out a tile whose data does not exist, rather than dashing it', async () => {
    // A dataset with no ROI summary at all — mushroombody does exactly this. The synapse totals
    // tile is absent; four zeros would read as measurements.
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [])
    show()
    await waitFor(() => expect(tile('Neurons')).toBeTruthy())
    expect(tile('Synapses')).toBeUndefined()
  })

  it('keeps a heading while its data is in flight, so the grid does not reflow', async () => {
    stub.completeness = 'hang'
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(within(tile('Region completeness')!).getByText('Loading…')).toBeTruthy()
  })

  it('totals synapses over the primary regions only', async () => {
    // AL-DA1(R) nests inside AL(R). Counting it gives 150 presynaptic sites against a true 100
    // — the failure is a plausible number, not an error, which is why it is asserted.
    show()
    await waitFor(() => expect(tile('Synapses')).toBeTruthy())
    const facts = tile('Synapses')!.textContent ?? ''
    expect(facts).toContain('100 / 200')
    expect(facts).toContain('50%')
  })

  it('ranks regions by completeness, and draws only the ones that tile the volume', async () => {
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    const keys = regionKeys()
    /*
     * Ranked by fraction, postsynaptic by default: AL(R) at 30% before EB at 10%. AL-DA1(R) is
     * nested inside AL(R) and left out — drawn beside its own parent, two columns read as two
     * regions whose heights can be compared when one contains the other.
     */
    expect(keys).toEqual(['AL(R)', 'EB'])
  })

  it('pages through a long attribute rather than hiding the tail behind a residual', async () => {
    stub.index = index(
      Array.from({ length: 30 }, (_, i) => ({
        neuronId: i,
        type: `T${i}`,
        status: 'Traced',
        class: `c${i}`,
        pre: 1,
        post: 1,
      })),
    )
    show()
    await waitFor(() => expect(tile('class')).toBeTruthy())

    // A range rather than a count, and no residual: nothing is hidden, so nothing is admitted.
    expect(tile('class')!.querySelector('.tile__qualifier')?.textContent).toBe('1–8 of 30')
    expect(within(tile('class')!).queryByText(/Other/)).toBeNull()
    expect(barKeys(tile('class')!)).toHaveLength(8)

    fireEvent.click(within(tile('class')!).getByLabelText('More class'))
    expect(tile('class')!.querySelector('.tile__qualifier')?.textContent).toBe('9–16 of 30')
  })

  it('offers no pager when everything already fits', async () => {
    // `status` has three values; a pager reading 1/1 is chrome claiming there is more.
    show()
    await waitFor(() => expect(tile('status')).toBeTruthy())
    expect(within(tile('status')!).queryByLabelText(/More /)).toBeNull()
  })
})

describe('rings versus bars', () => {
  it('draws a few categories as a ring, with every slice named', async () => {
    // `status` has three values — a whole worth splitting, not a ranking worth comparing.
    show()
    await waitFor(() => expect(tile('status')).toBeTruthy())
    const donut = tile('status')!.querySelector('.tile__donut')
    expect(donut).toBeTruthy()
    expect(tile('status')!.querySelectorAll('.tile__donut-slice')).toHaveLength(2)
    // Colour is never the only identification: each slice has a legend row carrying its name.
    expect(within(tile('status')!).getByText('Traced')).toBeTruthy()
    expect(within(tile('status')!).getByText('Assign')).toBeTruthy()
  })

  it('draws a long tail as bars instead', async () => {
    stub.index = index(
      Array.from({ length: 12 }, (_, i) => ({
        neuronId: i,
        type: 'T',
        status: `s${i}`,
        class: 'optic',
        pre: 1,
        post: 1,
      })),
    )
    show()
    await waitFor(() => expect(tile('status')).toBeTruthy())
    expect(tile('status')!.querySelector('.tile__donut')).toBeNull()
    expect(barKeys(tile('status')!).length).toBeGreaterThan(0)
  })

  it('gives each chart its own colour, so eight charts do not read as one', async () => {
    stub.index = index([
      { neuronId: 1, type: 'LC4', status: 'Traced', class: 'optic', pre: 1, post: 1 },
      { neuronId: 2, type: 'Tm9', status: 'Assign', class: 'central', pre: 1, post: 1 },
    ])
    show()
    await waitFor(() => expect(tile('Top cell types')).toBeTruthy())
    const fills = [...document.querySelectorAll('.tile__bar-fill, .tile__column-fill')].map(
      (el) => (el as HTMLElement).style.background,
    )
    expect(new Set(fills.filter(Boolean)).size).toBeGreaterThan(1)
  })
})

describe('when completeness has nothing to draw', () => {
  /*
   * Every case here rendered a bare "None", which reads as "this dataset has no regions" — and
   * the first two are not about the dataset at all. The failure is total rather than gradual:
   * one strict test applied per row drops every row at once, so the chart does not degrade, it
   * vanishes. That is what made it worth three tests.
   */
  const roiRow = (over: Record<string, CellValue>) => ({
    roi: 'AL(R)',
    pre: 90,
    post: 30,
    totalPre: 100,
    totalPost: 100,
    preCompleteness: 0.9,
    postCompleteness: 0.3,
    primary: true,
    ...over,
  })

  it('draws a region whose summability is not known yet', async () => {
    // `primary: null` means the source could not say — `Meta.primaryRois` had not landed. An
    // answer nobody has yet is not the claim that a dataset has no regions.
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [roiRow({ primary: null })])
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(regionKeys()).toEqual(['AL(R)'])
  })

  it('draws everything when the table carries no primary column at all', async () => {
    const schema = tableSchema(
      column('roi', 'str'),
      column('pre', 'i64'),
      column('post', 'i64'),
      column('totalPre', 'i64'),
      column('totalPost', 'i64'),
      column('preCompleteness', 'f64'),
      column('postCompleteness', 'f64'),
    )
    stub.completeness = tableFromRows(schema, [
      {
        roi: 'A',
        pre: 9,
        post: 3,
        totalPre: 10,
        totalPost: 10,
        preCompleteness: 0.9,
        postCompleteness: 0.3,
      },
    ])
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(regionKeys()).toEqual(['A'])
  })

  it('says the other measure would work, rather than "None"', async () => {
    // A dataset with presynaptic counts and no postsynaptic ones is a wrong-question case, not
    // an empty dataset — and the default measure is the one that finds nothing.
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [
      roiRow({ post: 0, totalPost: 0, postCompleteness: null }),
    ])
    show({ measure: 'post' })
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(within(tile('Region completeness')!).getByText(/try presynaptic/)).toBeTruthy()
    expect(within(tile('Region completeness')!).queryByText('None')).toBeNull()
  })

  it('says so plainly when the dataset really does publish no regions', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [])
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(
      within(tile('Region completeness')!).getByText(/publishes no region summary/),
    ).toBeTruthy()
  })
})

describe('region order', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    roi: `R${9 - i}`,
    pre: i,
    post: i,
    totalPre: 10,
    totalPost: 10,
    preCompleteness: i / 10,
    postCompleteness: i / 10,
    primary: true,
  }))

  it('ranks by completeness by default, strongest first', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, many)
    show({ sort: 'value' })
    await waitFor(() => expect(regionKeys().length).toBeGreaterThan(0))
    expect(regionKeys()).toEqual(['R4', 'R5', 'R6', 'R7', 'R8', 'R9'])
  })

  it('lists by name when asked, and writes the choice back to the node', async () => {
    const onSort = vi.fn()
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, many)
    show({ sort: 'value', onSort })
    await waitFor(() => expect(regionKeys().length).toBeGreaterThan(0))
    fireEvent.change(within(tile('Region completeness')!).getByLabelText('Region order'), {
      target: { value: 'label' },
    })
    expect(onSort).toHaveBeenCalledWith('label')

    cleanup()
    show({ sort: 'label' })
    await waitFor(() => expect(regionKeys().length).toBeGreaterThan(0))
    expect(regionKeys()).toEqual(['R4', 'R5', 'R6', 'R7', 'R8', 'R9'].sort())
  })

  it('orders names numerically, so R10 follows R9 rather than R1', async () => {
    // male-CNS names thousands of regions `ME_R_col_<n>`; a plain string sort puts them in an
    // order that reads as a bug.
    stub.completeness = tableFromRows(
      ROI_COMPLETENESS_SCHEMA,
      ['R1', 'R10', 'R9', 'R2'].map((roi, i) => ({
        roi,
        pre: i,
        post: i,
        totalPre: 10,
        totalPost: 10,
        preCompleteness: 0.5,
        postCompleteness: 0.5,
        primary: true,
      })),
    )
    show({ sort: 'label' })
    await waitFor(() => expect(regionKeys().length).toBe(4))
    expect(regionKeys()).toEqual(['R1', 'R2', 'R9', 'R10'])
  })

  it('breaks a completeness tie on the name, so equal regions cannot swap between renders', async () => {
    stub.completeness = tableFromRows(
      ROI_COMPLETENESS_SCHEMA,
      ['B', 'A', 'C'].map((roi) => ({
        roi,
        pre: 5,
        post: 5,
        totalPre: 10,
        totalPost: 10,
        preCompleteness: 0.5,
        postCompleteness: 0.5,
        primary: true,
      })),
    )
    show({ sort: 'value' })
    await waitFor(() => expect(regionKeys().length).toBe(3))
    expect(regionKeys()).toEqual(['A', 'B', 'C'])
  })
})

describe('the mean line', () => {
  /*
   * A big region and a tiny one, chosen so the two means differ a long way:
   *   ME(R)  900 of 1000 traced  (90%)
   *   AB(L)    1 of   10 traced  (10%)
   * weighted   = 901 / 1010 = 89.2%   <- what the line must show
   * arithmetic = (90 + 10) / 2 = 50%  <- what averaging the fractions gives
   * Averaging gives a ten-synapse neuropil the same vote as one holding a fifth of the volume.
   */
  const lopsided = [
    {
      roi: 'ME(R)',
      pre: 900,
      post: 900,
      totalPre: 1000,
      totalPost: 1000,
      preCompleteness: 0.9,
      postCompleteness: 0.9,
      primary: true,
    },
    {
      roi: 'AB(L)',
      pre: 1,
      post: 1,
      totalPre: 10,
      totalPost: 10,
      preCompleteness: 0.1,
      postCompleteness: 0.1,
      primary: true,
    },
  ]

  const meanLabel = () =>
    tile('Region completeness')?.querySelector('.tile__columns-mean-label')?.textContent

  it('weights by synapses, rather than averaging the per-region fractions', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, lopsided)
    show()
    await waitFor(() => expect(meanLabel()).toBeTruthy())
    expect(meanLabel()).toBe('mean 89%')
  })

  it('is drawn on the same axis as the bars, so the line can be read against them', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, lopsided)
    show()
    await waitFor(() => expect(meanLabel()).toBeTruthy())
    const line = tile('Region completeness')!.querySelector(
      '.tile__columns-mean',
    ) as HTMLElement
    // `bottom` is a percentage of the band the bars fill — the gridlines this replaced sat in
    // the outer plot, where the value and label rows shortened the bars' own box.
    expect(line.style.bottom).toMatch(/^89\.\d+%$/)
    expect(line.parentElement?.className).toContain('tile__columns-band')
  })

  it('does not move as you page, because it is over every region', async () => {
    stub.completeness = tableFromRows(
      ROI_COMPLETENESS_SCHEMA,
      Array.from({ length: 40 }, (_, i) => ({
        roi: `R${i}`,
        pre: i,
        post: i,
        totalPre: 100,
        totalPost: 100,
        preCompleteness: i / 100,
        postCompleteness: i / 100,
        primary: true,
      })),
    )
    show()
    await waitFor(() => expect(meanLabel()).toBeTruthy())
    const first = meanLabel()
    const pager = within(tile('Region completeness')!).queryByLabelText('More regions')
    if (pager) {
      fireEvent.click(pager)
      // A line that moved with the page would compare each page against itself.
      expect(meanLabel()).toBe(first)
    }
  })

  it('follows the measure, since the two are fifty points apart on a real dataset', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [
      {
        roi: 'A',
        pre: 90,
        post: 30,
        totalPre: 100,
        totalPost: 100,
        preCompleteness: 0.9,
        postCompleteness: 0.3,
        primary: true,
      },
    ])
    show({ measure: 'post' })
    await waitFor(() => expect(meanLabel()).toBe('mean 30%'))
    cleanup()
    show({ measure: 'pre' })
    await waitFor(() => expect(meanLabel()).toBe('mean 90%'))
  })

  it('is absent when there is nothing to divide', async () => {
    stub.completeness = tableFromRows(ROI_COMPLETENESS_SCHEMA, [])
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(meanLabel()).toBeUndefined()
  })
})

/*
 * The mean line's colour, read out of the stylesheet.
 *
 * vitest never applies the CSS and jsdom resolves no custom properties, so the only thing
 * assertable here is the declaration — the same idiom the Profile 3D tile's rule uses, and the
 * only kind of test that catches this class of bug at all. It is worth one: the line shipped
 * against `--text-muted`, which is `#898781` in *both* themes and was picked so a reference
 * would not compete with the bars. It did not compete, it vanished, and nothing failed.
 */
describe('the mean line is drawn in ink, not chrome', () => {
  function meanRules(): string {
    const css = readFileSync('src/ui/editor.css', 'utf8')
    const start = css.indexOf('.tile__columns-mean {')
    expect(start).toBeGreaterThan(-1)
    const end = css.indexOf('}', css.indexOf('.tile__columns-mean-label {', start))
    return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('takes the theme maximum-contrast ink, which flips black to white', () => {
    const rules = meanRules()
    expect(rules).toMatch(/border-top:\s*1px dashed var\(--text-primary\)/)
    expect(rules).toMatch(/color:\s*var\(--text-primary\)/)
    // `--text-muted` is one value for both themes and below what a hairline over saturated
    // colour needs; `--grid` is under the 3:1 non-text floor by design.
    expect(rules).not.toMatch(/--text-muted|--grid\b/)
  })

  it('carries the tile surface behind its label, since it sits on the bars', () => {
    // White-on-dark over a light green column is the one pairing this palette cannot survive.
    expect(meanRules()).toMatch(/background:\s*var\(--surface-2\)/)
  })

  it('stays dashed, so full contrast does not read as another bar', () => {
    expect(meanRules()).toMatch(/dashed/)
  })
})

describe('the completeness measure', () => {
  it('reports postsynaptic by default, since that is what bounds a connectivity query', async () => {
    show()
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    const select = within(tile('Region completeness')!).getByLabelText('Completeness measure')
    expect((select as HTMLSelectElement).value).toBe('post')
    // AL(R) is 30/100 post but 90/100 pre — the two orderings differ, which is the point.
    expect(within(tile('Region completeness')!).getByText('30%')).toBeTruthy()
  })

  it('switches the whole chart, and writes the choice back to the node', async () => {
    const onMeasure = vi.fn()
    show({ onMeasure })
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    fireEvent.change(
      within(tile('Region completeness')!).getByLabelText('Completeness measure'),
      {
        target: { value: 'pre' },
      },
    )
    expect(onMeasure).toHaveBeenCalledWith('pre')

    // The widget is controlled, so re-render with the new value the way the node would.
    cleanup()
    show({ measure: 'pre' })
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(within(tile('Region completeness')!).getByText('90%')).toBeTruthy()
  })
})

describe('region connectivity', () => {
  it('is not a tile, and is not fetched — in the card or the overlay', async () => {
    /*
     * It was both, behind an `enabled` flag that kept the 681 kB male-CNS matrix out of the
     * card. The tile is gone entirely: a 63x63 heatmap at the size a tile gets is texture
     * rather than a chart, and `neuron.roiConnectivity` draws the same data at whatever size
     * it is given. What matters here is the request that no longer happens — a card quietly
     * downloading most of a megabyte for something it does not draw is the regression this
     * catches, and the stub still offers the method so it can be caught.
     */
    show({ compact: false })
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(tile('Region connectivity')).toBeUndefined()
    expect(fetched).toContain('completeness')
    expect(fetched).not.toContain('connectivity')

    cleanup()
    show({ compact: true })
    await waitFor(() => expect(tile('Region completeness')).toBeTruthy())
    expect(fetched).not.toContain('connectivity')
  })
})

describe('reload', () => {
  it('is offered, and bumps the nonce the node keeps', async () => {
    const onReload = vi.fn()
    show({ onReload })
    await waitFor(() => expect(screen.getByLabelText('Reload dataset index')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Reload dataset index'))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})

describe('through ValuePreview', () => {
  /*
   * The dispatch, not the viewer — and this is the case a direct render structurally cannot see.
   *
   * `ValuePreview` early-returns "No result yet" on `!value`, which every other viewer passes
   * through once because they all have an output port. This node has **no outputs**, so its
   * value is undefined forever: below that guard its branch is unreachable and the card shows
   * "No result yet" permanently. Found by pointing a real browser at it, after the whole suite
   * below was already green.
   */
  it('draws the summary even though the node has no output value', async () => {
    const def = requireNodeDef('out.datasetSummary')
    const params = defaultParams(def)
    const node = { id: 'sum', type: 'out.datasetSummary', position: { x: 0, y: 0 }, params }
    const ctx = makeInferContext(def, params, { dataset: T.dataset('stub', DATASET) })

    render(
      <ValuePreview
        node={node}
        value={undefined}
        ctx={ctx}
        compact
        inputValues={{
          dataset: { kind: 'dataset', sourceId: 'stub', datasetId: DATASET, label: 'Stub' },
        }}
      />,
    )
    await waitFor(() => expect(tile('Neurons')).toBeTruthy())
    expect(screen.queryByText(/No result yet/)).toBeNull()
  })
})

describe('with nothing wired', () => {
  it('says so rather than drawing an empty dashboard', () => {
    show({ sourceId: undefined, datasetId: undefined })
    expect(document.querySelector('.viewer__caption')?.textContent).toContain('all statuses')
    // No dataset means no id to print, and the tile says "No dataset" rather than blank rows.
    expect(within(tile('Dataset')!).getByText('No dataset')).toBeTruthy()
  })
})
