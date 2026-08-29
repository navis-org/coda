/**
 * The cross-dataset cell-type mapper, against cocoa's own worked examples.
 *
 * These are not invented cases. The four rows of the table at the top of
 * [comparative.md](../../../docs/comparative.md) — nothing, a rename, a merge, a split — are the
 * specification, and the two AOTU008 figures in `cocoa/mappers.py`'s module docstring are the
 * reason the mapper is N-ary rather than pairwise. A mapper that gets all six right is very
 * likely right; one that gets the three-dataset collapse wrong is silently producing a
 * correspondence that depends on which datasets somebody happened to wire up.
 *
 * Everything here is a plain unit test with hand-written annotation rows, because the mapper is
 * pure by construction — `Match Cell Types` fetches the annotation tables and this function
 * decides what they mean. That split is what makes the hard half testable at all.
 *
 * **What is asserted is the grouping, not the spelling.** Which of a component's labels ends up
 * naming it is `labelMode`'s business and is tested separately; a test that pinned the name
 * would fail for a change that made the mapping better.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { MapperDataset, TypeMapping } from './typeMapping'
import {
  labelsByNeuron,
  COMPONENT_NODE_CAP,
  MAPPER_LABELS_SCHEMA,
  MAPPER_REPORT_SCHEMA,
  mapperDatasetFrom,
  mapperLabelsTable,
  mapperReportTable,
  matchCellTypes,
  keepLabelsFrom,
  mapperNetwork,
} from './typeMapping'

/** `{ id: labels }`, which is what an annotation table reduces to once the columns are picked. */
function dataset(rows: Record<string, string[]>): MapperDataset {
  return Object.entries(rows).map(([id, labels]) => ({ id, labels }))
}

/** The labels of one dataset as a plain object, for comparing whole mappings at once. */
function labelsOf(mapping: TypeMapping, index: number): Record<string, string> {
  return Object.fromEntries(mapping.labels[index]!)
}

