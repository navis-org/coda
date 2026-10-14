import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchIndividuals } from './bridge'
import type { ClassGraph } from './classes'
import { typeClass } from './classes'
import { readTermInfo } from './client'
import { pdbAnswer } from '../../test/vfbStubs'
import { cypher } from './pdb'
import { capPoints, readPointCloud } from './pointCloud'
import { fetchImageStack } from './stacks'
import { markdownSpans, spansText } from './markdown'
import { siteRefusal, vfbSiteFor } from './sites'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))

afterEach(() => vi.unstubAllGlobals())

describe('sites', () => {
  it('maps a release exactly, whichever way its version is spelt', () => {
    expect(vfbSiteFor('neuprint', 'hemibrain:v1.2.1')?.site).toBe(
      'neuprint_JRC_Hemibrain_1point2point1',
    )
    expect(vfbSiteFor('neuprint:https://neuprint.janelia.org', 'male-cns:v1.0')?.site).toBe(
      'male_cns_v1_0',
    )
    expect(vfbSiteFor('cave', 'flywire_fafb_public:783')?.site).toBe('flywire783')
    expect(vfbSiteFor('cave', 'brain_and_nerve_cord_public:888')?.site).toBe('BANC888')
  })

  it('refuses a release VFB does not hold, naming the ones it does, and never the nearest', () => {
    expect(vfbSiteFor('cave', 'brain_and_nerve_cord_public:900')).toBeUndefined()
    expect(siteRefusal('cave', 'brain_and_nerve_cord_public:900')).toMatch(
      /BANC 626 and BANC 888, not at 900/,
    )
    expect(siteRefusal('neuprint', 'fib19:v1.0')).toMatch(/holds no neurons from this dataset/)
    expect(siteRefusal('cave', 'flywire_fafb_public:783')).toBeUndefined()
  })
})

/** A graph shaped like the cases measured: MBON01, PFNa and a type nobody named. */
function graph(): ClassGraph {
  const parents: Record<string, string[]> = {
    mbon01: ['mbon'],
    mbon: ['neuron'],
    cholinergic: ['neuron'],
    glutamatergic: ['neuron'],
    'pfna-g5': ['pfna'],
    'pfna-g2': ['pfna'],
    pfna: ['pfn'],
    pfn: ['neuron'],
    nameless: ['neuron'],
    neuron: [],
  }
  const names: Record<string, Record<string, string[]>> = {
    mbon01: { hemibrain: ['MBON01'], banc: ['MBON01'] },
    mbon: { 'male-cns': ['MBON'] },
    pfna: { hemibrain: ['PFNa'], banc: ['PFNa'] },
    pfn: { banc: ['PFN'] },
  }
  return {
    labels: new Map(Object.keys(parents).map((id) => [id, id])),
    parents: new Map(Object.entries(parents)),
    names: new Map(
      Object.entries(names).map(([id, byKey]) => [id, new Map(Object.entries(byKey))]),
    ),
  }
}

describe('typeClass', () => {
  it('takes the named type over a transmitter class asserted beside it', () => {
    const answer = typeClass(graph(), ['glutamatergic', 'mbon01'])
    expect(answer).toMatchObject({ classId: 'mbon01', climbed: 0, tied: [] })
    expect(answer.finest).toEqual(['glutamatergic', 'mbon01'])
  })

  it('drops an asserted class that is an ancestor of another asserted one', () => {
    expect(typeClass(graph(), ['mbon', 'mbon01']).classId).toBe('mbon01')
  })

  it('climbs from an unnamed per-glomerulus class to the nearest named one, and no further', () => {
    expect(typeClass(graph(), ['pfna-g5', 'cholinergic'])).toMatchObject({
      classId: 'pfna',
      climbed: 1,
    })
  })

  it('answers no type rather than a generic one when nothing above is named', () => {
    expect(typeClass(graph(), ['nameless', 'cholinergic'])).toMatchObject({
      classId: undefined,
      tied: [],
    })
  })

  it('reports a tie between two unrelated named types rather than choosing one', () => {
    expect(typeClass(graph(), ['mbon01', 'pfna-g2'])).toMatchObject({
      classId: undefined,
      tied: ['mbon01', 'pfna'],
    })
  })
})

