/**
 * Type-level edge comparison, the algorithm.
 *
 * The node's own contract is in `analysis/compareConnectivity.test.ts`; what is pinned here is
 * everything that produces a plausible wrong table rather than an error — which is most of it,
 * because every output of this module is a number somebody will read as biology.
 *
 * The load-bearing case is decision 6: **0 and null are different answers**, and getting them
 * the wrong way round turns "this connection does not exist in the hemibrain" into "nobody
 * looked", or worse the reverse. cocoa does neither and drops the rows; the tests here are the
 * argument that keeping them is affordable.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import {
  COUNTS_SCHEMA,
  EDGE_TOTAL_RATIO_WARN,
  compareConnectivity,
  compareEdges,
  comparisonSchema,
  countsTable,
  labelledEdgesFrom,
  totalsRatio,
} from './edgeComparison'
import { labelsByNeuron } from './typeMapping'

const EDGES = tableSchema(column('pre', 'str'), column('post', 'str'), column('weight', 'i64'))
const LABELS = tableSchema(column('neuronId', 'str'), column('label', 'str'))

function edges(rows: Array<[string, string, number]>): TableValue {
  return tableFromRows(
    EDGES,
    rows.map(([pre, post, weight]) => ({ pre, post, weight })),
  )
}

function labels(pairs: Array<[string, string]>): TableValue {
  return tableFromRows(
    LABELS,
    pairs.map(([neuronId, label]) => ({ neuronId, label })),
  )
}

const COLUMNS = { pre: 'pre', post: 'post', weight: 'weight' }

/**
 * The comparison table read back as rows, keyed `pre->post`.
 *
 * A test-only view. `compareEdges` builds its columns directly — a row-shaped intermediate was
 * measured at over a gigabyte of allocate-and-drop at whole-brain scale — so the readable shape
 * lives here rather than in the module under test.
 */
function rowsOf(comparison: TableValue, names: readonly string[]) {
  const rows = new Map<
    string,
    { pre: string; post: string; weights: (number | null)[]; present: boolean[] }
  >()
  for (let i = 0; i < comparison.length; i++) {
    const pre = String(comparison.data.preLabel![i])
    const post = String(comparison.data.postLabel![i])
    rows.set(`${pre}->${post}`, {
      pre,
      post,
      weights: names.map((name) => comparison.data[`weight_${name}`]![i] as number | null),
      present: names.map((name) => comparison.data[`present_${name}`]![i] as boolean),
    })
  }
  return rows
}

/** One dataset, from the two tables the node wires in. */
function dataset(
  name: string,
  edgeRows: Array<[string, string, number]>,
  labelRows: Array<[string, string]>,
) {
  return labelledEdgesFrom(name, edges(edgeRows), labelsByNeuron(labels(labelRows)), COLUMNS)
}

