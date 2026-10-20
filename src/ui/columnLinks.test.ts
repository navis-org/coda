import { describe, expect, it } from 'vitest'

import { columnHref } from './columnLinks'

describe('columnHref', () => {
  it('keeps a DOI whole when it holds a # or a ?, which a URL would read as a fragment or a query', () => {
    const sici = '10.1002/(SICI)1096-9861(19970526)381:4<389::AID-CNE1>3.0.CO;2-#'
    const url = new URL(columnHref('doi', sici)!)
    expect(url.hash).toBe('')
    expect(decodeURIComponent(url.pathname)).toBe(`/${sici}`)
    expect(new URL(columnHref('doi', '10.1/a?b')!).search).toBe('')
  })

  it('links a VFB or FlyBase id, and nothing else, to VFB’s page', () => {
    expect(columnHref('vfb', 'FBbt_00100234')).toBe(
      'https://virtualflybrain.org/reports/FBbt_00100234',
    )
    expect(columnHref('vfb', 'RO_0002100')).toBeUndefined()
  })
})
