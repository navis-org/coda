/**
 * Opening a network in Cytoscape Web: the link, and what the dialog's toggles leave in the file.
 *
 * The link is checked by *reading it back* the way the far end does — `URLSearchParams` for the
 * query, then the `data:` URL's base64 — because the trap here is invisible in the string: a `+`
 * left raw in the query decodes as a space, and a base64 payload with a space in it is a file
 * that fails to parse on somebody else's screen with nothing on this one to say why.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { NetworkValue } from '../core/values'
import { tableFromRows } from '../core/values'
import type { CytoscapeChoice } from './cytoscapeWeb'
import {
  MAX_LINK_CHARS,
  cytoscapeCx2,
  dataLink,
  importLink,
  mayFitInLink,
} from './cytoscapeWeb'

function ring(count: number): NetworkValue {
  const ids = Array.from({ length: count }, (_, i) => `n${i}`)
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      tableSchema(column('id', 'str'), column('type', 'str')),
      ids.map((id) => ({ id, type: 'LC4' })),
    ),
    edges: tableFromRows(
      tableSchema(column('source', 'str'), column('target', 'str'), column('weight', 'f64')),
      ids.map((id, i) => ({ source: id, target: ids[(i + 1) % count]!, weight: i + 1 })),
    ),
  }
}

const ALL: CytoscapeChoice = { nodeAttributes: true, edgeAttributes: true, layout: true }

/** What Cytoscape Web ends up parsing: the query decoded, then the `data:` URL's payload. */
function readBack(link: string): string {
  const value = new URL(link).searchParams.get('import')!
  const [head, payload] = value.split(',', 2)
  expect(head).toBe('data:application/json;base64')
  const bytes = Uint8Array.from(atob(payload!), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

type Cx2Node = { v: Record<string, unknown>; x?: number }
type Cx2Edge = { v: Record<string, unknown> }

function aspect<T>(cx2: string, name: string): T {
  const aspects = JSON.parse(cx2) as Array<Record<string, unknown>>
  return aspects.find((a) => name in a)![name] as T
}

describe('the data link', () => {
  it('reads back as exactly the file it was built from', () => {
    const cx2 = cytoscapeCx2(ring(5), 'ring', ALL, undefined)
    expect(readBack(dataLink(cx2)!)).toBe(cx2)
  })

  it('escapes a `+`, which the query would otherwise decode as a space', () => {
    // `>>>` is `Pj4+` in base64.
    const link = dataLink('>>>')!
    expect(link).toContain('%2B')
    expect(readBack(link)).toBe('>>>')
  })

  it('carries text that is not ASCII, measured in bytes', () => {
    expect(readBack(dataLink('ME(R) → LC4 · ångström')!)).toBe('ME(R) → LC4 · ångström')
  })

  it('refuses a file that would not fit rather than build a link the server refuses', () => {
    expect(dataLink('x'.repeat(MAX_LINK_CHARS))).toBeUndefined()
    // Just under: three bytes are four characters, so the boundary is the encoded length.
    const fits = dataLink('x'.repeat(5000))!
    expect(fits.length).toBeLessThanOrEqual(MAX_LINK_CHARS)
  })
})

describe('the lower bound the dialog asks before building anything', () => {
  it('never turns away a graph the link would have carried', () => {
    // A floor that is too high sends a small graph through a gist — or blocks it outright for
    // somebody with no token — when it would have fitted. So it is checked against real files
    // at their smallest, every toggle off, across the sizes where the answer changes.
    const bare: CytoscapeChoice = {
      nodeAttributes: false,
      edgeAttributes: false,
      layout: false,
    }
    let fitted = 0
    for (let n = 1; n <= 150; n++) {
      if (!dataLink(cytoscapeCx2(ring(n), '', bare, undefined))) continue
      fitted++
      expect(mayFitInLink(ring(n)), `${n} nodes`).toBe(true)
    }
    expect(fitted).toBeGreaterThan(0)
  })

  it('turns away a graph no toggle could bring under the limit', () => {
    expect(mayFitInLink(ring(400))).toBe(false)
  })
})

describe('the import link', () => {
  it('carries a hosted file’s address whole, its own query string included', () => {
    const raw = 'https://gist.githubusercontent.com/me/abc/raw/123/coda-network.cx2?x=1&y=2'
    expect(new URL(importLink(raw)).searchParams.get('import')).toBe(raw)
  })
})

describe('what the toggles leave in the file', () => {
  const positions = new Map([
    ['n0', { x: 0, y: 0 }],
    ['n1', { x: 10, y: 5 }],
    ['n2', { x: 20, y: 0 }],
  ])

  it('writes everything when everything is ticked', () => {
    const cx2 = cytoscapeCx2(ring(3), 'ring', ALL, positions)
    const nodes = aspect<Cx2Node[]>(cx2, 'nodes')
    expect(nodes[0]!.v).toEqual({ name: 'n0', type: 'LC4' })
    expect(nodes[0]).toHaveProperty('x')
    expect(aspect<Cx2Edge[]>(cx2, 'edges')[0]!.v).toEqual({ weight: 1 })
  })

  it('keeps a node’s id, as its name, when its attributes are left out', () => {
    const cx2 = cytoscapeCx2(ring(3), 'ring', { ...ALL, nodeAttributes: false }, positions)
    expect(aspect<Cx2Node[]>(cx2, 'nodes')[0]!.v).toEqual({ name: 'n0' })
    expect(aspect<Cx2Edge[]>(cx2, 'edges')[0]!.v).toEqual({ weight: 1 })
  })

  it('leaves every edge its endpoints when edge attributes are left out', () => {
    const cx2 = cytoscapeCx2(ring(3), 'ring', { ...ALL, edgeAttributes: false }, positions)
    const edges = aspect<Array<Cx2Edge & { s: number; t: number }>>(cx2, 'edges')
    expect(edges).toHaveLength(3)
    expect(edges[0]).toMatchObject({ s: 0, t: 1, v: {} })
  })

  it('writes no positions when the layout is left out', () => {
    const cx2 = cytoscapeCx2(ring(3), 'ring', { ...ALL, layout: false }, positions)
    expect(aspect<Cx2Node[]>(cx2, 'nodes')[0]).not.toHaveProperty('x')
  })
})
