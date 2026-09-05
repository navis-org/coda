/**
 * Where a message's links are, and which of its characters belong to them.
 *
 * The trailing full stop is the whole reason this is a function rather than a regex at the call
 * site: `authRefusal` writes "…/tos/3/accept. Your token is fine", and a greedy match hands the
 * reader a link to `/accept.` — a 404 on the one page that would have fixed their problem, which
 * looks exactly like Coda naming the wrong URL.
 */

import { describe, expect, it } from 'vitest'

import { splitLinks } from './linkify'

const hrefs = (message: string) =>
  splitLinks(message)
    .filter((s) => s.href)
    .map((s) => s.href)

describe('splitting links out of a message', () => {
  it('keeps a URL out of the sentence that ends after it', () => {
    expect(
      hrefs(
        'accept them at https://global.daf-apis.com/sticky_auth/api/v1/tos/3/accept. Your token is fine.',
      ),
    ).toEqual(['https://global.daf-apis.com/sticky_auth/api/v1/tos/3/accept'])
  })

  it('renders the link with its href as the text, which is the safety property', () => {
    // These sentences are not always ours — a URL can come out of a remote deployment's error
    // body — and a label that differs from its href is the only thing an anchor can lie about.
    const [, link] = splitLinks('go to https://example.org/x now')
    expect(link).toEqual({ text: 'https://example.org/x', href: 'https://example.org/x' })
  })

  it('leaves every other scheme as text', () => {
    // A server cannot get a scheme of its choosing into an `href` by writing one into a message.
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])
      expect(hrefs(`try ${bad} instead`)).toEqual([])
  })

  it('drops a bracket nothing opened and keeps one something did', () => {
    expect(hrefs('see (https://example.org/a) for more')).toEqual(['https://example.org/a'])
    expect(hrefs('see https://example.org/a_(b) for more')).toEqual([
      'https://example.org/a_(b)',
    ])
  })

  it('finds several, in order, with the text between them kept', () => {
    expect(splitLinks('a https://x.test b https://y.test c').map((s) => s.text)).toEqual([
      'a ',
      'https://x.test',
      ' b ',
      'https://y.test',
      ' c',
    ])
  })

  it('answers one span for a message with no link at all, and for an empty one', () => {
    expect(splitLinks('nothing here')).toEqual([{ text: 'nothing here' }])
    expect(splitLinks('')).toEqual([{ text: '' }])
  })

  it('does not linkify a bare scheme', () => {
    expect(hrefs('https:// is a scheme')).toEqual([])
  })
})
