/**
 * The encoder at the size it was designed for. **Skipped unless `EDGE_SCALE=1`.**
 *
 *   EDGE_SCALE=1 pnpm vitest run src/data/edges/scale.test.ts
 *
 * Gated for `live.test.ts`'s reason rather than because it is slow: it allocates most of a
 * gigabyte transiently, which is not a thing to do on every commit — and the numbers it prints
 * are the argument for the whole layout, so they want reading rather than merely passing.
 *
 * Measured on this machine, ten million edges over 140,000 CAVE-shaped eighteen-digit ids:
 *
 *   add()      789 ms
 *   finish()   781 ms
 *   stored     115 MB of typed arrays, both directions, plus a 5 MB dictionary
 *   peak rss   698 MB
 *
 * The 115 is the width ladder at work, and its residual is worth reading rather than only
 * passing. Targets take `Uint32` because 140,000 neurons do not index in sixteen bits. Weights
 * are generated here as 1..200, which is a `Uint8`, and come out `Uint16` — because 2,668 pairs
 * were merged and their sums passed 255. That is exactly the rule `narrowWeights` exists for,
 * arriving on its own rather than in a unit test written to provoke it.
 *
 * The pair counts moved once — 9,997,332 distinct / 2,668 merged became 9,997,407 / 2,593 — when
 * `tidy` stopped compacting a run in place while reading through its sort order. The old numbers
 * were the corruption: edges lost and others double-counted as merges, on a green suite.
 *
 * Against the alternative this exists to avoid: the same edges as a five-column Coda
 * `TableValue` are 2 x 72 + 3 x 8 bytes a row — **about 1.7 GB**, and every byte of it resident
 * for as long as the node holds its result. Eleven times, which is the difference between a
 * feature and a tab that dies.
 *
 * The peak is the number to improve, and the route is known: `add` buffers raw triples that
 * only exist to be permuted. A reader holding a *file* can pass over it twice — once to build
 * the dictionary and count degrees, once to fill the CSR directly — and never allocate them.
 */
import { describe, expect, it } from 'vitest'

import { EdgeSetBuilder } from './encode'

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

describe.skipIf(process.env.EDGE_SCALE !== '1')('the encoder at ten million edges', () => {
  it('encodes, transposes and reports inside a couple of seconds', () => {
    const NEURONS = 140_000
    const EDGES = 10_000_000
    // Eighteen-digit text ids: the expensive case, and the one a CAVE datastack really has.
    const ids = Array.from({ length: NEURONS }, (_, i) => '72057594' + (1000000000 + i))

    // mulberry32, the generator `core.sample` uses. A plain LCG in doubles loses its low bits
    // past 2^53 and gave 8,201 distinct pairs out of ten million — invariant 8's arithmetic,
    // arriving in the harness written to measure it.
    let seed = 0x9e3779b9
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) % NEURONS
    }

    const builder = new EdgeSetBuilder()
    const t0 = Date.now()
    for (let i = 0; i < EDGES; i++) builder.add(ids[next()]!, ids[next()]!, (i % 200) + 1)
    const added = Date.now() - t0

    const t1 = Date.now()
    const encoded = builder.finish()
    const compressed = Date.now() - t1

    const stored =
      encoded.out.offsets.byteLength +
      encoded.out.targets.byteLength +
      encoded.out.weights.byteLength +
      encoded.in.offsets.byteLength +
      encoded.in.targets.byteLength +
      encoded.in.weights.byteLength

    // The printed numbers are this suite's output: a scale harness that only goes green has
    // told nobody anything.
    // eslint-disable-next-line no-console
    console.log(
      `\n  ${EDGES.toLocaleString()} edges over ${NEURONS.toLocaleString()} neurons` +
        `\n  add()     ${added} ms` +
        `\n  finish()  ${compressed} ms` +
        `\n  stored    ${mb(stored)} MB typed arrays, both directions` +
        `\n  rss       ${mb(process.memoryUsage().rss)} MB peak` +
        `\n  pairs     ${encoded.edges.toLocaleString()} distinct, ${encoded.report.merged.toLocaleString()} merged\n`,
    )

    // The claim the layout rests on: an order of magnitude under a TableValue of the same data.
    expect(stored).toBeLessThan(300 * 1024 * 1024)
    // Both directions describe one edge set, or `inputs` and `outputs` disagree.
    expect(encoded.in.targets.length).toBe(encoded.out.targets.length)
    expect(encoded.ids.length).toBe(NEURONS)
  }, 300_000)
})
