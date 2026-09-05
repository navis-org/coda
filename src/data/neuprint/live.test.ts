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

import { getColumn } from '../../core/values'
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
    expect(source.skeletonSourcesFor!('hemibrain:v1.2.1')?.map((r) => r.id)).toEqual([
      'neuprint',
    ])
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

/**
 * The region split and the two denominators, against the server they were designed from.
 *
 * Every claim in `ConnectivityRequest.splitByRoi`, `SynapseTotalsBasis` and
 * `synapseTotalsCypher` is a claim about male-CNS's data rather than about this code, and none
 * of them can be checked from a fixture — a recorded response proves the decoder works and
 * proves nothing about whether `roiInfo` still sums to `w.weight`, or whether `downstream` is
 * still the number a connection weight is a fraction of. Those are facts about somebody's
 * database, they are what every number this feature emits is built on, and they would change
 * silently.
 *
 * The reference values, measured on **male-cns:v1.0, body 10005** (AOTU019, Traced) when this
 * was written. Ratios rather than bare numbers wherever a re-export could legitimately move
 * them; the identities are asserted exactly, because those are structural.
 *
 *   n.post = n.upstream ....... 31,981      n.pre (T-bars) ........  2,837
 *   n.downstream .............. 23,423      Sigma out-weight, all partners ... 23,423
 *   Sigma out-weight, :Neuron partners ...  9,324
 *   Sigma in-weight, all partners ....... 31,981   :Neuron partners ... 31,389
 *
 * Out of CI like every other live file here: it needs a credential and somebody else's
 * database, and it reads only.
 */
