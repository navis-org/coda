/**
 * The population filters — the checkboxes, the projection, and the local filter.
 *
 * `data/neuprint/neuprint.test.ts` pins what they compile to against a server, and
 * `nodes/dataset/dataset.test.ts` pins which nodes offer them. What is left is the middle, and
 * every case here fails as a **count** rather than as an error: too many rows if a filter is
 * dropped, too few if the OR is joined as an AND, none at all if one is compiled against a
 * dataset with no such column.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PopulationFilter } from '../../core/types'
import type { DatasetValue, TableValue } from '../../core/values'
import {
  narrowPopulation,
  populationRows,
  resolvePopulation,
  typeColumns,
} from '../../data/neuronFilter'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource } from '../../data/source'
import { neuronSetRequest } from './datasetParam'
import { populationFrom, populationIssues, populationValue } from './populationParams'

const DATASET = mockDatasetIds()[0]!

let source: MockSource

beforeAll(() => {
  source = registerSource(new MockSource({ latencyMs: 0 })) as MockSource
})

const NEURONS = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('status', 'str'),
  column('superclass', 'str'),
  column('flywireType', 'str'),
  column('celltypePredictedNt', 'str'),
)
const BARE = tableSchema(column('neuronId', 'i64'), column('status', 'str'))

const dataset = (population?: PopulationFilter[]): DatasetValue => ({
  kind: 'dataset',
  sourceId: 'mock',
  datasetId: DATASET,
  label: 'x',
  ...(population ? { population } : {}),
})

describe('which columns answer "typed"', () => {
  /*
   * A suffix, not a substring, and this is the whole of why. male-CNS publishes per-cell-type
   * neurotransmitter predictions, and a column like `celltypePredictedNt` is populated for very
   * nearly every neuron — folded into the OR, "Typed only" passes every row in the dataset while
   * the card says it is on and the count does not move.
   */
  it('takes every column ending in type and nothing merely describing one', () => {
    expect(typeColumns(NEURONS)).toEqual(['type', 'flywireType'])
  })

  it('is case-insensitive, because the datasets are not consistent about it', () => {
    const schema = tableSchema(column('cell_TYPE', 'str'), column('hemibrainType', 'str'))
    expect(typeColumns(schema)).toEqual(['cell_TYPE', 'hemibrainType'])
  })

  it('is empty on a dataset with none, which is a real answer rather than an error', () => {
    expect(typeColumns(BARE)).toEqual([])
    expect(typeColumns(undefined)).toEqual([])
  })

  /*
   * The guard that keeps this from being the failure it replaces. A filter naming a column the
   * dataset does not publish is dropped rather than compiled into a clause matching nothing — so
   * the run returns too many rows rather than none, which is the direction somebody can see.
   */
  it('drops a filter the dataset publishes no column for, keeping the rest', () => {
    expect(resolvePopulation(['traced', 'superclass'], BARE)).toEqual(['traced'])
    expect(resolvePopulation(['superclass'], BARE)).toEqual([])
  })

  // Declaration order, not the caller's, so two nodes asking for the same set produce the same
  // clause and the same provenance key whichever way the boxes were ticked.
  it('answers in declaration order rather than the order asked', () => {
    expect(resolvePopulation(['superclass', 'traced'], NEURONS)).toEqual([
      'traced',
      'superclass',
    ])
  })
})

describe('reading the params', () => {
  /*
   * The back-compatibility rule. `defaultParams` writes a default in when a node is created and
   * never runs over `deserializeGraph`, so absent describes a node built before the param
   * existed — one that queried every neuron.
   */
  it('reads absent and an explicit false as off, whatever the declared default', () => {
    expect(populationFrom({})).toEqual([])
    expect(populationFrom({ tracedOnly: false, typedOnly: false })).toEqual([])
    expect(populationFrom({ tracedOnly: true, typedOnly: true })).toEqual(['traced', 'typed'])
  })

  // Declaration order, so two nodes asking for the same set produce the same provenance key
  // whichever way the boxes were ticked.
  it('orders the filters by declaration rather than by param', () => {
    expect(populationFrom({ superclassOnly: true, tracedOnly: true })).toEqual([
      'traced',
      'superclass',
    ])
  })

  // Absent rather than an empty list, so a graph saved before the params existed and one with
  // every box cleared produce the same value — and therefore the same key.
  it('spreads nothing at all when no box is ticked', () => {
    expect(populationValue({ tracedOnly: false })).toEqual({})
    expect(populationValue({ tracedOnly: true })).toEqual({ population: ['traced'] })
  })
})

describe('the request projection', () => {
  /*
   * A pure projection: it carries what the dataset asks for and drops nothing. The *source*
   * resolves against its own discovered schema, which is the authoritative copy — resolving
   * here as well was the same question answered twice against two schemas, the node-side one
   * being a synchronous fallback that can be a discovery behind. `resolvePopulation` is where
   * the dropping is pinned, above.
   */
  it('carries the filters the dataset asks for', () => {
    expect(neuronSetRequest(dataset(['traced', 'typed'])).population).toEqual([
      'traced',
      'typed',
    ])
  })

  it('never invents one on a dataset that did not ask', () => {
    expect(neuronSetRequest(dataset()).population).toBeUndefined()
  })

  // Absent rather than an empty list, so it spreads into a request the way `annotations` does.
  it('spreads nothing for an empty list', () => {
    expect(neuronSetRequest(dataset([])).population).toBeUndefined()
  })
})

