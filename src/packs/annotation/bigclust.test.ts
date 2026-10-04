/**
 * BigClust Project, run end to end on a five-neuron project pyarrow wrote
 * (`data/bigclust/__fixtures__/tiny`), laid out the way BigClust writes one: pandas' index stored
 * as an `id` column, a k-NN file of row positions, and feature columns named by their tuple.
 *
 * The fixture holds every case the reading has to get right and none of which would show as an
 * error if it were wrong — an embedding with no ids, one whose ids are listed in a different order,
 * a self-neighbour, a `-1` pad, an index past the end, an isolated neuron, and a two-level feature
 * name — so each test is about a *value*, never only that a run succeeded.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { Scheduler } from '../../core/scheduler'
import { requireSource } from '../../data/source'
import { attributeSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { holdFolderFiles, resetFolders } from '../../data/bigclust/folders'
import { parseInfo } from '../../data/bigclust/info'
import { parseSceneUrl, layerSourceUrl } from '../../data/neuroglancer/scene'
import { resetProjects } from '../../data/bigclust/project'
import { resetTableFiles } from '../../data/files/registry'
import { resetPrecomputedProbes } from '../../data/precomputed/probe'
import { node } from '../../test/graph'
import { sourcelessScheduler } from '../../test/scheduler'
import '../../nodes'
import { featureName } from './bigclust'
import type { EnumOption, EnumParam, InferContext } from '../../core/node'
import { getNodeDef } from '../../core/registry'

const TINY = 'src/data/bigclust/__fixtures__/tiny/'
const IDS = [1, 2, 3, 4, 5].map((n) => String(720575940600000000n + BigInt(n)))

/** The tiny project as a chosen folder, with any of its files' text replaced. */
function tinyFolder(replace: Record<string, string> = {}): {
  folderId: string
  folderName: string
} {
  const files = readdirSync(TINY).map(
    (name) => new File([replace[name] ?? readFileSync(TINY + name)], name),
  )
  const held = holdFolderFiles(files)!
  return { folderId: held.id, folderName: 'tiny' }
}

function graph(params: Record<string, unknown>): CodaGraph {
  return addNode(emptyGraph('bigclust'), node('p', 'annotation:bigclust', params))
}

async function run(g: CodaGraph): Promise<Scheduler> {
  const scheduler = sourcelessScheduler()
  await scheduler.run(g, { mode: 'full' })
  return scheduler
}

function table(scheduler: Scheduler, port: string): TableValue {
  const value = scheduler.output('p', port)
  if (!isTableValue(value))
    throw new Error(`${port} is not a table: ${scheduler.info('p').error}`)
  return value
}

/** The table's rows as arrays, in the order of `columns`. */
function rows(t: TableValue, columns: readonly string[]): unknown[][] {
  return Array.from({ length: t.length }, (_, i) => columns.map((c) => t.data[c]![i]))
}

beforeEach(() => {
  resetTableFiles()
  resetFolders()
  resetProjects()
})
afterEach(() => vi.unstubAllGlobals())

/**
 * The tiny project at an address, served the way nginx serves it with `gzip` on for
 * `application/octet-stream` and a browser offering gzip: no `Content-Length` on a HEAD, and the
 * whole body for a range request. `info` reads as text either way.
 */
function serveCompressing(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const name = url.split('/').pop() ?? ''
    if (!readdirSync(TINY).includes(name)) return new Response(null, { status: 404 })
    if (init?.method === 'HEAD') return new Response(null, { status: 200 })
    return new Response(new Uint8Array(readFileSync(TINY + name)), { status: 200 })
  })
}

