/**
 * The `#!` grammar and the packed codec.
 *
 * The load-bearing assertions here are the *refusals*: a link is the one artefact in this app
 * that arrives from outside with no context at all, so what it says when it cannot be read is
 * most of what anybody ever sees of this module.
 */

import { describe, expect, it } from 'vitest'

import { deserializeGraph, emptyGraph, newId, type CodaGraph } from '../../core/graph'
import {
  ShareLinkError,
  decodePacked,
  encodeShareFragment,
  hasShareFragment,
  isLocalOrigin,
  parseShareFragment,
  shareUrl,
} from './fragment'
import '../../nodes'

/** A graph with enough in it that packing has something to compress. */
function sampleGraph(): CodaGraph {
  const graph = emptyGraph('Partner sweep')
  for (let i = 0; i < 6; i += 1) {
    graph.nodes.push({
      id: newId('n'),
      type: 'core.filter',
      position: { x: i * 220, y: 40 },
      params: { column: 'weight', op: '>=', value: String(i) },
    })
  }
  for (let i = 1; i < graph.nodes.length; i += 1) {
    graph.edges.push({
      id: newId('e'),
      source: graph.nodes[i - 1]!.id,
      sourceHandle: 'out',
      target: graph.nodes[i]!.id,
      targetHandle: 'in',
    })
  }
  return graph
}

describe('hasShareFragment', () => {
  it('answers on the prefix alone, without reading the payload', () => {
    expect(hasShareFragment('#!c1.abc')).toBe(true)
    expect(hasShareFragment('#!{}')).toBe(true)
    // Nonsense after the prefix still counts: "there is a link here" and "the link is readable"
    // are different questions, and the store asks only the first one, in the tick it is created.
    expect(hasShareFragment('#!????')).toBe(true)
  })

  it('is false for an ordinary anchor, an empty prefix and no hash at all', () => {
    expect(hasShareFragment('#chapter-3')).toBe(false)
    expect(hasShareFragment('#!')).toBe(false)
    expect(hasShareFragment('')).toBe(false)
  })
})

