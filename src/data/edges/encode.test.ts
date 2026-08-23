/**
 * The edge encoder.
 *
 * Every case here is one that fails as a *plausible wrong connectome* rather than as an error:
 * a rounded id is a different neuron, an unsorted transpose reports the wrong partners, and an
 * unmerged per-region file counts one connection five times. None of them throw.
 */
import { describe, expect, it } from 'vitest'

import type { EdgeCsr } from './encode'
import { EDGE_FORMAT, EdgeSetBuilder, edgeSetBytes } from './encode'

/** Every (source, target, weight) triple in one direction, for asserting against by hand. */
function edgesOf(csr: EdgeCsr) {
  const out: [number, number, number][] = []
  for (let n = 0; n + 1 < csr.offsets.length; n++) {
    for (let i = csr.offsets[n]!; i < csr.offsets[n + 1]!; i++) {
      out.push([n, csr.targets[i]!, csr.weights[i]!])
    }
  }
  return out
}

function build(rows: [string, string, number][]) {
  const b = new EdgeSetBuilder()
  for (const [pre, post, w] of rows) b.add(pre, post, w)
  return b.finish()
}

describe('EdgeSetBuilder', () => {
  it('keeps an eighteen-digit id exactly, which is the whole point of the dictionary', () => {
    // 720575940628857210 as a double is ...344 — a different neuron, invariant 8.
    const wide = '720575940628857210'
    const other = '720575940628857211'
    const encoded = build([
      [wide, other, 5],
      [other, wide, 3],
    ])
    expect(encoded.ids).toContain(wide)
    expect(encoded.ids).toContain(other)
    // Adjacent wide ids must stay two neurons rather than collapsing into one.
    expect(new Set(encoded.ids).size).toBe(2)
    expect(encoded.edges).toBe(2)
  })

  it('resolves partners in both directions from one file', () => {
    const encoded = build([
      ['1', '2', 10],
      ['1', '3', 20],
      ['2', '3', 30],
    ])
    const at = (id: string) => encoded.ids.indexOf(id)
    // Outputs of neuron 1.
    expect(edgesOf(encoded.out).filter(([s]) => s === at('1'))).toEqual([
      [at('1'), at('2'), 10],
      [at('1'), at('3'), 20],
    ])
    // Inputs of neuron 3 — the direction a scan of the whole set would otherwise be needed for.
    expect(edgesOf(encoded.in).filter(([t]) => t === at('3'))).toEqual([
      [at('3'), at('1'), 20],
      [at('3'), at('2'), 30],
    ])
  })

  it('keeps every edge when a neuron’s targets arrive out of order', () => {
    /*
     * The compaction inside `tidy` writes back into the same run it is reading, so a run whose
     * targets are not already ascending had entries overwritten before the sort reached them.
     * Silent: edges vanish, others are emitted twice, and `merged` stays 0 — so the counts look
     * fine and the connectome is wrong.
     *
     * `4` is introduced first so its own run comes first and leaves `write` sitting exactly at
     * the start of `1`'s run, which is the case that clobbers.
     */
    const encoded = build([
      ['4', '2', 1],
      ['4', '3', 1],
      ['4', '5', 1],
      ['1', '5', 10],
      ['1', '2', 20],
      ['1', '3', 30],
    ])
    expect(encoded.report.merged).toBe(0)
    expect(encoded.edges).toBe(6)
    const at = (id: string) => encoded.ids.indexOf(id)
    expect(edgesOf(encoded.out).filter(([s]) => s === at('1'))).toEqual([
      [at('1'), at('2'), 20],
      [at('1'), at('3'), 30],
      [at('1'), at('5'), 10],
    ])
  })

  it('sums duplicate pairs, so a per-region edge list loads as connectivity', () => {
    // One row per (pre, post, region) is the ordinary shape of a published edge list, and
    // carrying it through unmerged counts one connection five times downstream.
    const encoded = build([
      ['1', '2', 3],
      ['1', '2', 4],
      ['1', '2', 1],
    ])
    expect(encoded.edges).toBe(1)
    expect(edgesOf(encoded.out)[0]![2]).toBe(8)
    expect(encoded.report.merged).toBe(2)
    expect(encoded.report.rowsRead).toBe(3)
    // The transpose has to agree, or `inputs` and `outputs` disagree about one connection.
    expect(edgesOf(encoded.in)[0]![2]).toBe(8)
  })

  it('takes the narrowest weight type that holds every value exactly', () => {
    // A synapse count is small and unsigned, which is the common case and a quarter of Int32.
    expect(build([['1', '2', 7]]).out.weights).toBeInstanceOf(Uint8Array)
    expect(build([['1', '2', 300]]).out.weights).toBeInstanceOf(Uint16Array)
    expect(build([['1', '2', 100_000]]).out.weights).toBeInstanceOf(Int32Array)
    // A signed score skips both unsigned rungs rather than being clamped to zero.
    const signed = build([['1', '2', -5]])
    expect(signed.out.weights).toBeInstanceOf(Int32Array)
    expect(signed.out.weights[0]).toBe(-5)
    // A normalised score must not be silently rounded away.
    const scored = build([['1', '2', 0.25]])
    expect(scored.out.weights).toBeInstanceOf(Float64Array)
    expect(scored.out.weights[0]).toBe(0.25)
  })

  it('narrows after merging, or two rows of 200 become 144', () => {
    // The width has to be chosen from the summed values. Picking it from the file's own would
    // fit both 200s in a Uint8Array and then wrap their sum.
    const encoded = build([
      ['1', '2', 200],
      ['1', '2', 200],
    ])
    expect(edgesOf(encoded.out)[0]![2]).toBe(400)
    expect(encoded.out.weights).toBeInstanceOf(Uint16Array)
    expect(edgesOf(encoded.in)[0]![2]).toBe(400)
  })

  it('indexes in Uint16 under 65,536 neurons and Uint32 above', () => {
    // hemibrain is ~25,000 neurons, so it halves this array; FlyWire's proofread set is
    // 138,640 and cannot. There is no standard array between the two.
    expect(build([['1', '2', 1]]).out.targets).toBeInstanceOf(Uint16Array)
    const rows: [string, string, number][] = []
    for (let i = 0; i < 70_000; i++) rows.push([String(i), String(i + 1), 1])
    expect(build(rows).out.targets).toBeInstanceOf(Uint32Array)
  })

  it('reports what it occupies, both directions and the dictionary', () => {
    const encoded = build([
      ['1', '2', 3],
      ['2', '3', 4],
    ])
    expect(edgeSetBytes(encoded)).toBeGreaterThan(0)
  })

  it('drops a row with no weight or no id, and says how many', () => {
    const encoded = build([
      ['1', '2', 5],
      ['1', '', 5],
      ['', '2', 5],
      ['1', '3', Number.NaN],
    ])
    expect(encoded.edges).toBe(1)
    expect(encoded.report.droppedId).toBe(2)
    expect(encoded.report.droppedWeight).toBe(1)
  })

  it('keeps a non-numeric id but counts it, because it will match nothing', () => {
    // An edge list keyed by cell type is well-formed, loads cleanly, and then joins to no
    // neuron at all. Saying so at import is the only place anybody can act on it.
    const encoded = build([['LC4', 'DNp01', 5]])
    expect(encoded.edges).toBe(1)
    expect(encoded.report.nonNumericIds).toBe(2)
  })

  it('keeps a self-edge and counts it', () => {
    const encoded = build([['1', '1', 4]])
    expect(encoded.edges).toBe(1)
    expect(encoded.report.selfEdges).toBe(1)
  })

  it('trims whitespace, or " 1" is a second neuron', () => {
    const encoded = build([
      ['1', '2', 3],
      [' 1', '2 ', 4],
    ])
    expect(encoded.ids).toEqual(['1', '2'])
    expect(edgesOf(encoded.out)[0]![2]).toBe(7)
  })

  it('stamps the format, so a stored set cannot outlive the layout that wrote it', () => {
    expect(build([['1', '2', 1]]).format).toBe(EDGE_FORMAT)
  })

  it('is empty rather than broken with nothing in it', () => {
    const encoded = build([])
    expect(encoded.edges).toBe(0)
    expect(encoded.ids).toEqual([])
    expect(edgesOf(encoded.out)).toEqual([])
  })
})