/** Which ids share a label, as sorted groups. The grouping is the claim; the name is not. */
function groups(mapping: TypeMapping): string[][] {
  const byLabel = new Map<string, string[]>()
  mapping.labels.forEach((perDataset, d) => {
    for (const [id, label] of perDataset) {
      const held = byLabel.get(label)
      if (held) held.push(`${d}:${id}`)
      else byLabel.set(label, [`${d}:${id}`])
    }
  })
  return [...byLabel.values()].map((ids) => ids.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
}

// ---------------------------------------------------------------------------
// cocoa's AOTU008 figures — the reason this takes every dataset at once

/*
 * FlyWire's two hemispheres, from `mappers.py`'s second figure. Each neuron carries its own
 * granular type and the coarser hemibrain-namespace type beside it, which is the ordinary shape
 * of a FlyWire annotation row.
 */
const FLYWIRE_LEFT = dataset({
  '720575940643300974': ['AOTU008a', 'AOTU008'],
  '720575940623374218': ['AOTU008b', 'AOTU008'],
})
const FLYWIRE_RIGHT = dataset({
  '720575940622365991': ['AOTU008a', 'AOTU008'],
  '720575940629805327': ['AOTU008b', 'AOTU008'],
})
const HEMIBRAIN = dataset({ '861237679': ['AOTU008'] })

/*
 * Two types merged: the maleCNS neuron's cross-reference column names both FlyWire types at
 * once. Shared between the grouping test and the naming tests, which reason about it as the one
 * component — note what it does *not* hold once the trim has run. `AVLP001` is the maleCNS
 * neuron's own type, sits on no path that crosses into FlyWire, and so cannot name the group.
 */
const MERGED = [
  dataset({ m1: ['AVLP001', 'PS008,PS009'] }),
  dataset({ f1: ['PS008'], f2: ['PS009'] }),
]

describe('the granularity a mapping can reach depends on which datasets are in it', () => {
  /*
   * "Note how we can map AOTU008a and AOTU008b between the two datasets without having to go
   * through AOTU008" — cocoa's figure 2. Both hemispheres name the subtypes, so the subtype
   * label carries a crossing on its own and the split survives.
   */
  it('keeps AOTU008a and AOTU008b apart across two hemispheres that both name them', () => {
    const mapping = matchCellTypes([FLYWIRE_LEFT, FLYWIRE_RIGHT])
    expect(groups(mapping)).toEqual([
      ['0:720575940623374218', '1:720575940629805327'],
      ['0:720575940643300974', '1:720575940622365991'],
    ])
  })

  /*
   * Figure 3, and the finding that decided the node's shape. The hemibrain has only `AOTU008`,
   * so no partition of this component leaves all three datasets in both halves — the subtypes
   * collapse. This is why `Match Cell Types` is variadic and why nothing lets a user chain two
   * two-dataset mappers: the composed answer would be the *finer* one above, with nothing on
   * screen to say it disagrees.
   */
  it('collapses them into one label the moment a third dataset knows only the coarse one', () => {
    const mapping = matchCellTypes([FLYWIRE_LEFT, FLYWIRE_RIGHT, HEMIBRAIN])
    expect(groups(mapping)).toEqual([
      [
        '0:720575940623374218',
        '0:720575940643300974',
        '1:720575940622365991',
        '1:720575940629805327',
        '2:861237679',
      ],
    ])
  })

  it('is not two pairwise mappings composed', () => {
    // Stated as an assertion rather than left implicit: the pairwise answer is strictly finer,
    // so composing them cannot recover the three-dataset one.
    const pairwise = groups(matchCellTypes([FLYWIRE_LEFT, FLYWIRE_RIGHT]))
    const together = groups(matchCellTypes([FLYWIRE_LEFT, FLYWIRE_RIGHT, HEMIBRAIN]))
    expect(pairwise.length).toBeGreaterThan(together.length)
  })
})

// ---------------------------------------------------------------------------
// The four rows of comparative.md's table

describe('the four things that happen to a type label between datasets', () => {
  it('matches an unchanged label', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'], a2: ['LC6'] }),
      dataset({ b1: ['LC4'], b2: ['LC6'] }),
    ])
    expect(labelsOf(mapping, 0)).toEqual({ a1: 'LC4', a2: 'LC6' })
    expect(labelsOf(mapping, 1)).toEqual({ b1: 'LC4', b2: 'LC6' })
  })

  /*
   * A rename: dataset B calls it `X`, and its cross-reference column says that is A's `A`. The
   * two labels are different text and would never join on a column lookup; the neuron carrying
   * both is the whole bridge.
   */
  it('matches a renamed label through the neuron that carries both names', () => {
    const mapping = matchCellTypes([dataset({ a1: ['A'] }), dataset({ b1: ['X', 'A'] })])
    expect(groups(mapping)).toEqual([['0:a1', '1:b1']])
  })

  /*
   * A merge. `PS008,PS009` is split into its parts on the way in, so the one maleCNS neuron
   * reaches both FlyWire types, and no partition can leave that single neuron on both sides —
   * so the merged pair becomes one shared label.
   */
  it('matches two types merged into one', () => {
    expect(groups(matchCellTypes(MERGED))).toEqual([['0:m1', '1:f1', '1:f2']])
  })

  /*
   * A split, and the interesting half of it: `A_a` and `A_b` are dropped rather than kept. They
   * sit on no path that crosses into FlyWire — FlyWire has no evidence for the split — so the
   * correspondence is at `X`, and both maleCNS neurons land in it. Keeping the finer labels
   * would claim a distinction the other brain cannot see.
   */
  it('collapses a split type onto the label the other dataset does have', () => {
    const mapping = matchCellTypes([
      dataset({ m1: ['A_a', 'X'], m2: ['A_b', 'X'] }),
      dataset({ f1: ['X'], f2: ['X'] }),
    ])
    expect(groups(mapping)).toEqual([['0:m1', '0:m2', '1:f1', '1:f2']])
  })
})

// ---------------------------------------------------------------------------

describe('what does not get a label', () => {
  it('leaves a neuron whose type exists in only one dataset unmatched, and counts it', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'], a2: ['OnlyHere'] }),
      dataset({ b1: ['LC4'] }),
    ])
    expect(labelsOf(mapping, 0)).toEqual({ a1: 'LC4' })
    expect(mapping.unmatched).toEqual([1, 0])
  })

  /*
   * A neuron with no type at all is unmatched rather than matched to an empty label — an empty
   * shared label would pool every unlabelled neuron in both brains into one enormous
   * correspondence, which is the most confidently wrong answer available.
   */
  it('leaves an untyped neuron unmatched rather than pooling the untyped together', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'], a2: [''], a3: ['   '] }),
      dataset({ b1: ['LC4'], b2: [''] }),
    ])
    expect(groups(mapping)).toEqual([['0:a1', '1:b1']])
    expect(mapping.unmatched).toEqual([2, 1])
  })

  /*
   * Nothing in the graph knows that `unknown` is not a cell type — it is a label both datasets
   * use, so it corresponds like any other and quietly asserts that these two neurons are the
   * same cells. Saying so is the caller's job, which is why this is a param rather than a list
   * of known-bad strings in here.
   */
  it('drops a bad label entirely, so nothing corresponds through it', () => {
    const rows = [
      dataset({ a1: ['LC4'], a2: ['unknown'] }),
      dataset({ b1: ['LC4'], b2: ['unknown'] }),
    ]
    expect(groups(matchCellTypes(rows))).toEqual([
      ['0:a1', '1:b1'],
      ['0:a2', '1:b2'],
    ])

    const filtered = matchCellTypes(rows, { badLabels: ['unknown'] })
    expect(groups(filtered)).toEqual([['0:a1', '1:b1']])
    expect(filtered.unmatched).toEqual([1, 1])
  })

  /*
   * One dataset has no correspondence to establish, so it produces none. The alternative — every
   * neuron taking its own most granular type — would be a *second* definition of what a shared
   * label is, living in the one function whose entire subject is the first definition.
   */
  it('matches nothing at all where there is only one dataset', () => {
    const mapping = matchCellTypes([dataset({ m1: ['MeTu4e', 'MeTu4'], m2: ['MeTu4'] })])
    expect(labelsOf(mapping, 0)).toEqual({})
    expect(mapping.unmatched).toEqual([2])
  })
})

