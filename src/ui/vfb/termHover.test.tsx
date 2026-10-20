// @vitest-environment jsdom

/**
 * A VFB term in a table, through `ColumnLinkCell`: a link labelled with the id, and a hover that
 * asks VFB what the term is only once it opens.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { TableViewer } from '../viewers/TableViewer'

beforeAll(() => installJsdomStubs({ width: 1000, height: 700 }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('VFB term hover', () => {
  it('links a term id to its VFB page and, once rested on, shows what VFB says it is', async () => {
    const fetch = vi.fn(async (_url: string) =>
      Response.json({
        Id: 'FBbt_00100234',
        Name: 'MBON01',
        IsClass: true,
        Meta: {
          Name: '[mushroom body output neuron 1](FBbt_00100234)',
          Description: 'A [neuron](FBbt_00005106) of the mushroom body.',
        },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    render(<TableViewer table={termTable()} />)
    const link = screen.getByText('FBbt_00100234').closest('a')!
    expect(link.getAttribute('href')).toBe('https://virtualflybrain.org/reports/FBbt_00100234')
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.pointerEnter(link.parentElement!, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText('mushroom body output neuron 1')).toBeTruthy())
    expect(screen.getByText('A neuron of the mushroom body.')).toBeTruthy()
    expect(screen.getByText('MBON01 · FBbt_00100234')).toBeTruthy()
    expect(String(fetch.mock.calls[0]![0])).toContain('/get_term_info?id=FBbt_00100234')
  })
})

function termTable() {
  return tableFromRows({ columns: [{ name: 'fbbtId', dtype: 'str', link: 'vfb' }] }, [
    { fbbtId: 'FBbt_00100234' },
  ])
}
