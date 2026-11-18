/**
 * A CAVE table read at a moment (`queryTableLive`).
 *
 * What is pinned is the request, because each of the three ways it differs from the materialized
 * endpoint was measured to fail **silently** on `wclee_aedes_brain` (2026-11-17): quoted ids
 * answer `[]`, a column list is a 500, and so is an epoch timestamp.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryTableLive } from './api'
import { CaveError } from './client'
import { DEFAULT_CAVE_SERVER } from './deployments'

const OPTIONS = { deployment: DEFAULT_CAVE_SERVER, token: 't' }
const AT = Date.UTC(2026, 10, 17, 8, 22, 57, 833)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Answers `text` as it is, so a test can send an id too wide for `Response.json` to write. */
function installServer(text = '[]') {
  const sent: { url: string; body: string }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, body: String(init?.body) })
    return new Response(text, { status: 200 })
  })
  return sent
}

const ask = (idsIn: Record<string, readonly string[]>) =>
  queryTableLive(
    'https://cave.example.org',
    'wclee_aedes_brain',
    AT,
    {
      table: 'nuclei_v1_aedes',
      idsIn,
      columns: ['id', 'pt_root_id', 'pt_position'],
      resolution: [1, 1, 1],
    },
    { consequence: 'some neurons would be missing their soma' },
    OPTIONS,
  )

describe('a table read at a moment', () => {
  it('sends the ids as bare integers, the columns keyed by table, and the moment in ISO', async () => {
    const sent = installServer()
    await ask({ pt_root_id: ['648518347585551219', '648518347558097460'] })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(
      'https://cave.example.org/materialize/api/v3/datastack/wclee_aedes_brain/query?' +
        'return_pyarrow=false&arrow_format=false&split_positions=false&merge_reference=false&' +
        'allow_missing_lookups=false&allow_invalid_root_ids=false',
    )
    // The literal body: an id written as a JSON number past 2⁵³ would already be another neuron
    // if it had passed through `JSON.parse`, so the text is what is compared.
    expect(sent[0]!.body).toBe(
      '{"table":"nuclei_v1_aedes","timestamp":"2026-11-17T08:22:57.833Z",' +
        '"filter_in_dict":{"nuclei_v1_aedes":{"pt_root_id":[648518347585551219,648518347558097460]}},' +
        '"select_columns":{"nuclei_v1_aedes":["id","pt_root_id","pt_position"]},' +
        '"desired_resolution":[1,1,1]}',
    )
  })

  it('reads a root id in the answer as text, exactly', async () => {
    installServer('[{"id":6393,"pt_root_id":648518347585551219,"pt_position_x":380352}]')
    const rows = await ask({ pt_root_id: ['648518347585551219'] })
    expect(rows[0]!.pt_root_id).toBe('648518347585551219')
  })

  it('refuses a value that is not a 64-bit id before anything is sent', async () => {
    const sent = installServer()
    // A sign or a leading zero passes the transport grammar and is not a number the server reads.
    for (const bad of ['1]}, "x": [2', '-1', '0648518347585551219', '18446744073709551616']) {
      await expect(ask({ pt_root_id: [bad] })).rejects.toThrow(/is not a root id/)
    }
    expect(sent).toEqual([])
  })

  it('refuses a read that names no root ids, which would be the whole table', async () => {
    const sent = installServer()
    await expect(ask({})).rejects.toThrow(/must name the root ids/)
    expect(sent).toEqual([])
  })

  it('answers nothing, asking nothing, about an empty list of ids', async () => {
    const sent = installServer()
    expect(await ask({ pt_root_id: [] })).toEqual([])
    expect(sent).toEqual([])
  })

  it('refuses a moment that is not a time, as a CAVE error', async () => {
    const sent = installServer()
    await expect(
      queryTableLive(
        'https://cave.example.org',
        'wclee_aedes_brain',
        Number.NaN,
        { table: 'nuclei_v1_aedes', idsIn: { pt_root_id: ['1'] } },
        { consequence: 'x' },
        OPTIONS,
      ),
    ).rejects.toThrow(CaveError)
    expect(sent).toEqual([])
  })
})
