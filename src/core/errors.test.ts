import { describe, expect, it } from 'vitest'

import { FixableError, errorFix } from './errors'

const FIX = { label: 'Allow it', action: 'tickAndRun', param: 'allow' } as const

describe('errorFix', () => {
  it('reads a FixableError’s fix, and nothing from a plain error', () => {
    expect(errorFix(new FixableError('No.', FIX))).toBe(FIX)
    expect(errorFix(new Error('No.'))).toBeUndefined()
    expect(errorFix('No.')).toBeUndefined()
  })

  it('finds it through a wrapper that keeps the original as its cause', () => {
    const wrapped = new Error('Could not be run again.', {
      cause: new FixableError('No.', FIX),
    })
    expect(errorFix(wrapped)).toBe(FIX)
  })
})
