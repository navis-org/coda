/**
 * The NeuronBridge client, against responses recorded from the live bucket on `v3_10_0`.
 *
 * `current.txt`, `config.json` and both `by_body` files are verbatim. The two match files are
 * *samples* of the recorded ones — the real CDS file is 3 MB — taken in file order: the first ten
 * matches of each LM collection from the CDS file, so every chip has something under it and five
 * lines carry more than one image, and the first twelve of the PPPM file.
 *
 * `live.test.ts` asks the same questions of the bucket itself.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NB_BUCKET,
  currentVersion,
  fetchConfig,
  fetchMatches,
  fileUrl,
  hasMatches,
  isReadableVersion,
  lookupBody,
  matchesPageUrl,
  peekCurrentVersion,
  resetNeuronBridgeClient,
  searchPageUrl,
  versionLabel,
} from './client'
import { datasetLibraries, isCoveredDataset } from './libraries'
import { COLLECTIONS, collectionCounts, collectionOf, groupByLine } from './matches'
import type { NbCollection } from './matches'
import { readImage, readMatches } from './types'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')

const BODIES: Record<string, string> = {
  '1734350788': 'by_body-1734350788.json',
  '11442': 'by_body-11442.json',
}

/** The bucket, as far as these files go. Anything else is a 404, as S3 answers a missing key. */
function bucket(current = fixture('current.txt')) {
  const calls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const path = url.startsWith(NB_BUCKET) ? url.slice(NB_BUCKET.length) : url
    let body: string | undefined
    if (path === '/current.txt') body = current
    else if (path === '/v3_10_0/config.json') body = fixture('config.json')
    else {
      const byBody = /^\/v3_10_0\/metadata\/by_body\/(\d+)\.json$/.exec(path)
      if (byBody && BODIES[byBody[1]!]) body = fixture(BODIES[byBody[1]!]!)
      if (path === '/v3_10_0/metadata/cdsresults/2945073143147307019.json')
        body = fixture('cdsresults-2945073143147307019.sample.json')
      if (path === '/v3_10_0/metadata/pppmresults/2941778995433177634.json')
        body = fixture('pppmresults-2941778995433177634.sample.json')
    }
    return body === undefined
      ? new Response('<Error><Code>NoSuchKey</Code></Error>', {
          status: 404,
          statusText: 'Not Found',
        })
      : new Response(body, { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, calls }
}

beforeEach(() => resetNeuronBridgeClient())
afterEach(() => vi.unstubAllGlobals())

describe('the version pointer', () => {
  it('reads current.txt, and a peek starts that fetch once and answers after', async () => {
    const { calls } = bucket()
    expect(peekCurrentVersion()).toBeUndefined()
    expect(peekCurrentVersion()).toBeUndefined()
    expect(await currentVersion()).toBe('v3_10_0')
    expect(peekCurrentVersion()).toBe('v3_10_0')
    expect(calls.filter((url) => url.endsWith('/current.txt'))).toHaveLength(1)
  })

  it('refuses a version older than the layout it parses, rather than misreading it', async () => {
    bucket('v2_4_0\n')
    await expect(currentVersion()).rejects.toThrow(/cannot read/)
    expect(isReadableVersion('v3_0_0')).toBe(true)
    expect(isReadableVersion('v10_0_0')).toBe(true)
    expect(isReadableVersion('v2_4_0')).toBe(false)
    expect(versionLabel('v3_10_0')).toBe('v3.10.0')
  })
})

describe('config', () => {
  it('keeps each store’s prefixes, and one library listed under both stores once', async () => {
    bucket()
    const config = await fetchConfig('v3_10_0')
    expect(config.prefixes.get('fl:open_data:brain')?.CDMThumbnail).toBe(
      'https://s3.amazonaws.com/janelia-flylight-color-depth-thumbnails/',
    )
    // Listed under both stores, brain and VNC — one library under one name.
    const banc = config.emLibraries.filter((l) => l.name === 'FlyWire_BANC_v626')
    expect(banc).toHaveLength(1)
    expect(banc[0]!.publishedNamePrefix).toBe('flywire_banc:v626')
  })
})

describe('lookups', () => {
  it('finds a body by its bare id', async () => {
    bucket()
    const records = await lookupBody('v3_10_0', '1734350788')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      type: 'EMImage',
      libraryName: 'FlyEM_Hemibrain_v1.2.1',
      publishedName: 'hemibrain:v1.2.1:1734350788',
      neuronType: 'DA1_lPN',
      // 19 digits, which a float would have changed.
      id: '2945073143147307019',
    })
  })

  it('answers an unknown body with nothing, not an error', async () => {
    bucket()
    expect(await lookupBody('v3_10_0', '99')).toEqual([])
  })

  it('never builds a key out of something that is not a body id', async () => {
    const { calls } = bucket()
    expect(await lookupBody('v3_10_0', '../config')).toEqual([])
    expect(calls).toEqual([])
  })

  it('returns every library’s neuron for an ambiguous id, for the caller to choose between', async () => {
    bucket()
    const config = await fetchConfig('v3_10_0')
    const records = await lookupBody('v3_10_0', '11442')
    expect(records.map((r) => r.libraryName).sort()).toEqual([
      'FlyEM_MANC_v1.2.1',
      'FlyEM_Male_CNS_Brain_v0.9',
      'FlyEM_VNC_v0.5',
    ])
    const inMaleCns = datasetLibraries(config, 'neuprint', 'male-cns:v0.9')!
    expect(records.filter((r) => inMaleCns.names.has(r.libraryName))).toHaveLength(1)
    const inManc = datasetLibraries(config, 'neuprint', 'manc:v1.2.1')!
    expect(
      records.filter((r) => inManc.names.has(r.libraryName)).map((r) => r.libraryName),
    ).toEqual(['FlyEM_MANC_v1.2.1'])
  })
})

