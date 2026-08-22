// @vitest-environment jsdom

/**
 * How a row draws community tags, which are deliberately not chips.
 *
 * A CAVE datastack lets anyone attach free-form text to a neuron — FlyWire's
 * `neuron_information_v2` is one row per (neuron, tag) — so once Group By's `join` has gathered
 * them into a cell they are somebody's prose rather than a controlled vocabulary. Three things
 * follow, and each is what the test is about: their own row, no palette slot, and a cap, because
 * a neuron with forty tags must not push its neighbours off the page.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { NeuronRow } from './NeuronRow'
import { rowFields } from './rowFields'

beforeAll(() => installJsdomStubs({ width: 800, height: 500 }))
afterEach(cleanup)

const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('cell_class', 'str'),
  column('community', 'str'),
)

function draw(community: string | null) {
  const table = tableFromRows(
    SCHEMA,
    [{ neuronId: '720575940628857210', type: 'DNp01', cell_class: 'descending', community }],
    'neurons',
  )
  const fields = rowFields(table.schema, [], 'community')
  return render(
    <NeuronRow
      table={table}
      row={0}
      fields={fields}
      sourceId={undefined}
      datasetId={undefined}
      selected={false}
      onToggle={() => undefined}
      compact={false}
    />,
  )
}

describe('community tags on a row', () => {
  it('draws them apart from the chips, and unlike them', () => {
    const { container } = draw('putative giant fibre; DA?')
    const tags = [...container.querySelectorAll('.explore-tag')].map((t) => t.textContent)
    expect(tags).toEqual(['putative giant fibre', 'DA?'])

    // Not chips: no palette slot, so nothing claims they came from a known field.
    for (const el of container.querySelectorAll('.explore-tag')) {
      expect(el.getAttribute('data-slot')).toBeNull()
    }
    // And the chips are still the chips.
    expect(container.querySelector('.explore-chip')?.textContent).toBe('descending')
  })

  it('carries the whole of a tag in its title, since the row clips it', () => {
    // The truncation is CSS — `max-width` plus `text-overflow` — which jsdom performs none of,
    // so what is assertable here is the half that makes it recoverable.
    const long = 'this neuron was checked against the male CNS and looks like a match'
    draw(long)
    expect(screen.getByTitle(long).textContent).toBe(long)
  })

  it('caps the row and says how many it held back', () => {
    const { container } = draw('a; b; c; d; e; f; g')
    const tags = [...container.querySelectorAll('.explore-tag')].map((t) => t.textContent)
    // Four, then the admission — every row the same height is what makes a list scannable.
    expect(tags).toEqual(['a', 'b', 'c', 'd', '+3 more'])
    // Nothing is hidden without a way to see it.
    expect(screen.getByText('+3 more').getAttribute('title')).toBe('a\nb\nc\nd\ne\nf\ng')
  })

  it('draws no row at all for a neuron nobody tagged', () => {
    // An absence, not an empty chip — `join` writes null rather than an empty string for a
    // group with nothing in it, and this is the other end of that.
    expect(draw(null).container.querySelector('.explore-row__tags')).toBeNull()
    expect(draw('').container.querySelector('.explore-row__tags')).toBeNull()
  })

  it('draws what the cell says, even where that repeats', () => {
    /*
     * `join` folds a repeat away, so this cell cannot come from one — but an uploaded CSV or a
     * hand-built column can, and the row's job is to show what it was given rather than to
     * second-guess it. What is really pinned here is the React key: two children sharing one
     * would drop the second silently.
     */
    const { container } = draw('left; left')
    expect([...container.querySelectorAll('.explore-tag')].map((t) => t.textContent)).toEqual([
      'left',
      'left',
    ])
  })
})
