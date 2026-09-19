/**
 * The NeuronBridge bucket itself, asked the questions the fixtures stand in for.
 *
 * Skipped unless `NEURONBRIDGE_LIVE` is set, the gate `data/zapbench/live.test.ts` uses. What the
 * fixtures cannot tell anybody is that a path still resolves: a URL built from a record and a
 * store prefix is only right if the bucket answers it, and a release that moved a directory would
 * leave every fixture test green over a card of broken images. So the thumbnail the card would draw
 * is fetched, and the pointer is asked for rather than assumed to be the recorded `v3_10_0`.
 *
 *     NEURONBRIDGE_LIVE=1 pnpm vitest run src/data/neuronbridge/live.test.ts
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  currentVersion,
  fetchConfig,
  fetchMatches,
  fileUrl,
  hasMatches,
  lookupBody,
  resetNeuronBridgeClient,
} from './client'
import { datasetLibraries } from './libraries'
import { COLLECTIONS, groupByLine } from './matches'

const live = process.env.NEURONBRIDGE_LIVE ? describe : describe.skip

live('NeuronBridge, live', () => {
  beforeEach(() => resetNeuronBridgeClient())

  it('publishes a current version this build can read, and every connectome it maps', async () => {
    const version = await currentVersion()
    const config = await fetchConfig(version)
    for (const [source, dataset] of [
      ['neuprint', 'hemibrain:v1.2.1'],
      ['neuprint', 'male-cns:v0.9'],
      ['neuprint', 'manc:v1.2.1'],
      ['cave', 'flywire_fafb_public:783'],
      ['cave', 'brain_and_nerve_cord_public:626'],
    ] as const) {
      expect(datasetLibraries(config, source, dataset)?.names.size, dataset).toBeGreaterThan(0)
    }
  }, 30_000)

  it('finds a hemibrain neuron, reads its matches, and serves the images the card draws', async () => {
    const version = await currentVersion()
    const config = await fetchConfig(version)
    const hemibrain = datasetLibraries(config, 'neuprint', 'hemibrain:v1.2.1')!
    const records = (await lookupBody(version, '1734350788')).filter((r) =>
      hemibrain.names.has(r.libraryName),
    )
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(hasMatches(record, 'cds')).toBe(true)

    const { results } = await fetchMatches(version, record, 'cds')
    expect(results.length).toBeGreaterThan(100)
    const lines = groupByLine(results, 'cds', new Set(COLLECTIONS.map((c) => c.id)))
    expect(lines.length).toBeGreaterThan(10)

    const urls = [
      fileUrl(config, record.files, 'CDMThumbnail'),
      fileUrl(config, lines[0]!.best.image.files, 'CDMThumbnail'),
      fileUrl(config, lines[0]!.best.files, 'CDMMatch'),
    ]
    for (const url of urls) {
      expect(url).toBeDefined()
      const response = await fetch(url!, { method: 'HEAD' })
      expect(response.status, url).toBe(200)
    }
  }, 60_000)
})
