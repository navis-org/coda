import { describe, expect, it } from 'vitest'
import { dotmotifHost, matchColumns } from './dotmotifHost'

describe('dotmotifHost', () => {
  it('keys nodes by their rank in id order, and sorts links by the pair of keys', () => {
    const host = dotmotifHost(['c', 'a', 'b'], ['c', 'a'], ['a', 'b'], true)
    expect(host.ids).toEqual(['a', 'b', 'c'])
    expect(Array.from(host.keyOfRow)).toEqual([2, 0, 1])
    // a → b is (0, 1) and sorts before c → a, (2, 0); each remembers the row it came from.
    expect(Array.from(host.sources)).toEqual([0, 2])
    expect(Array.from(host.targets)).toEqual([1, 0])
    expect(Array.from(host.linkRows)).toEqual([1, 0])
  })

  it('sorts an undirected link by its smaller key, and keeps the direction it was written in', () => {
    const host = dotmotifHost(['a', 'b', 'c'], ['c', 'b'], ['a', 'c'], false)
    expect(Array.from(host.sources)).toEqual([2, 1])
    expect(Array.from(host.targets)).toEqual([0, 2])
    expect(Array.from(host.linkRows)).toEqual([0, 1])
  })

  it('gives one network the same keys whatever order its rows arrive in', () => {
    const one = dotmotifHost(['1', '2', '3'], ['1', '2'], ['2', '3'], true)
    const other = dotmotifHost(['3', '2', '1'], ['2', '1'], ['3', '2'], true)
    expect(other.ids).toEqual(one.ids)
    const pairs = (host: typeof one) =>
      Array.from(host.sources, (s, i) => `${s}>${host.targets[i]}`).sort()
    expect(pairs(other)).toEqual(pairs(one))
  })

  it('keeps an eighteen-digit id exact', () => {
    const wide = '720575940600000001'
    expect(dotmotifHost([wide, '2'], [wide], ['2'], true).ids).toContain(wide)
  })

  it('takes both directions of a pair when directed, and a self-loop', () => {
    expect(() => dotmotifHost(['1', '2'], ['1', '2', '1'], ['2', '1', '1'], true)).not.toThrow()
  })

  it.each([
    ['an empty id', ['', '2'], ['2'], ['2'], true, 'empty or missing'],
    ['a repeated id', ['1', '1'], ['1'], ['1'], true, 'appears more than once'],
    ['a link to a node not in the table', ['1', '2'], ['unknown'], ['1'], true, 'not in the'],
    ['parallel links', ['1', '2'], ['1', '1'], ['2', '2'], true, 'Merge parallel links'],
    [
      'a reversed pair, undirected',
      ['1', '2'],
      ['1', '2'],
      ['2', '1'],
      false,
      'Merge parallel',
    ],
  ] as const)('refuses %s', (_, ids, sources, targets, directed, message) => {
    expect(() => dotmotifHost([...ids], [...sources], [...targets], directed)).toThrow(message)
  })
})

describe('matchColumns', () => {
  it('names each role of each match by the id its key stands for', () => {
    const keys = new Int32Array([1, 2, 1, 0])
    expect(matchColumns({ count: 2, roles: ['A', 'B'], keys }, ['x', 'y', 'z'])).toEqual({
      matchId: [1, 1, 2, 2],
      variable: ['A', 'B', 'A', 'B'],
      nodeId: ['y', 'z', 'y', 'x'],
    })
  })
})