describe('which libraries a dataset is', () => {
  it('knows the five connectomes NeuronBridge matched, and nothing else', () => {
    expect(isCoveredDataset('neuprint', 'hemibrain:v1.2.1')).toBe(true)
    expect(isCoveredDataset('cave', 'flywire_fafb_public:783')).toBe(true)
    expect(isCoveredDataset('cave', 'brain_and_nerve_cord_public:626')).toBe(true)
    // A second neuPrint deployment is the same backend: `backendOf` splits the source id.
    expect(isCoveredDataset('neuprint:https://example.org', 'manc:v1.2.1')).toBe(true)
    expect(isCoveredDataset('neuprint', 'optic-lobe:v1.0')).toBe(false)
    expect(isCoveredDataset('mock', 'optic-lobe-mini')).toBe(false)
    expect(isCoveredDataset('cave', 'minnie65_public:1300')).toBe(false)
  })

  it('compares versions rather than assuming them, in both spellings', async () => {
    bucket()
    const config = await fetchConfig('v3_10_0')
    const hemibrain = datasetLibraries(config, 'neuprint', 'hemibrain:v1.2.1')!
    expect([...hemibrain.names]).toEqual(['FlyEM_Hemibrain_v1.2.1'])
    expect(hemibrain.versionMismatch).toBe(false)

    const maleCns = datasetLibraries(config, 'neuprint', 'male-cns:v1.0')!
    expect([...maleCns.names].sort()).toEqual([
      'FlyEM_Male_CNS_Brain_v0.9',
      'FlyEM_Male_CNS_VNC_v0.9',
    ])
    expect(maleCns).toMatchObject({
      versionMismatch: true,
      nbVersion: 'v0.9',
      datasetVersion: 'v1.0',
    })

    // CAVE spells a materialization bare; NeuronBridge prefixes a `v`. The same version.
    expect(datasetLibraries(config, 'cave', 'flywire_fafb_public:783')!.versionMismatch).toBe(
      false,
    )
    expect(datasetLibraries(config, 'cave', 'flywire_fafb_public:1078')!.versionMismatch).toBe(
      true,
    )
    expect(datasetLibraries(config, 'neuprint', 'optic-lobe:v1.0')).toBeUndefined()
  })
})

describe('file URLs', () => {
  it('prefixes a record’s path with its own store’s prefix for that kind', async () => {
    bucket()
    const config = await fetchConfig('v3_10_0')
    const [record] = await lookupBody('v3_10_0', '1734350788')
    expect(fileUrl(config, record!.files, 'CDMThumbnail')).toBe(
      'https://s3.amazonaws.com/janelia-flylight-color-depth-thumbnails/JRC2018_Unisex_20x_HR/' +
        'FlyEM_Hemibrain_v1.2.1/1734350788-JRC2018_Unisex_20x_HR-CDM.jpg',
    )
    expect(fileUrl(config, record!.files, 'NoSuchKind')).toBeUndefined()
  })

  it('keeps an absolute http(s) path and refuses any other scheme', async () => {
    bucket()
    const config = await fetchConfig('v3_10_0')
    expect(fileUrl(config, { CDM: 'https://example.org/a.png' }, 'CDM')).toBe(
      'https://example.org/a.png',
    )
    expect(fileUrl(config, { CDM: 'javascript:alert(1)' }, 'CDM')).toBeUndefined()
  })

  it('links to NeuronBridge’s own pages the way its app does', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    expect(matchesPageUrl(record!, 'cds')).toBe(
      'https://neuronbridge.janelia.org/matches/cdm/2945073143147307019',
    )
    expect(matchesPageUrl(record!, 'pppm')).toBe(
      'https://neuronbridge.janelia.org/matches/pppm/2941778995433177634',
    )
    expect(searchPageUrl('SS02800')).toBe('https://neuronbridge.janelia.org/search?q=SS02800')
  })
})

