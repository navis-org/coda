import { describe, expect, it } from 'vitest'

import { bodyExcerpt } from './errorBody'

describe('bodyExcerpt', () => {
  it('reads an HTML error page down to its title', () => {
    const page =
      '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n' +
      '<body><center><h1>503 Service Temporarily Unavailable</h1></center></body></html>'
    expect(bodyExcerpt(page)).toBe('503 Service Temporarily Unavailable')
    expect(bodyExcerpt(`<!DOCTYPE html>${page}`)).toBe('503 Service Temporarily Unavailable')
  })

  it('leaves a body that is not a document alone, however much markup it holds', () => {
    // A title inside prose is not a page's title, and a tag stripper would do worse.
    expect(bodyExcerpt('bad request: <title>x</title>')).toBe('bad request: <title>x</title>')
    expect(bodyExcerpt('x'.repeat(400))).toHaveLength(300)
  })

  it('falls back to the body where a page has no usable title, and says when there is nothing', () => {
    expect(bodyExcerpt('<html><head><title> </title></head></html>')).toBe(
      '<html><head><title> </title></head></html>',
    )
    expect(bodyExcerpt('')).toBe('(empty response)')
  })
})
