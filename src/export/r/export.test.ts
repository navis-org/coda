/**
 * The R exporter, against the same everything graph the notebook exporter uses.
 *
 * Sharing the fixture is what holds the two to one coverage bar: a node that emits Python and
 * nothing in R shows up here as a TODO in the golden file rather than as a document nobody
 * noticed was shorter.
 *
 * The one place they part company is the **backend**. Python emits caveclient and R has no
 * equivalent, so `caveGraph` is refused outright here rather than exported as a document of
 * TODOs — which is what `DatasetFamily.notebook` being per language buys, and what the last
 * test in this file pins.
 *
 * Regenerate with `pnpm export:golden` after an intentional change, and read the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import type { ParamValues } from '../../core/node'
import { allNodeDefs } from '../../core/registry'
import '../../nodes'
import { caveGraph, everythingGraph, twoNodeGraph } from '../fixture'
import { exportRmd } from './exporter'
import { getEmitter } from './registry'

const GOLDEN = new URL('./__fixtures__/everything.Rmd', import.meta.url).pathname
const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

describe('R Markdown export', () => {
  it('matches the golden document', () => {
    const result = exportRmd(everythingGraph(), OPTIONS)
    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, result.source)
      return
    }
    expect(result.source).toEqual(readFileSync(GOLDEN, 'utf-8'))
  })

  it('reaches every emitting node type', () => {
    const covered = new Set(everythingGraph().nodes.map((n) => n.type))
    const missed = allNodeDefs()
      .map((d) => d.type)
      .filter((t) => getEmitter(t) && !covered.has(t))
    expect(missed).toEqual([])
  })

  it('gives every chunk a unique label, or knitr aborts the render', () => {
    const result = exportRmd(everythingGraph(), OPTIONS)
    if (!result.ok) throw new Error(result.reason)
    const labels = [...result.source.matchAll(/^```\{r ([^}]*)\}/gm)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(10)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('refuses a CAVE graph the notebook exporter accepts', () => {
    /*
     * Not a gap being papered over: R's route into FlyWire is `fafbseg`, which wraps FlyWire
     * specifically rather than CAVE generally, and no emitter has been written for it. Refusing
     * says so once; exporting would say it in a TODO per cell.
     */
    const result = exportRmd(caveGraph(), OPTIONS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('neuprintr')
    // And it points at the format that *can* do it, or the refusal reads as "not supported".
    expect(result.detail).toContain('Jupyter notebook')
  })

  it('refuses a graph holding a synthetic dataset', () => {
    let g = emptyGraph('mock')
    g = addNode(g, {
      id: 'm',
      type: 'dataset.mock.opticlobe',
      position: { x: 0, y: 0 },
      params: {},
    })
    const result = exportRmd(g)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/[Rr]eplace them with a real dataset/)
  })
})

/**
 * `Include fragments`. neuprintr's `neuprint_connection_table` builds
 * `MATCH (a:{node})-[c:ConnectsTo]->(b:{node})` with `node = ifelse(all_segments, "Segment",
 * "Neuron")`, read off natverse/neuprintr rather than guessed — so the argument exists and the
 * default was already the restricted set.
 */
describe('include fragments', () => {
  function chunk(params: ParamValues): string {
    let g = emptyGraph('partners')
    g = addNode(g, {
      id: 'ds',
      type: 'dataset.hemibrain',
      position: { x: 0, y: 0 },
      params: { version: 'v1.2.1' },
    })
    g = addNode(g, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 260, y: 0 },
      params: { typePattern: 'LC4' },
    })
    g = addNode(g, { id: 'c', type: 'neuron.connectivity', position: { x: 520, y: 0 }, params })
    g = {
      ...g,
      edges: [
        {
          id: 'e1',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'find',
          targetHandle: 'dataset',
        },
        {
          id: 'e2',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'c',
          targetHandle: 'dataset',
        },
        {
          id: 'e3',
          source: 'find',
          sourceHandle: 'neurons',
          target: 'c',
          targetHandle: 'neurons',
        },
      ],
    }
    const result = exportRmd(g, OPTIONS)
    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    return result.source
  }

  it('names the argument both ways', () => {
    expect(chunk({ direction: 'outputs', hops: 1, minWeight: 1 })).toContain(
      'all_segments = FALSE',
    )
    expect(
      chunk({ direction: 'outputs', hops: 1, minWeight: 1, includeFragments: true }),
    ).toContain('all_segments = TRUE')
  })

  it('threads it through the traversal helper, which is where the frontier is bounded', () => {
    const source = chunk({
      direction: 'outputs',
      hops: 2,
      minWeight: 1,
      includeFragments: true,
    })
    expect(source).toContain('all_segments = TRUE')
    expect(source).toContain(
      'step <- coda_edge_list(todo, prepost, min_weight, all_segments, conn)',
    )
  })

  /*
   * The one place the two languages differ, said in the generated document rather than only
   * here: neuprintr applies the label to **both** ends, so a queried body that is not itself a
   * published neuron returns nothing — where the canvas always keeps the neurons you named.
   */
  it('says that the restriction reaches the queried end too', () => {
    expect(chunk({ direction: 'outputs', hops: 1, minWeight: 1 })).toContain(
      'it applies to BOTH ends',
    )
  })
})

