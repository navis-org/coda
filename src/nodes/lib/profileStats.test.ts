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

import type { CellValue } from '../../core/values'
import { tableSchema, column } from '../../core/types'
import { tableFromRows } from '../../core/values'
import {
  partnerKey,
  connectivitySummary,
  hemisphereSplit,
  partnerTypes,
  regionRows,
  roiSide,
  partitionByMember,
  profileSubjects,
  subjectConnectivity,
  subjectPartnerTypes,
  subjectRegions,
  subjectTopPartners,
  subjectTransmitter,
  topPartners,
} from './profileStats'

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

/**
 * A connectivity table. `neuronId` defaults to one body and is overridable per row, which is what
 * a *grouped* fetch returns — one table covering every member of the subject.
 */
function connectivity(
  rows: Array<{
    neuronId?: number
    partnerId: number
    partnerType: string | null
    weight: number
  }>,
) {
  return tableFromRows(
    CONNECTIVITY,
    rows.map((row) => ({ neuronId: 1, neuronType: 'CT1', ...row })),
  )
}

function roiCounts(rows: Array<{ roi: string; pre: number; post: number }>) {
  return tableFromRows(
    ROI_COUNTS,
    rows.map((row) => ({ neuronId: 1, type: 'CT1', ...row })),
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
  it('keeps a wide partner id exactly, and still breaks a tie by it', () => {
    /*
     * Invariant 8: this was `toNumber`, so an eighteen-digit CAVE root id was rounded before the
     * widget printed it — a partner that does not exist — and `a.neuronId - b.neuronId` then
     * compared two adjacent ids as *equal*, so the tie-break silently stopped being one.
     */
    const wide: [string, string] = ['720575940628857210', '720575940628857211']
    const table = tableFromRows(
      tableSchema(
        column('neuronId', 'str'),
        column('partnerId', 'str'),
        column('partnerType', 'str'),
        column('weight', 'i64'),
      ),
      [
        { neuronId: '1', partnerId: wide[1], partnerType: 'b', weight: 5 },
        { neuronId: '1', partnerId: wide[0], partnerType: 'a', weight: 5 },
      ],
    )
    const rows = topPartners(table, { minWeight: 1, topN: 10 })
    expect(rows.map((r) => r.neuronId)).toEqual(wide)
    // Not "18 digits": the rounded pair collapses to one value, so a length assertion passes
    // against the bug.
    expect(new Set(rows.map((r) => r.neuronId)).size).toBe(2)
  })

  it('ranks individual neurons by weight', () => {
    const rows = topPartners(
      connectivity([
        { partnerId: 10, partnerType: 'Tm9', weight: 5 },
        { partnerId: 11, partnerType: 'Tm1', weight: 50 },
      ]),
    )
    expect(rows.map((r) => r.neuronId)).toEqual(['11', '10'])
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

describe('subjectTransmitter', () => {
  /**
   * A subject of one, which is how the single-neuron rules are exercised now that there is one
   * transmitter reader rather than two. The rules themselves — which column holds the call, that
   * `predictedNtProb` is a confidence and not a transmitter, that a published-but-empty value is
   * absent — are what these pin; `callColumnOf`, `confidenceColumnOf` and `probabilityLabel` are
   * where they live.
   */
  const one = (row: Record<string, CellValue>) => subjectTransmitter([row])

  it('prefers the curated call over the predicted one', () => {
    const reading = one({ consensusNt: 'gaba', predictedNt: 'acetylcholine' })
    expect(reading.calls.map((c) => c.label)).toEqual(['gaba'])
  })

  it('falls back to the prediction, and answers nothing where there is none', () => {
    expect(one({ predictedNt: 'gaba' }).calls[0]?.label).toBe('gaba')
    expect(one({ type: 'CT1' }).calls).toEqual([])
    expect(one({ type: 'CT1' }).probabilities).toEqual([])
  })

  it('reads the per-transmitter probabilities, strongest first', () => {
    const reading = one({ ntAchProb: 0.2, ntGabaProb: 0.7, ntGluProb: 0.1 })
    expect(reading.probabilities.map((p) => p.label)).toEqual(['GABA', 'ACh', 'Glu'])
    expect(reading.probabilities[0]?.value).toBeCloseTo(0.7)
  })

  it('keeps the confidence out of the probabilities, and reports it separately', () => {
    // `predictedNtProb` is confidence in the *call*. Swept in as a transmitter it would sit
    // beside the real ones and make the set sum past one.
    const reading = one({ predictedNt: 'gaba', predictedNtProb: 0.92, ntGabaProb: 0.66 })
    expect(reading.probabilities.map((p) => p.label)).toEqual(['GABA'])
    expect(reading.confidence?.mean).toBeCloseTo(0.92)
  })

  it('skips a column that is published but empty', () => {
    // `Number(null)` is 0, which is finite — so presence has to be checked first or a missing
    // probability draws a confident zero.
    const reading = one({ ntGabaProb: null, ntAchProb: 0.5 })
    expect(reading.probabilities.map((p) => p.label)).toEqual(['ACh'])
  })

  it('averages the confidence over the members that publish one', () => {
    const reading = subjectTransmitter([
      { predictedNt: 'gaba', predictedNtProb: 0.9 },
      { predictedNt: 'gaba', predictedNtProb: 0.7 },
      { predictedNt: 'gaba' },
    ])
    // Two publishers, not three: an unscored neuron has not been measured, so counting it as
    // zero would make a type look less confident the more of it the model declined to score.
    expect(reading.confidence?.mean).toBeCloseTo(0.8)
    expect(reading.confidence?.n).toBe(2)
    expect(reading.calls).toEqual([{ label: 'gaba', count: 3 }])
  })
})

describe('grouping a partner list', () => {
  const TABLE = tableFromRows(
    tableSchema(
      column('neuronId', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('weight', 'i64'),
    ),
    [
      { neuronId: '1', partnerId: '900', partnerType: 'Tm3', weight: 5 },
      { neuronId: '1', partnerId: '901', partnerType: 'Tm3', weight: 3 },
      { neuronId: '1', partnerId: '902', partnerType: null, weight: 2 },
      { neuronId: '1', partnerId: '903', partnerType: null, weight: 1 },
    ],
  )

  it('lumps the untyped into one row by default, which is what `type` means', () => {
    const rows = partnerTypes(TABLE, { minWeight: 1 })
    expect(rows.map((r) => r.type)).toEqual(['Tm3', null])
    // The lump is two neurons and three synapses, and that is exactly what you cannot see into.
    expect(rows[1]).toMatchObject({ partners: 2, synapses: 3 })
  })

  it('splits only the untyped under `typed`, keyed by id', () => {
    const rows = partnerTypes(TABLE, { minWeight: 1, grouping: 'typed' })
    expect(rows.map((r) => r.type)).toEqual(['Tm3', '902', '903'])
    // The typed bucket is untouched: both Tm3 neurons stay one row.
    expect(rows[0]).toMatchObject({ type: 'Tm3', partners: 2 })
    // And a row keyed by an id whose neuron has no type carries no cell type to show.
    expect(rows[1]?.partnerType).toBeUndefined()
  })

  it('gives every partner its own row under `neuron`, with the type kept beside it', () => {
    const rows = partnerTypes(TABLE, { minWeight: 1, grouping: 'neuron' })
    expect(rows.map((r) => r.type)).toEqual(['900', '901', '902', '903'])
    expect(rows.every((r) => r.partners === 1)).toBe(true)
    /*
     * `partnerType` is for display and filtering only. It must never reach the key: keyed by type,
     * `900` and `901` would collapse back into one row the moment somebody asked for neurons.
     */
    expect(rows[0]?.partnerType).toBe('Tm3')
    expect(rows[1]?.partnerType).toBe('Tm3')
    expect(rows[0]?.type).not.toBe(rows[1]?.type)
  })

  it('keeps the shares over the same population whichever way it is grouped', () => {
    // 11 synapses over 4 partners, however the rows are cut. A share computed per bucket rather
    // than over the whole direction would make the numbers depend on the control.
    for (const grouping of ['type', 'typed', 'neuron'] as const) {
      const rows = partnerTypes(TABLE, { minWeight: 1, grouping })
      const synapses = rows.reduce((sum, r) => sum + r.synapses, 0)
      const shares = rows.reduce((sum, r) => sum + r.synapseShare, 0)
      expect(synapses).toBe(11)
      expect(shares).toBeCloseTo(1)
    }
  })

  it('answers null only where a grouping has nothing to call a partner', () => {
    // `partnerKey` is the one rule both the list and the arbour read; `null` is what `markLabel`
    // spells `—`, and it may only mean "the untyped bucket".
    expect(partnerKey('type', null, '900')).toBeNull()
    expect(partnerKey('typed', null, '900')).toBe('900')
    expect(partnerKey('neuron', 'Tm3', '900')).toBe('900')
    expect(partnerKey('type', 'Tm3', '900')).toBe('Tm3')
    expect(partnerKey('typed', 'Tm3', '900')).toBe('Tm3')
  })
})

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

const NEURONS = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('status', 'str'),
)

function neurons(rows: Array<{ neuronId: number; type: string | null; status?: string }>) {
  return tableFromRows(
    NEURONS,
    rows.map((row) => ({ status: 'Traced', ...row })),
  )
}

describe('profileSubjects', () => {
  it('is one subject per row when nothing is grouped', () => {
    const subjects = profileSubjects(
      neurons([
        { neuronId: 1, type: 'LC4' },
        { neuronId: 2, type: 'LC4' },
      ]),
    )
    expect(subjects.map((s) => s.key)).toEqual(['1', '2'])
    expect(subjects.map((s) => s.members)).toEqual([['1'], ['2']])
  })

  it('groups by the column, keeping the table’s own order', () => {
    // First appearance, not alphabetical: an upstream Sort is then what decides the paging
    // order, where a private rule here would silently override it.
    const subjects = profileSubjects(
      neurons([
        { neuronId: 1, type: 'LPLC2' },
        { neuronId: 2, type: 'LC4' },
        { neuronId: 3, type: 'LPLC2' },
      ]),
      'type',
    )
    expect(subjects.map((s) => s.label)).toEqual(['LPLC2', 'LC4'])
    expect(subjects[0]?.members).toEqual(['1', '3'])
  })

  it('gives the untyped their own subject rather than folding them into a neighbour', () => {
    const subjects = profileSubjects(
      neurons([
        { neuronId: 1, type: 'LC4' },
        { neuronId: 2, type: null },
      ]),
      'type',
    )
    expect(subjects.map((s) => s.label)).toEqual(['LC4', '—'])
    expect(subjects[1]?.members).toEqual(['2'])
  })

  it('counts a repeated neuron once, or the denominator is not the type’s size', () => {
    // A Stack of two searches carries one neuron twice. A mean over three rows and two cells is
    // not a mean over the cell type.
    const subjects = profileSubjects(
      neurons([
        { neuronId: 1, type: 'LC4' },
        { neuronId: 2, type: 'LC4' },
        { neuronId: 1, type: 'LC4' },
      ]),
      'type',
    )
    expect(subjects[0]?.rows).toHaveLength(3)
    expect(subjects[0]?.members).toEqual(['1', '2'])
  })

  it('ignores a group column the schema does not have, and says it did', () => {
    const subjects = profileSubjects(neurons([{ neuronId: 1, type: 'LC4' }]), 'hemilineage')
    expect(subjects.map((s) => s.key)).toEqual(['1'])
    // `grouped` is the fallback's own answer, so a caller cannot disagree with it by reading
    // the param — which is how a lone neuron came to be drawn as a group of one.
    expect(subjects[0]?.grouped).toBe(false)
  })

  it('marks a real group as grouped even when it holds one neuron', () => {
    const subjects = profileSubjects(neurons([{ neuronId: 1, type: 'LC4' }]), 'type')
    expect(subjects[0]?.grouped).toBe(true)
  })
})

/**
 * The partition every subject roll-up now takes, spelled out at the call site.
 *
 * It used to be built inside each roll-up and memoised behind their backs; passing it in is what
 * lets three roll-ups over one subject share one `selectRows` pass without the stats module
 * depending on a caller's `useMemo`.
 */
const parts = partitionByMember

describe('subject roll-ups', () => {
  const TABLE = connectivity([
    // Member 1 reaches Tm3 with 10, member 2 with 2, member 3 not at all.
    { neuronId: 1, partnerId: 900, partnerType: 'Tm3', weight: 10 },
    { neuronId: 2, partnerId: 901, partnerType: 'Tm3', weight: 2 },
    { neuronId: 3, partnerId: 902, partnerType: 'Mi1', weight: 6 },
  ])

  it('divides by every member, not by the ones that happen to connect', () => {
    // The whole reason `present` sits beside `mean`: 4 across three cells where one connects is
    // a different fact from 4 across three where all three do, and the mean cannot say which.
    const rows = subjectPartnerTypes(parts(TABLE, ['1', '2', '3']))
    const tm3 = rows.find((r) => r.type === 'Tm3')
    expect(tm3?.synapses.total).toBe(12)
    expect(tm3?.synapses.mean).toBeCloseTo(4)
    expect(tm3?.synapses.present).toBe(2)
    expect(tm3?.synapses.n).toBe(3)
  })

  it('counts a member with no rows at all as a measured zero', () => {
    // Member 4 is in the type and connects to nothing the fetch returned. Dropping it would
    // report the mean over the members that connect and call it the mean over the type.
    const rows = subjectPartnerTypes(parts(TABLE, ['1', '2', '3', '4']))
    expect(rows.find((r) => r.type === 'Tm3')?.synapses.mean).toBeCloseTo(3)
  })

  it('reports a sample standard deviation, and none for a subject of one', () => {
    // [10, 0, 2] about a mean of 4: 36 + 16 + 4 = 56, over n-1 = 2.
    const rows = subjectPartnerTypes(parts(TABLE, ['1', '2', '3']))
    expect(rows.find((r) => r.type === 'Tm3')?.synapses.sd).toBeCloseTo(Math.sqrt(28))

    const alone = subjectPartnerTypes(parts(TABLE, ['1']))
    expect(alone[0]?.synapses.sd).toBeNull()
  })

  it('agrees with the single-neuron roll-up on a subject of one', () => {
    // The grouped answer *is* the ungrouped one folded — that is the point of running the same
    // functions per member rather than reimplementing them over a grouped table.
    const one = connectivity([
      { neuronId: 1, partnerId: 900, partnerType: 'Tm3', weight: 10 },
      { neuronId: 1, partnerId: 901, partnerType: null, weight: 3 },
    ])
    const flat = partnerTypes(one, { minWeight: 1 })
    const grouped = subjectPartnerTypes(parts(one, ['1']))
    expect(grouped.map((r) => r.type)).toEqual(flat.map((r) => r.type))
    expect(grouped.map((r) => r.synapses.total)).toEqual(flat.map((r) => r.synapses))
    expect(grouped.map((r) => r.partners.total)).toEqual(flat.map((r) => r.partners))
    expect(grouped.map((r) => r.synapseShare)).toEqual(flat.map((r) => r.synapseShare))
  })

  it('ranks on the whole population, not on each member’s own top list', () => {
    // Capping per member first would rank a type by how often it reaches somebody's top ten
    // rather than by how strong it is.
    const rows = subjectPartnerTypes(parts(TABLE, ['1', '2', '3']), { topN: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('Tm3')
  })

  it('summarises synapses and partners per member', () => {
    const summary = subjectConnectivity(parts(TABLE, ['1', '2', '3']))
    expect(summary.synapses.total).toBe(18)
    expect(summary.synapses.mean).toBeCloseTo(6)
    expect(summary.partners.total).toBe(3)
    expect(summary.partners.n).toBe(3)
  })

  it('honours the threshold without a refetch, exactly as the single-neuron list does', () => {
    const rows = subjectPartnerTypes(parts(TABLE, ['1', '2', '3']), { minWeight: 5 })
    expect(rows.map((r) => r.type)).toEqual(['Tm3', 'Mi1'])
    // Member 2's connection of 2 is below the floor, so Tm3 is 10 over three members.
    expect(rows[0]?.synapses.total).toBe(10)
    expect(rows[0]?.synapses.present).toBe(1)
  })

  it('rolls individual partners up per member too', () => {
    const rows = subjectTopPartners(parts(TABLE, ['1', '2', '3']))
    expect(rows[0]).toMatchObject({ neuronId: '900', type: 'Tm3' })
    expect(rows[0]?.weight.mean).toBeCloseTo(10 / 3)
    expect(rows[0]?.weight.present).toBe(1)
  })
})

describe('subjectRegions', () => {
  const TABLE = tableFromRows(ROI_COUNTS, [
    { neuronId: 1, type: 'LC4', roi: 'LO(R)', pre: 10, post: 4 },
    { neuronId: 1, type: 'LC4', roi: 'OL(R)', pre: 10, post: 4 },
    { neuronId: 2, type: 'LC4', roi: 'LO(R)', pre: 6, post: 2 },
  ])

  it('filters to the primary list before averaging, or the totals double-count', () => {
    const out = subjectRegions(parts(TABLE, ['1', '2']), { primaryRois: ['LO(R)'] })
    expect(out.rows.map((r) => r.roi)).toEqual(['LO(R)'])
    expect(out.rows[0]?.pre.mean).toBeCloseTo(8)
    expect(out.rows[0]?.post.mean).toBeCloseTo(3)
  })

  it('splits the sides over every region, not only the ones the list shows', () => {
    const out = subjectRegions(parts(TABLE, ['1', '2']), { primaryRois: ['LO(R)'] })
    expect(out.right.mean).toBeCloseTo(11)
    expect(out.left.total).toBe(0)
    expect(out.total).toBeCloseTo(11)
  })

  it('counts a member with no regions as a zero, not as an absence', () => {
    const out = subjectRegions(parts(TABLE, ['1', '2', '3']), { primaryRois: ['LO(R)'] })
    expect(out.rows[0]?.pre.mean).toBeCloseTo(16 / 3)
    expect(out.rows[0]?.pre.n).toBe(3)
    expect(out.rows[0]?.pre.present).toBe(2)
  })
})
