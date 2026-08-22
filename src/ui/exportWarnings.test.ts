/**
 * Which graph an in-flight exporter walk belongs to.
 *
 * The module's contract is that it starts *at most one* walk per (graph, language): a walk
 * lazily imports an exporter and runs it over the whole graph, and both surfaces that ask — the
 * Save menu on mount, the palette on its `menu` state — can ask again while one is running. A
 * guard or a cache that answers for the wrong graph is therefore not a tidiness question; it is
 * a second exporter loaded and a second full walk, or an answer about a graph nobody is looking
 * at any more.
 *
 * **What is not covered here is anything about a superseded graph** — neither the ownership
 * check nor `compute`'s `owner` parameter, which together decide what a walk that outlived its
 * graph may touch. Both need a hook *between* two `compute` continuations, and there is none:
 * the announce channel is deliberately silent for the stale walk, and vitest hands the **real**
 * exporter to a second concurrent dynamic import of a mocked module, so the walks cannot be
 * counted or told apart either. Two tests were written for it and both were vacuous under
 * mutation, which is worse than none — so the guarantee is structural instead: a walk can only
 * ever clear the set it was handed, and can only ever write to the entry it was started for.
 * That is the property to preserve if this is touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { addNode, emptyGraph } from '../core/graph'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import {
  peekExportWarnings,
  requestExportWarnings,
  resetExportWarnings,
  subscribeExportWarnings,
} from './exportWarnings'

/** Which graphs the Python exporter was actually walked over, by their single node's id. */
const walked: string[] = []

vi.mock('../export/python/exporter', () => ({
  exportNotebook: (graph: CodaGraph) => ({
    ok: true,
    // A TODO per walk, so an answer is distinguishable from "nothing to report".
    todos: [{ nodeId: graph.nodes[0]?.id ?? '?', label: graph.nodes[0]?.id ?? '?' }],
  }),
}))
vi.mock('../export/r/exporter', () => ({
  exportRmd: () => ({ ok: true, todos: [] }),
}))

/** A one-node graph on a real connectome, so neither exporter refuses it outright. */
function graphNamed(id: string): CodaGraph {
  return addNode(emptyGraph(), {
    id,
    type: 'dataset.hemibrain',
    position: { x: 0, y: 0 },
    params: {},
  })
}

beforeEach(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  resetExportWarnings()
  walked.length = 0
})

/** Poll rather than sleep: the walks are behind a lazy import whose cost is not fixed. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 400; n++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('what a walk is allowed to answer for', () => {
  it('answers for the graph that asked', async () => {
    const only = graphNamed('only')
    requestExportWarnings(only)
    await until(() => peekExportWarnings(only, 'python') !== undefined, 'the answer')
    expect(peekExportWarnings(only, 'python')?.detail).toContain('“only”')
  })

  it('announces once per language, and asking again re-walks nothing', async () => {
    const graph = graphNamed('one')
    let announced = 0
    const stop = subscribeExportWarnings(() => {
      announced += 1
    })

    requestExportWarnings(graph)
    await until(() => announced >= 2, 'both answers')
    // A surface re-mounting, which is the ordinary case and must be free.
    requestExportWarnings(graph)
    await new Promise((resolve) => setTimeout(resolve, 100))
    stop()

    expect(announced).toBe(2)
  })
})