/**
 * The `Neuron Set` port, emitted whether or not anything downstream reads it — an emitter cannot
 * see which of its outputs the graph consumes, and a port left unassigned is an "object not
 * found" at the reader's console rather than a chunk that is merely longer.
 */
describe('the Neuron Set port', () => {
  function connectivityChunk(params: ParamValues): string {
    let g = emptyGraph('endpoints')
    g = addNode(g, {
      id: 'ds',
      type: 'dataset.hemibrain',
      position: { x: 0, y: 0 },
      params: { version: 'v1.2.1' },
    })
    g = addNode(g, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 260, y: 0 },
      params: { typePattern: 'LC4' },
    })
    g = addNode(g, { id: 'c', type: 'neuron.connectivity', position: { x: 520, y: 0 }, params })
    g = {
      ...g,
      edges: [
        {
          id: 'e1',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'find',
          targetHandle: 'dataset',
        },
        {
          id: 'e2',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'c',
          targetHandle: 'dataset',
        },
        {
          id: 'e3',
          source: 'find',
          sourceHandle: 'neurons',
          target: 'c',
          targetHandle: 'neurons',
        },
      ],
    }
    const result = exportRmd(g, OPTIONS)
    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    return result.source
  }

  it('binds it from the edge list and the seeds', () => {
    const source = connectivityChunk({ direction: 'outputs', hops: 1, minWeight: 1 })
    expect(source).toContain('coda_endpoint_neurons <- function(')
    expect(source).toContain(
      'connectivity_neuron_set <- coda_endpoint_neurons(connectivity_connections, find_neurons$neuronId)',
    )
    // The derived form binds the port directly; only `full` needs a lookup in between.
    expect(source).not.toContain('.endpoints <-')
  })

  it('looks the rows up for full, and says what that call cannot answer for', () => {
    const source = connectivityChunk({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      neuronRows: 'full',
    })
    expect(source).toContain('.endpoints <- coda_endpoint_neurons(')
    expect(source).toContain(
      'connectivity_neuron_set <- neuprint_get_meta(.endpoints$neuronId, conn = hemibrain_neuprint) |> coda_neurons()',
    )
    expect(source).toContain("below the dataset's neuron threshold")
    // The helper the pipe calls has to be declared, not merely called: `resolveHelpers` only
    // writes out what was asked for, and a chunk calling an undefined function knits and fails.
    expect(source).toContain('coda_neurons <- function(')
  })
})

/*
 * The same per-emitter check the notebook exporter makes, and it has to be made twice: the two
 * languages express the narrowing four different ways between them — a `NeuronCriteria`
 * argument, a pandas mask, a dplyr `filter()` after `neuprint_search`, and a `WHERE` inside
 * Explore's hand-written Cypher — so one emitter forgetting is not something the other
 * language's test could see. What it would look like is a document that knits cleanly and
 * returns 186,061 neurons where the canvas showed a fraction of them.
 */