describe('match files', () => {
  it('reads a CDS file and a PPPM file for the same neuron', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    expect(hasMatches(record!, 'cds')).toBe(true)
    expect(hasMatches(record!, 'pppm')).toBe(true)
    const cds = await fetchMatches('v3_10_0', record!, 'cds')
    expect(cds.inputImage.publishedName).toBe('hemibrain:v1.2.1:1734350788')
    expect(cds.results).toHaveLength(40)
    expect(cds.results[0]).toMatchObject({ type: 'CDSMatch', mirrored: true })
    expect(cds.results[0]!.normalizedScore).toBeGreaterThan(0)
    const pppm = await fetchMatches('v3_10_0', record!, 'pppm')
    expect(pppm.results.map((m) => m.pppmRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('refuses a method the record has no file for, rather than guessing a name', async () => {
    const fetch = bucket().fetch
    const flywire = readImage({
      type: 'EMImage',
      id: '1',
      publishedName: 'flywire_fafb:v783:720575940625431866',
      libraryName: 'FlyWire_FAFB_v783_realign',
      files: { CDSResults: '1.json' },
    })!
    expect(hasMatches(flywire, 'pppm')).toBe(false)
    await expect(fetchMatches('v3_10_0', flywire, 'pppm')).rejects.toThrow(/no PPPM matches/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a file with no input image, since every match is relative to it', () => {
    expect(() => readMatches({ results: [] }, 'x.json')).toThrow(
      /not a NeuronBridge match file/,
    )
  })
})

describe('collections and lines', () => {
  it('names every collection spelling NeuronBridge uses, underscores and all', () => {
    expect(collectionOf('FlyLight Split-GAL4 Drivers')).toBe('split')
    expect(collectionOf('FlyLight_Split-GAL4_Drivers')).toBe('split')
    expect(collectionOf('FlyLight Split-GAL4 Omnibus Broad')).toBe('omnibus')
    expect(collectionOf('FlyLight Gen1 MCFO v1.1')).toBe('mcfo')
    expect(collectionOf('FlyLight Gen1 MCFO')).toBe('mcfo')
    expect(collectionOf('FlyLight Annotator Gen1 MCFO v1.1')).toBe('annotator')
    expect(collectionOf('FlyLight Something New')).toBe('other')
  })

  it('groups a match file into one entry per line, strongest line first', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    const { results } = await fetchMatches('v3_10_0', record!, 'cds')
    const all = new Set(COLLECTIONS.map((c) => c.id))
    const lines = groupByLine(results, 'cds', all)
    expect(lines).toHaveLength(new Set(results.map((m) => m.image.publishedName)).size)
    const best = lines.map((l) => l.best.normalizedScore!)
    expect(best).toEqual([...best].sort((a, b) => b - a))
    for (const line of lines) {
      expect(line.images[0]).toBe(line.best)
      expect(line.images.every((m) => m.image.publishedName === line.line)).toBe(true)
      const scores = line.images.map((m) => m.normalizedScore!)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
    }
    // The sample holds lines with several images; none of them is lost in the grouping.
    expect(lines.reduce((n, l) => n + l.images.length, 0)).toBe(results.length)
    expect(lines.find((l) => l.line === 'SS02800')!.images.length).toBeGreaterThan(1)
  })

  it('drops unticked collections, and always shows a collection it does not know', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    const { results } = await fetchMatches('v3_10_0', record!, 'cds')
    const split = groupByLine(results, 'cds', new Set<NbCollection>(['split']))
    expect(split.length).toBeGreaterThan(0)
    expect(split.every((l) => collectionOf(l.best.image.libraryName) === 'split')).toBe(true)
    expect(groupByLine(results, 'cds', new Set())).toEqual([])

    const unknown = { ...results[0]!, image: { ...results[0]!.image, libraryName: 'New Set' } }
    expect(groupByLine([unknown], 'cds', new Set())).toHaveLength(1)
  })

  it('counts each collection whatever is ticked', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    const { results } = await fetchMatches('v3_10_0', record!, 'cds')
    const counts = collectionCounts(results)
    expect(COLLECTIONS.map((c) => counts.get(c.id))).toEqual([10, 10, 10, 10])
  })

  it('orders PPPM by rank, best first, since its rank and not its score is the published order', async () => {
    bucket()
    const [record] = await lookupBody('v3_10_0', '1734350788')
    const { results } = await fetchMatches('v3_10_0', record!, 'pppm')
    const lines = groupByLine(
      [...results].reverse(),
      'pppm',
      new Set(COLLECTIONS.map((c) => c.id)),
    )
    const ranks = lines.map((l) => l.best.pppmRank!)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(ranks[0]).toBe(0)
  })
})
