/**
 * Annotation sources against the real services. **Skipped unless `SEATABLE_TOKEN` is set.**
 *
 * `annotations.test.ts` runs against recorded replies, which proves the shaping and proves
 * nothing about whether the four calls still answer in the shapes those replies were cut from.
 * Every one of them is a live fact nobody publishes a contract for — the `Token` scheme, the
 * account-vs-base token distinction, the per-base server in the access token, and the absence of
 * gzip. This is what notices when one changes.
 *
 * Run it:
 *
 *   SEATABLE_TOKEN=$(cat ~/.cloudvolume/secrets/flytable.json) \
 *     pnpm vitest run src/data/annotations/live.test.ts
 *
 * Out of CI on purpose — it needs a credential and a network. It reads only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SEATABLE_HOSTS, resetSeaTableCredentials, setToken } from './credentials'
import { listBases, readMetadata, resolveWorkspace } from './seaTable'
import { annotationProvider } from './registry'
import './index'

const TOKEN = process.env.SEATABLE_TOKEN
const HOST = SEATABLE_HOSTS.flytable

const live = TOKEN ? describe : describe.skip

beforeAll(() => setToken(HOST, TOKEN))
afterAll(() => resetSeaTableCredentials())

live('FlyTable, live', () => {
  it('lists the bases the account can reach', async () => {
    const bases = await listBases(HOST)
    expect(bases.length).toBeGreaterThan(0)
    // The FlyWire annotations everyone means when they say "FlyTable".
    expect(bases.some((b) => b.name === 'main')).toBe(true)
  }, 60_000)

  it('reads a base’s tables and their columns', async () => {
    const tables = await readMetadata(HOST, '5', 'main')
    const info = tables.find((t) => t.name === 'info')!
    expect(info).toBeTruthy()
    // The join key, and the columns a CAVE dataset has no answer for.
    expect(info.columns.map((c) => c.name)).toContain('root_id')
    expect(info.columns.map((c) => c.name)).toContain('side')
  }, 60_000)

  it('reads a table into a Coda table with ids intact', async () => {
    const provider = annotationProvider('seaTable')!
    const table = await provider.fetch(
      {
        provider: 'seaTable',
        config: {
          host: HOST,
          workspace: '5',
          base: 'main',
          table: 'info',
          idColumn: 'root_id',
          columns: 'side,cell_type',
        },
      },
      { refresh: true },
    )

    // `cell_type` arrives as `type`: the second of the two columns nodes address by name, and
    // the one a chain has to rename onto for connectivity, Explore and Profile to see it.
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'side', 'type'])
    expect(table.length).toBeGreaterThan(50_000)

    /*
     * Every id exactly eighteen digits of text, and none of them rounded. This is the assertion
     * the whole join rests on: SeaTable stores a root id as a string, so it meets CAVE's — which
     * `json.ts` had to work to keep — with no conversion at either end.
     */
    const ids = (table.data.neuronId ?? []).slice(0, 500).map(String)
    expect(ids.every((id) => /^\d{15,19}$/.test(id))).toBe(true)
    // The load-bearing half: most of these cannot survive being a double, so if anything on the
    // way in had made one a number, the text here would differ from the text on the wire. (An
    // id merely *ending* in zeroes proves nothing — plenty do by chance.)
    const unrepresentable = ids.filter((id) => String(Number(id)) !== id)
    expect(unrepresentable.length).toBeGreaterThan(ids.length / 2)
  }, 300_000)
})

/**
 * The workspace worked out, against the real account.
 *
 * 46 bases across 14 workspaces is exactly the case the field was tedious for — and the only
 * place the uniqueness assumption can actually be checked.
 */
describe.skipIf(!TOKEN)('FlyTable, live — resolving a workspace', () => {
  it('reads a base named without its workspace, and agrees with the explicit form', async () => {
    setToken(HOST, TOKEN!)
    const bases = await listBases(HOST)
    const names = bases.map((b) => b.name)
    const unique = names.filter((n) => names.filter((m) => m === n).length === 1)
    expect(unique.length).toBeGreaterThan(0)

    // Resolution agrees with the listing for every base whose name is unique — the property the
    // whole feature rests on, checked across the account rather than on one example.
    for (const name of unique) {
      const found = resolveWorkspace(bases, name)
      expect(found).toEqual([bases.find((b) => b.name === name)!.workspaceId])
    }

    // And a base actually opens without one. `main` is FlyWire's annotations base.
    const target = unique.includes('main') ? 'main' : unique[0]!
    const tables = await readMetadata(HOST, '', target)
    expect(tables.length).toBeGreaterThan(0)
  }, 60_000)
})
