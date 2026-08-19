/**
 * The Profile widget's arithmetic.
 *
 * Worth testing hard because none of it is visible: jsdom has no canvas and no WebGL, so a
 * wrong roll-up renders as a plausible-looking bar chart that nobody can check. The cases
 * that matter are the ones where a naive implementation still produces numbers — nested ROIs
 * double counting, `predictedNtProb` being swept in as a transmitter, a partner appearing in
 * two rows and being counted twice.
 */

import { describe, expect, it } from 'vitest'

import { tableSchema, column } from '../../core/types'
import { tableFromRows } from '../../core/values'
import {
  connectivitySummary,
  hemisphereSplit,
  partnerTypes,
  regionRows,
  roiSide,
  topPartners,
  transmitterReading,
} from './profileStats'

const CONNECTIVITY = tableSchema(
  column('bodyId', 'i64'),
  column('bodyType', 'str'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

const ROI_COUNTS = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('roi', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

function connectivity(
  rows: Array<{ partnerId: number; partnerType: string | null; weight: number }>,
) {
  return tableFromRows(
    CONNECTIVITY,
    rows.map((row) => ({ bodyId: 1, bodyType: 'CT1', ...row })),
  )
}

function roiCounts(rows: Array<{ roi: string; pre: number; post: number }>) {
  return tableFromRows(
    ROI_COUNTS,
    rows.map((row) => ({ bodyId: 1, type: 'CT1', ...row })),
  )
}

describe('partnerTypes', () => {
  it('sums synapses and counts distinct partners per type', () => {
    const rows = partnerTypes(
      connectivity([
        { partnerId: 10, partnerType: 'Tm9', weight: 30 },
        { partnerId: 11, partnerType: 'Tm9', weight: 20 },
        { partnerId: 12, partnerType: 'Tm1', weight: 50 },
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ type: 'Tm1', synapses: 50, partners: 1 })
    expect(rows[1]).toMatchObject({ type: 'Tm9', synapses: 50, partners: 2 })
    // Ties in synapses break by name, so the order is stable rather than insertion-dependent.
    expect(rows.map((r) => r.type)).toEqual(['Tm1', 'Tm9'])
  })

  it('counts a partner once per type even when it appears in several rows', () => {
    // neuPrint returns one row per connection, and a neuron can connect to the same partner
    // through more than one — summing rows to get a partner count would over-report.
    const rows = partnerTypes(
      connectivity([
        { partnerId: 10, partnerType: 'Tm9', weight: 30 },
        { partnerId: 10, partnerType: 'Tm9', weight: 5 },
      ]),
    )
    expect(rows[0]).toMatchObject({ synapses: 35, partners: 1 })
  })

  it('shares are of the direction total, and sum to one', () => {
    const rows = partnerTypes(
      connectivity([
        { partnerId: 10, partnerType: 'A', weight: 75 },
        { partnerId: 11, partnerType: 'B', weight: 25 },
      ]),
    )
    expect(rows[0]?.synapseShare).toBeCloseTo(0.75)
    expect(rows[1]?.synapseShare).toBeCloseTo(0.25)
    expect(rows.reduce((sum, r) => sum + r.synapseShare, 0)).toBeCloseTo(1)
    expect(rows.reduce((sum, r) => sum + r.partnerShare, 0)).toBeCloseTo(1)
  })

  it('keeps untyped partners in their own bucket', () => {
    const rows = partnerTypes(
      connectivity([
        { partnerId: 10, partnerType: null, weight: 40 },
        { partnerId: 11, partnerType: '', weight: 30 },
        { partnerId: 12, partnerType: 'Tm9', weight: 10 },
      ]),
    )
    const untyped = rows.find((r) => r.type === null)
    // Null and empty-string are the same absence, so they merge with each other but not into
    // a real type.
    expect(untyped).toMatchObject({ synapses: 70, partners: 2 })
    expect(rows).toHaveLength(2)
  })

  it('applies the threshold and the row cap', () => {
    const table = connectivity([
      { partnerId: 10, partnerType: 'A', weight: 9 },
      { partnerId: 11, partnerType: 'B', weight: 4 },
      { partnerId: 12, partnerType: 'C', weight: 7 },
    ])
    expect(partnerTypes(table, { minWeight: 5 }).map((r) => r.type)).toEqual(['A', 'C'])
    expect(partnerTypes(table, { topN: 1 }).map((r) => r.type)).toEqual(['A'])
    // Shares are computed after the threshold, so they still describe what is shown.
    expect(partnerTypes(table, { minWeight: 5 })[0]?.synapseShare).toBeCloseTo(9 / 16)
  })
})

describe('topPartners', () => {
  it('ranks individual neurons by weight', () => {
    const rows = topPartners(
      connectivity([
        { partnerId: 10, partnerType: 'Tm9', weight: 5 },
        { partnerId: 11, partnerType: 'Tm1', weight: 50 },
      ]),
    )
    expect(rows.map((r) => r.bodyId)).toEqual([11, 10])
    expect(rows[0]?.share).toBeCloseTo(50 / 55)
  })
})

describe('connectivitySummary', () => {
  it('reports synapses and distinct partners at the threshold', () => {
    const table = connectivity([
      { partnerId: 10, partnerType: 'A', weight: 30 },
      { partnerId: 10, partnerType: 'A', weight: 3 },
      { partnerId: 11, partnerType: 'B', weight: 2 },
    ])
    expect(connectivitySummary(table)).toEqual({ synapses: 35, partners: 2 })
    expect(connectivitySummary(table, { minWeight: 5 })).toEqual({ synapses: 30, partners: 1 })
  })

  it('is zero rather than NaN with nothing fetched', () => {
    expect(connectivitySummary(undefined)).toEqual({ synapses: 0, partners: 0 })
  })
})

describe('regionRows', () => {
  it('drops ROIs outside the primary list, because roiInfo nests', () => {
    // A synapse in LO(R) is also counted in its parent OL(R). Summing both reports twice the
    // synapses the neuron has, which is the whole reason the filter exists.
    const table = roiCounts([
      { roi: 'LO(R)', pre: 100, post: 200 },
      { roi: 'OL(R)', pre: 100, post: 200 },
    ])
    const rows = regionRows(table, { primaryRois: ['LO(R)'] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ roi: 'LO(R)', pre: 100, post: 200, total: 300 })
  })

  it('keeps everything when the primary list is not known yet', () => {
    const rows = regionRows(roiCounts([{ roi: 'LO(R)', pre: 1, post: 2 }]))
    expect(rows).toHaveLength(1)
  })

  it('sorts by total and drops empty regions', () => {
    const rows = regionRows(
      roiCounts([
        { roi: 'A', pre: 1, post: 1 },
        { roi: 'B', pre: 10, post: 10 },
        { roi: 'C', pre: 0, post: 0 },
      ]),
    )
    expect(rows.map((r) => r.roi)).toEqual(['B', 'A'])
  })
})

describe('roiSide', () => {
  it('reads the trailing parenthesis', () => {
    expect(roiSide('LO(R)')).toBe('R')
    expect(roiSide('ADMN(L)')).toBe('L')
  })

  it('reads the LAST parenthesis, not the first', () => {
    // MANC's leg neuropils have two. Anchoring on the first reports every one as unsided.
    expect(roiSide('HTct(UTct-T3)(L)')).toBe('L')
    expect(roiSide('LegNp(T1)(R)')).toBe('R')
  })

  it('calls an unlateralised ROI center rather than unknown', () => {
    expect(roiSide('ANm')).toBe('center')
    expect(roiSide('AbNT')).toBe('center')
    expect(roiSide('CV')).toBe('center')
  })
})

describe('hemisphereSplit', () => {
  it('totals each side over the filtered region rows', () => {
    const rows = regionRows(
      roiCounts([
        { roi: 'LO(R)', pre: 50, post: 50 },
        { roi: 'ADMN(L)', pre: 10, post: 10 },
        { roi: 'ANm', pre: 5, post: 0 },
      ]),
    )
    expect(hemisphereSplit(rows)).toEqual({ left: 20, right: 100, center: 5, total: 125 })
  })
})

describe('transmitterReading', () => {
  it('prefers the curated call over the predicted one', () => {
    const reading = transmitterReading({ consensusNt: 'gaba', predictedNt: 'acetylcholine' })
    expect(reading.call).toBe('gaba')
    expect(reading.callColumn).toBe('consensusNt')
  })

  it('falls back through the list and reports nothing where a dataset publishes nothing', () => {
    expect(transmitterReading({ predictedNt: 'gaba' }).call).toBe('gaba')
    expect(transmitterReading({ type: 'CT1' }).call).toBeUndefined()
    expect(transmitterReading({ type: 'CT1' }).probabilities).toEqual([])
  })

  it('reads per-transmitter probabilities and shortens the long MANC names', () => {
    const reading = transmitterReading({
      ntAcetylcholineProb: 0.3,
      ntGabaProb: 0.66,
      ntGlutamateProb: 0.03,
      ntUnknownProb: 0.01,
    })
    expect(reading.probabilities.map((p) => p.label)).toEqual(['GABA', 'ACh', 'Glu', 'unknown'])
    expect(reading.probabilities[0]?.value).toBeCloseTo(0.66)
  })

  it('does not mistake predictedNtProb for a transmitter', () => {
    // It is the confidence in the call, not a per-transmitter probability. Sweeping it in
    // puts a phantom bar beside the real ones and makes the set sum past 1.
    const reading = transmitterReading({ predictedNtProb: 0.92, ntGabaProb: 0.66 })
    expect(reading.probabilities.map((p) => p.column)).toEqual(['ntGabaProb'])
    expect(reading.confidence).toBeCloseTo(0.92)
  })

  it('ignores non-numeric probability cells rather than charting NaN', () => {
    const reading = transmitterReading({ ntGabaProb: null, ntAchProb: 0.5 })
    expect(reading.probabilities.map((p) => p.column)).toEqual(['ntAchProb'])
  })
})
