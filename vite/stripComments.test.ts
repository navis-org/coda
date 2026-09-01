/**
 * The four cases that make `stripHtmlComments` more than a one-line regex.
 *
 * Each is silent when wrong — the output still parses, and three of the four still look right on
 * the pages this repo actually has. See the module header for what each guards.
 */
import { describe, expect, it } from 'vitest'
import { stripHtmlComments } from './stripComments'

describe('stripHtmlComments', () => {
  it('removes a comment and the blank line it sat on', () => {
    const html = '<head>\n  <!--\n    a note\n  -->\n  <title>x</title>\n</head>\n'
    expect(stripHtmlComments(html)).toBe('<head>\n\n  <title>x</title>\n</head>\n')
  })

  it('leaves a `<!--` inside a script alone — in there it is characters, not a comment', () => {
    // The failure this prevents is a cut to the next `-->`, which takes `b = 2` with it.
    const html = '<script>\nconst a = 1 /* <!-- */\nconst b = 2 // -->\n</script>\n'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('leaves a `<!--` inside a style alone', () => {
    const html = '<style>\n/* <!-- */\n.a { color: red }\n/* --> */\n</style>\n'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('removes a comment that encloses a script, script and all', () => {
    // The enclosing comment starts first, so it wins the alternation.
    const html = '<body>\n<!-- <script>alert(1)</script> -->\n<div></div>\n</body>\n'
    expect(stripHtmlComments(html)).toBe('<body>\n\n<div></div>\n</body>\n')
  })

  it('does not eat the document when a script is left unclosed', () => {
    // The element arm fails, so the comment arm decides — a lost comment, never lost markup.
    const html = '<script>\nconst a = 1\n<!-- note -->\n<p>kept</p>\n'
    expect(stripHtmlComments(html)).toContain('<p>kept</p>')
    expect(stripHtmlComments(html)).toContain('const a = 1')
  })

  it('is idempotent, and keeps no state between calls', () => {
    // The module-level regexes carry the `g` flag; `replace` resets `lastIndex`, and this is what
    // says so for the next reader who moves one to `.test()`.
    const html = '<p>a</p>\n<!-- one -->\n<p>b</p>\n<!-- two -->\n'
    const once = stripHtmlComments(html)
    expect(stripHtmlComments(once)).toBe(once)
    expect(stripHtmlComments(html)).toBe(once)
  })

  it('leaves a document with no comments byte-identical', () => {
    const html = '<head>\n  <title>x</title>\n</head>\n\n<body>\n  <p>y</p>\n</body>\n'
    expect(stripHtmlComments(html)).toBe(html)
  })
})