describe('the warnings', () => {
  it('says nothing while every asked-for filter applies', () => {
    expect(populationIssues(NEURONS, { tracedOnly: true }, 'x')).toEqual([])
  })

  it('names the filter that cannot apply, and says the others still do', () => {
    const issues = populationIssues(
      BARE,
      { tracedOnly: true, superclassOnly: true },
      'male-cns',
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('Superclass only')
    expect(issues[0]).toContain('only the other filters apply')
  })

  /*
   * The message that exists only because the filters are OR-ed: with every disjunct dropped
   * there is no clause at all, so a card showing a ticked box returns the entire dataset.
   */
  it('warns that everything comes through when every filter is dropped', () => {
    const issues = populationIssues(BARE, { superclassOnly: true }, 'hemibrain:v1.2.1')
    expect(issues[0]).toContain('every neuron the server has')
  })
})

describe('the local filter', () => {
  const table: TableValue = {
    kind: 'neurons',
    schema: NEURONS,
    data: {
      neuronId: [1, 2, 3, 4, 5],
      type: ['LC4', null, null, '', null],
      status: ['Traced', 'Anchor', 'Traced', 'Anchor', null],
      superclass: [null, 'central', null, null, null],
      flywireType: [null, null, null, 'Tm9', null],
      // Populated everywhere, as in the real dataset. Nothing may consult it.
      celltypePredictedNt: ['ACh', 'ACh', 'ACh', 'ACh', 'ACh'],
    },
    length: 5,
  }

  it('keeps the rows matching one filter', () => {
    expect(populationRows(table, ['traced'])).toEqual([0, 2])
    expect(populationRows(table, ['superclass'])).toEqual([1])
  })

  /*
   * `typed` spans every type column: row 3 has an empty `type` and a `flywireType`, which is a
   * typed neuron. And an empty string is absent — the same rule the `notEmpty` operator applies,
   * so a checkbox and the equivalent filter row cannot answer two different sets.
   */
  it('spans the type columns and counts an empty string as absent', () => {
    expect(populationRows(table, ['typed'])).toEqual([0, 3])
  })

  // The whole counter-intuitive half, in one assertion: two boxes let MORE rows through.
  it('unions the filters rather than intersecting them', () => {
    const traced = populationRows(table, ['traced'])!
    const superclass = populationRows(table, ['superclass'])!
    const both = populationRows(table, ['traced', 'superclass'])!
    expect(both).toEqual([0, 1, 2])
    expect(both.length).toBeGreaterThan(traced.length)
    expect(both.length).toBeGreaterThan(superclass.length)
  })

  it('fails an absent value rather than coercing it', () => {
    // Row 4 has a null status, a null type and no superclass: nothing can keep it.
    expect(populationRows(table, ['traced', 'typed', 'superclass'])).not.toContain(4)
  })

  // The same object, not a copy: `evaluate` hands this straight to a port, and copying 165k rows
  // of twenty columns to produce an identical table is pure waste.
  it('returns the input untouched when nothing is asked for', () => {
    expect(narrowPopulation(table, [])).toBe(table)
    expect(narrowPopulation(table, undefined)).toBe(table)
  })

  /*
   * A table with no such column passes through whole rather than emptying. Undefined from
   * `populationRows` is "the question cannot be put", which is a different answer from "no rows
   * match" — and blanking a dataset for a column it never had is the failure the request-level
   * `Traced` default caused on CAVE.
   */
  it('passes a table through rather than emptying it when every filter is dropped', () => {
    const unstated: TableValue = {
      kind: 'neurons',
      schema: BARE,
      data: { neuronId: [1, 2], status: ['Anchor', 'Anchor'] },
      length: 2,
    }
    expect(populationRows(unstated, ['superclass'])).toBeUndefined()
    expect(narrowPopulation(unstated, ['superclass'])).toBe(unstated)
  })

  /*
   * Identity, and it is not a micro-optimisation. `searchIndexFor` memoises Explore's ~24 MB
   * haystack in a `WeakMap` keyed by table *identity*, so a fresh `TableValue` per call meant
   * the node rebuilt that haystack on every Run and the card built a second one beside it for
   * the same rows. One object per (index, population) is what restores the single haystack the
   * shared neuron index had before any of this existed.
   */
  it('hands back one object per index and population, so downstream caches hold', () => {
    expect(narrowPopulation(table, ['traced'])).toBe(narrowPopulation(table, ['traced']))
    // A different population is a different table, and an equivalent list is the same one.
    expect(narrowPopulation(table, ['typed'])).not.toBe(narrowPopulation(table, ['traced']))
    expect(narrowPopulation(table, ['traced', 'typed'])).toBe(
      narrowPopulation(table, ['typed', 'traced']),
    )
  })

  it('narrows a real index to a strict, non-empty subset', async () => {
    const index = await source.neuronIndex!({ datasetId: DATASET })
    const traced = narrowPopulation(index, ['traced'])
    expect(traced.length).toBeGreaterThan(0)
    // The index is deliberately unfiltered, so there is something here to remove.
    expect(traced.length).toBeLessThan(index.length)
    expect(new Set(traced.data.status)).toEqual(new Set(['Traced']))
  })
})
