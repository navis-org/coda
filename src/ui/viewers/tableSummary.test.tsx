// @vitest-environment jsdom

/**
 * A table shown as text, for a panel with no room to draw one.
 *
 * Three things about it would each read as a bug rather than as a design: an id must not be
 * truncated, an empty table must not print a null that is not there, and every column has to be
 * listed — the readout is a *schema* with an example, so a column missing from it is a column
 * somebody will believe is missing from the table.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable, tableFromRows } from '../../core/values'
import { TableSummary } from './TableSummary'

afterEach(cleanup)

const rows = (container: HTMLElement) => container.querySelectorAll('.table-summary__row')

describe('TableSummary', () => {
  it('lists every column with its type and the first row’s value', () => {
    const table = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('type', 'str'), column('pre', 'i64')),
      [
        { neuronId: '720575940628857210', type: 'LC4', pre: 1234 },
        { neuronId: '720575940626838909', type: 'LC6', pre: 9 },
      ],
    )
    const { container } = render(<TableSummary table={table} />)
    expect(rows(container)).toHaveLength(3)
    expect(container.textContent).toContain('neuronId')
    expect(container.textContent).toContain('i64')
    // The *first* row, and formatted the way the table would format it — a count groups.
    expect(container.textContent).toContain('LC4')
    expect(container.textContent).toContain('1,234')
    expect(container.textContent).not.toContain('LC6')
  })

  it('keeps a neuron id whole', () => {
    /*
     * Eighteen digits, and the column somebody is most often checking. A truncated id is not an
     * id — it is a different neuron, silently, which is invariant 8's whole subject.
     */
    const id = '720575940628857210'
    const table = tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: id }])
    render(<TableSummary table={table} />)
    expect(screen.getByTitle(id).textContent).toBe(id)
  })

  it('cuts a long value but keeps the whole of it on the element', () => {
    const long = 'a description somebody typed that runs well past the width of this panel'
    const table = tableFromRows(tableSchema(column('note', 'str')), [{ note: long }])
    render(<TableSummary table={table} />)
    const cell = screen.getByTitle(long)
    expect(cell.textContent).toContain('…')
    expect(cell.textContent!.length).toBeLessThan(long.length)
  })

  it('says nothing rather than a dash for a table with no rows', () => {
    /*
     * There is no first row to be absent from, so a `—` would read as a null *in* one — which on
     * a schema readout is a claim about the data rather than about the table being empty.
     */
    const table = makeTable(tableSchema(column('neuronId', 'str'), column('type', 'str')), {
      neuronId: [],
      type: [],
    })
    const { container } = render(<TableSummary table={table} />)
    expect(rows(container)).toHaveLength(2)
    expect(container.textContent).not.toContain('—')
  })
})
