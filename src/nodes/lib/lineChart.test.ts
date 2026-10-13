import { describe, expect, it } from 'vitest'
import { column, tableSchema } from '../../core/types'
import { yColumnsOf } from './lineChart'

const WIDE = tableSchema(
  column('t', 'f64'),
  column('soma', 'f64'),
  column('tip', 'f64'),
  column('note', 'str'),
)
const LONG = tableSchema(column('t', 'f64'), column('v', 'f64'), column('site', 'str'))

describe('yColumnsOf', () => {
  it('takes every numeric column but X and the series when no Y is picked', () => {
    expect(yColumnsOf(WIDE, [], 't', undefined)).toEqual(['soma', 'tip'])
    expect(yColumnsOf(WIDE, ['tip'], 't', undefined)).toEqual(['tip'])
    expect(yColumnsOf(LONG, [], 't', 'site')).toEqual(['v'])
  })
})
