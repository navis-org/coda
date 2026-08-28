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

import type { MapperDataset, TypeMapping } from './typeMapping'
import { COMPONENT_NODE_CAP, matchCellTypes } from './typeMapping'

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

describe('hand-written correspondence', () => {
  /*
   * The `extra` port's whole purpose. `LC4` and `Lobula columnar 4` are the same cells under two
   * naming conventions and share no text, so nothing in the data will ever join them.
   */
  it('joins two labels nothing in the data relates', () => {
    const rows = [dataset({ a1: ['LC4'] }), dataset({ b1: ['Lobula columnar 4'] })]
    expect(groups(matchCellTypes(rows))).toEqual([])
    expect(
      groups(
        matchCellTypes(rows, { synonyms: [{ label: 'LC4', synonym: 'Lobula columnar 4' }] }),
      ),
    ).toEqual([['0:a1', '1:b1']])
  })

  it('ignores a synonym naming a label that was declared bad', () => {
    const mapping = matchCellTypes([dataset({ a1: ['LC4'] }), dataset({ b1: ['junk'] })], {
      badLabels: ['junk'],
      synonyms: [{ label: 'LC4', synonym: 'junk' }],
    })
    expect(groups(mapping)).toEqual([])
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

describe('the report', () => {
  it('counts each label per dataset, in a stable order', () => {
    const mapping = matchCellTypes([
      dataset({ a1: ['LC4'], a2: ['LC4'], a3: ['LC6'] }),
      dataset({ b1: ['LC4'], b2: ['LC4'], b3: ['LC6'] }),
    ])
    expect(mapping.report).toEqual([
      { label: 'LC4', counts: [2, 2], suspicious: false },
      { label: 'LC6', counts: [1, 1], suspicious: false },
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
    expect(mapping.report).toEqual([{ label: 'LC4', counts: [1, 3], suspicious: true }])
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
    expect(matchCellTypes([])).toEqual({ labels: [], report: [], unmatched: [] })
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
