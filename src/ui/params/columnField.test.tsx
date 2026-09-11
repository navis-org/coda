// @vitest-environment jsdom

/**
 * What a column picker *says* about a port that has not published a schema.
 *
 * **Unknown is not missing**, and both widgets used to flatten the two. The resolver and
 * `validateColumnParams` already draw the distinction — `columnSchemaFor` answers `undefined`
 * separately from an empty schema for exactly this reason — but the widgets asked only
 * "is this name in the available list", which is `false` for a port carrying no list at all.
 *
 * Reported on `Table from URL → Combine Columns → Update root IDs`, where a fresh session drew
 * `ID column: neuronId (missing)` over `Supervoxel ID column: no column` on a node that then ran
 * perfectly well. Both claims were false and both pointed at the user's configuration.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ColumnParam, ColumnsParam, MultiEnumParam, NodeDefinition } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import type { CodaType } from '../../core/types'
import { T, column, tableSchema } from '../../core/types'
import { ParamField } from './ParamField'

afterEach(cleanup)

const SCHEMA = tableSchema(column('neuronId', 'str'), column('supervoxel_id', 'str'))

const ID: ColumnParam = {
  id: 'idColumn',
  kind: 'column',
  label: 'ID column',
  from: 'in',
  default: 'neuronId',
}
const MANY: ColumnsParam = {
  id: 'columns',
  kind: 'columns',
  label: 'Columns',
  from: 'in',
  default: [],
}

function def(param: ColumnParam | ColumnsParam | MultiEnumParam): NodeDefinition {
  return {
    type: 'test.picker',
    label: 'Test',
    category: 'transform',
    description: 'fixture',
    cost: 'cheap',
    inputs: [{ id: 'in', label: 'Table', type: T.table() }],
    outputs: [{ id: 'out', label: 'Table', type: T.table() }],
    params: [param],
    evaluate: () => ({}),
  }
}

function draw(
  param: ColumnParam | ColumnsParam | MultiEnumParam,
  input: CodaType | undefined,
  params: Record<string, unknown> = {},
) {
  const d = def(param)
  const values = { ...defaultParams(d), ...params }
  const ctx = makeInferContext(d, values as never, { in: input })
  return render(
    <ParamField
      param={param}
      value={values[param.id] as never}
      ctx={ctx}
      onChange={() => undefined}
    />,
  )
}

describe('a required picker with no schema upstream', () => {
  it('shows the column it will use rather than calling it missing', () => {
    // `T.table()` is a wire carrying a table whose columns nobody has published — a Pivot, Raw
    // Cypher, or `Table from URL` before its first fetch of the session.
    draw(ID, T.table(), { idColumn: 'neuronId' })
    const select = screen.getByLabelText<HTMLSelectElement>('ID column')
    expect(select.value).toBe('neuronId')
    expect(select.textContent).not.toContain('missing')
  })

  it('is not disabled, so the value is visible at all', () => {
    /*
     * The half that made the supervoxel picker read `no column`: with nothing stored the option
     * list came out empty, `SelectField` took its no-options branch, and the select rendered
     * *disabled* showing a placeholder — so the resolver's answer, which is what actually runs,
     * was the one thing not on screen.
     */
    draw(ID, T.table(), { idColumn: '' })
    const select = screen.getByLabelText<HTMLSelectElement>('ID column')
    expect(select.disabled).toBe(false)
    // The declared default, which is what `resolveColumn` answers for an unset required picker.
    expect(select.value).toBe('neuronId')
  })

  it('says "not run yet" where there is no resolved value to show either', () => {
    /*
     * The placeholder case, reached when the *declared default* is empty too — `out.barChart`'s
     * `Category` under a Pivot, say. "no columns" there is a claim about the table; the truth is
     * that nobody has published one, and the two send you to different places.
     */
    const blank: ColumnParam = { ...ID, default: '' }
    draw(blank, T.table(), { idColumn: '' })
    const select = screen.getByLabelText('ID column')
    expect(select.textContent).toContain('not run yet')
    expect(select.textContent).not.toContain('no columns')
  })

  it('still says "missing" for a column a known schema really has lost', () => {
    // The distinction, from the other side: this claim is true here and has to survive.
    draw(ID, T.table(SCHEMA), { idColumn: 'gone' })
    expect(screen.getByLabelText('ID column').textContent).toContain('gone (missing)')
  })

  it('still says "no columns" for a schema that is known and empty', () => {
    draw(ID, T.table(tableSchema()), { idColumn: '' })
    expect(screen.getByLabelText('ID column').textContent).toContain('no columns')
  })
})