// ---------------------------------------------------------------------------

describe('compound labels', () => {
  it('splits a compound into its parts, both ways round', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['PS008,PS009'] }),
      dataset({ b1: ['PS008'] }),
    ])
    expect(groups(mapping)).toEqual([['0:a1', '1:b1']])
  })

  it('takes the separator from the caller', () => {
    const rows = [dataset({ a1: ['PS008|PS009'] }), dataset({ b1: ['PS008'] })]
    expect(groups(matchCellTypes(rows))).toEqual([])
    expect(groups(matchCellTypes(rows, { compoundSeparator: '|' }))).toEqual([['0:a1', '1:b1']])
  })

  /*
   * The three guards, each a real label that a naive split destroys. `P1_17a,b` is the one worth
   * stating: it is a single type with two suffixes, and splitting it invents a type called `b`
   * that would then bridge everything else called `b` in both brains.
   */
  it.each([
    ['(M_adPNm4,M_adPNm5)b', 'a name that contains a comma'],
    ['CB.FB3,4A9', 'a compartment path'],
    ['P1_17a,b', 'one type with two suffixes'],
  ])('does not split %s — %s', (compound) => {
    const part = compound.split(',')[1]!
    const mapping = matchCellTypes([dataset({ a1: [compound] }), dataset({ b1: [part] })])
    expect(groups(mapping)).toEqual([])
  })

  /*
   * The naming half of the same rule, and it was wrong until it was tested: `chooseLabel` had
   * its own bare `split`, so a label the graph deliberately refused to split was split anyway
   * when it came to name the group — putting text that is not a type into a shared label.
   */
  it('does not split a guarded label when naming the group either', () => {
    const mapping = matchCellTypes(
      [dataset({ a1: ['CB.FB3,4A9'] }), dataset({ b1: ['CB.FB3,4A9'] })],
      { labelMode: 'all' },
    )
    expect(labelsOf(mapping, 0)).toEqual({ a1: 'CB.FB3,4A9' })
  })

  /*
   * Decision 3: one connectome's naming habits are settings the user can see, not behaviour
   * baked into the mapper. A deployment whose type names start with `(` for another reason can
   * say so.
   */
  it('takes the no-split prefixes from the caller', () => {
    const rows = [dataset({ a1: ['(M_adPNm4,M_adPNm5)b'] }), dataset({ b1: ['M_adPNm5)b'] })]
    expect(groups(matchCellTypes(rows))).toEqual([])
    expect(groups(matchCellTypes(rows, { noSplitPrefixes: [] }))).toEqual([['0:a1', '1:b1']])
  })
})

// ---------------------------------------------------------------------------

