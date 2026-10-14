// @vitest-environment jsdom

/**
 * The VFB Info card, in jsdom, against VFBquery's recorded answer for MBON01: one page per distinct
 * id, asked for when it is shown, with the parts the hover leaves out drawn.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { VfbInfoViewer } from './VfbInfoViewer'

beforeAll(() => installJsdomStubs({ width: 1000, height: 700 }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const MBON01 = JSON.parse(
  readFileSync(
    join(__dirname, '../../data/vfb/__fixtures__/term_info-FBbt_00100234.json'),
    'utf8',
  ),
) as unknown

/** VFBquery answering MBON01 with the recording, and any other term with a bare page. */
function stubVfb() {
  const fetch = vi.fn(async (url: string) => {
    const id = new URL(url).searchParams.get('id')
    return Response.json(id === 'FBbt_00100234' ? MBON01 : { Id: id, Name: `name of ${id}` })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const terms = () =>
  tableFromRows(tableSchema(column('neuronId', 'str'), column('fbbtId', 'str')), [
    { neuronId: '1', fbbtId: 'FBbt_00100234' },
    { neuronId: '2', fbbtId: 'FBbt_00100234' },
    { neuronId: '3', fbbtId: 'FBbt_00047144' },
  ])

describe('VFB Info', () => {
  it('pages the distinct ids and draws what the hover leaves out', async () => {
    const fetch = stubVfb()
    const onPage = vi.fn()
    render(<VfbInfoViewer terms={terms()} column="fbbtId" page={0} onPage={onPage} />)
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(await screen.findByText('mushroom body output neuron 1')).toBeTruthy()
    // Each connectome's own name, a parent type as a link to VFB, and a paper's DOI.
    expect(screen.getByText('Names in connectomes')).toBeTruthy()
    expect(screen.getByText('male-cns')).toBeTruthy()
    const parent = screen.getByText('adult typical mushroom body output neuron').closest('a')!
    expect(parent.getAttribute('href')).toBe(
      'https://virtualflybrain.org/reports/FBbt_00049843',
    )
    expect(screen.getByText('10.1038/ncomms15230').closest('a')!.getAttribute('href')).toBe(
      'https://doi.org/10.1038/ncomms15230',
    )
    // A relation id VFB has no page for is plain text, its target a link.
    expect(screen.getByText('has soma location').closest('a')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Next term'))
    expect(onPage).toHaveBeenCalledWith(1)
  })

  it('asks for the term on the page it is turned to, and says when the column is missing', async () => {
    stubVfb()
    const { rerender } = render(
      <VfbInfoViewer terms={terms()} column="fbbtId" page={1} onPage={() => {}} />,
    )
    expect(await screen.findByText('name of FBbt_00047144')).toBeTruthy()
    rerender(<VfbInfoViewer terms={terms()} column={undefined} page={0} onPage={() => {}} />)
    expect(screen.getByText(/Pick the column/)).toBeTruthy()
  })
})