describe('the packed form', () => {
  it('round-trips a graph through the fragment', async () => {
    const graph = sampleGraph()
    const fragment = await encodeShareFragment(graph)
    expect(fragment.startsWith('#!c1.')).toBe(true)

    const ref = parseShareFragment(fragment)
    expect(ref.kind).toBe('packed')
    if (ref.kind !== 'packed') throw new Error('unreachable')

    const { graph: back } = deserializeGraph(await decodePacked(ref.blob))
    expect(back.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id))
    expect(back.edges).toHaveLength(graph.edges.length)
    expect(back.meta?.name).toBe('Partner sweep')
  })

  it('is base64url — nothing in it needs escaping in a URL', async () => {
    const fragment = await encodeShareFragment(sampleGraph())
    expect(fragment.slice('#!c1.'.length)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  /**
   * The whole reason to compress. Measured across the bundled examples at roughly 2.8x, and
   * the margin is what decides whether an ordinary workflow fits in a link at all.
   */
  it('is substantially shorter than the same graph as JSON', async () => {
    const graph = sampleGraph()
    const packed = await encodeShareFragment(graph)
    expect(packed.length).toBeLessThan(JSON.stringify(graph).length / 1.5)
  })

  it('survives a payload large enough to break the one-line base64', async () => {
    // `String.fromCharCode(...bytes)` is the tempting spelling and blows the call stack well
    // below the size an Explore select-all reaches. Random ids so it cannot compress away.
    const graph = emptyGraph('Big selection')
    const ids: string[] = []
    for (let i = 0; i < 20_000; i += 1) ids.push(String(100_000_000 + i * 7919))
    graph.nodes.push({
      id: 'n1',
      type: 'core.filter',
      position: { x: 0, y: 0 },
      params: { column: 'bodyId', op: '>=', value: ids.join(',') },
    })
    const fragment = await encodeShareFragment(graph)
    const ref = parseShareFragment(fragment)
    if (ref.kind !== 'packed') throw new Error('unreachable')
    const back = deserializeGraph(await decodePacked(ref.blob)).graph
    expect(String(back.nodes[0]?.params['value']).split(',')).toHaveLength(20_000)
  })

  it('blames truncation for a blob that will not inflate, because that is what happens', async () => {
    const fragment = await encodeShareFragment(sampleGraph())
    const cut = fragment.slice('#!c1.'.length, -400)
    await expect(decodePacked(cut)).rejects.toThrow(/truncated|cut short/i)
  })
})

describe('the literal form', () => {
  it('reads a bare {…} fragment, so a hand-written link works', () => {
    const ref = parseShareFragment('#!{"version":1,"nodes":[],"edges":[]}')
    expect(ref).toEqual({ kind: 'json', json: '{"version":1,"nodes":[],"edges":[]}' })
  })

  it('reads one that a chat client has percent-encoded', () => {
    const ref = parseShareFragment('#!%7B%22version%22%3A1%2C%22nodes%22%3A%5B%5D%7D')
    expect(ref.kind).toBe('json')
    if (ref.kind !== 'json') throw new Error('unreachable')
    expect(JSON.parse(ref.json)).toEqual({ version: 1, nodes: [] })
  })

  /**
   * A payload that is not encoded at all must not be refused for containing a stray `%`. The
   * decode is attempted and its failure ignored, which is the only way both forms can work.
   */
  it('tolerates a malformed escape rather than refusing the link', () => {
    expect(parseShareFragment('#!{"name":"100%"}')).toEqual({
      kind: 'json',
      json: '{"name":"100%"}',
    })
  })
})

describe('references', () => {
  it('reads gh:// with and without the owner segment', () => {
    expect(parseShareFragment('#!gh://schlegelp/b52b3af9')).toEqual({
      kind: 'gist',
      id: 'b52b3af9',
      owner: 'schlegelp',
    })
    expect(parseShareFragment('#!gh://b52b3af9')).toEqual({ kind: 'gist', id: 'b52b3af9' })
  })

  it('reads a pinned revision', () => {
    expect(parseShareFragment('#!gh://schlegelp/b52b3af9@37a0cd14')).toEqual({
      kind: 'gist',
      id: 'b52b3af9',
      owner: 'schlegelp',
      revision: '37a0cd14',
    })
  })

  it('splits gs:// at the first slash, so a nested path survives', () => {
    expect(parseShareFragment('#!gs://my-bucket/workflows/lc4/sweep.coda.json')).toEqual({
      kind: 'gcs',
      bucket: 'my-bucket',
      path: 'workflows/lc4/sweep.coda.json',
    })
  })

  it('refuses a gs:// address with no path, naming what is missing', () => {
    expect(() => parseShareFragment('#!gs://my-bucket')).toThrow(/bucket and a path/i)
  })

  it('keeps an https:// URL whole', () => {
    expect(parseShareFragment('#!https://lab.example.org/w.json?v=2')).toEqual({
      kind: 'https',
      url: 'https://lab.example.org/w.json?v=2',
    })
  })
})

describe('refusals', () => {
  /**
   * Naming the scheme is the point. The fix for `http://` is a URL change, the fix for
   * `file://` is to send the file itself, and a shared "bad link" helps with neither.
   */
  it('names the scheme it cannot open', () => {
    expect(() => parseShareFragment('#!ftp://example.org/w.json')).toThrow(/"ftp:\/\/"/)
    expect(() => parseShareFragment('#!http://example.org/w.json')).toThrow(/"http:\/\/"/)
  })

  it('refuses javascript: like any other unknown scheme rather than treating it as a URL', () => {
    expect(() => parseShareFragment('#!javascript://alert(1)')).toThrow(ShareLinkError)
  })

  it('says a link may be truncated or from a newer build when it matches nothing', () => {
    expect(() => parseShareFragment('#!wat')).toThrow(/newer version|truncated/i)
  })

  it('refuses an empty packed payload', () => {
    expect(() => parseShareFragment('#!c1.')).toThrow(/carries no data/i)
  })

  it('refuses a fragment that is not a share link at all', () => {
    expect(() => parseShareFragment('#chapter-3')).toThrow(ShareLinkError)
  })
})

describe('building the address', () => {
  /**
   * `base` is `'./'`, so the app can be served from a subpath. A link built from the current
   * href would carry whatever route the user happened to be on.
   */
  it('is the deploy root plus the fragment, not the current page', () => {
    expect(shareUrl('#!c1.abc', './', 'https://navis-org.github.io/coda/index.html')).toBe(
      'https://navis-org.github.io/coda/#!c1.abc',
    )
  })

  it('marks an origin only its author can open', () => {
    expect(isLocalOrigin('http://localhost:5173/')).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:4173/coda/')).toBe(true)
    expect(isLocalOrigin('file:///Users/x/dist/index.html')).toBe(true)
    expect(isLocalOrigin('https://navis-org.github.io/coda/')).toBe(false)
  })
})
