/**
 * Annotation sources against the real services. **Skipped unless a gate is set.**
 *
 * Two gates, because the two backends need different things. FlyTable needs `SEATABLE_TOKEN`;
 * Google Sheets needs no credential at all, so it is gated on `GOOGLE_SHEET_LIVE=1` instead —
 * `catmaid/live.test.ts`' idiom, and for its reason: a test with nothing to withhold would
 * otherwise run on every commit and hit somebody else's server for no new information.
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
import { GOOGLE_SHEET_PROVIDER, sheetExportUrl } from './googleSheet'
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

/**
 * Google Sheets, live. **Skipped unless `GOOGLE_SHEET_LIVE=1`.**
 *
 * The sheet is Google's own published sample — `Class Data`, linked from their Sheets API
 * documentation — so it is about as stable a public document as exists, and reading it needs no
 * account. What this notices is the thing recorded at length in `googleSheet.ts` and provable
 * nowhere else: that the export URL still answers, that it still redirects to
 * `googleusercontent.com`, and that **both hops still carry CORS**. A browser CORS-checks every
 * hop, so the day the first one stops echoing the origin the node is dead in the app and every
 * recorded-reply test in the tree still passes.
 *
 * Node's `fetch` does no CORS enforcement, so the headers are asserted rather than relied on —
 * which is exactly the gap `docs/flytable-cors.md` records having been caught by: "probed live"
 * covered every endpoint shape and none of the browser's actual constraint.
 *
 *   GOOGLE_SHEET_LIVE=1 pnpm vitest run src/data/annotations/live.test.ts
 */
const sheets = process.env.GOOGLE_SHEET_LIVE ? describe : describe.skip

/** Google's own documentation sample. Public, tiny, and not ours to change. */
const SAMPLE = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'

sheets('Google Sheets, live', () => {
  it('answers the export URL with CORS on every hop of the redirect', async () => {
    const response = await fetch(sheetExportUrl(SAMPLE, '0'), {
      headers: { Origin: 'https://example.com' },
      redirect: 'follow',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    /*
     * The final hop answers `*`; the 307 before it echoes the origin, which `redirect: 'follow'`
     * has already consumed by here. Both were measured — see the module note in
     * `googleSheet.ts` — and this asserts the half a followed redirect can still see.
     */
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect((await response.text()).split('\n')[0]).toContain('Student Name')
  }, 60_000)

  it('reads it into a Coda annotation table', async () => {
    const table = await annotationProvider(GOOGLE_SHEET_PROVIDER)!.fetch(
      {
        provider: GOOGLE_SHEET_PROVIDER,
        config: {
          documentId: SAMPLE,
          gid: '0',
          // Not a neuron table — nothing public is — so the id column is whatever this sheet
          // keys on. What is being proved is the transport and the shaping, not the biology.
          idColumn: 'Student Name',
          columns: 'Gender, Major',
        },
      },
      {},
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'Gender', 'Major'])
    expect(table.length).toBeGreaterThan(20)
    expect(table.data['neuronId']?.[0]).toBe('Alexandra')
  }, 60_000)

  it('answers a readable 404 for a document that does not exist', async () => {
    /*
     * The half of the failure path that comes back as a status rather than as a thrown fetch —
     * and the reason the message can name the *id*. A **Restricted** sheet is the other half and
     * is not testable here: it is a 302 to a sign-in page that a browser blocks and Node does
     * not, so what it proves in Node is the opposite of what happens in the app. That one is
     * covered by `annotations.test.ts`, against a stub of the browser's behaviour, with the real
     * measurement recorded in `googleSheet.ts`.
     */
    await expect(
      annotationProvider(GOOGLE_SHEET_PROVIDER)!.fetch(
        {
          provider: GOOGLE_SHEET_PROVIDER,
          config: {
            documentId: '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            gid: '',
            idColumn: 'root_id',
            columns: '',
          },
        },
        {},
      ),
    ).rejects.toThrow(/No sheet with that id/)
  }, 60_000)
})
