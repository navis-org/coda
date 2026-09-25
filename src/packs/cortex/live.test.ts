/**
 * The Cortex frames' declared tables, against the real services. **Skipped unless `CAVE_TOKEN` is
 * set.**
 *
 *   CAVE_TOKEN=$(jq -r .token ~/.cloudvolume/secrets/cave-secret.json) \
 *     pnpm vitest run src/packs/cortex/live.test.ts
 *
 * `CorticalFrame.cellTypes` is a list somebody wrote down, and a publisher can retire or rename a
 * table under it. What this pins is the one property the gallery relies on: every declared table
 * reads through the CAVE table reader and arrives keyed by neuron with a `type` column — the
 * column `Group by` defaults to. About fifteen seconds for minnie65's eight.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import '../../data/annotations/caveTable'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import { cellTypeAnnotations, cellTypeRefs } from './cellTypes'
import { CORTICAL_FRAMES } from './frames'

const TOKEN = process.env.CAVE_TOKEN
const live = TOKEN ? describe : describe.skip

beforeAll(() => setToken(DEFAULT_CAVE_SERVER, TOKEN))
afterAll(() => resetCredentials())

live('Cortex frames, live', () => {
  for (const frame of CORTICAL_FRAMES.filter((f) => f.scope === 'cave')) {
    // The newest materialization the frame was checked at; a frame binds any of them.
    const dataset = `${frame.dataset}:1822`
    it.each(frame.cellTypes.map((source, i) => [source.table, i === 0 ? '' : source.table]))(
      `${frame.dataset}: %s reads with a type column`,
      async (_, choice) => {
        const annotations = await cellTypeAnnotations(
          undefined,
          cellTypeRefs(frame, { sourceId: 'cave', datasetId: dataset }, choice),
          {},
        )
        const table = annotations!.table
        expect(table.length).toBeGreaterThan(1000)
        const types = new Set(table.data['type']?.filter((v) => v !== null))
        expect(types.size).toBeGreaterThan(1)
        // Proofreading rides along whichever typing is chosen.
        expect(table.data[frame.proofreading!.dendrite]).toBeDefined()
      },
      60_000,
    )
  }
})