describe('markdown', () => {
  it('reads links, several to a string, with brackets and parentheses inside the label', () => {
    expect(
      markdownSpans(
        "[MBON01(y5B'2a)_R (MaleCNS:10013)](VFB_jrmc2094); [P{R12C11-GAL4.DBD} ∩ x](VFBexp_1)",
      ),
    ).toEqual([
      { text: "MBON01(y5B'2a)_R (MaleCNS:10013)", target: 'VFB_jrmc2094' },
      { text: '; ' },
      { text: 'P{R12C11-GAL4.DBD} ∩ x', target: 'VFBexp_1' },
    ])
  })

  it('reads a thumbnail as one link, the image inside its label kept whole', () => {
    const [link] = markdownSpans(
      "[![LC4 aligned](https://www.virtualflybrain.org/data/VFB/i/a/b/thumbnail.png 'LC4 aligned')](VFB_00101567,VFB_fw1)",
    )
    expect(link?.target).toBe('VFB_00101567,VFB_fw1')
    expect(link?.text).toMatch(/^!\[LC4 aligned\]\(.*thumbnail\.png 'LC4 aligned'\)$/)
  })

  it('reduces a bare image to its alt text, its URL never kept', () => {
    const spans = markdownSpans(
      'See ![fig](http://example.org/x.png) and [MBON01](FBbt_00100234).',
    )
    expect(spansText(spans)).toBe('See fig and MBON01.')
    expect(spans.find((s) => s.target)).toEqual({ text: 'MBON01', target: 'FBbt_00100234' })
    expect(JSON.stringify(spans)).not.toContain('example.org')
  })
})

describe('term info', () => {
  it('reads a class: its queries and its example images', () => {
    const info = readTermInfo(fixture('term_info-FBbt_00100234.json'))
    expect(info).toMatchObject({ id: 'FBbt_00100234', isClass: true })
    expect(info.queries).toContain('SplitsTargeting')
    expect(info.images.size).toBeGreaterThan(0)
  })

  it('reads what the VFB Info card shows: links, parents, relations, names, papers', () => {
    const info = readTermInfo(fixture('term_info-FBbt_00100234.json'))
    // The definition keeps its citation as a link to the paper's id.
    expect(info.definition.find((s) => s.target === 'FBrf0205263')?.text).toMatch(/^Tanaka/)
    expect(info.parents).toContainEqual({
      id: 'FBbt_00049843',
      label: 'adult typical mushroom body output neuron',
    })
    expect(info.relations.find((r) => r.relation === 'has soma location')?.targets).toEqual([
      { id: 'FBbt_00100308', label: 'adult superior brain cell body rind' },
    ])
    // Each connectome's own name for the type, read off `name_in_*`.
    expect(info.synonyms).toContainEqual({ label: 'MBON01', dataset: 'male-cns' })
    expect(info.papers).toContainEqual({
      title: 'Shyu et al., 2017, Nat. Commun. 8: 15230',
      id: 'FBrf0235522',
      doi: '10.1038/ncomms15230',
      pmid: '28504254',
    })
    expect(info.xrefs[0]).toEqual({
      label: 'FlyBrain NeuronDB 10459',
      url: 'https://flybrain-ndb.virtualflybrain.org/neuronrec-10459.html',
    })
    expect(info.tags).toContain('Glutamatergic')
  })

  it('reads a relationship list into its relations, and refuses a cross-reference that is not http', () => {
    const info = readTermInfo({
      Id: 'FBbt_x',
      Meta: {
        Relationships:
          '[part of](BFO_1): [a](FBbt_a), [b](FBbt_b); [develops from](RO_2): [c](FBbt_c)',
      },
      Xrefs: [{ label: 'Bad', link: 'javascript:alert(1)' }],
    })
    expect(info.relations).toEqual([
      {
        relation: 'part of',
        targets: [
          { id: 'FBbt_a', label: 'a' },
          { id: 'FBbt_b', label: 'b' },
        ],
      },
      { relation: 'develops from', targets: [{ id: 'FBbt_c', label: 'c' }] },
    ])
    expect(info.xrefs).toEqual([])
  })

  it('reads an expression image in both templates it was registered to', () => {
    const info = readTermInfo(fixture('term_info-VFB_00069262.json'))
    expect([...info.images.keys()].sort()).toEqual(['VFB_00017894', 'VFB_00101567'])
    const [image] = info.images.get('VFB_00101567')!
    expect(image!.obj).toMatch(/\/i\/0006\/9262\/VFB_00101567\/volume\.obj$/)
  })

  it('keeps only VFB’s own file server, upgraded to https, and drops anything else', () => {
    const info = readTermInfo({
      Id: 'VFB_x',
      Images: {
        T: [
          {
            id: 'VFB_x',
            thumbnail: 'javascript:alert(1)',
            obj: 'http://www.virtualflybrain.org/data/VFB/i/x/volume.obj',
            nrrd: 'https://elsewhere.example/volume.nrrd',
          },
        ],
      },
    })
    expect(info.images.get('T')![0]).toEqual({
      id: 'VFB_x',
      label: 'VFB_x',
      template: 'T',
      obj: 'https://www.virtualflybrain.org/data/VFB/i/x/volume.obj',
    })
  })
})