describe('relabelling and summing one dataset', () => {
  it('pools every neuron of a label into one edge', () => {
    // Two LC4s onto one DNp01 is one LC4→DNp01 edge of 30, which is the entire point of working
    // at the type level.
    const a = dataset(
      'A',
      [
        ['1', '3', 20],
        ['2', '3', 10],
      ],
      [
        ['1', 'LC4'],
        ['2', 'LC4'],
        ['3', 'DNp01'],
      ],
    )
    expect([...a.weights.values()].map((pair) => pair.weight)).toEqual([30])
    expect(a.labels.get('LC4')).toEqual({ neurons: 2, out: 30, in: 0 })
    expect(a.labels.get('DNp01')).toEqual({ neurons: 1, out: 0, in: 30 })
  })

  it('drops an edge whose either end has no label, and keeps the other end out of the counts', () => {
    /*
     * `relabelTable`'s `unmatched: 'drop'`, and the same reasoning: an unlabelled neuron has no
     * place in a label-level comparison. What matters here is the *second* clause — the labelled
     * end of a dropped edge must not contribute to `counts` either, or a normalisation divides
     * by a weight that is not in `comparison`.
     */
    const a = dataset(
      'A',
      [
        ['1', '3', 20],
        ['1', '9', 40],
      ],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
      ],
    )
    expect([...a.weights.values()].map((pair) => pair.weight)).toEqual([20])
    expect(a.labels.get('LC4')!.out).toBe(20)
  })

  it('counts a neuron once however many edges it has', () => {
    const a = dataset(
      'A',
      [
        ['1', '3', 5],
        ['1', '4', 5],
      ],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
        ['4', 'DNp01'],
      ],
    )
    expect(a.labels.get('LC4')!.neurons).toBe(1)
    expect(a.labels.get('DNp01')!.neurons).toBe(2)
  })

  it('reads the pool from the mapping, not from the edges', () => {
    // The distinction the whole 0-vs-null rule rests on: a label nothing connected to is still a
    // label this dataset could have answered about.
    const a = dataset(
      'A',
      [['1', '3', 5]],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
        ['7', 'LPLC1'],
      ],
    )
    expect(a.pool.has('LPLC1')).toBe(true)
    expect(a.labels.has('LPLC1')).toBe(false)
  })

  it('counts each edge as one where no weight column is given', () => {
    const plain = labelledEdgesFrom(
      'A',
      edges([
        ['1', '3', 99],
        ['2', '3', 99],
      ]),
      labelsByNeuron(
        labels([
          ['1', 'LC4'],
          ['2', 'LC4'],
          ['3', 'DNp01'],
        ]),
      ),
      { pre: 'pre', post: 'post' },
    )
    expect([...plain.weights.values()].map((pair) => pair.weight)).toEqual([2])
  })

  it('keeps a label pair distinct from one that concatenates to the same text', () => {
    // `rowKey`'s separator rule: without it `("ab","c")` and `("a","bc")` are one row.
    const a = dataset(
      'A',
      [
        ['1', '2', 5],
        ['3', '4', 7],
      ],
      [
        ['1', 'ab'],
        ['2', 'c'],
        ['3', 'a'],
        ['4', 'bc'],
      ],
    )
    expect(a.weights.size).toBe(2)
    const { comparison } = compareEdges([a], ['A'])
    expect([...rowsOf(comparison, ['A']).keys()]).toEqual(['ab->c', 'a->bc'])
  })
})

describe('absent versus unsampled', () => {
  /*
   * A knows LC4, DNp01 and LPLC1; B knows only LC4 and DNp01. So for the pair LPLC1→DNp01, B was
   * never in a position to answer — where for LC4→DNp01, B holds both labels and simply has no
   * such connection.
   */
  const a = () =>
    dataset(
      'A',
      [
        ['1', '3', 20],
        ['7', '3', 4],
      ],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
        ['7', 'LPLC1'],
      ],
    )
  const b = () =>
    dataset(
      'B',
      [['12', '13', 6]],
      [
        ['11', 'LC4'],
        ['12', 'PLP001'],
        ['13', 'DNp01'],
      ],
    )

  const compared = () => rowsOf(compareEdges([a(), b()], ['A', 'B']).comparison, ['A', 'B'])

  it('reports a real absence as zero', () => {
    // B holds both LC4 and DNp01 and has no edge between them. That is a finding.
    const row = compared().get('LC4->DNp01')!
    expect(row.weights).toEqual([20, 0])
    expect(row.present).toEqual([true, true])
  })

  it('reports an unasked question as null, not as zero', () => {
    // B has no LPLC1 at all, so "0 synapses" would be a claim nothing supports.
    const row = compared().get('LPLC1->DNp01')!
    expect(row.weights).toEqual([4, null])
    expect(row.present).toEqual([true, false])
  })

  it('keeps a pair only one dataset could see, rather than intersecting the labels away', () => {
    // cocoa's `Comparison.compile` drops this row. Keeping it is the asymmetry somebody ran the
    // comparison to find.
    const row = compared().get('PLP001->DNp01')!
    expect(row.weights).toEqual([null, 6])
    expect(row.present).toEqual([false, true])
  })

  it('never reports a weight with `present` false that came from nowhere', () => {
    for (const row of compared().values()) {
      row.present.forEach((seen: boolean, i: number) => {
        if (!seen) return
        // present true means the dataset could answer, so it always has a number.
        expect(row.weights[i]).not.toBeNull()
      })
    }
  })
})

