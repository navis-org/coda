/**
 * The DVID reader, against the real server. **Skipped unless `DVID_LIVE` is set.**
 *
 *   DVID_LIVE=1 pnpm vitest run src/data/dvid/live.test.ts
 *
 * Every fact here is one nobody publishes a contract for, and each was measured before the code
 * was written rather than after: that `.ngmesh` is `neuroglancer_legacy_mesh`'s fragment, that a
 * missing instance answers **400** where a missing key answers **404**, and — the one that would
 * otherwise be silent — that **meshes are in nanometres and skeletons are in voxels**, in the
 * same repo for the same body.
 *
 * `flyem.dvid.io` is used because it is public: most DVID deployments are reachable by anybody
 * holding the address, so a private one must not appear in a committed file. `mushroombody` here
 * is the same node `neuprint.janelia.org` names in that dataset's published viewer state.
 *
 * It reads only, and deliberately never fetches `AL-VA1v` body 1010's mesh — 107 MB for one
 * neuron. That number is asserted from its *skeleton* and its extents instead.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { THUMBNAIL_MAX_BYTES, fetchCoarseMesh, fetchMeshes } from '../precomputed/index'
import { meshSourceFromState } from '../neuprint/nglayers'
import { readInstanceInfo } from './client'
import { openDvidMeshSource, readNgMesh } from './meshes'
import { openDvidSkeletonSource, readDvidSkeleton } from './skeletons'
import { instanceUrl, meshInstance, parseDvidRef, skeletonInstance } from './refs'

const live = process.env.DVID_LIVE ? describe : describe.skip

/** The public mushroombody node, exactly as neuPrint's `nglayers` publishes it. */
const MUSHROOMBODY = 'https://flyem.dvid.io/babdf6dbc23e44a69953a66e2260ff0a/groundtruth'

/** Two small mushroombody bodies: 23 kB and 106 kB. */
const SMALL = '100001853'
const BIGGER = '100003022'