describe('pdb', () => {
  it('refuses a statement that could write, before sending anything', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(cypher('MATCH (n) SET n.x = 1')).rejects.toThrow(/could write/)
    await expect(cypher('MATCH (n) DETACH DELETE n')).rejects.toThrow(/could write/)
    await expect(cypher('CALL apoc.create.node([], {})')).rejects.toThrow(/could write/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a server-side error in the server’s words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ results: [], errors: [{ code: 'Neo.ClientError', message: 'bad' }] }),
      ),
    )
    await expect(cypher('MATCH (n) RETURN n')).rejects.toThrow(/refused the query: bad/)
  })
})

describe('fetchIndividuals', () => {
  it('reads an answer the size of the largest site, male-cns’ 166,693 neurons', async () => {
    const ids = Array.from({ length: 166_693 }, (_, i) => String(i))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        pdbAnswer(
          ['accession', 'vfbId', 'classes'],
          ids.map((id) => [[id], `VFB_${id}`, ['FBbt_x']]),
        ),
      ),
    )
    expect(await fetchIndividuals('male-cns', ids)).toHaveLength(ids.length)
  })

  it('sends the ids as a parameter, keeps them as text, and returns only the ones asked for', async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return pdbAnswer(
          ['accession', 'vfbId', 'classes'],
          [
            [['720575940624117245', 'other'], 'VFB_fw000040', ['FBbt_00100234']],
            [['999'], 'VFB_fw999', []],
          ],
        )
      }),
    )
    const found = await fetchIndividuals('flywire783', ['720575940624117245'])
    expect(found).toEqual([
      {
        accession: '720575940624117245',
        vfbId: 'VFB_fw000040',
        classes: ['FBbt_00100234'],
      },
    ])
    const sent = JSON.parse(bodies[0]!) as {
      statements: { statement: string; parameters: Record<string, unknown> }[]
    }
    expect(sent.statements[0]!.parameters).toEqual({
      site: 'flywire783',
      ids: ['720575940624117245'],
    })
    expect(sent.statements[0]!.statement).not.toContain('720575940624117245')
  })
})

describe('point clouds', () => {
  const OBJ = [
    '####',
    '# OBJ File Generated by VirtualFlyBrain.org',
    'v 1 2 3 0.5',
    'v 4 5 6 0.1',
    'v 7 8 9',
    'f 1 2 3',
    'v bad 1 2 0.9',
  ].join('\n')

  it('reads v lines as nm with their intensity, skipping comments, faces and junk', () => {
    const cloud = readPointCloud(OBJ)
    expect([...cloud.positions]).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])
    expect([...cloud.intensity]).toEqual([0.5, Math.fround(0.1), 1])
  })

  it('drops points below a floor', () => {
    expect(readPointCloud(OBJ, 0.4).intensity.length).toBe(2)
  })

  it('thins to a cap at an even stride, and leaves a cloud under it alone', () => {
    const cloud = readPointCloud(OBJ)
    expect(capPoints(cloud, 0)).toBe(cloud)
    expect(capPoints(cloud, 5)).toBe(cloud)
    const two = capPoints(cloud, 2)
    expect([...two.positions]).toEqual([1000, 2000, 3000, 7000, 8000, 9000])
  })
})

describe('image stacks', () => {
  it('fetches a stack only from VFB’s own file server', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchImageStack('https://elsewhere.example/volume.nrrd')).rejects.toThrow(
      /not on Virtual Fly Brain/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
