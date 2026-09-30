/**
 * A Delta table on CAVE's public bucket, read through the app's own path. **Skipped unless
 * `DELTA_LIVE` is set.**
 *
 *   DELTA_LIVE=1 pnpm vitest run src/data/files/delta/live.test.ts
 *
 * What the fixtures cannot say: that the log of a table six hundred commits long replays to the
 * live files delta-rs reports, that the bucket's lack of CORS at its direct address is got round
 * through the JSON API (Node has no CORS, so here that is only the listing and the metadata), and
 * that a lookup skips every file but the one holding the id. The answer is polars' — 174 rows for
 * this neuron at version 596 — so a later commit that touches this neuron's connections fails
 * this loudly, and the number is to be re-measured then rather than edited to pass.
 */

import { describe, expect, it } from 'vitest'

import { openTableSpec, readRows } from '../read'
import { fileSpec } from '../registry'
import { readRequest } from '../../../test/tableFiles'

const TABLE =
  'gs://mat_dbs/public/deltalake_exports/flywire_fafb_production/v783/valid_connection_v2/pre_pt_root_id'
const live = process.env.DELTA_LIVE ? describe : describe.skip

live('CAVE’s Delta export', () => {
  it('replays the log, and looks one neuron up in the one file holding it', async () => {
    const spec = await fileSpec({ kind: 'url', url: TABLE })
    if (spec.kind !== 'delta') throw new Error('Not read as a Delta table')
    expect(spec.snapshot.version).toBeGreaterThanOrEqual(596)
    const reader = await openTableSpec(spec)
    const key = { names: ['pre_pt_root_id'], ids: ['720575940638257498'] }
    const out = await readRows(reader, readRequest(reader.summary, { key }))
    expect(out.rows).toBe(174)
    expect(out.blocksRead).toBe(1)
  }, 120_000)

  it('reads the first thousand rows without reading a file, or a row group of one', async () => {
    const spec = await fileSpec({ kind: 'url', url: TABLE })
    let bytes = 0
    const fetched = globalThis.fetch
    globalThis.fetch = async (...args) => {
      const response = await fetched(...args)
      bytes += Number(response.headers.get('content-length') ?? 0)
      return response
    }
    try {
      const reader = await openTableSpec(spec)
      const out = await readRows(reader, readRequest(reader.summary, { limit: 1000 }))
      expect(out.rows).toBe(1000)
      expect(out.truncated).toBe(true)
      expect(new Set(out.data.pre_pt_root_id).size).toBeGreaterThan(0)
      // A file here is over a hundred megabytes and a row group tens of them; measured, 7.3 MB.
      expect(bytes).toBeLessThan(20e6)
    } finally {
      globalThis.fetch = fetched
    }
  }, 120_000)
})