live('DVID meshes, live', () => {
  const ref = parseDvidRef(MUSHROOMBODY)!
  /*
   * Opened once for the whole block. This file's whole point is that it hits a real Janelia
   * server, so re-opening per case doubled the requests for nothing — the one case that needs
   * its own open is the one asserting on the open.
   */
  let source: Awaited<ReturnType<typeof openDvidMeshSource>>
  beforeAll(async () => {
    source = await openDvidMeshSource(ref)
  }, 60_000)

  it('finds the mesh instance by neuroglancer’s naming convention', async () => {
    expect(source.format).toBe('dvid-ngmesh')
    expect(source.levels).toBe(1)
    expect(source.base).toContain('groundtruth_meshes')
  }, 60_000)

  it('tells a missing instance (400) from a missing key (404)', async () => {
    /*
     * The opposite way round from what a reader expecting REST would guess, and both are
     * ordinary: this repo publishes meshes and no skeletons.
     */
    expect(await readInstanceInfo(instanceUrl(ref, meshInstance(ref)))).toBeTruthy()
    expect(await readInstanceInfo(instanceUrl(ref, skeletonInstance(ref)))).toBeUndefined()
    // A body that is not in the store, through the same reader a scene uses.
    expect(await readNgMesh(source, '5813020600', {})).toBeUndefined()
  }, 60_000)

  it('decodes .ngmesh with the legacy fragment parser and nothing else', async () => {
    const mesh = await readNgMesh(source, BIGGER, {})
    expect(mesh).toBeTruthy()
    // Measured 2026-08-31: 106,360 bytes, 2,966 vertices, 5,897 triangles.
    expect(mesh!.positions.length / 3).toBe(2966)
    expect(mesh!.indices.length / 3).toBe(5897)
    expect(mesh!.indices.length % 3).toBe(0)
  }, 60_000)

  it('puts mesh vertices in nanometres, not voxels', async () => {
    /*
     * The finding this whole file exists to pin. `groundtruth` is 8 nm isotropic with a voxel
     * extent of x 2,496…5,503 — so 19,968…44,024 nm. A mesh vertex at x≈31,000 is inside the
     * nanometre range and an order of magnitude outside the voxel one. `skeletons.ts` scales;
     * this does not, and neither may assume the other's rule.
     */
    const mesh = await readNgMesh(source, BIGGER, {})
    const xs = mesh!.positions.filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBeGreaterThan(19_968)
    expect(Math.max(...xs)).toBeLessThan(44_024)
  }, 60_000)

  it('reads a set through fetchMeshes, counting an absent body as missing', async () => {
    const result = await fetchMeshes(source, [SMALL, BIGGER, '5813020600'], { refresh: true })
    expect(result.levels).toBe(1)
    expect(result.meshes.map((m) => m.neuronId).sort()).toEqual([BIGGER, SMALL].sort())
    expect(result.missing).toEqual(['5813020600'])
  }, 120_000)

  it('bounds the download rather than the decode, since DVID publishes no size', async () => {
    /*
     * `HEAD` carries no `Content-Length` and `Range` is ignored (200, not 206) — both measured —
     * so the only way to bound one body is to stop reading it. A check after `arrayBuffer()`
     * would already have spent the bytes, and one body in another repo is 107 MB.
     */
    const result = await fetchMeshes(source, [BIGGER], { refresh: true, maxBytesPerBody: 1024 })
    expect(result.meshes).toEqual([])
    expect(result.missing).toEqual([BIGGER])
  }, 60_000)

  it('draws a thumbnail, because the ceiling makes that affordable', async () => {
    /*
     * The one place `dvid-ngmesh` and `legacy` part company in `fetchCoarseMesh`, and the reason
     * is the ceiling rather than the pyramid: neither has levels, but a DVID body is one key
     * that `maxBytes` can cut off, where a legacy body is a manifest plus fragments already
     * mostly spent by the time a ceiling could bite. Sampled on this dataset, 40 bodies: median
     * 16 kB, p90 92 kB, max 487 kB — a page of 25 is about 0.4 MB.
     */
    const mesh = await fetchCoarseMesh(source, BIGGER)
    expect(mesh).toBeTruthy()
    expect(mesh!.positions.length / 3).toBe(2966)
    // And a body over the ceiling draws a placeholder rather than downloading itself.
    expect(THUMBNAIL_MAX_BYTES).toBeGreaterThan(487 * 1024)
  }, 60_000)
})

live('the neuPrint route, live', () => {
  /*
   * The payoff that is not about private servers: `mushroombody` and `fib19:v1.0` are the two
   * neuPrint datasets whose published state names a `dvid://` segmentation and no object store,
   * so both answered "does not publish a mesh source".
   *
   * The state is fetched with a bare `fetch` rather than through `NeuPrintSource`, because
   * `neuprint/client.ts` refuses every path without a token even though `/api/npexplorer/…`
   * answers unauthenticated — so going through the source would test the token gate rather than
   * this. What is under test is `meshSourceFromState` choosing the DVID branch and
   * `openDvidMeshSource` opening what it chose.
   */
  // Memoised: four cases read three states, against somebody else's server.
  const states = new Map<string, Promise<Parameters<typeof meshSourceFromState>[0]>>()
  const stateFor = (datasetId: string) => {
    const held = states.get(datasetId)
    if (held) return held
    const fetching = fetch(
      `https://neuprint.janelia.org/api/npexplorer/nglayers/${datasetId}.json`,
    ).then((r) => r.json() as Promise<Parameters<typeof meshSourceFromState>[0]>)
    states.set(datasetId, fetching)
    return fetching
  }

  it('picks the dvid segmentation out of mushroombody’s published state', async () => {
    const chosen = meshSourceFromState(await stateFor('mushroombody'), 'mushroombody')
    expect(chosen?.scheme).toBe('dvid')
    expect(chosen?.url).toBe(MUSHROOMBODY)
  }, 60_000)

  it('does the same for fib19, the other dataset with no object store', async () => {
    const chosen = meshSourceFromState(await stateFor('fib19:v1.0'), 'fib19:v1.0')
    expect(chosen?.scheme).toBe('dvid')
    // The node is abbreviated to five hex characters in this one, which is why `parseDvidRef`
    // has no length rule.
    expect(chosen?.url).toContain('/93f08/segmentation')
  }, 60_000)

  it('still prefers a pyramid where one exists, rather than taking dvid first', async () => {
    // hemibrain publishes both an object store and a `dvid://` annotation layer. DVID is a last
    // resort: one level of detail, and bodies that run to 107 MB.
    const chosen = meshSourceFromState(await stateFor('hemibrain:v1.2.1'), 'hemibrain:v1.2.1')
    expect(chosen?.scheme).toBe('precomputed')
  }, 60_000)

  it('reads mushroombody meshes end to end from its published state', async () => {
    const chosen = meshSourceFromState(await stateFor('mushroombody'), 'mushroombody')
    const source = await openDvidMeshSource(parseDvidRef(chosen!.url)!)
    const result = await fetchMeshes(source, [SMALL, BIGGER], { refresh: true })
    expect(result.meshes.map((m) => m.neuronId).sort()).toEqual([BIGGER, SMALL].sort())
    expect(result.meshes[0]!.positions.length).toBeGreaterThan(0)
  }, 180_000)
})

