// @vitest-environment jsdom

/**
 * The filterable list behind `StringParam.suggestions`, and the chip list behind
 * `StringParam.chips`. What the CAVE nodes feed them is tested beside those nodes, in
 * `nodes/dataset/caveTables.test.ts`.
 *
 * Two things the `datalist` it replaced got wrong are pinned here: a field holding a chosen name
 * has to open onto *every* option rather than only that name, and a name nobody listed is still a
 * value the field commits.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { NodeDefinition, StringParam } from '../../core/node'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { registerNode } from '../../core/registry'
import { ComboField, filterOptions } from './ComboField'
import { ParamField } from './ParamField'

beforeAll(() => {
  installJsdomStubs()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TABLES = ['nuclei_v1', 'neuron_information_v2', 'proofread_neurons', 'synapses_nt_v1']

function draw(value: string, options: readonly string[] = TABLES) {
  const onChange = vi.fn()
  render(<ComboField label="Table" value={value} options={options} onChange={onChange} />)
  const input = screen.getByLabelText<HTMLInputElement>('Table')
  return { input, onChange }
}

const shown = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('filterOptions', () => {
  it('matches every term, anywhere, ignoring case', () => {
    expect(filterOptions(TABLES, 'NEURON')).toEqual([
      'neuron_information_v2',
      'proofread_neurons',
    ])
    expect(filterOptions(TABLES, 'v2 info')).toEqual(['neuron_information_v2'])
    expect(filterOptions(TABLES, '  ')).toEqual(TABLES)
  })
})

describe('ComboField', () => {
  it('opens onto every option even while it holds a chosen one', () => {
    const { input } = draw('nuclei_v1')
    act(() => {
      fireEvent.focus(input)
    })
    expect(shown()).toEqual(TABLES)
  })

  it('filters as somebody types, and picks with the keyboard', () => {
    const { input, onChange } = draw('')
    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'v1' } })
    })
    expect(shown()).toEqual(['nuclei_v1', 'synapses_nt_v1'])
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onChange).toHaveBeenLastCalledWith('synapses_nt_v1')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picks on a click', () => {
    const { input, onChange } = draw('')
    act(() => {
      fireEvent.focus(input)
    })
    act(() => {
      fireEvent.click(screen.getByRole('option', { name: 'proofread_neurons' }))
    })
    expect(onChange).toHaveBeenLastCalledWith('proofread_neurons')
  })

  it('keeps a name nobody listed', () => {
    const { input, onChange } = draw('')
    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'my_lab_table' } })
    })
    expect(shown()).toEqual([])
    act(() => {
      fireEvent.blur(input)
    })
    expect(onChange).toHaveBeenLastCalledWith('my_lab_table')
  })

  it('closes on the first Escape and reverts on the second', () => {
    const { input } = draw('nuclei_v1')
    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'syn' } })
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.value).toBe('syn')
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(input.value).toBe('nuclei_v1')
  })

  /*
   * The viewer's Escape listens on the window's capture phase, ahead of this input, so only the
   * `data-owns-escape` claim keeps it from closing the viewer over an open list or a draft.
   */
  it('claims Escape only while it has a list to close or an edit to revert', () => {
    const { input } = draw('nuclei_v1')
    expect(input.hasAttribute('data-owns-escape')).toBe(false)
    act(() => {
      fireEvent.focus(input)
    })
    expect(input.hasAttribute('data-owns-escape')).toBe(true)
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(input.hasAttribute('data-owns-escape')).toBe(false)
  })

  it('opens nothing while there is nothing to list', () => {
    const { input } = draw('', [])
    act(() => {
      fireEvent.focus(input)
    })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('a chip list (StringParam.chips)', () => {
  const PARAM: StringParam = {
    id: 'columns',
    kind: 'string',
    label: 'Columns',
    default: '',
    chips: true,
    suggestions: () => TABLES,
  }
  const DEF: NodeDefinition = {
    type: 'test.chips',
    label: 'Test',
    category: 'transform',
    description: 'fixture',
    cost: 'cheap',
    inputs: [],
    outputs: [],
    params: [PARAM],
    evaluate: () => ({}),
  }

  function drawList(value: string) {
    const onChange = vi.fn()
    const ctx = makeInferContext(DEF, { ...defaultParams(DEF), columns: value }, {})
    render(<ParamField param={PARAM} value={value} ctx={ctx} onChange={onChange} />)
    return { adder: screen.getByLabelText<HTMLInputElement>('Add to Columns'), onChange }
  }

  it('draws each entry of the stored string as a chip', () => {
    drawList('nuclei_v1, proofread_neurons')
    expect(screen.getByTitle('Remove nuclei_v1')).toBeTruthy()
    expect(screen.getByTitle('Remove proofread_neurons')).toBeTruthy()
  })

  it('stores a pick as the same comma-separated string, and offers only what is not chosen', () => {
    const { adder, onChange } = drawList('nuclei_v1')
    act(() => {
      fireEvent.focus(adder)
    })
    expect(shown()).not.toContain('nuclei_v1')
    act(() => {
      fireEvent.click(screen.getByRole('option', { name: 'synapses_nt_v1' }))
    })
    expect(onChange).toHaveBeenLastCalledWith('nuclei_v1, synapses_nt_v1')
    // Ready for the next one: the adder clears rather than holding the name it just added.
    expect(adder.value).toBe('')
  })

  it('adds a name nobody offered on Enter, and nothing while it is being typed', () => {
    const { adder, onChange } = drawList('')
    act(() => {
      fireEvent.focus(adder)
      fireEvent.change(adder, { target: { value: 'my_col' } })
    })
    expect(onChange).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(adder, { key: 'Enter' })
    })
    expect(onChange).toHaveBeenLastCalledWith('my_col')
  })

  it('is refused beside multiline, which draws no chips', () => {
    expect(() =>
      registerNode({
        ...DEF,
        type: 'test.chipsMultiline',
        params: [{ ...PARAM, multiline: true }],
      }),
    ).toThrow(/multiline.*chips/)
  })

  it('removes a chip', () => {
    const { onChange } = drawList('nuclei_v1, proofread_neurons')
    act(() => {
      fireEvent.click(screen.getByTitle('Remove nuclei_v1'))
    })
    expect(onChange).toHaveBeenLastCalledWith('proofread_neurons')
  })
})