live('neuPrint, live — what a weight is a fraction of', () => {
  const DATASET = 'male-cns:v1.0'
  const BODY = '10005'

  const sum = (t: { data: Record<string, unknown[]> }): number =>
    (t.data.weight ?? []).reduce((total: number, w) => total + Number(w), 0)
  const total = (t: { data: Record<string, unknown[]> }): number => Number(t.data.total?.[0])

  it('splits a connection over the primary regions without adding or losing a synapse', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    await source.listDatasets()
    const primaryRois = source.peekDataset(DATASET)?.primaryRois
    expect(primaryRois?.length).toBeGreaterThan(100)

    const request = { datasetId: DATASET, neuronIds: [BODY], direction: 'outputs' as const }
    const whole = await source.fetchConnectivity(request)
    const split = await source.fetchConnectivity({
      ...request,
      rois: primaryRois!,
      splitByRoi: true,
    })

    /*
     * The decomposition promise, and the only place it can actually be tested. 23,423 either
     * way when this was written: male-CNS's 144 primary regions tile, so every synapse of every
     * connection lands in exactly one of them. If neuPrint ever publishes a primary set that
     * does not tile, or a `roiInfo` that omits regions, this is where it shows up — and
     * everywhere else it would show up as a total that is quietly wrong.
     */
    expect(sum(split)).toBe(sum(whole))
    expect(split.length).toBeGreaterThan(whole.length)
    expect(new Set(split.data.roi).size).toBeGreaterThan(1)
  }, 120_000)

  it('loses the sub-percent of hemibrain that sits in no primary region, and no more', async () => {
    /*
     * The other half of the same fact, pinned rather than left as prose on `splitByRoi`. The
     * primary set does **not** tile every dataset: over 20,000 sampled connections hemibrain
     * puts 1,104 of 274,844 synapses (0.4%) outside every primary region, and optic-lobe 0.9%.
     * A split over that set drops them — nothing here invents a `NotPrimary` bucket the way
     * neuprint-python does — so this asserts both that the loss is real and that it is small.
     * A split that started losing a tenth of a connectome would be a change in the data or a
     * bug in the region list, and either is worth failing over.
     */
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    await source.listDatasets()
    const dataset = 'hemibrain:v1.2.1'
    const primaryRois = source.peekDataset(dataset)?.primaryRois
    expect(primaryRois?.length).toBe(63)

    const seeds = ['1671631407', '5813069064', '1158187240']
    const request = { datasetId: dataset, neuronIds: seeds, direction: 'outputs' as const }
    const whole = await source.fetchConnectivity(request)
    const split = await source.fetchConnectivity({
      ...request,
      rois: primaryRois!,
      splitByRoi: true,
    })
    expect(sum(split)).toBeLessThanOrEqual(sum(whole))
    expect(sum(split)).toBeGreaterThan(sum(whole) * 0.97)
  }, 120_000)

  it('restricts a weight to the region rather than passing the whole connection', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const request = { datasetId: DATASET, neuronIds: [BODY], direction: 'outputs' as const }
    const restricted = await source.fetchConnectivity({ ...request, rois: ['LAL(L)'] })
    // 9,344 in LAL(L), out of 13,071 carried by the connections that touch it. A filter that
    // kept whole connections would answer the larger number, and both are plausible.
    expect(sum(restricted)).toBeLessThan(11_000)
    expect(sum(restricted)).toBeGreaterThan(8_000)
  }, 120_000)

  it('publishes a total that the all-partner weights sum to exactly', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    for (const side of ['outputs', 'inputs'] as const) {
      const edges = await source.fetchConnectivity({
        datasetId: DATASET,
        neuronIds: [BODY],
        direction: side,
      })
      const totals = await source.fetchSynapseTotals({
        datasetId: DATASET,
        neuronIds: [BODY],
        side,
        basis: 'all',
      })
      const summed = sum(edges)
      /*
       * The identity the `all` basis rests on: `n.downstream` (23,423) and `n.upstream`
       * (31,981) are exactly the sums of the connection weights over *every* partner. That is
       * what makes "all synapses" a denominator the fractions of a full partner list sum to 1
       * under — and it is also why `n.pre` is not it, at 2,837.
       */
      expect(total(totals)).toBe(summed)
    }
  }, 180_000)

  it('sums a type’s denominator over its whole population', async () => {
    /*
     * The claim `fetchGroupTotals` rests on, and the only place it can be checked: a Paths row's
     * weight is every LC4→partner synapse, so its denominator has to be every synapse every LC4
     * neuron receives — the grouped query and the per-neuron one summed have to be the *same
     * number*. If they ever differ, `groupTotalsCypher`'s `:Neuron` match and `findNeurons`'
     * population have parted company, and the fraction on the card would be quietly wrong rather
     * than missing.
     */
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const members = await source.findNeurons({
      datasetId: DATASET,
      rows: [{ field: 'type', op: 'is', values: ['LC4'] }],
    })
    const ids = (members.data.neuronId ?? []).map(String)
    expect(ids.length).toBeGreaterThan(10)

    for (const side of ['inputs', 'outputs'] as const) {
      const perNeuron = await source.fetchSynapseTotals({
        datasetId: DATASET,
        neuronIds: ids,
        side,
        basis: 'all',
      })
      const grouped = await source.fetchGroupTotals({
        datasetId: DATASET,
        types: ['LC4'],
        side,
        basis: 'all',
      })
      const summed = (perNeuron.data.total ?? []).reduce((t: number, v) => t + Number(v), 0)
      expect(grouped.length).toBe(1)
      expect(grouped.data.key?.[0]).toBe('LC4')
      expect(total(grouped)).toBe(summed)
    }
  }, 180_000)

  it('keys a lone body by its id as text, which is what the traversal looks up', async () => {
    // The other arm, and the one a numeric key would break silently: a group key is text
    // everywhere in `pathOps`, so an id that came back as a number misses every lookup and reads
    // as a dataset that publishes no totals.
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const grouped = await source.fetchGroupTotals({
      datasetId: DATASET,
      neuronIds: [BODY],
      side: 'inputs',
      basis: 'all',
    })
    expect(grouped.data.key?.[0]).toBe(BODY)
    // 31,981 — the same number the per-neuron query answers, since one body is one group.
    const perNeuron = await source.fetchSynapseTotals({
      datasetId: DATASET,
      neuronIds: [BODY],
      side: 'inputs',
      basis: 'all',
    })
    expect(total(grouped)).toBe(total(perNeuron))
  }, 120_000)

  it('leaves out the fragments for the connected basis, which is most of the outputs', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const request = { datasetId: DATASET, neuronIds: [BODY] }
    const [allOut, connectedOut] = await Promise.all([
      source.fetchSynapseTotals({ ...request, side: 'outputs', basis: 'all' }),
      source.fetchSynapseTotals({ ...request, side: 'outputs', basis: 'connected' }),
    ])
    /*
     * 23,423 against 9,324 — the gap the control exists for, and the asymmetry the user of this
     * node has to be told about: outputs land on dendrites, which are hard to reconstruct, so
     * only about 40% of them reach a named neuron. Inputs come from axons and lose 2%.
     */
    expect(total(connectedOut)).toBeLessThan(total(allOut) * 0.6)

    const [allIn, connectedIn] = await Promise.all([
      source.fetchSynapseTotals({ ...request, side: 'inputs', basis: 'all' }),
      source.fetchSynapseTotals({ ...request, side: 'inputs', basis: 'connected' }),
    ])
    expect(total(connectedIn)).toBeGreaterThan(total(allIn) * 0.95)
  }, 180_000)
})