live('DVID skeletons, live', () => {
  /*
   * What is live-checkable here is narrower than for meshes, and the reason is a fact about the
   * public servers rather than about the code: **no public DVID has both the
   * `<segmentation>_skeletons` convention resolving and a populated store.** `AL-VA1v` has 192
   * real skeletons but keeps them in `bodies121714_skeletons`, a legacy prefix with no
   * segmentation behind it; `hemibrain-flattened` resolves the convention and its store is empty
   * (`keyrange` answers `[]`). So the two ends are checked here and the decode itself is checked
   * against real bytes in `skeletons.test.ts`.
   */
  const AL_VA1V = 'https://flyem.dvid.io/d925633ed0974da78e2bb5cf38d01f4d/segmentation'
  const HEMIBRAIN =
    'https://hemibrain-dvid.janelia.org/28841c8277e044a7b187dda03e18da13/segmentation'

  it('refuses where the convention finds no store, as neuroglancer does', async () => {
    // `AL-VA1v`'s skeletons are real and are not where the convention looks. Matching
    // neuroglancer is the decision — showing skeletons it says are absent would be worse.
    await expect(openDvidSkeletonSource(parseDvidRef(AL_VA1V)!)).rejects.toThrow(
      /no segmentation_skeletons instance/,
    )
  }, 60_000)

  let hemibrain: Awaited<ReturnType<typeof openDvidSkeletonSource>>
  beforeAll(async () => {
    hemibrain = await openDvidSkeletonSource(parseDvidRef(HEMIBRAIN)!)
  }, 60_000)

  it('opens a real store and reads its scale off the segmentation', async () => {
    /*
     * The scale is the half that cannot be defaulted. It comes from the *segmentation*
     * instance — a keyvalue store describes no geometry — so this costs one extra `info`, and a
     * scale that cannot be read is a refusal rather than an identity: publishing voxels as
     * nanometres would put every skeleton 8× inside its mesh with nothing failing.
     */
    expect(hemibrain.scale).toEqual([8, 8, 8])
    expect(hemibrain.base).toContain('segmentation_skeletons')
  }, 60_000)

  it('answers undefined for a body with no skeleton, rather than failing a scene', async () => {
    // Both key spellings are tried and neither is there; a scene of two hundred neurons must not
    // fail because one was never traced.
    expect(await readDvidSkeleton(hemibrain, '1734350788')).toBeUndefined()
  }, 60_000)

  it('refuses a store whose instance names no voxel size', async () => {
    // `bodies121714` is a keyvalue prefix, not a labelmap, so there is no `VoxelSize` behind it.
    // The refusal names what is missing rather than guessing 1.
    const legacy = 'https://flyem.dvid.io/d925633ed0974da78e2bb5cf38d01f4d/bodies121714'
    await expect(openDvidSkeletonSource(parseDvidRef(legacy)!)).rejects.toThrow(
      /does not say what bodies121714's voxels measure/,
    )
  }, 60_000)
})