describe('reading info', () => {
  it('resolves entries against the top level, and tells a k-NN graph from a matrix', () => {
    const info = parseInfo(
      JSON.stringify({
        meta: 'meta.parquet',
        distances: { file: 'top.parquet' },
        features: 'f.parquet',
        embeddings: [
          {
            name: 'A',
            file: 'a.parquet',
            distances: { file: 'k.parquet', type: 'nblast:knn' },
          },
          { name: 'a', file: 'b.parquet', features: null },
        ],
      }),
    )
    expect(info.embeddings.map((e) => [e.name, e.distances, e.features?.file])).toEqual([
      ['A', { file: 'k.parquet', knn: true }, 'f.parquet'],
      // An entry with nothing of its own falls back to the top level.
      ['a', { file: 'top.parquet', knn: false }, 'f.parquet'],
    ])
  })

  it('reads the older single-entry form', () => {
    const info = parseInfo(
      JSON.stringify({ meta: { file: 'm.parquet' }, embeddings: 'e.parquet' }),
    )
    expect(info.embeddings).toEqual([{ name: 'embedding 1', file: 'e.parquet' }])
  })

  it('tells repeated embedding names apart, the name being what the node stores', () => {
    const info = parseInfo(
      JSON.stringify({
        meta: 'm.parquet',
        embeddings: [
          { name: 'umap', file: 'a.parquet' },
          { name: 'umap', file: 'b.parquet' },
        ],
      }),
    )
    expect(info.embeddings.map((e) => e.name)).toEqual(['umap', 'umap (2)'])
  })

  it('names the projects of a collection rather than guessing one', () => {
    expect(() => parseInfo('["fafb", "hemibrain"]')).toThrow(
      /collection of 2 projects \(fafb, hemibrain\)/,
    )
  })

  it('refuses a project with no meta, which BigClust requires', () => {
    expect(() => parseInfo('{"embeddings": []}')).toThrow(/no `meta` table/)
  })

  it('splits a two-level feature name into group and feature', () => {
    expect(featureName("('upstream', '(CH-r2)')")).toEqual({
      group: 'upstream',
      feature: '(CH-r2)',
    })
    expect(featureName('LC4')).toEqual({ group: null, feature: 'LC4' })
  })
})