describe('the population filters', () => {
  const graphWith = (params: ParamValues, query: string, queryParams: ParamValues = {}) =>
    twoNodeGraph('dataset.hemibrain', params, query, queryParams)

  function emit(params: ParamValues, query: string, queryParams: ParamValues = {}): string {
    const result = exportRmd(graphWith(params, query, queryParams), OPTIONS)
    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    return result.source
  }

  const NONE = { tracedOnly: false, typedOnly: false, superclassOnly: false }

  /*
   * `neuprint_search` narrows on one field and that field is spent on the type or label pattern,
   * so both search emitters express the population as a dplyr `filter()` on the returned
   * metadata. Explore is the exception: it writes its own Cypher, so the narrowing goes in the
   * `WHERE` and the response is smaller rather than merely shorter.
   */
  const QUERIES: [string, ParamValues, string][] = [
    ['neuron.findNeurons', { typePattern: 'LC.*' }, 'filter((status == "Traced"))'],
    ['neuron.idsFromLabel', { labels: ['LC4'], status: '' }, 'filter((status == "Traced"))'],
    ['neuron.explore', {}, "WHERE n.`status` = 'Traced'"],
  ]

  it.each(QUERIES)('narrows the %s chunk', (type, params, expected) => {
    expect(emit({ ...NONE, tracedOnly: true }, type, params)).toContain(expected)
    expect(emit(NONE, type, params)).not.toContain('Traced')
  })

  // An empty string is absent, the same rule the `notEmpty` operator applies — and `nzchar` is
  // deliberately avoided, since it errors on `NA` in older R and returns `NA` in newer.
  it.each(QUERIES)('spells a non-empty test explicitly in %s', (type, params) => {
    const source = emit({ ...NONE, typedOnly: true }, type, params)
    expect(source).toMatch(/!is\.na\(type\) & type != ""|n\.`type` IS NOT NULL/)
  })

  /*
   * The OR, parenthesised per disjunct. R binds `&` tighter than `|`, so the unbracketed form
   * happens to group correctly and stops doing so the first time somebody edits a clause —
   * and in a knitted document nobody re-derives precedence before trusting a row count.
   */
  it('ORs the disjuncts rather than ANDing them', () => {
    const source = emit({ ...NONE, tracedOnly: true, typedOnly: true }, 'neuron.findNeurons', {
      typePattern: 'LC.*',
    })
    expect(source).toContain('(status == "Traced") | (!is.na(type) & type != "")')
  })

  // The precedence, as in the notebook: the row is the more specific statement and removes the
  // `traced` disjunct, so the chunk must not filter twice and return nothing.
  it('lets an explicit status row win rather than filtering twice', () => {
    const source = emit({ ...NONE, tracedOnly: true }, 'neuron.findNeurons', {
      typePattern: 'LC.*',
      status: 'Assign',
    })
    expect(source).toContain('"Assign"')
    expect(source).not.toContain('Traced')
  })
})

/**
 * The four aggregations whose R spelling is not the bare function name, each because base R
 * answers something Coda does not once a null is in the column.
 *
 * `min` reaches the golden through the fixture's own Group By, and `probe-r-helpers.R` runs the
 * emitted `coda_min` against an all-absent group. `max` is that helper's mirror and gets no node
 * of its own — two adjacent Group By cells differing only in an enum is noise in a document
 * somebody reads — so it is pinned here, where what matters is that the emitter reaches for the
 * helper at all rather than for `max()`.
 */
describe('the aggregations R spells differently', () => {
  /** The whole fixture with its Group By re-aggregated, so the graph stays a valid one. */
  const emitted = (agg: string): string => {
    const base = everythingGraph()
    const graph = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'extremes' ? { ...n, params: { ...n.params, agg } } : n,
      ),
    }
    const result = exportRmd(graph, OPTIONS)
    if (!result.ok) throw new Error(`refused: ${result.detail}`)
    return result.source
  }

  it('reaches for coda_max rather than max, and generates it', () => {
    const source = emitted('max')
    expect(source).toContain('`max_size` = coda_max(`size`)')
    // The helper has to travel with the call, or the document stops at an undefined function.
    expect(source).toContain('coda_max <- function(x)')
    // …and its mirror does not come along for the ride.
    expect(source).not.toContain('coda_min <- function(x)')
  })

  it('drops absences from sum, mean and countDistinct rather than propagating them', () => {
    // Without `na.rm` a single null answers NA for the whole group, which is the
    // one-null-takes-out-the-row failure; `n_distinct` counts NA as an answer where Coda and
    // `nunique` do not.
    expect(emitted('sum')).toContain('`sum_size` = sum(`size`, na.rm = TRUE)')
    expect(emitted('mean')).toContain('`mean_size` = mean(`size`, na.rm = TRUE)')
    expect(emitted('countDistinct')).toContain(
      '`countDistinct_size` = n_distinct(`size`, na.rm = TRUE)',
    )
  })
})
