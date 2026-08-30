/**
 * The two skeleton routes a neuPrint dataset can have. **Skipped unless `NEUPRINT_TOKEN` is set.**
 *
 *   NEUPRINT_TOKEN="$NEUPRINT_APPLICATION_CREDENTIALS" \
 *     pnpm vitest run src/data/neuprint/live.test.ts
 *
 * `neuprint.test.ts` runs against recorded responses and hand-written layer lists, which proves
 * the resolution and proves nothing about the only question that eventually matters: **which
 * datasets actually publish a skeleton layer**. That is a fact about somebody's bucket, it is
 * mentioned in no contract, and it decides whether the Skeletons node offers one route or two.
 *
 * What was measured when this was written, over all twelve datasets the deployment lists:
 *
 *   male-cns:v0.9      skeletons-malecns/skeletons-precomputed
 *   male-cns:v1.0      skeletons-malecns/skeletons-precomputed
 *   optic-lobe:v1.0.1  skeletons                    (the male-CNS export; covers 5 of 20 sampled)
 *   optic-lobe:v1.1    skeletons-precomputed
 *   manc:v1.0          skeleton
 *   hemibrain, manc:v1.2.x, banc, fib19, mushroombody — none
 *
 * And on `male-cns:v1.0` body 45882, the two routes are the **same reconstruction**: 1,688 nodes
 * either way, the same bounds in nanometres once the SWC's voxels are scaled by 8. The published
 * copy carries no radii, needs no token, and is about half the bytes — which is the whole of
 * what the choice is between, and is why the SWC leads.
 *
 * Out of CI on purpose, like every other live file here: it needs a credential and somebody
 * else's bandwidth. It reads only.
 */

import { afterAll, describe, expect, it } from 'vitest'

import { NeuPrintSource } from './NeuPrintSource'
import { resetCredentials, setToken } from './credentials'

const TOKEN = process.env.NEUPRINT_TOKEN
const live = TOKEN ? describe : describe.skip

/*
 * No storage stub, and that is a claim rather than an omission: `client.ts` remembers which
 * route a deployment answered on in `localStorage`, and `credentials.ts` keeps the token there —
 * both behind guards, because `localStorage` is undefined under plain Node. A file that had to
 * install one would be a file proving something about jsdom.
 */
afterAll(() => resetCredentials())

live('neuPrint, live — where a skeleton comes from', () => {
  it('offers both routes for male-CNS, and the SWC first', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    // Two chained reads behind the answer — the neuroglancer state, then the volume's `info` —
    // and the peek is not allowed to await either (invariant 2), so this test does.
    expect(source.skeletonSourcesFor!('male-cns:v1.0')).toBeUndefined()
    for (let i = 0; i < 100 && !source.skeletonSourcesFor!('male-cns:v1.0'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(source.skeletonSourcesFor!('male-cns:v1.0')?.map((r) => r.id)).toEqual([
      'neuprint',
      'published',
    ])
  }, 120_000)

  it('offers one for hemibrain, whose bucket names no skeletons', async () => {
    // The other half of the same question, and the reason the list is per dataset rather than
    // per source: eight of the twelve publish nothing to choose from.
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    source.skeletonSourcesFor!('hemibrain:v1.2.1')
    for (let i = 0; i < 100 && !source.skeletonSourcesFor!('hemibrain:v1.2.1'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(source.skeletonSourcesFor!('hemibrain:v1.2.1')?.map((r) => r.id)).toEqual(['neuprint'])
  }, 120_000)

  it('reads the same neuron down both routes, in the same nanometres', async () => {
    /*
     * The claim the dropdown makes, checked rather than asserted from a docstring. Same node
     * count, same bounds — and only one of them has radii, which is the difference somebody
     * choosing between them needs to know about.
     *
     * The bounds are compared with a tolerance of nothing at all: they are the same float32
     * coordinates, arrived at one way by scaling neuPrint's voxels by the `Meta.voxelSize` of 8
     * and the other by reading a bucket that stores nanometres. A mismatch here is the factor-of-8
     * error that puts a skeleton across the room from its own mesh with nothing failing.
     */
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const request = { datasetId: 'male-cns:v1.0', neuronIds: ['45882'] }

    const swc = await source.fetchSkeletons({ ...request })
    const published = await source.fetchSkeletons({ ...request, skeletonSource: 'published' })

    expect(swc.provenance?.id).toBe('neuprint')
    expect(published.provenance?.id).toBe('published')
    expect(swc.items[0]!.parents.length).toBe(published.items[0]!.parents.length)
    expect(published.bounds.min).toEqual(swc.bounds.min)
    expect(published.bounds.max).toEqual(swc.bounds.max)
    expect(swc.units).toBe('nm')
    expect(published.units).toBe('nm')

    // The one real difference. male-CNS's directory declares no `vertex_attributes` at all, so
    // every radius is 0 — a fact `precomputed/skeletons.ts` records and this confirms is still
    // true of the published copy while the SWC's radii are real.
    expect(swc.items[0]!.radii.some((r) => r > 0)).toBe(true)
    expect(published.items[0]!.radii.every((r) => r === 0)).toBe(true)
  }, 180_000)

  it('refuses the published route on a dataset that has none, rather than answering with the SWC', async () => {
    // The substitution is the failure: a card still saying "published skeletons" over geometry
    // that came from somewhere else silently changes what every cable length downstream means.
    setToken(TOKEN!)
    await expect(
      new NeuPrintSource().fetchSkeletons({
        datasetId: 'hemibrain:v1.2.1',
        neuronIds: ['1158187240'],
        skeletonSource: 'published',
      }),
    ).rejects.toThrow(/publishes no precomputed skeleton layer/)
  }, 120_000)
})