describe('a multi-column picker with no schema upstream', () => {
  it('draws the kept names plainly, because that is what will be used', () => {
    // `resolveColumns` returns a stored list untouched while the schema is unknown, so labelling
    // every chip "(missing)" contradicts the resolver an inch away.
    const { container } = draw(MANY, T.table(), { columns: ['cell_type', 'hemibrain_type'] })
    const chips = [...container.querySelectorAll('.chip')].map((c) => c.textContent ?? '')
    expect(chips.join(' ')).toContain('cell_type')
    expect(chips.join(' ')).not.toContain('missing')
  })

  it('does not add a placeholder chip beside chips that are already there', () => {
    // `cell_type ×  hemibrain_type ×  not run yet` reads as a warning about the two beside it.
    const { container } = draw(MANY, T.table(), { columns: ['cell_type'] })
    expect(container.textContent).not.toContain('not run yet')
    // With nothing selected there is something worth saying, and it is still said.
    cleanup()
    const empty = draw(MANY, T.table(), { columns: [] })
    expect(empty.container.textContent).toContain('not run yet')
  })

  it('still marks a name a known schema has lost', () => {
    const { container } = draw(MANY, T.table(SCHEMA), { columns: ['gone'] })
    expect(container.textContent).toContain('gone (missing)')
  })
})

/**
 * A chip is cut to fit its card, and what gets cut is the label: a property named
 * `weightDendriteDendrite` beside "(not by region)" is wider than a Connectivity card, and cutting
 * the end would take the half that says what the choice means. jsdom lays nothing out, so what is
 * pinned is the structure the stylesheet truncates — the width itself is a browser's to show.
 */
describe('a chip whose option carries a note', () => {
  const PROPS: MultiEnumParam = {
    id: 'props',
    kind: 'multiEnum',
    label: 'Edge properties',
    noun: 'property',
    default: [],
    options: [
      {
        value: 'weightDendriteDendrite',
        label: 'weightDendriteDendrite',
        note: 'not by region',
      },
      { value: 'weightHP', label: 'weightHP' },
    ],
  }

  it('draws the label and the note apart, so the stylesheet can cut one and keep the other', () => {
    const { container } = draw(PROPS, undefined, { props: ['weightDendriteDendrite'] })
    const chip = container.querySelector('.chip:not(.chip--empty)')!
    expect(chip.querySelector('.chip__text')?.textContent).toBe('weightDendriteDendrite')
    expect(chip.querySelector('.chip__note')?.textContent).toBe(' (not by region)')
    // …and says all of it on hover, which is where a cut label is read in full.
    expect(chip.getAttribute('title')).toBe('weightDendriteDendrite (not by region)')
  })

  it('offers the whole text in the dropdown, which is never cut', () => {
    draw(PROPS, undefined, { props: [] })
    const add = screen.getByLabelText('Add a property to Edge properties')
    const rows = [...add.querySelectorAll('option')].map((o) => o.textContent)
    expect(rows).toContain('weightDendriteDendrite (not by region)')
    expect(rows).toContain('weightHP')
  })

  it('notes a value the list has lost, so "missing" survives the cut too', () => {
    const { container } = draw(PROPS, undefined, { props: ['gone'] })
    expect(container.querySelector('.chip__note')?.textContent).toBe(' (missing)')
  })
})
