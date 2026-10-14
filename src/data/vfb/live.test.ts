/**
 * Virtual Fly Brain itself, asked the questions the fixtures stand in for.
 *
 * Skipped unless `VFB_LIVE` is set, the same kind of gate as `data/neuronbridge/live.test.ts`'s. Every request
 * is a read: VFBquery GETs, and Cypher that `pdb.ts` refuses to send if it could write.
 *
 *     VFB_LIVE=1 pnpm vitest run src/data/vfb/live.test.ts
 *
 * What fixtures cannot say: that a site in `sites.ts` still exists (a renamed `:Site` would map
 * every neuron to nothing, silently), that the two measured cases still resolve to the classes
 * they resolved to on 2026-10-14, and that an LM image's `volume.obj` is still a point cloud.
 */

import { describe, expect, it } from 'vitest'

import {
  fetchClassGraph,
  fetchIndividuals,
  fetchLineImages,
  fetchLines,
  fetchReferences,
} from './bridge'
import { typeClass } from './classes'
import { fetchTermInfo } from './client'
import { text } from './common'
import { fetchImageStack } from './stacks'
import { cypher } from './pdb'
import { spansText } from './markdown'
import { VFB_SITES } from './sites'

const live = process.env.VFB_LIVE ? describe : describe.skip

live('Virtual Fly Brain, live', () => {
  it('still has every site sites.ts maps to, each holding neurons', async () => {
    const rows = await cypher(
      `MATCH (s:Site) WHERE s.short_form IN $sites
       RETURN s.short_form AS site,
              exists((:Individual)-[:database_cross_reference]->(s)) AS populated`,
      { sites: VFB_SITES.map((s) => s.site) },
    )
    const populated = new Set(rows.filter((r) => r.populated === true).map((r) => text(r.site)))
    for (const { site } of VFB_SITES) expect(populated.has(site), site).toBe(true)
  }, 60_000)

  it('types male CNS body 10013 as MBON01, past the transmitter class beside it', async () => {
    const [individual] = await fetchIndividuals('male_cns_v1_0', ['10013'])
    expect(individual?.vfbId).toBe('VFB_jrmc2094')
    const graph = await fetchClassGraph(individual!.classes)
    expect(typeClass(graph, individual!.classes)).toMatchObject({
      classId: 'FBbt_00100234',
      climbed: 0,
    })
  }, 60_000)

  it('climbs a hemibrain PFNa neuron one step, to the class every dataset names PFNa', async () => {
    const [individual] = await fetchIndividuals('neuprint_JRC_Hemibrain_1point2point1', [
      '570518166',
    ])
    const graph = await fetchClassGraph(individual!.classes)
    const answer = typeClass(graph, individual!.classes)
    expect(answer).toMatchObject({ classId: 'FBbt_00111396', climbed: 1 })
    const names = graph.names.get('FBbt_00111396')!
    for (const key of ['hemibrain', 'banc', 'male-cns', 'flywire_fafb']) {
      expect(names.get(key), key).toContain('PFNa')
    }
  }, 60_000)

  it('cites Aso 2014 for MBON01 as defining it and naming it, with its DOI and PMID', async () => {
    const references = await fetchReferences(['FBbt_00100234'], ['def', 'syn'])
    const aso = references.find((r) => r.pubId === 'FBrf0227179')
    expect(aso).toMatchObject({
      classLabel: 'mushroom body output neuron 1',
      roles: ['def', 'syn'],
      doi: '10.7554/eLife.04577',
      pmid: '25535793',
    })
    expect(references.some((r) => r.pubId === 'Unattributed')).toBe(false)
  }, 60_000)

  it('finds MB074C for MBON01, and its JRC2018U images with point clouds, quickly', async () => {
    const lines = await fetchLines(['FBbt_00100234'])
    const mb074c = lines.find((l) => l.line === 'MB074C')
    expect(mb074c).toMatchObject({ kind: 'split', targets: 3 })
    // The template is read off the folder: following its `depicts` edge took 9.4 s for one line.
    const started = performance.now()
    const images = await fetchLineImages([mb074c!.lineId], ['VFB_00101567'], false)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(images.length).toBeGreaterThan(0)
    expect(images.every((i) => i.template === 'VFB_00101567')).toBe(true)
    expect(images.find((i) => i.obj)?.obj).toMatch(
      /^https:\/\/www\.virtualflybrain\.org\/.*\/VFB_00101567\/volume\.obj$/,
    )
  }, 60_000)

  it('describes MBON01 for the term hover: a name, a definition and a thumbnail', async () => {
    const info = await fetchTermInfo('FBbt_00100234')
    expect(info.name).toBe('MBON01')
    expect(info.label).toBe('mushroom body output neuron 1')
    expect(spansText(info.definition).length).toBeGreaterThan(40)
    expect(spansText(info.definition)).not.toMatch(/\]\(/)
    expect(info.thumbnail).toMatch(/^https:\/\/www\.virtualflybrain\.org\/.*thumbnail\.png$/)
  }, 60_000)

  it('lists SS02268 in the brain and the nerve cord, and decodes its brain stack whole', async () => {
    const lines = await fetchLines(['FBbt_00004020'])
    const ss02268 = lines.find((l) => l.line === 'SS02268')
    expect(ss02268).toBeDefined()
    const images = await fetchLineImages(
      [ss02268!.lineId],
      ['VFB_00101567', 'VFB_00200000'],
      false,
    )
    expect(new Set(images.map((i) => i.template))).toEqual(
      new Set(['VFB_00101567', 'VFB_00200000']),
    )
    const brain = images.find((i) => i.template === 'VFB_00101567' && i.nrrd)!
    const stack = await fetchImageStack(brain.nrrd!)
    expect(stack).toMatchObject({ width: 1210, height: 566, depth: 174 })
    expect(stack.data.length).toBe(1210 * 566 * 174)
  }, 120_000)

  it('serves an LM image as a point cloud: vertices with an intensity, and no faces', async () => {
    const info = await fetchTermInfo('VFB_00069262')
    const url = info.images.get('VFB_00101567')?.[0]?.obj
    expect(url).toBeDefined()
    const text = await (await fetch(url!, { headers: { Range: 'bytes=0-65535' } })).text()
    const lines = text.split('\n').slice(0, -1)
    const vertices = lines.filter((l) => l.startsWith('v '))
    expect(vertices.length).toBeGreaterThan(100)
    expect(vertices[0]!.trim().split(/\s+/)).toHaveLength(5)
    expect(lines.some((l) => l.startsWith('f '))).toBe(false)
  }, 60_000)
})