describe('minWeight', () => {
  const a = () =>
    dataset(
      'A',
      [
        ['1', '3', 1],
        ['7', '3', 40],
      ],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
        ['7', 'LPLC1'],
      ],
    )
  const b = () =>
    dataset(
      'B',
      [
        ['11', '13', 40],
        ['17', '13', 1],
      ],
      [
        ['11', 'LC4'],
        ['13', 'DNp01'],
        ['17', 'LPLC1'],
      ],
    )

  it('keeps a pair that any dataset reaches, so an asymmetry survives its own threshold', () => {
    /*
     * The whole reason the threshold is per *row* rather than per value: LC4→DNp01 is 1 in A and
     * 40 in B, which is exactly what somebody sets a threshold hoping to see past — not the noise
     * they meant to trim. Thresholding per dataset would suppress A's 1 into a 0 that then means
     * "below the threshold" as well as "really absent".
     */
    const rows = rowsOf(compareEdges([a(), b()], ['A', 'B'], 10).comparison, ['A', 'B'])
    expect(rows.get('LC4->DNp01')!.weights).toEqual([1, 40])
    expect(rows.get('LPLC1->DNp01')!.weights).toEqual([40, 1])
  })

  it('drops a pair no dataset reaches', () => {
    const quiet = dataset(
      'A',
      [['1', '3', 2]],
      [
        ['1', 'LC4'],
        ['3', 'DNp01'],
      ],
    )
    expect(compareEdges([quiet], ['A'], 10).comparison.length).toBe(0)
    expect(compareEdges([quiet], ['A'], 2).comparison.length).toBe(1)
  })
})

describe('the ratio warning', () => {
  it('is the widest pair, not the first against the rest', () => {
    expect(totalsRatio([100, 100, 10])).toBe(10)
    expect(totalsRatio([10, 100, 100])).toBe(10)
  })

  it('says nothing where a dataset contributed nothing', () => {
    // Zero is not a factor of anything, and "infinitely different" is not the sentence to print.
    expect(totalsRatio([100, 0])).toBe(0)
    expect(totalsRatio([100])).toBe(0)
  })

  it('warns with both totals once the datasets are that far apart, and refuses nothing', () => {
    const warnings: string[] = []
    const warner = { warn: (message: string) => warnings.push(message) }
    const out = compareConnectivity(
      [
        {
          name: 'A',
          edges: edges([['1', '3', 1000]]),
          labels: labels([
            ['1', 'LC4'],
            ['3', 'DNp01'],
          ]),
          columns: COLUMNS,
        },
        {
          name: 'B',
          edges: edges([['11', '13', 10]]),
          labels: labels([
            ['11', 'LC4'],
            ['13', 'DNp01'],
          ]),
          columns: COLUMNS,
        },
      ],
      { warn: warner },
    )
    expect(warnings).toHaveLength(1)
    // The ratio is what a reader acts on; the threshold only decides how often it is printed.
    expect(warnings[0]).toMatch(/factor of 100\.0/)
    expect(warnings[0]).toMatch(/A 1,000/)
    expect(warnings[0]).toMatch(/B 10/)
    // Warned, not refused: the table is there and complete.
    expect(out.comparison.length).toBe(1)
  })

  it('stays quiet inside the threshold', () => {
    const warnings: string[] = []
    const near = (weight: number) => ({
      name: String(weight),
      edges: edges([['1', '3', weight]]),
      labels: labels([
        ['1', 'LC4'],
        ['3', 'DNp01'],
      ]),
      columns: COLUMNS,
    })
    compareConnectivity([near(100), near(100 * EDGE_TOTAL_RATIO_WARN)], {
      warn: { warn: (m: string) => warnings.push(m) },
    })
    expect(warnings).toEqual([])
  })
})

