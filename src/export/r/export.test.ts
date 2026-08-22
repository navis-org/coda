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
import { allNodeDefs } from '../../core/registry'
import '../../nodes'
import { caveGraph, everythingGraph } from '../fixture'
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
      type: 'dataset.mock.hemibrain',
      position: { x: 0, y: 0 },
      params: {},
    })
    const result = exportRmd(g)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/[Rr]eplace them with a real dataset/)
  })
})