/**
 * Partner-resolved synapses, checked against the server's own connection weights.
 *
 * `fetchSynapseLinks` exists because neuPrint drops `partnerId`/`partnerType` from the synapse
 * schema, and the query behind it is transcribed from neuprint-python's `fetch_synapse_connections`
 * — a `SynapseSet` pair to pin which two *neurons*, then a `SynapsesTo` pair to pin which two
 * *synapses*. Both halves are easy to get subtly wrong in ways that still return a plausible
 * table, so what is asserted here is the one thing that cannot be fudged: every returned row is
 * one connection, and grouping them by partner must reproduce `ConnectsTo.weight` exactly.
 *
 * Measured when this was written, on `male-cns:v1.0` body 10003 (VCH): 57,034 rows in 2.7 s —
 * exactly `n.synweight` — being 30,020 outgoing over 14,983 partners and 27,014 incoming over
 * 3,016, with per-partner weights identical to `ConnectsTo` on both arms.
 *
 * The **shape** of the query is load-bearing and is not visible in its results: written as
 * `MATCH (n:Neuron), (pattern)` with the `WHERE` afterwards, Neo4j expands every neuron in the
 * dataset before filtering and the query does not return inside two minutes. Binding and
 * filtering `n` first is what makes it 2.7 s. A regression there reads as a hang, not an error.
 */
live('partner-resolved synapses, live', () => {
  const DATASET = 'male-cns:v1.0'
  const BODY = '10003'

  it('returns one row per connection, agreeing with ConnectsTo per partner', async () => {
    setToken(TOKEN!)
    const source = new NeuPrintSource()
    const points = await source.fetchSynapseLinks!({
      datasetId: DATASET,
      neuronIds: [BODY],
    })

    const partners = getColumn(points.attributes, 'partnerId')!
    const polarity = getColumn(points.attributes, 'polarity')!
    expect(points.attributes.length).toBeGreaterThan(0)
    // Three coordinates per row, or the cloud and the table have come apart.
    expect(points.positions.length).toBe(points.attributes.length * 3)

    const outgoing = new Map<string, number>()
    for (let i = 0; i < points.attributes.length; i++) {
      if (polarity[i] !== 'pre') continue
      const key = String(partners[i])
      outgoing.set(key, (outgoing.get(key) ?? 0) + 1)
    }

    const reference = await source.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: [BODY],
      direction: 'outputs',
    })
    const refPartner = getColumn(reference, 'partnerId')!
    const refWeight = getColumn(reference, 'weight')!

    expect(outgoing.size).toBe(reference.length)
    for (let i = 0; i < reference.length; i++) {
      expect(outgoing.get(String(refPartner[i]))).toBe(Number(refWeight[i]))
    }
  }, 120_000)
})