describe('the tables', () => {
  const inputs = () => [
    {
      name: 'flywire',
      edges: edges([
        ['1', '3', 20],
        ['2', '3', 10],
      ]),
      labels: labels([
        ['1', 'LC4'],
        ['2', 'LC4'],
        ['3', 'DNp01'],
      ]),
      columns: COLUMNS,
    },
    {
      name: 'hemibrain',
      edges: edges([['11', '13', 6]]),
      labels: labels([
        ['11', 'LC4'],
        ['13', 'DNp01'],
      ]),
      columns: COLUMNS,
    },
  ]

  it('publishes the columns it produces, two per dataset and named after them', () => {
    const { comparison } = compareConnectivity(inputs())
    const declared = comparisonSchema(['flywire', 'hemibrain'])
    expect(comparison.schema.columns).toEqual(declared.columns)
    expect(declared.columns.map((c) => c.name)).toEqual([
      'preLabel',
      'postLabel',
      'weight_flywire',
      'weight_hemibrain',
      'present_flywire',
      'present_hemibrain',
    ])
  })

  it('holds the weights side by side, which is the whole product', () => {
    const { comparison } = compareConnectivity(inputs())
    expect(comparison.data.preLabel).toEqual(['LC4'])
    expect(comparison.data.weight_flywire).toEqual([30])
    expect(comparison.data.weight_hemibrain).toEqual([6])
  })

  it('emits counts long, with a constant schema whatever the arity', () => {
    const { counts } = compareConnectivity(inputs())
    expect(counts.schema).toEqual(COUNTS_SCHEMA)
    const rows = new Map(
      Array.from({ length: counts.length }, (_, i) => [
        `${counts.data.label![i]}/${counts.data.dataset![i]}`,
        {
          n: counts.data.nNeurons![i],
          out: counts.data.outWeight![i],
          in: counts.data.inWeight![i],
        },
      ]),
    )
    expect(rows.get('LC4/flywire')).toEqual({ n: 2, out: 30, in: 0 })
    expect(rows.get('DNp01/flywire')).toEqual({ n: 1, out: 0, in: 30 })
    expect(rows.get('LC4/hemibrain')).toEqual({ n: 1, out: 6, in: 0 })
  })

  it('separates out from in, which is what the design record could not express', () => {
    /*
     * Both directions, so all three normalisations decision 5 names are a Join away: per-neuron
     * mean divides by `nNeurons`, input fraction by the *post* label's `inWeight`, and global
     * scaling by the sum of `outWeight` — which a single both-ends column would double.
     */
    const reciprocal = compareConnectivity([
      {
        name: 'A',
        edges: edges([
          ['1', '3', 20],
          ['3', '1', 5],
        ]),
        labels: labels([
          ['1', 'LC4'],
          ['3', 'DNp01'],
        ]),
        columns: COLUMNS,
      },
    ]).counts
    const at = (label: string) =>
      Array.from({ length: reciprocal.length }, (_, i) => i).find(
        (i) => reciprocal.data.label![i] === label,
      )!
    expect(reciprocal.data.outWeight![at('LC4')]).toBe(20)
    expect(reciprocal.data.inWeight![at('LC4')]).toBe(5)
    // The dataset's own total is the sum of one column, not half the sum of a combined one.
    const total = (reciprocal.data.outWeight as number[]).reduce((sum, w) => sum + w, 0)
    expect(total).toBe(25)
  })

  it('is empty and still shaped where nothing corresponds', () => {
    const empty = compareConnectivity([
      {
        name: 'A',
        edges: edges([['1', '3', 5]]),
        labels: labels([['9', 'LC4']]),
        columns: COLUMNS,
      },
    ])
    expect(empty.comparison.length).toBe(0)
    expect(empty.counts.length).toBe(0)
    expect(empty.comparison.schema.columns.map((c) => c.name)).toContain('weight_A')
  })
})

describe('schema and value halves agree', () => {
  it('for every arity', () => {
    // Invariant 3, and here the schema is *not* a constant — it is two columns per dataset named
    // after params, so the two halves have a real chance to disagree.
    for (const names of [['A'], ['A', 'B'], ['A', 'B', 'C', 'D']]) {
      const sources = names.map((name) =>
        dataset(
          name,
          [['1', '3', 5]],
          [
            ['1', 'LC4'],
            ['3', 'DNp01'],
          ],
        ),
      )
      const built = compareEdges(sources, names).comparison
      expect(built.schema.columns).toEqual(comparisonSchema(names).columns)
      expect(countsTable(sources).schema).toEqual(COUNTS_SCHEMA)
    }
  })
})
