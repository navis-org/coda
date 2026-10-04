import { describe, expect, it } from 'vitest'

import { foreignColor } from './foreignColor'

describe('a colour as another tool spells it', () => {
  it('reads CSS names, hex with or without #, and RGB(A) lists in either range', () => {
    expect(foreignColor('orange')).toBe('#ffa500')
    expect(foreignColor(' Light Grey ')).toBe('#d3d3d3')
    expect(foreignColor('#ABC')).toBe('#aabbcc')
    expect(foreignColor('00ff0080')).toBe('#00ff00')
    expect(foreignColor([1, 0.5, 0, 0.2])).toBe('#ff8000')
    expect(foreignColor([255, 128, 0])).toBe('#ff8000')
  })

  it('reads nothing into what is not a colour', () => {
    for (const value of [null, undefined, '', 'LC4', '#12', 3, true, [1, 2], ['a', 'b', 'c']]) {
      expect(foreignColor(value as never)).toBeUndefined()
    }
  })
})