describe('a correspondence the data does not support', () => {
  /*
   * The mapping is **derived and only derived** — the hand-written `label ↔ label` route
   * (cocoa's `add_synonym`, once this node's `Synonyms` port) is gone, so two names for the same
   * cells that share no text stay apart. Kept as a test because it is the one behaviour somebody
   * will read as a bug: forcing the pair is a downstream `Relabel`, not a setting on here.
   */
  it('leaves two labels nothing in the data relates unmatched', () => {
    const rows = [dataset({ a1: ['LC4'] }), dataset({ b1: ['Lobula columnar 4'] })]
    expect(groups(matchCellTypes(rows))).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('a correspondence that runs through another neuron', () => {
  /*
   * cocoa's `allow_indirect` example, in miniature. `m2` reaches FlyWire only via the group
   * label it shares with `m1` and then via `m1`'s own type — an assertion about `m2` made
   * entirely out of somebody else's cell body. Off by default, because that is a claim the data
   * did not make.
   */
  const INDIRECT = [
    dataset({ m1: ['AOTU001', 'group_7'], m2: ['group_7'] }),
    dataset({ f1: ['AOTU001'] }),
  ]

  it('is refused by default, leaving the far neuron unmatched', () => {
    const mapping = matchCellTypes(INDIRECT)
    expect(groups(mapping)).toEqual([['0:m1', '1:f1']])
    expect(mapping.unmatched).toEqual([1, 0])
  })

  it('is allowed when asked for, and then carries the far neuron with it', () => {
    const mapping = matchCellTypes(INDIRECT, { allowIndirect: true })
    expect(groups(mapping)).toEqual([['0:m1', '0:m2', '1:f1']])
    expect(mapping.unmatched).toEqual([0, 0])
  })
})

// ---------------------------------------------------------------------------

describe('what the shared label is called', () => {
  it('prefers a short, non-compound name under `first`', () => {
    // `PS008,PS009` is in the component and loses to every single-part label in it.
    expect(labelsOf(matchCellTypes(MERGED, { labelMode: 'first' }), 0)).toEqual({ m1: 'PS008' })
  })

  it('names every part under `all`, so a merge reads as a merge', () => {
    expect(labelsOf(matchCellTypes(MERGED, { labelMode: 'all' }), 0)).toEqual({
      m1: 'PS008,PS009',
    })
  })

  it('names a group after its lowest id under `id`', () => {
    const mapping = matchCellTypes([dataset({ '10': ['LC4'] }), dataset({ '200': ['LC4'] })], {
      labelMode: 'id',
    })
    // Length before text — `compareIds`, not `Number`, so an eighteen-digit root id survives.
    expect(labelsOf(mapping, 0)).toEqual({ '10': '10' })
    expect(labelsOf(mapping, 1)).toEqual({ '200': '10' })
  })

  /*
   * The reason `id` mode needs a second pass at all: an id is unique only inside its own
   * dataset, so an id both brains happen to use names two different groups. Excluded rather than
   * allowed to collide.
   */
  it('will not name a group after an id that two datasets both use', () => {
    const mapping = matchCellTypes(
      [dataset({ '10': ['LC4'], '33': ['LC4'] }), dataset({ '10': ['LC4'] })],
      { labelMode: 'id' },
    )
    expect(new Set(Object.values(labelsOf(mapping, 0)))).toEqual(new Set(['33']))
  })
})

// ---------------------------------------------------------------------------

/**
 * A male-only type against a female brain, which is what the pass-through port is for. `pMP2`'s
 * component holds one dataset, so step 1 drops it — the same treatment a naming artifact gets,
 * because nothing in the data tells the two apart. `LC4` is the control that matches either way.
 */
const SEXED = [dataset({ m1: ['pMP2'], m2: ['LC4'] }), dataset({ f1: ['LC4'] })]

describe('the report', () => {
  it('counts each label per dataset, in a stable order', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'], a2: ['LC4'], a3: ['LC6'] }),
      dataset({ b1: ['LC4'], b2: ['LC4'], b3: ['LC6'] }),
    ])
    expect(mapping.report).toEqual([
      { label: 'LC4', counts: [2, 2], matched: true, suspicious: false },
      { label: 'LC6', counts: [1, 1], matched: true, suspicious: false },
    ])
  })

  /*
   * The column the mapping gets checked with. Four neurons against forty is a mapping error
   * rather than a finding, and there is nowhere else it shows up — the labels table looks the
   * same either way.
   */
  it('flags a label whose counts differ between datasets by more than a factor of two', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'] }),
      dataset({ b1: ['LC4'], b2: ['LC4'], b3: ['LC4'] }),
    ])
    expect(mapping.report).toEqual([
      { label: 'LC4', counts: [1, 3], matched: true, suspicious: true },
    ])
  })

  /*
   * The flag is off for a pass-through and that is not leniency: an unmatched label has zero
   * neurons in at least one dataset *by definition*, so the ratio is 0 for every one of them.
   * Left on, "show me every suspicious label" returns the entire pass-through list — noise
   * exactly where somebody is reading.
   */
  it('does not flag a pass-through as suspicious, and says it was not matched', () => {
    const mapping = matchCellTypes(SEXED, { keepLabels: ['pMP2'] })
    expect(mapping.report).toEqual([
      { label: 'LC4', counts: [1, 1], matched: true, suspicious: false },
      { label: 'pMP2', counts: [1, 0], matched: false, suspicious: false },
    ])
  })
})

// ---------------------------------------------------------------------------