describe('BigClust Project', () => {
  it('asks for a project', () => {
    expect(inferGraph(graph({})).nodes.p?.issues.map((i) => i.message)).toContainEqual(
      expect.stringMatching(/address of a BigClust project folder/),
    )
  })

  it('publishes meta’s schema and offers the project’s embeddings, before any run', async () => {
    const g = graph(tinyFolder())
    // The peek is a read in flight; inference has the schema once it lands.
    await vi.waitFor(() =>
      expect(attributeSchema(inferGraph(g).nodes.p?.outputs.neurons)).toBeDefined(),
    )
    const outputs = inferGraph(g).nodes.p?.outputs
    expect(attributeSchema(outputs?.neurons)?.columns.map((c) => [c.name, c.dtype])).toEqual([
      ['neuronId', 'str'],
      ['type', 'str'],
      ['pre', 'i64'],
    ])
    expect(attributeSchema(outputs?.embedding)?.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'x',
      'y',
    ])
    // The first stands in for an empty choice, and says which it is.
    const param = getNodeDef('annotation:bigclust')!.params!.find((p) => p.id === 'embedding')!
    const options = (param as EnumParam).options as (ctx: InferContext) => EnumOption[]
    expect(
      options({ params: g.nodes[0]!.params } as unknown as InferContext).map((o) => o.label),
    ).toEqual([
      'First (morphology(nblast))',
      'morphology(nblast)',
      'connectivity(type)',
      'shuffled',
      'from meta',
    ])
  })

  it('reads the first embedding by default, aligned with meta by row', async () => {
    const scheduler = await run(graph(tinyFolder()))
    const neurons = table(scheduler, 'neurons')
    expect(neurons.kind).toBe('neurons')
    expect(neurons.data.neuronId).toEqual(IDS)
    expect(Object.keys(neurons.data)).toEqual(['neuronId', 'type', 'pre'])
    const embedding = table(scheduler, 'embedding')
    expect(embedding.data.neuronId).toEqual(IDS)
    expect(embedding.data.x).toEqual([0, 1, 2, 3, 4])
    expect(embedding.data.y).toEqual([5, 6, 7, 8, 9])
  })

  it('aligns an embedding by row whether it carries ids or not, and says when they disagree', async () => {
    const noIds = await run(graph({ ...tinyFolder(), embedding: 'connectivity(type)' }))
    expect(table(noIds, 'embedding').data.y).toEqual([-1, -2, -3, -4, -5])
    const shuffled = await run(graph({ ...tinyFolder(), embedding: 'shuffled' }))
    expect(table(shuffled, 'embedding').data.x).toEqual([20, 21, 22, 23, 24])
    expect(shuffled.warning('p')).toMatch(
      /"shuffled" lists its rows in a different order from meta for 2/,
    )
    // Two meta columns are an embedding too.
    const fromMeta = await run(graph({ ...tinyFolder(), embedding: 'from meta' }))
    expect(table(fromMeta, 'embedding').data.x).toEqual([10, 20, 30, 40, 50])
  })

  it('names the embeddings a project has, for one it does not', async () => {
    const g = graph({ ...tinyFolder(), embedding: 'umap' })
    await vi.waitFor(() =>
      expect(inferGraph(g).nodes.p?.issues.map((i) => i.message)).toContainEqual(
        expect.stringMatching(
          /no embedding "umap"\. It has: morphology\(nblast\), connectivity\(type\)/,
        ),
      ),
    )
  })

  it('turns the k-NN file’s row positions into ids, dropping what BigClust drops', async () => {
    const scheduler = await run(graph(tinyFolder()))
    const neighbours = table(scheduler, 'neighbours')
    const [a, b, c, d] = IDS
    expect(rows(neighbours, ['queryId', 'targetId', 'rank', 'distance'])).toEqual([
      // -1 at rank 3 dropped.
      [a, b, 1, expect.closeTo(0.1)],
      [a, c, 2, expect.closeTo(0.2)],
      // Rank 2 is the neuron itself: dropped.
      [b, a, 1, expect.closeTo(0.1)],
      [b, d, 3, expect.closeTo(0.3)],
      // Rank 2 points past the end: dropped.
      [c, d, 1, expect.closeTo(0.2)],
      [c, a, 3, expect.closeTo(0.6)],
      [d, c, 1, expect.closeTo(0.2)],
      [d, a, 2, expect.closeTo(0.4)],
      [d, b, 3, expect.closeTo(0.5)],
    ])
    expect(scheduler.warning('p')).toMatch(
      /1 of 5 neurons have no neighbour in distances_0\.parquet/,
    )
    // This embedding brings no features: empty, with its schema.
    expect(table(scheduler, 'features').length).toBe(0)
  })

  it('reads the features long, non-zeros only, with each column’s group', async () => {
    const scheduler = await run(graph({ ...tinyFolder(), embedding: 'connectivity(type)' }))
    const features = table(scheduler, 'features')
    const [a, b, , d, e] = IDS
    expect(rows(features, ['neuronId', 'group', 'feature', 'value'])).toEqual([
      [b, 'upstream', 'LC4', 1],
      [e, 'upstream', 'LC4', 4],
      [a, 'upstream', 'T4a', 3],
      [d, 'downstream', '(DN-x)', 2.5],
      [e, 'downstream', '(DN-x)', 1],
    ])
    expect(table(scheduler, 'neighbours').length).toBe(0)
  })

  it('downloads each file of a project at a URL in one request', async () => {
    // Every file the node opens it reads in full, so a range per column chunk buys nothing: the
    // example project's features file was ~8,400 of them, one dropped connection failing the run.
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const name = url.split('/').pop() ?? ''
      const range = new Headers(init?.headers).get('Range')
      requests.push(`${init?.method ?? 'GET'} ${name}${range ? ' ranged' : ''}`)
      if (!readdirSync(TINY).includes(name)) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(readFileSync(TINY + name)), { status: 200 })
    })
    const scheduler = await run(graph({ url: 'https://example.org/projects/tiny/' }))
    expect(scheduler.info('p').error).toBeUndefined()
    expect(table(scheduler, 'neighbours').length).toBe(9)
    expect(requests.sort()).toEqual([
      'GET distances_0.parquet',
      'GET embeddings_0.parquet',
      'GET info',
      'GET meta.parquet',
    ])
  })

  it('reads a project from a server that will not hand over part of a file', async () => {
    // Link Table refuses such a server, its files being gigabytes; a project is downloaded whole
    // anyway, so nothing here depends on ranges, and nothing is said about it.
    serveCompressing()
    const scheduler = await run(graph({ url: 'https://example.org/projects/tiny/' }))
    expect(scheduler.info('p').error).toBeUndefined()
    expect(table(scheduler, 'neurons').data.neuronId).toEqual(IDS)
    expect(table(scheduler, 'neighbours').length).toBe(9)
    expect(scheduler.warning('p')).not.toMatch(/whole|pieces/)
  })

  it('hides the URL while a folder is chosen, so it is neither drawn nor in the key', () => {
    const url = getNodeDef('annotation:bigclust')!.params!.find((p) => p.id === 'url')!
    expect(url.visibleIf?.({ folderId: 'folder-1', url: 'https://x' })).toBe(false)
    expect(url.visibleIf?.({ folderId: '', url: 'https://x' })).toBe(true)
  })

  it('reads meta once for every node on a project, an embedding each', async () => {
    // Several nodes joined on one project would otherwise decode meta apiece and hold a copy each.
    const folder = tinyFolder()
    let g = addNode(emptyGraph('bigclust'), node('a', 'annotation:bigclust', folder))
    g = addNode(g, node('b', 'annotation:bigclust', { ...folder, embedding: 'shuffled' }))
    const scheduler = await run(g)
    const ids = (id: string) => scheduler.output(id, 'neurons') as TableValue
    expect(ids('a').data.neuronId).toEqual(IDS)
    expect(ids('a').data.neuronId).toBe(ids('b').data.neuronId)
  })
})

