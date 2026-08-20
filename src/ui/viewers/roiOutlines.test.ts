/**
 * The outlines, which are what survives a fetch the meshes do not.
 *
 * Two properties matter here and neither is visible by looking at the result. The stored form has
 * to be *small* — that is the whole reason there are three fixed planes rather than a camera — and
 * it has to be **invalidated by anything that changes how it was traced**, because once the
 * geometry is released these polylines are the only copy and nothing about them says which tracer
 * produced them.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resetCache } from '../../data/cache'
import { MockSource } from '../../data/mock/MockSource'
import { getConnectome } from '../../data/mock/generate'
import { ROI_VIEWS } from './roiProjection'
import { buildRoiOutlines, loadRoiOutlines, resetRoiOutlineState } from './roiOutlines'

const DATASET = 'hemibrain-mini'

let source: MockSource

beforeEach(() => {
  source = new MockSource({ latencyMs: 0 })
  resetCache()
  resetRoiOutlineState()
})

async function meshes() {
  return source.fetchRoiMeshes({ datasetId: DATASET })
}

describe('buildRoiOutlines', () => {
  it('flattens every region into all three planes', async () => {
    const set = buildRoiOutlines(await meshes())
    const rois = getConnectome(DATASET)!.rois

    expect(set.regions).toHaveLength(rois.length)
    expect(set.regions.map((r) => r.roi)).toEqual(rois)
    for (const region of set.regions) {
      for (const view of ROI_VIEWS) {
        expect(region.views[view].rings.length).toBeGreaterThan(0)
        // x,y interleaved, so an odd length means somebody wrote a bare point list.
        expect(region.views[view].rings[0]!.length % 2).toBe(0)
        expect(region.views[view].radius).toBeGreaterThan(0)
      }
    }
  })

  it('is small — which is the entire point of having three planes and no camera', async () => {
    const fetched = await meshes()
    const meshBytes = fetched.items.reduce(
      (sum, item) => sum + item.positions.byteLength + item.indices.byteLength,
      0,
    )
    const set = buildRoiOutlines(fetched)
    const outlineBytes = set.regions.reduce(
      (sum, region) =>
        sum +
        ROI_VIEWS.reduce(
          (viewSum, view) =>
            viewSum + region.views[view].rings.reduce((r, ring) => r + ring.byteLength, 0),
          0,
        ),
      0,
    )
    // Against real neuPrint geometry this is three orders of magnitude; the mock's shells are
    // already coarse, so the assertion here is only that flattening is the cheaper direction.
    expect(outlineBytes).toBeLessThan(meshBytes)
  })

  it('measures each region, so the geometry can be released', async () => {
    // Approximate by construction — a decimated display surface — but nothing else in Coda can
    // say anything at all about a region's size.
    const set = buildRoiOutlines(await meshes())
    for (const region of set.regions) {
      expect(region.volume).toBeGreaterThan(0)
      expect(region.surfaceArea).toBeGreaterThan(0)
    }
  })

  it('names the regions that were asked for and published nothing', async () => {
    // Not an error and often not even a gap: every region male-CNS refuses is an
    // `-unspecified` bucket, which collects unassigned synapses and is not a shape.
    const rois = getConnectome(DATASET)!.rois
    const set = buildRoiOutlines(await meshes(), [...rois, 'VNC-unspecified'])
    expect(set.missing).toEqual(['VNC-unspecified'])
  })

  it('reads an absent primary column as unknown rather than as nested', async () => {
    const fetched = await meshes()
    const stripped = {
      ...fetched,
      attributes: {
        ...fetched.attributes,
        schema: {
          columns: fetched.attributes.schema.columns.filter((c) => c.name !== 'primary'),
        },
        data: { roi: fetched.attributes.data['roi']! },
      },
    }
    const set = buildRoiOutlines(stripped as typeof fetched)
    // A source that says nothing has not said these regions nest inside others.
    expect(set.regions.every((r) => r.primary)).toBe(true)
  })

  it('drops a region that projects to nothing in any plane', () => {
    const empty = {
      kind: 'meshes' as const,
      items: [
        {
          bodyId: 0,
          label: 'nothing',
          positions: new Float32Array(0),
          indices: new Uint32Array(0),
        },
      ],
      attributes: { length: 1, schema: { columns: [] }, data: {} },
      bounds: {
        min: [0, 0, 0] as [number, number, number],
        max: [0, 0, 0] as [number, number, number],
      },
    }
    const set = buildRoiOutlines(empty as never, ['nothing'])
    expect(set.regions).toHaveLength(0)
    expect(set.missing).toEqual(['nothing'])
  })
})

describe('loadRoiOutlines', () => {
  it('fetches once and answers from cache after', async () => {
    let fetches = 0
    const counting = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'fetchRoiMeshes') {
          return (req: Parameters<MockSource['fetchRoiMeshes']>[0]) => {
            fetches++
            return target.fetchRoiMeshes(req)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })

    const rois = getConnectome(DATASET)!.rois
    const first = await loadRoiOutlines({ source: counting, datasetId: DATASET, rois })
    const second = await loadRoiOutlines({ source: counting, datasetId: DATASET, rois })

    expect(fetches).toBe(1)
    expect(second.regions).toHaveLength(first.regions.length)
  })

  it('shares one download between two cards asking at once', async () => {
    let fetches = 0
    const counting = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'fetchRoiMeshes') {
          return (req: Parameters<MockSource['fetchRoiMeshes']>[0]) => {
            fetches++
            return target.fetchRoiMeshes(req)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const rois = getConnectome(DATASET)!.rois
    await Promise.all([
      loadRoiOutlines({ source: counting, datasetId: DATASET, rois }),
      loadRoiOutlines({ source: counting, datasetId: DATASET, rois }),
    ])
    expect(fetches).toBe(1)
  })

  it('re-fetches when the region list changes', async () => {
    /*
     * The fingerprint's job. A dataset that renames or adds a region would otherwise reuse
     * outlines traced for a different set of shapes — and since the meshes are gone, nothing
     * about the stored polylines would reveal it.
     */
    let fetches = 0
    const counting = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'fetchRoiMeshes') {
          return (req: Parameters<MockSource['fetchRoiMeshes']>[0]) => {
            fetches++
            return target.fetchRoiMeshes(req)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const rois = getConnectome(DATASET)!.rois
    await loadRoiOutlines({ source: counting, datasetId: DATASET, rois })
    await loadRoiOutlines({ source: counting, datasetId: DATASET, rois: rois.slice(0, 3) })
    expect(fetches).toBe(2)
  })

  it('refuses a source that publishes no region meshes, by name', async () => {
    const withoutMeshes = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, roiMeshes: false }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    await expect(
      loadRoiOutlines({ source: withoutMeshes, datasetId: DATASET, rois: ['AL(R)'] }),
    ).rejects.toThrow(/region meshes/i)
  })

  it('reports progress while it downloads', async () => {
    const seen: number[] = []
    await loadRoiOutlines({
      source,
      datasetId: DATASET,
      rois: getConnectome(DATASET)!.rois,
      onProgress: (fraction) => seen.push(fraction),
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe(1)
  })
})
