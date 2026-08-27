/**
 * A loop's side effects.
 *
 * What matters here is not that files get written — `fileSink.test.ts` covers that — but that
 * the *right* ones do, named so that a folder of four hundred is usable, and that a Download
 * outside the region is left for `useDownloads` to handle. Each of those is a silent failure:
 * an unwritten file and a file written twice both look like a loop that ran.
 */

import { describe, expect, it } from 'vitest'

import type { IterationInfo } from '../core/scheduler'
import type { CodaGraph } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import { column, tableSchema } from '../core/types'
import type { Value } from '../core/values'
import { tableFromRows } from '../core/values'
import type { FileSink } from './fileSink'
import { runIteration } from './useForEach'

const FIXED = new Date(2026, 7, 27, 14, 32)

/** A sink that keeps everything, so a test can read the names back. */
function recordingSink(): FileSink & { names: string[] } {
  const names: string[] = []
  return {
    names,
    mode: 'zip',
    label: 'test.zip',
    written: 0,
    write(files) {
      for (const file of files) names.push(file.name)
      this.written += files.length
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}

const TABLE = tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: '7205759406' }])

/** `download` sits in the region; `after` sits outside it. */
function graphWith(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('loop-files')
  g = addNode(g, {
    id: 'download',
    type: 'out.download',
    position: { x: 0, y: 0 },
    params: { filename: 'skeleton', format: 'csv', onRun: true, ...params },
  })
  g = addNode(g, {
    id: 'after',
    type: 'out.download',
    position: { x: 0, y: 0 },
    params: { filename: 'summary', format: 'csv', onRun: true },
  })
  g = addEdge(g, {
    source: 'download',
    sourceHandle: 'out',
    target: 'after',
    targetHandle: 'in',
  })
  return g
}

function pass(index: number, count: number, label: string, size = 1): IterationInfo {
  return { nodeId: 'loop', index, count, label, size, region: ['download'] }
}

const inputs = (): Record<string, Value | undefined> => ({ in: TABLE })

describe('runIteration', () => {
  it('names a file by the element, so a folder of them is readable', async () => {
    const sink = recordingSink()
    await runIteration(pass(0, 3, 'LC4'), graphWith(), inputs, sink, FIXED)
    expect(sink.names).toEqual(['skeleton-1-LC4.csv'])
  })

  /**
   * Zero-padded to the width of the total.
   *
   * The one thing anybody does with a folder of four hundred files is look at it in order, and
   * `1, 10, 100, 2` is what an unpadded ordinal sorts to in every file browser there is.
   */
  it('pads the ordinal to the width of the count', async () => {
    const sink = recordingSink()
    await runIteration(pass(6, 400, 'LC6'), graphWith(), inputs, sink, FIXED)
    expect(sink.names).toEqual(['skeleton-007-LC6.csv'])
  })

  it('falls back to the ordinal when the element has no name', async () => {
    const sink = recordingSink()
    await runIteration(pass(2, 10, ''), graphWith(), inputs, sink, FIXED)
    expect(sink.names).toEqual(['skeleton-03.csv'])
  })

  it('sanitises a name that a filesystem would refuse', async () => {
    const sink = recordingSink()
    await runIteration(pass(0, 2, 'LC4 (left) / v2'), graphWith(), inputs, sink, FIXED)
    expect(sink.names).toEqual(['skeleton-1-LC4-(left)-v2.csv'])
  })

  /*
   * The whole reason `IterationInfo.region` exists. A Download after the loop reads the finished
   * accumulation and belongs to `useDownloads`; writing it here would produce one file per
   * element of something that only has one value.
   */
  it('ignores a Download outside the region', async () => {
    const sink = recordingSink()
    await runIteration(pass(0, 2, 'LC4'), graphWith(), inputs, sink, FIXED)
    expect(sink.names.some((n) => n.startsWith('summary'))).toBe(false)
  })

  it('honours On run being switched off', async () => {
    const sink = recordingSink()
    await runIteration(pass(0, 2, 'LC4'), graphWith({ onRun: false }), inputs, sink, FIXED)
    expect(sink.names).toEqual([])
  })

  /*
   * Reported rather than thrown. One unwritable element is not a reason to abandon the other
   * three hundred and ninety-nine — the same call the scheduler makes about a failing pass.
   */
  it('reports a pass with nowhere to write once, before doing any of the work', async () => {
    const outcome = await runIteration(pass(0, 2, 'LC4'), graphWith(), inputs, undefined, FIXED)
    // One problem, not one per Download node: the absence was knowable at entry.
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]).toMatch(/nowhere to write/)
  })

  /*
   * A batch is named by its ordinal alone, because `planExport` already appends each item's own
   * id. Keeping the label too gave twenty files all prefixed with the batch's *first* neuron.
   */
  it('drops the label for a pass carrying more than one element', async () => {
    const sink = recordingSink()
    await runIteration(pass(0, 3, '7205759406 +19', 20), graphWith(), inputs, sink, FIXED)
    expect(sink.names).toEqual(['skeleton-1.csv'])
  })

  it('reports a format the value cannot take, naming the node', async () => {
    const sink = recordingSink()
    const outcome = await runIteration(
      pass(0, 2, 'LC4'),
      graphWith({ format: 'swc' }),
      inputs,
      sink,
      FIXED,
    )
    expect(outcome.problems[0]).toMatch(/cannot be written as SWC/)
    expect(sink.names).toEqual([])
  })
})