describe('the Scene output', () => {
  /** The tiny project with a neuroglancer block, its meta the one carrying sources and colours. */
  function sceneProject(neuroglancer: Record<string, unknown> | undefined): CodaGraph {
    const info = JSON.parse(readFileSync(TINY + 'info', 'utf8')) as Record<string, unknown>
    const folder = tinyFolder({
      info: JSON.stringify({
        ...info,
        meta: { file: 'meta_scene.parquet' },
        ...(neuroglancer ? { neuroglancer } : {}),
      }),
    })
    let g = addNode(emptyGraph('bigclust'), node('p', 'annotation:bigclust', folder))
    g = addNode(g, node('ng', 'out.neuroglancer'))
    g = addEdge(g, {
      source: 'p',
      sourceHandle: 'scene',
      target: 'ng',
      targetHandle: 'dataset',
    })
    return addEdge(g, {
      source: 'p',
      sourceHandle: 'embedding',
      target: 'ng',
      targetHandle: 'neurons',
    })
  }

  const SHELL = 'precomputed://gs://bucket-shell/brain'

  /** The layers of the scene the Neuroglancer node linked to. */
  function sceneLayers(scheduler: Scheduler): Record<string, unknown>[] {
    const url = scheduler.output('ng', 'url')
    if (url?.kind !== 'string') throw new Error(scheduler.info('ng').error)
    return (parseSceneUrl(String(url.value))?.layers ?? []) as Record<string, unknown>[]
  }

  /** Run with the registry: the Neuroglancer node reaches the project's scene source. */
  async function runWithSources(g: CodaGraph): Promise<Scheduler> {
    const scheduler = new Scheduler({ resolveSource: requireSource })
    await scheduler.run(g, { mode: 'full' })
    return scheduler
  }

  it('puts each neuron in its own source’s layer, in the project’s colour', async () => {
    const scheduler = await runWithSources(
      sceneProject({ source: '_source', color: '_color', neuropil_mesh: `1,2@${SHELL}` }),
    )
    const layers = sceneLayers(scheduler)
    // Named by the dataset each source's neurons come from; the shell last, faint and unpickable.
    expect(layers.map((l) => [l.name, layerSourceUrl(l.source), l.segments])).toEqual([
      ['A', 'precomputed://gs://bucket-a/seg', [IDS[0], IDS[1], IDS[4]]],
      ['B', 'dvid://https://host/uuid/segmentation?dvid-service=x', [IDS[2], IDS[3]]],
      ['neuropil', SHELL, ['1', '2']],
    ])
    expect(layers[2]).toMatchObject({ objectAlpha: 0.1, pick: false })
    // A CSS name and short hex read as hex; a null and a word that is no colour are left out.
    expect(layers[0]!.segmentColors).toEqual({
      [IDS[0]!]: '#ffa500',
      [IDS[1]!]: '#00ff00',
      [IDS[4]!]: '#112233',
    })
    expect(layers[1]!.segmentColors).toEqual({})
  })

  it('reads a per-dataset map, and a colour chosen on the node wins over the project’s', async () => {
    let g = sceneProject({
      source: { A: 'precomputed://gs://a', B: 'precomputed://gs://b' },
      color: '_color',
    })
    g = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'ng'
          ? {
              ...n,
              params: { ...n.params, segmentColorMode: 'constant', segmentColor: '#abcdef' },
            }
          : n,
      ),
    }
    const scheduler = await runWithSources(g)
    const layers = sceneLayers(scheduler)
    expect(layers.map((l) => [l.name, layerSourceUrl(l.source), l.segmentColors])).toEqual([
      ['A', 'precomputed://gs://a', {}],
      ['B', 'precomputed://gs://b', {}],
    ])
    expect(layers[0]!.segmentDefaultColor).toBe('#abcdef')
  })

  it('writes one colour every neuron shares once, not once per neuron', async () => {
    const scheduler = await runWithSources(sceneProject({ source: '_source', color: 'red' }))
    const layers = sceneLayers(scheduler)
    expect(layers.map((l) => [l.segmentDefaultColor, l.segmentColors])).toEqual([
      ['#ff0000', {}],
      ['#ff0000', {}],
    ])
  })

  it('opens on the first volume’s frame, which a mesh-only source does not have', async () => {
    // Neuroglancer frames on whichever layer arrives first, and a legacy mesh directory has no
    // bounds: BigClust's example, FlyWire's meshes beside the male CNS volume, opened at the origin.
    resetPrecomputedProbes()
    const infos: Record<string, unknown> = {
      'https://storage.googleapis.com/a/info': { '@type': 'neuroglancer_legacy_mesh' },
      'https://storage.googleapis.com/b/info': {
        '@type': 'neuroglancer_multiscale_volume',
        type: 'segmentation',
        data_type: 'uint64',
        num_channels: 1,
        scales: [{ resolution: [8, 8, 8], size: [100, 200, 300], voxel_offset: [10, 0, 0] }],
      },
    }
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const info = infos[String(input instanceof Request ? input.url : input)]
      return info ? Response.json(info) : new Response(null, { status: 404 })
    })
    const scheduler = await runWithSources(
      sceneProject({ source: { A: 'precomputed://gs://a', B: 'precomputed://gs://b' } }),
    )
    const url = scheduler.output('ng', 'url')
    const scene = parseSceneUrl(String(url?.kind === 'string' ? url.value : ''))!
    expect(scene).toMatchObject({
      dimensions: { x: [8e-9, 'm'], y: [8e-9, 'm'], z: [8e-9, 'm'] },
      position: [60, 100, 150],
      projectionScale: 300,
    })
  })

  it('says what a link cannot carry: a landmark warp, and a mesh file', async () => {
    const scheduler = await run(
      sceneProject({
        source: '_source',
        neuropil_mesh: 'brain.ply',
        transforms: [{ type: 'landmarks', apply_to: 'B', file: 'landmarks.csv' }],
      }),
    )
    expect(scheduler.warning('p')).toMatch(/warps one dataset .* own space/)
    expect(scheduler.warning('p')).toMatch(/brain\.ply, is a plain file/)
  })

  it('publishes no scene for a project without a neuroglancer block, and says so', async () => {
    const g = sceneProject(undefined)
    await run(g)
    const issues = inferGraph(g).nodes['ng']?.issues.map((i) => i.message) ?? []
    expect(issues.join(' ')).toMatch(/publishes no neuroglancer scene/)
  })
})