describe('labels passed through without a counterpart', () => {
  it('drops a one-sided type by default', () => {
    const mapping = matchCellTypes(SEXED)
    expect(labelsOf(mapping, 0)).toEqual({ m2: 'LC4' })
    expect(mapping.unmatched).toEqual([1, 0])
  })

  it('keeps it when named, under its own name', () => {
    const mapping = matchCellTypes(SEXED, { keepLabels: ['pMP2'] })
    expect(labelsOf(mapping, 0)).toEqual({ m1: 'pMP2', m2: 'LC4' })
    expect(labelsOf(mapping, 1)).toEqual({ f1: 'LC4' })
    // It has a label, so it is not unmatched. The report's zero count is where the one-sidedness
    // shows, which says more than a number would.
    expect(mapping.unmatched).toEqual([0, 0])
  })

  /*
   * The property that makes this useful with three datasets: a female-specific type is in the
   * hemibrain *and* FlyWire but not the maleCNS, so step 1 drops it for want of the third — and
   * passing it through gives both female brains the same string, which is a correspondence.
   * Nothing arranges that; matching by text does it for free.
   */
  it('re-joins the datasets that do have it, matching by text', () => {
    const mapping = matchCellTypes(
      [
        dataset({ h1: ['pC1'], h2: ['LC4'] }),
        dataset({ w1: ['pC1'], w2: ['LC4'] }),
        dataset({ m1: ['LC4'] }),
      ],
      { keepLabels: ['pC1'] },
    )
    expect(groups(mapping)).toEqual([
      ['0:h1', '1:w1'],
      ['0:h2', '1:w2', '2:m1'],
    ])
  })

  it('splits a compound, so listing one part catches a neuron typed with two', () => {
    const mapping = matchCellTypes(
      [dataset({ m1: ['pMP2,pMP3'] }), dataset({ f1: ['LC4'] })],
      { keepLabels: ['pMP2'] },
    )
    expect(labelsOf(mapping, 0)).toEqual({ m1: 'pMP2' })
  })

  /*
   * The other half, and the one that matters more in practice: `buildGraph` makes a label node
   * for the whole compound *and* for each part, so `pMP2,pMP3` is a label in the mapper's space
   * too. A pass-through table is built the obvious way — filter a dataset's own type column —
   * which holds that string verbatim. Testing only the parts dropped it silently.
   */
  it('takes the whole compound when that is what was listed', () => {
    const mapping = matchCellTypes(
      [dataset({ m1: ['pMP2,pMP3'] }), dataset({ f1: ['LC4'] })],
      { keepLabels: ['pMP2,pMP3'] },
    )
    expect(labelsOf(mapping, 0)).toEqual({ m1: 'pMP2,pMP3' })
  })

  /* Both listed: the shorter, non-compound name wins, which is `chooseLabel`'s ordering. */
  it('prefers the part over the compound when both are listed', () => {
    const mapping = matchCellTypes(
      [dataset({ m1: ['pMP2,pMP3'] }), dataset({ f1: ['LC4'] })],
      { keepLabels: ['pMP2,pMP3', 'pMP2'] },
    )
    expect(labelsOf(mapping, 0)).toEqual({ m1: 'pMP2' })
  })

  /*
   * A derived label is better evidence than a list, so the matcher's answer stands. Listing a
   * type that *does* match is a no-op rather than an override — which matters because the list
   * is usually somebody's whole sex-specific annotation, wired in without checking each name.
   */
  it('leaves a matched neuron alone', () => {
    const mapping = matchCellTypes([dataset({ a1: ['LC4'] }), dataset({ b1: ['LC4'] })], {
      keepLabels: ['LC4'],
    })
    expect(mapping.report).toEqual([
      { label: 'LC4', counts: [1, 1], matched: true, suspicious: false },
    ])
  })

  /** Contradictory instructions, and the destructive reading is the safe one. */
  it('lets `badLabels` win over a label named in both', () => {
    const mapping = matchCellTypes([dataset({ m1: ['junk'] }), dataset({ f1: ['LC4'] })], {
      badLabels: ['junk'],
      keepLabels: ['junk'],
    })
    expect(labelsOf(mapping, 0)).toEqual({})
  })

  /*
   * `id` mode names each matched *group* by a neuron id, which a pass-through is not part of —
   * and replacing `pMP2` with `#0` would hide the one thing the user asked to see. It also has
   * to survive `resolveIdLabels`, which renames every label it is handed.
   */
  it('keeps its own name under `id` mode', () => {
    const mapping = matchCellTypes(
      [dataset({ m1: ['pMP2'], m2: ['LC4'] }), dataset({ f1: ['LC4'] })],
      { keepLabels: ['pMP2'], labelMode: 'id' },
    )
    expect(labelsOf(mapping, 0)).toEqual({ m1: 'pMP2', m2: 'f1' })
  })

  it('does nothing for a name no dataset uses', () => {
    expect(labelsOf(matchCellTypes(SEXED, { keepLabels: ['nope'] }), 0)).toEqual({ m2: 'LC4' })
  })
})

// ---------------------------------------------------------------------------

describe('the properties the node depends on', () => {
  /*
   * Invariant 4: `evaluate` must be deterministic or declare a nonce. The greedy agglomeration
   * inside the split is where that could go wrong — it merges whichever pair scores best, and
   * ties are common on a small type component — so the tie-break is on node index rather than on
   * iteration order.
   */
  it('gives the same answer twice', () => {
    const rows = [FLYWIRE_LEFT, FLYWIRE_RIGHT, HEMIBRAIN]
    expect(matchCellTypes(rows)).toEqual(matchCellTypes(rows))
  })

  it('keeps ids as text, exactly', () => {
    // Eighteen digits: `Number('720575940643300974')` is a different neuron (invariant 8).
    const mapping = matchCellTypes([FLYWIRE_LEFT, FLYWIRE_RIGHT])
    expect([...mapping.labels[0]!.keys()]).toContain('720575940643300974')
  })

  it('answers nothing for no datasets, and does not throw', () => {
    expect(matchCellTypes([])).toEqual({
      labels: [],
      report: [],
      unmatched: [],
      graph: { nodes: [], edges: [] },
    })
  })
})

