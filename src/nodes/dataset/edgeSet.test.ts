/**
 * Attaching a user-supplied edge set to a dataset node.
 *
 * The identity lives in two params and travels in the `.coda.json`; the edges themselves never
 * do. Everything asserted here is a consequence of that, and each one fails as something
 * *plausible*: a set that reaches the value but not the type leaves the Paths node refused on a
 * dataset that could answer it, a name in the provenance key re-runs an entire graph because
 * somebody renamed a file, and a warning raised before the catalogue has been read appears on
 * every dataset node in a graph that is perfectly fine.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { EdgeSetBuilder } from '../../data/edges/encode'
import { edgeSetsKnown, listEdgeSets, resetEdgeSets, saveEdgeSet } from '../../data/edges/store'
import { sourceSupports } from '../lib/datasetParam'
import '../index'

const FAMILY = 'dataset.mock.hemibrain'
const CATMAID = 'dataset.catmaid.fafb'

beforeAll(async () => {
  await registerSource(new MockSource({ latencyMs: 0 })).listDatasets()
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetEdgeSets()
})

function ctxFor(type: string, params: ParamValues = {}) {
  const def = requireNodeDef(type)
  return makeInferContext(def, { ...defaultParams(def), ...params }, {})
}

const paramIds = (type: string) => (requireNodeDef(type).params ?? []).map((p) => p.id)

async function importSet(name = 'FlyWire 783') {
  const b = new EdgeSetBuilder()
  b.add('1001', '1002', 5)
  return saveEdgeSet(b.finish(), { name, origin: 'edges.csv' })
}

describe('the params', () => {
  it('are on a backend that might want one, and absent on CATMAID', () => {
    expect(paramIds(FAMILY)).toContain('edgeSetId')
    // Not a capability gap — `data/queries.ts` is backend-agnostic — but a control nobody is
    // expected to reach for. See `DatasetBackend.edgeSets`.
    expect(paramIds(CATMAID)).not.toContain('edgeSetId')
    expect(paramIds(CATMAID)).not.toContain('edgeSetName')
  })

  it('keeps the id in the provenance key and the name out of it', () => {
    // Asserted on the declaration rather than through the scheduler, which is what actually
    // reads `presentational` — that half is covered by `profile.test.ts` and `download.test.ts`.
    // What can go wrong *here* is the flags, and they are opposite for a reason: the id decides
    // every connectivity answer, and the name reaches only a refusal message, so leaving it in
    // would re-run an entire graph because somebody renamed a file.
    const params = requireNodeDef(FAMILY).params ?? []
    expect(params.find((p) => p.id === 'edgeSetId')?.presentational).toBeFalsy()
    expect(params.find((p) => p.id === 'edgeSetName')?.presentational).toBe(true)
  })

  it('are internal, so the card does not advertise them as settings', () => {
    // They are machinery the panel writes, like a `refresh` nonce — counting them would have a
    // dataset card claim a parameter had been changed whenever a file was attached.
    const params = requireNodeDef(FAMILY).params ?? []
    for (const id of ['edgeSetId', 'edgeSetName']) {
      expect(params.find((p) => p.id === id)?.internal).toBe(true)
    }
  })
})

describe('the type', () => {
  it('says an edge set is attached, which unlocks Paths', async () => {
    const bare = requireNodeDef(FAMILY).inferOutputs!(ctxFor(FAMILY))['dataset']
    const attached = requireNodeDef(FAMILY).inferOutputs!(ctxFor(FAMILY, { edgeSetId: 'abc' }))[
      'dataset'
    ]
    expect(bare).not.toHaveProperty('edges')
    expect(attached).toMatchObject({ edges: true })

    // The unlock itself: a local edge set answers a hop, so a backend declaring `paths: false`
    // goes from refusing outright to being traceable. Asserted through `sourceSupports`, which
    // is what the Paths node's `validate` calls — it did not, until this pass, so the flag had
    // no reader outside this test and the assertion was about nothing.
    expect(sourceSupports({ inputs: { dataset: bare } }, 'paths')).toBe(
      new MockSource({ latencyMs: 0 }).capabilities.paths,
    )
    expect(sourceSupports({ inputs: { dataset: attached } }, 'paths')).toBe(true)
  })
})

describe('the value', () => {
  it('carries the id, and the catalogue’s current name', async () => {
    const meta = await importSet('FlyWire 783')
    await listEdgeSets()
    const def = requireNodeDef(FAMILY)
    const out = await def.evaluate!({
      params: { ...defaultParams(def), edgeSetId: meta.id, edgeSetName: 'stale name' },
      input: () => undefined,
      inputKey: () => undefined,
      inputType: () => undefined,
      column: () => undefined,
      columns: () => [],
      resolveSource: () => registerSource(new MockSource({ latencyMs: 0 })),
      refresh: false,
      signal: new AbortController().signal,
      progress: () => {},
      reportFetched: () => {},
    } as never)
    // The stored name is a fallback for the case the catalogue cannot answer — a set that has
    // been renamed since should read as its current name, not as the one baked into the file.
    expect((out.dataset as { edges?: { id: string; name: string } }).edges).toEqual({
      id: meta.id,
      name: 'FlyWire 783',
    })
  })

  it('carries nothing at all when none is attached', async () => {
    const def = requireNodeDef(FAMILY)
    const out = await def.evaluate!({
      params: defaultParams(def),
      input: () => undefined,
      inputKey: () => undefined,
      inputType: () => undefined,
      column: () => undefined,
      columns: () => [],
      resolveSource: () => registerSource(new MockSource({ latencyMs: 0 })),
      refresh: false,
      signal: new AbortController().signal,
      progress: () => {},
      reportFetched: () => {},
    } as never)
    // A spread rather than a field, so a saved graph does not gain an `edges: undefined`.
    expect(out.dataset).not.toHaveProperty('edges')
  })
})

describe('validate', () => {
  it('says nothing before the catalogue has been read', () => {
    // Otherwise every dataset node in a loaded graph warns for the instant before the read
    // lands — the unknown-versus-empty distinction, and a check that cries wolf.
    const issues = requireNodeDef(FAMILY).validate!(ctxFor(FAMILY, { edgeSetId: 'missing' }))
    expect(issues.filter((i) => /edge set/i.test(i))).toEqual([])
  })

  it('starts the catalogue read itself rather than waiting for the card', async () => {
    /*
     * `validate` is the one caller guaranteed to run. Returning early on `edgeSetsKnown()` left
     * the read to be started by the dataset card's own peek — and the card is not rendered while
     * the node is collapsed, so a collapsed card naming a missing edge set warned about nothing,
     * for ever.
     */
    expect(edgeSetsKnown()).toBe(false)
    requireNodeDef(FAMILY).validate!(ctxFor(FAMILY, { edgeSetId: 'missing' }))
    // Waited for rather than awaited: calling `listEdgeSets()` here would start the read this
    // test is trying to observe, which is what made the first version of it pass either way.
    await vi.waitFor(() => expect(edgeSetsKnown()).toBe(true))
  })

  it('names a set this browser does not have, once it knows', async () => {
    await listEdgeSets()
    const issues = requireNodeDef(FAMILY).validate!(
      ctxFor(FAMILY, { edgeSetId: 'missing', edgeSetName: 'FlyWire 783' }),
    )
    expect(issues.some((i) => i.includes('FlyWire 783'))).toBe(true)
    // Recoverable, and the message has to say how: the id is the file's contents.
    expect(issues.some((i) => /same file/.test(i))).toBe(true)
  })

  it('is quiet about a set that is here', async () => {
    const meta = await importSet()
    await listEdgeSets()
    const issues = requireNodeDef(FAMILY).validate!(ctxFor(FAMILY, { edgeSetId: meta.id }))
    expect(issues.filter((i) => /edge set/i.test(i))).toEqual([])
  })
})
