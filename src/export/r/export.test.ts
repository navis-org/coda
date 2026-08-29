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
    const source = emit(
      { ...NONE, tracedOnly: true, typedOnly: true },
      'neuron.findNeurons',
      { typePattern: 'LC.*' },
    )
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