// ---------------------------------------------------------------------------

describe('the guard rail', () => {
  /*
   * A guard rail warns, it does not refuse ([limits.md](../../../docs/limits.md)). The trim and
   * the split are both quadratic in a component's size, and a component of thousands means one
   * generic label has fused everything — so the answer is coarser labels plus a message naming
   * the cause, rather than a stalled tab or a refusal to map anything at all.
   */
  it('matches an enormous component without splitting it, and says so', () => {
    const rows = (prefix: string) =>
      dataset(
        Object.fromEntries(
          Array.from({ length: COMPONENT_NODE_CAP }, (_, i) => [
            `${prefix}${i}`,
            ['everything', `${prefix}t${i}`],
          ]),
        ),
      )
    const warnings: string[] = []
    const mapping = matchCellTypes([rows('a'), rows('b')], {
      warn: { warn: (m) => warnings.push(m) },
    })

    // `warnOverThreshold`'s phrasing rather than a bespoke sentence: what went past, what it
    // went past, what it costs, and that there is a result on the other side of it.
    expect(warnings.join(' ')).toMatch(/is past the size a component can still be trimmed/)
    expect(warnings.join(' ')).toMatch(/ignored labels.*Going ahead anyway/s)
    // Every neuron matched, all under the one label the generic bridge produced.
    expect(mapping.unmatched).toEqual([0, 0])
    expect(mapping.report).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

/**
 * The two seams where a table crosses into the mapper, and the two where the result crosses out.
 *
 * These have a node on top of them (`nodes/analysis/matchTypes.test.ts`), which is where the
 * ports and the fetching are tested. What is here is what that node cannot see: the per-cell
 * rules about which values count, and the exact column layout of what comes back — the halves
 * invariant 3 pairs, tested against each other rather than through a run.
 */
describe('reading a table into the mapper', () => {
  const NEURONS = tableFromRows(
    tableSchema(
      column('neuronId', 'str'),
      column('type', 'str'),
      column('flywireType', 'str'),
      column('size', 'i64'),
    ),
    [
      { neuronId: '720575940643300974', type: 'AOTU008a', flywireType: 'AOTU008', size: 12 },
      { neuronId: '861237679', type: 'AOTU008', flywireType: '', size: 4 },
    ],
  )

  it('takes every named column as a label and ignores the rest', () => {
    expect(mapperDatasetFrom(NEURONS, ['type', 'flywireType'])).toEqual([
      { id: '720575940643300974', labels: ['AOTU008a', 'AOTU008'] },
      // The blank is an absence, not a label: an empty shared label would pool every unlabelled
      // neuron in both brains into one enormous correspondence.
      { id: '861237679', labels: ['AOTU008'] },
    ])
  })

  it('keeps a neuron that has no labels at all, so the unmatched count is honest', () => {
    // The second row's `flywireType` is blank, so it comes through carrying nothing.
    const kept = mapperDatasetFrom(NEURONS, ['flywireType'])
    expect(kept).toEqual([
      { id: '720575940643300974', labels: ['AOTU008'] },
      { id: '861237679', labels: [] },
    ])
    // Dropping it here would quietly shrink the denominator and make a mapping that covered a
    // tenth of a brain report as though it covered all of it.
    expect(matchCellTypes([kept, kept]).unmatched).toEqual([1, 1])
  })

  it('reads a number column as text rather than refusing it', () => {
    // A type column is usually `str`, but a numeric group id is a real label — cocoa's
    // `mcns_group_` case — and refusing it would silently drop the grouping it encodes.
    expect(mapperDatasetFrom(NEURONS, ['size'])[0]!.labels).toEqual(['12'])
  })

  /*
   * Invariant 8 at the one seam that can enforce it. A source that publishes its id column as
   * `i64` has *already* rounded an eighteen-digit root id by the time this reads it —
   * `Number('720575940643300974')` is `720575940643300975`, a neuron that may well exist — so
   * the honest answer is to drop the row rather than to map somebody else's cell under it. A
   * narrower id in the same column is exact and comes through.
   */
  it('drops a wide id that arrived as a number rather than mapping a rounded one', () => {
    const numeric = tableFromRows(
      tableSchema(column('neuronId', 'i64'), column('type', 'str')),
      [
        // Written as a conversion rather than a literal because the literal is one the
        // linter refuses — which is the whole point being tested.
        { neuronId: Number('720575940643300974'), type: 'AOTU008a' },
        { neuronId: 861237679, type: 'AOTU008' },
      ],
    )
    expect(mapperDatasetFrom(numeric, ['type'])).toEqual([
      { id: '861237679', labels: ['AOTU008'] },
    ])
  })

  it('answers nothing for a column that is not there', () => {
    expect(mapperDatasetFrom(NEURONS, ['nope'])[0]).toEqual({
      id: '720575940643300974',
      labels: [],
    })
    expect(mapperDatasetFrom(NEURONS, ['type'], 'missingIdColumn')).toEqual([])
  })
})

describe('reading the pass-through table', () => {
  const NAMES = tableFromRows(tableSchema(column('type', 'str'), column('note', 'str')), [
    { type: 'pMP2', note: 'male' },
    { type: ' pMP2 ', note: 'male, again' },
    { type: '', note: 'no name' },
    { type: 'pC1', note: 'female' },
  ])

  // Trimmed, blank-free and deduplicated, so `matchCellTypes` gets a list rather than a column.
  it('takes the named column as a set of labels', () => {
    expect(keepLabelsFrom(NAMES, 'type')).toEqual(['pMP2', 'pC1'])
  })

  /* Nothing wired and no column chosen are both legitimate — and the common — states. */
  it.each([
    ['nothing wired', undefined, 'type'],
    ['no column chosen', NAMES, undefined],
    ['a column that is not there', NAMES, 'nope'],
  ])('answers nothing for %s', (_case, table, chosen) => {
    expect(keepLabelsFrom(table, chosen)).toEqual([])
  })
})

describe('writing the mapping back out', () => {
  const MAPPING = matchCellTypes([
    dataset({ a1: ['LC4'], a2: ['LC4'], a3: ['LC4'] }),
    dataset({ b1: ['LC4'] }),
  ])

  it('emits one labels row per matched neuron, keyed by the id column', () => {
    const table = mapperLabelsTable(MAPPING.labels[0]!)
    expect(table.schema).toEqual(MAPPER_LABELS_SCHEMA)
    expect(table.length).toBe(3)
    // Text, exactly — the column is `str` and the values came in as text (invariant 8).
    expect(table.data['neuronId']).toEqual(['a1', 'a2', 'a3'])
    expect(table.data['label']).toEqual(['LC4', 'LC4', 'LC4'])
  })

  /*
   * Long form, one row per (label, dataset). That is what keeps the schema constant while the
   * *number* of datasets is not — a count column per dataset would make this the one table whose
   * columns the node's port declaration and its `evaluate` derived separately.
   */
  it('emits the report long, naming each dataset on its own row', () => {
    const table = mapperReportTable(MAPPING.report, ['flywire', 'hemibrain'])
    expect(table.schema).toEqual(MAPPER_REPORT_SCHEMA)
    expect(table.length).toBe(2)
    expect(table.data['label']).toEqual(['LC4', 'LC4'])
    expect(table.data['dataset']).toEqual(['flywire', 'hemibrain'])
    expect(table.data['nNeurons']).toEqual([3, 1])
    // Both flags are about the *label*, so they repeat down that label's rows — the trade long
    // form makes, and what turns "show me every suspicious label" into one filter.
    expect(table.data['matched']).toEqual([true, true])
    expect(table.data['suspicious']).toEqual([true, true])
  })
})

describe('reading a labels table back', () => {
  /** The shape `mapperLabelsTable` writes, through its own constant so a rename reaches here. */
  const labels = (pairs: Array<[string, string]>) =>
    tableFromRows(
      MAPPER_LABELS_SCHEMA,
      pairs.map(([neuronId, label]) => ({ neuronId, label })),
    )

  it('drops a wide id that arrived as a number rather than mapping a rounded one', () => {
    /*
     * Invariant 8 at this seam. `720575940643300974` as an `i64` cell is a float64 holding
     * `720575940643300992` — a different neuron — so `idText` refuses it. Mapping the rounded
     * value would attach a label to whichever neuron happened to own it.
     */
    const wide = tableSchema(column('neuronId', 'i64'), column('label', 'str'))
    const lossy = tableFromRows(wide, [
      { neuronId: Number('720575940643300974'), label: 'LC4' },
    ])
    expect(labelsByNeuron(lossy).size).toBe(0)
  })

  it('keeps the first of a repeated id', () => {
    expect(
      labelsByNeuron(
        labels([
          ['1', 'first'],
          ['1', 'second'],
        ]),
      ).get('1'),
    ).toBe('first')
  })

  it('reads a blank label as no label rather than as a label named blank', () => {
    expect(labelsByNeuron(labels([['1', '']])).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------

/**
 * The label graph on its way to the Network Viewer.
 *
 * The graph *is* the algorithm, so a drawing of it is the only way to see why two types
 * corresponded and why two others did not — which means what has to be pinned is not that it
 * has some shape but that its shape is the one the walk actually used.
 */
describe('the graph the answer was read off', () => {
  /** `LC4` matched both ways; `pMP2` is male-only, so its component holds one dataset. */
  const MAPPING = matchCellTypes([
    dataset({ m1: ['LC4'], m2: ['LC4'], m3: ['pMP2'] }),
    dataset({ f1: ['LC4'] }),
  ])

  it('carries a node per label and per neuron group, not per neuron', () => {
    const { nodes } = MAPPING.graph
    // `m1` and `m2` share a label set, so they are one node weighing 2 — cocoa's
    // `collapse_neuron_nodes`, done at construction. Four groups would mean it stopped.
    expect(nodes.filter((n) => n.kind === 'neurons').map((n) => n.nNeurons).sort()).toEqual([
      1, 1, 2,
    ])
    expect(nodes.filter((n) => n.kind === 'label').map((n) => n.name).sort()).toEqual([
      'LC4',
      'pMP2',
    ])
  })

  it("gives a label node the neurons that carry it, so one size encoding reads on both kinds", () => {
    const lc4 = MAPPING.graph.nodes.find((n) => n.name === 'LC4')
    expect(lc4?.nNeurons).toBe(3)
  })

  /*
   * The whole point of the port: every component, including the one step 1 dropped. `pMP2` is
   * there and is marked as having matched nothing, which is the answer to "why did this not come
   * through" — and it is only answerable because the dropped components are kept.
   */
  it('keeps the components that did not match, and says they did not', () => {
    const named = Object.fromEntries(MAPPING.graph.nodes.map((n) => [n.name, n.label]))
    expect(named['LC4']).toBe('LC4')
    expect(named['pMP2']).toBe('')
  })

  it('records an undirected edge once, weighted by the neurons behind it', () => {
    const { nodes, edges } = MAPPING.graph
    // Sorted ends, because the pair is undirected and which index came first is an artifact of
    // construction order rather than something a drawing should depend on.
    const drawn = edges
      .map((e) => [nodes[e.source]!.name, nodes[e.target]!.name].sort().join('-') + `:${e.weight}`)
      .sort()
    // `m1` names the group holding m1 and m2, so its edge to LC4 weighs 2 — the group's size,
    // which is the number `collapse_neuron_nodes` gets by summing. Once per pair, not twice.
    expect(drawn).toEqual(['LC4-f1:1', 'LC4-m1:2', 'm3-pMP2:1'])
  })

  /*
   * A label is a string somebody typed into an annotation table, so one called
   * `flywire:720575940623374218` is possible. Unprefixed it would be the same id as the neuron
   * group it names, and `net.build`'s own rule — one row per id — would merge two nodes silently.
   */
  it('prefixes node ids by kind, so a label cannot collide with a neuron group', () => {
    const net = mapperNetwork(MAPPING.graph, ['maleCNS', 'hemibrain'])
    const ids = (net.nodes.data['id'] as unknown[]).map(String)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('label/LC4')
    expect(ids).toContain('neurons/maleCNS:m1')
    // The dataset column names the brain; the id qualifies it, decision 1's grammar.
    expect(net.nodes.data['dataset']).toContain('hemibrain')
  })

  /*
   * Undirected, because the graph is: `adjacency` records every edge both ways and the split
   * reads one weight per pair. Arrowheads would assert a direction the algorithm does not have.
   */
  it('is undirected, and every link names nodes that are in it', () => {
    const net = mapperNetwork(MAPPING.graph, ['a', 'b'])
    expect(net.directed).toBe(false)
    const ids = new Set((net.nodes.data['id'] as unknown[]).map(String))
    for (const end of ['source', 'target']) {
      for (const cell of net.edges.data[end] as unknown[]) expect(ids.has(String(cell))).toBe(true)
    }
    expect(net.edges.data['kind']).toEqual(['membership', 'membership', 'membership'])
  })

  it('marks a compound edge as one', () => {
    const compound = matchCellTypes([
      dataset({ m1: ['PS008,PS009'] }),
      dataset({ f1: ['PS008'] }),
    ])
    const net = mapperNetwork(compound.graph, ['a', 'b'])
    expect(net.edges.data['kind']).toContain('compound')
  })

  /*
   * One dataset has no correspondence to establish, but it still has a label graph — and a port
   * that went empty at an arity nobody thinks to test is the other kind of surprise.
   */
  it('is built even with one dataset, where nothing can match', () => {
    const alone = matchCellTypes([dataset({ m1: ['LC4'] })])
    expect(alone.graph.nodes).toHaveLength(2)
    expect(alone.graph.nodes.every((n) => n.label === '')).toBe(true)
  })

  /*
   * `id` mode names each matched group by a neuron id, and the graph has to follow: a view built
   * before `resolveIdLabels` would say `#0` where every other output says an id.
   */
  it('follows the id-mode rename', () => {
    const byId = matchCellTypes([dataset({ m1: ['LC4'] }), dataset({ f1: ['LC4'] })], {
      labelMode: 'id',
    })
    const lc4 = byId.graph.nodes.find((n) => n.name === 'LC4')
    expect(lc4?.label).toBe('f1')
    expect(lc4?.label.startsWith('#')).toBe(false)
  })
})
