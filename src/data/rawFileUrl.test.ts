/**
 * GitHub file links, rewritten to something a browser can read.
 *
 * The two forms are what people actually have in their clipboard — the address bar of a file
 * page, and the `Raw` button next to it — and both fail in a way that is *not* an error message:
 * the page answers 200 with HTML, and the raw button's redirect fails CORS at the hop before the
 * one that would have worked. So the cases here are the two spellings, plus the boundary the
 * rewrite must not cross.
 */

import { describe, expect, it } from 'vitest'

import { rawFileUrl } from './rawFileUrl'

const RAW = 'https://raw.githubusercontent.com/flyconnectome/flywire_annotations'
const FILE = 'supplemental_files/Supplemental_file1_neuron_annotations.tsv'

describe('rawFileUrl', () => {
  it('rewrites the address bar of a file page', () => {
    expect(
      rawFileUrl(`https://github.com/flyconnectome/flywire_annotations/blob/main/${FILE}`),
    ).toBe(`${RAW}/main/${FILE}`)
  })

  it('rewrites the Raw link, refs and all', () => {
    // `refs/heads/main` is what GitHub's own Raw button produces today, and raw.githubusercontent
    // serves it — so the ref is passed through whole rather than parsed. A branch name may hold
    // slashes, which makes any rule about where the ref ends wrong somewhere.
    expect(
      rawFileUrl(
        `https://github.com/flyconnectome/flywire_annotations/raw/refs/heads/main/${FILE}`,
      ),
    ).toBe(`${RAW}/refs/heads/main/${FILE}`)
  })

  it('drops the file view state a raw host has no use for', () => {
    // `?plain=1`, `?raw=true` and `#L4-L20` are the page's own controls. A fragment is never
    // sent by a fetch anyway; the query would just be noise on the request.
    expect(rawFileUrl('https://github.com/o/r/blob/main/a.csv?plain=1#L4-L20')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a.csv',
    )
    expect(rawFileUrl('https://www.github.com/o/r/blob/main/a.csv?raw=true')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a.csv',
    )
  })

  it('leaves everything else exactly as it was', () => {
    // Narrow on purpose, `precomputedToHttp`'s rule. Anything this does not recognise is the
    // node's `validate` to judge, not this function's — a rewriter with a second opinion about
    // an unusable address is a second, differently-worded error message.
    const untouched = [
      `${RAW}/main/${FILE}`, // already raw: serves Access-Control-Allow-Origin: *
      'https://example.org/annotations.csv',
      'https://github.com/flyconnectome/flywire_annotations', // a repo, not a file
      'https://github.com/flyconnectome/flywire_annotations/tree/main/supplemental_files',
      'https://github.com/o/r/blob/main', // no path under the ref
      'https://gist.github.com/someone/deadbeef', // a different host and a different grammar
      'https://github.enterprise.example/o/r/blob/main/a.csv',
      'not a url at all',
      '',
    ]
    for (const url of untouched) expect(rawFileUrl(url)).toBe(url)
  })

  it('trims, because a pasted link brings whitespace with it', () => {
    expect(rawFileUrl('  https://github.com/o/r/blob/main/a.csv \n')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a.csv',
    )
  })
})
