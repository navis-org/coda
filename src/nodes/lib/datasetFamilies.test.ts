/**
 * Dataset families, versions, and the deployment/base-URL split.
 *
 * The version ordering is the part worth pinning: "defaults to the latest" is only correct if
 * `v1.2.3` beats `v1.2.1` beats `v1.0` — which a string comparison gets right by luck here and
 * wrong the moment a `v1.10` appears.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import {
  DEFAULT_SERVER,
  baseUrlForServer,
  normaliseServer,
  serverLabel,
  sourceIdForServer,
} from '../../data/neuprint/servers'
import {
  DATASET_FAMILIES,
  compareVersions,
  datasetFamily,
  resolveDatasetId,
  splitDataset,
  versionsFor,
} from './datasetFamilies'

beforeAll(async () => {
  const mock = registerSource(new MockSource({ latencyMs: 0 }))
  // Populates the synchronous peek cache the version dropdown reads from.
  await mock.listDatasets()
})

describe('compareVersions', () => {
  it('orders by numeric segment, not by string', () => {
    // The case a string sort gets wrong, and the reason this function exists.
    expect(compareVersions('v1.10', 'v1.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', 'v1.2.1')).toBeGreaterThan(0)
    expect(compareVersions('v1.0', 'v0.9')).toBeGreaterThan(0)
  })

  it('treats a missing segment as older', () => {
    expect(compareVersions('v1.2.1', 'v1.2')).toBeGreaterThan(0)
    expect(compareVersions('v1.1', 'v1.0.1')).toBeGreaterThan(0)
  })

  it('is symmetric and reflexive', () => {
    expect(compareVersions('v1.0', 'v1.0')).toBe(0)
    expect(Math.sign(compareVersions('v2', 'v1'))).toBe(-Math.sign(compareVersions('v1', 'v2')))
  })

  it('falls back to text for segments that are not numbers', () => {
    // `mock-1.0` and dated versions must still order stably rather than all tying at zero.
    expect(compareVersions('mock-1.0', 'mock-1.0')).toBe(0)
    expect(compareVersions('beta', 'alpha')).toBeGreaterThan(0)
  })

  it('sorts a real family listing newest first', () => {
    const manc = ['v1.0', 'v1.2.1', 'v1.2.3'].sort((a, b) => compareVersions(b, a))
    expect(manc).toEqual(['v1.2.3', 'v1.2.1', 'v1.0'])
  })
})

describe('splitDataset', () => {
  it('splits neuPrint’s family:version ids', () => {
    expect(splitDataset('male-cns:v1.0')).toEqual(['male-cns', 'v1.0'])
  })

  it('treats an id with no colon as all family', () => {
    // `mushroombody` is real and carries no version.
    expect(splitDataset('mushroombody')).toEqual(['mushroombody', ''])
  })
})

describe('the family table', () => {
  it('has a unique key per family, since the key is the node type', () => {
    const keys = DATASET_FAMILIES.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers every family neuPrint publishes visibly', () => {
    // Verified against the live listing: banc and wasp3 are marked hidden and never surface.
    const neuprint = DATASET_FAMILIES.filter((f) => f.sourceId === 'neuprint').map(
      (f) => f.family,
    )
    expect(neuprint.sort()).toEqual([
      'fib19',
      'hemibrain',
      'male-cns',
      'manc',
      'mushroombody',
      'optic-lobe',
    ])
  })

  it('is looked up by key', () => {
    expect(datasetFamily('malecns')?.family).toBe('male-cns')
    expect(datasetFamily('nope')).toBeUndefined()
  })
})

describe('versionsFor / resolveDatasetId', () => {
  const mockHemibrain = datasetFamily('mock.hemibrain')!

  it('finds the versions a source actually lists', () => {
    expect(versionsFor(mockHemibrain).map((v) => v.datasetId)).toEqual(['hemibrain-mini'])
  })

  it('resolves an empty version to the newest listed', () => {
    expect(resolveDatasetId(mockHemibrain, '')).toBe('hemibrain-mini')
  })

  it('keeps a pinned version rather than silently upgrading it', () => {
    // A graph that says v0.9 has to keep meaning v0.9, even against a server that has moved on.
    const malecns = datasetFamily('malecns')!
    expect(resolveDatasetId(malecns, 'v0.9')).toBe('male-cns:v0.9')
  })

  it('returns nothing when the source has listed nothing yet', () => {
    // Inference runs before any listing resolves, and must answer rather than throw.
    const unlisted = { ...mockHemibrain, sourceId: 'not-registered' }
    expect(versionsFor(unlisted)).toEqual([])
    expect(resolveDatasetId(unlisted, '')).toBeUndefined()
  })
})

describe('deployment URLs', () => {
  it('canonicalises the many ways of writing one server', () => {
    for (const written of [
      'https://neuprint.janelia.org',
      'https://neuprint.janelia.org/',
      'neuprint.janelia.org',
      '  https://neuprint.janelia.org/results  ',
    ]) {
      expect(normaliseServer(written)).toBe(DEFAULT_SERVER)
    }
  })

  it('treats an empty field as the default rather than an error', () => {
    expect(normaliseServer('')).toBe(DEFAULT_SERVER)
    expect(normaliseServer(undefined)).toBe(DEFAULT_SERVER)
  })

  it('keeps a different deployment', () => {
    expect(normaliseServer('https://neuprint-pre.janelia.org')).toBe(
      'https://neuprint-pre.janelia.org',
    )
  })

  it('sends the default deployment through the configured proxy', () => {
    // Not the deployment URL itself: neuPrint sends no CORS headers, so a direct fetch is
    // blocked before it is sent. This mapping is the entire reason the two are separate.
    expect(baseUrlForServer(DEFAULT_SERVER)).toBe('/neuprint')
  })

  it('sends any other deployment through the generic proxy', () => {
    expect(baseUrlForServer('https://neuprint-pre.janelia.org')).toBe(
      '/np/https%3A%2F%2Fneuprint-pre.janelia.org',
    )
  })

  it('keeps the bare source id for the default, so existing graphs still resolve', () => {
    expect(sourceIdForServer(DEFAULT_SERVER)).toBe('neuprint')
    expect(sourceIdForServer('https://other.example.org')).toBe(
      'neuprint:https://other.example.org',
    )
  })

  it('labels a deployment by host', () => {
    expect(serverLabel('https://neuprint.janelia.org')).toBe('neuprint.janelia.org')
  })
})
