// @vitest-environment jsdom

/**
 * Which of Describe Table's two ports the card draws.
 *
 * `ValuePreview` is handed one output value — the *primary* port's — and on every tap here
 * that is deliberately the pass-through, so the default for a table value is to draw the input
 * back. This node is the one that must not: its whole point is the second port, and a card that
 * fell through to the default would render a second Table node under a different name, which
 * looks entirely reasonable and is wrong.
 *
 * jsdom performs no layout, so nothing about how the grid *looks* is testable here. What is
 * testable is which frame reached it, and that is the branch worth pinning.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ValuePreview } from './ValuePreview'
import '../../nodes'

beforeAll(() => installJsdomStubs({ width: 620, height: 360 }))
afterEach(cleanup)

const SCHEMA = tableSchema(column('neuronId', 'i64'), column('weight', 'i64', 'synapses'))

function table(): TableValue {
  return tableFromRows(
    SCHEMA,
    [
      { neuronId: 1001, weight: 10 },
      { neuronId: 1002, weight: 30 },
    ],
    'neurons',
  )
}

function draw(type: string, value: TableValue) {
  const def = requireNodeDef(type)
  const params = defaultParams(def)
  return render(
    <ValuePreview
      node={{ id: 'v', type, position: { x: 0, y: 0 }, params } as never}
      value={value}
      ctx={makeInferContext(def, params, { in: T.table(SCHEMA) })}
      compact
    />,
  )
}

describe('out.describe on a card', () => {
  it('draws the summary rather than the table that passed through', () => {
    draw('out.describe', table())
    // The summary's own columns, which the input does not have.
    expect(screen.getByText('unique')).toBeTruthy()
    expect(screen.getByText('median')).toBeTruthy()
    // One row per column of the input, named in the `column` column.
    expect(screen.getByText('weight')).toBeTruthy()
    // Two rows, not two hundred: this is a table *about* a table, so its length is the
    // input's column count.
    expect(screen.getByText('1–2 of 2')).toBeTruthy()
  })

  it('leaves every other table node drawing its own value', () => {
    draw('out.table', table())
    // `out.table` has no `unique` column — it is showing the input, as it should.
    expect(screen.queryByText('unique')).toBeNull()
    expect(screen.getByText('neuronId')).toBeTruthy()
  })
})
