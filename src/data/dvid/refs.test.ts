import { describe, expect, it } from 'vitest'

import {
  instanceUrl,
  keyUrl,
  meshInstance,
  parseDvidRef,
  serverOf,
  skeletonInstance,
} from './refs'

const MB = 'https://flyem.dvid.io/babdf6dbc23e44a69953a66e2260ff0a/groundtruth'

describe('parseDvidRef', () => {
  it('splits a published source into server, node and instance', () => {
    expect(parseDvidRef(MB)).toEqual({
      server: 'https://flyem.dvid.io',
      node: 'babdf6dbc23e44a69953a66e2260ff0a',
      instance: 'groundtruth',
    })
  })

  it('accepts an abbreviated node, because a published source uses one', () => {
    // neuPrint's own `fib19:v1.0` layer names five hex characters, not thirty-two. A length
    // rule here would reject a real dataset.
    expect(parseDvidRef('dvid-less://x')).toBeUndefined()
    expect(parseDvidRef('https://emdata6-fib19.janelia.org/93f08/segmentation')).toEqual({
      server: 'https://emdata6-fib19.janelia.org',
      node: '93f08',
      instance: 'segmentation',
    })
  })

  it('keeps a path prefix on the server, so a DVID under a path works', () => {
    // The node and instance are the *last* two segments; everything before them is the server.
    expect(parseDvidRef('https://lab.example/dvid/api-front/abc123/seg')).toEqual({
      server: 'https://lab.example/dvid/api-front',
      node: 'abc123',
      instance: 'seg',
    })
  })

  it('refuses what is not this shape', () => {
    expect(parseDvidRef('')).toBeUndefined()
    // Nothing to name an instance with.
    expect(parseDvidRef('https://flyem.dvid.io/onlyone')).toBeUndefined()
    // A node has to be hex — this is the one check that can catch a location with the pieces
    // in the wrong order before a request goes out.
    expect(parseDvidRef('https://flyem.dvid.io/groundtruth/babdf6d')).toBeUndefined()
    // Not a fetchable scheme.
    expect(parseDvidRef('gs://bucket/uuid/inst')).toBeUndefined()
  })

  it('tolerates a trailing slash and surrounding space', () => {
    expect(parseDvidRef(`  ${MB}/  `)).toEqual(parseDvidRef(MB))
  })
})

describe('the geometry instances and their URLs', () => {
  const ref = parseDvidRef(MB)!

  it('names geometry by neuroglancer’s convention, from the segmentation instance', () => {
    expect(meshInstance(ref)).toBe('groundtruth_meshes')
    expect(skeletonInstance(ref)).toBe('groundtruth_skeletons')
  })

  it('addresses one instance, which is what the narrow existence probe reads', () => {
    /*
     * `/api/repos/info` would answer with every repo on the host — on the public server that is
     * 42 kB naming other people's aliases, uuids and instances. This is the whole reason the
     * check is per instance; `fetchInfo` appends the `/info` and memoises it.
     */
    expect(instanceUrl(ref, meshInstance(ref))).toBe(
      'https://flyem.dvid.io/api/node/babdf6dbc23e44a69953a66e2260ff0a/groundtruth_meshes',
    )
  })

  it('builds a key URL from the instance URL alone, encoding the key', () => {
    // From the base rather than from a `DvidRef`, so a `MeshSource` carrying only that string
    // can still address a body — nothing has to thread a ref through precomputed machinery.
    const base = instanceUrl(ref, meshInstance(ref))
    expect(keyUrl(base, '100003022.ngmesh')).toBe(
      'https://flyem.dvid.io/api/node/babdf6dbc23e44a69953a66e2260ff0a/groundtruth_meshes/key/100003022.ngmesh',
    )
    // Never happens with a neuron id, which is the point of not relying on that.
    expect(keyUrl(base, 'a/b')).toContain('/key/a%2Fb')
  })

  it('names the server and not the node, for a message somebody will paste', () => {
    // The node is the whole of the access control on these deployments.
    expect(serverOf(instanceUrl(ref, meshInstance(ref)))).toBe('https://flyem.dvid.io')
  })
})
