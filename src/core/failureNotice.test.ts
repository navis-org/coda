import { beforeAll, describe, expect, it } from 'vitest'

import { emptyGraph, type CodaGraph } from './graph'
import { failureNotice, rootFailure } from './failureNotice'
import { registerNode } from './registry'
import { T } from './types'

const graph: CodaGraph = {
  ...emptyGraph(),
  nodes: [
    { id: 'a', type: 'not.registered', position: { x: 0, y: 0 }, params: {}, title: 'Search' },
    { id: 'b', type: 'not.registered', position: { x: 0, y: 0 }, params: {}, title: 'Table' },
    { id: 'c', type: 'not.registered', position: { x: 0, y: 0 }, params: {}, title: 'Plot' },
  ],
}
const errors: Record<string, string> = { a: 'The model download is off.', b: 'No rows' }
const errorOf = (id: string) => errors[id]

describe('failureNotice', () => {
  it('says nothing when nothing failed', () => {
    expect(failureNotice([], graph, errorOf)).toBeUndefined()
  })

  it('names the node and gives its reason', () => {
    expect(failureNotice(['a'], graph, errorOf)).toBe(
      'Search failed: The model download is off.',
    )
  })

  it('names the first failure and counts the rest', () => {
    expect(failureNotice(['a', 'b'], graph, errorOf)).toBe(
      'Search failed: The model download is off. 1 more node failed too.',
    )
    expect(failureNotice(['b', 'a', 'c'], graph, errorOf)).toBe(
      'Table failed: No rows. 2 more nodes failed too.',
    )
  })

  it('ends a reason in a bracket with a full stop before the count, and starts with a capital', () => {
    const brackets = (id: string) => (id === 'a' ? 'No rows (filter removed all)' : undefined)
    expect(failureNotice(['a', 'b'], graph, brackets)).toBe(
      'Search failed: No rows (filter removed all). 1 more node failed too.',
    )
    expect(failureNotice(['gone'], graph, errorOf)).toBe('A node failed.')
  })

  it('still names a node whose reason is unknown', () => {
    expect(failureNotice(['c'], graph, errorOf)).toBe('Plot failed.')
    expect(failureNotice(['c', 'a'], graph, errorOf)).toBe(
      'Plot failed. 1 more node failed too.',
    )
  })
})

describe('rootFailure', () => {
  beforeAll(() => {
    registerNode({
      type: 'test.failure.refs',
      label: 'Refs',
      category: 'utility',
      cost: 'cheap',
      inputs: [
        { id: 'in', label: 'In', type: T.any(), required: false },
        { id: 'ref', label: 'Ref', type: T.any(), required: false, reference: true },
      ],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      inferOutputs: () => ({ out: T.any() }),
      evaluate: () => ({}),
    })
  })

  // a → b → c → d
  const chain: CodaGraph = {
    ...emptyGraph(),
    edges: ['ab', 'bc', 'cd'].map(([s, t]) => ({
      id: `${s}${t}`,
      source: s!,
      sourceHandle: 'out',
      target: t!,
      targetHandle: 'in',
    })),
  }
  const failed =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id)

  it('is the node itself where it failed', () => {
    expect(rootFailure(chain, 'c', failed('c'))).toBe('c')
  })

  it('is the failure furthest up, not one beneath it', () => {
    expect(rootFailure(chain, 'd', failed('b', 'a'))).toBe('a')
  })

  const at = (id: string) => ({
    id,
    type: 'test.failure.refs',
    position: { x: 0, y: 0 },
    params: {},
  })

  /*
   * A reference edge may point upstream (`asReference`), putting `a` among its own ancestors: a
   * failed node above itself, so the failure that started it all was never named.
   */
  it('names a failure a reference makes its own ancestor', () => {
    const graph: CodaGraph = {
      ...emptyGraph(),
      nodes: ['a', 'b', 'c'].map(at),
      edges: [
        { id: 'ab', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
        { id: 'bc', source: 'b', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
        { id: 'ba', source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'ref' },
      ],
    }
    expect(rootFailure(graph, 'c', failed('a'))).toBe('a')
  })

  /* A node whose referenced node failed is refused too, so a reference is a way up as well. */
  it('follows a reference up to a failure', () => {
    const graph: CodaGraph = {
      ...emptyGraph(),
      nodes: ['ds', 'search', 'review'].map(at),
      edges: [
        { id: 'r', source: 'ds', sourceHandle: 'out', target: 'search', targetHandle: 'ref' },
        {
          id: 'd',
          source: 'search',
          sourceHandle: 'out',
          target: 'review',
          targetHandle: 'in',
        },
      ],
    }
    expect(rootFailure(graph, 'review', failed('ds'))).toBe('ds')
  })

  it('is nothing where nothing at or above failed', () => {
    expect(rootFailure(chain, 'b', failed('c', 'd'))).toBeUndefined()
  })
})
