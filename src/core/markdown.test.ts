/**
 * The markdown subset.
 *
 * Two things are being defended here. The first is that the blurbs neuPrint actually publishes
 * render as prose — those are the whole reason this module exists, so the hemibrain and MANC
 * fixtures are parsed as-is rather than a tidied paraphrase of them. The second is that nothing
 * a server sends can become markup or a live `javascript:` target: this parser is the only
 * gatekeeper on that path, because `MarkdownView` renders whatever it returns.
 */

import { describe, expect, it } from 'vitest'

import datasets from '../data/neuprint/__fixtures__/datasets.json'
import type { MarkdownBlock, MarkdownInline, MarkdownList } from './markdown'
import { parseMarkdown, safeHref } from './markdown'

/** Every link in a tree, in document order. */
function links(blocks: MarkdownBlock[]): { text: string; href: string }[] {
  const found: { text: string; href: string }[] = []
  const walkInline = (nodes: MarkdownInline[]) => {
    for (const node of nodes) {
      if (node.kind === 'link') found.push({ text: plain(node.children), href: node.href })
      else if (node.kind === 'strong' || node.kind === 'em') walkInline(node.children)
    }
  }
  const walkList = (list: MarkdownList) => {
    for (const item of list.items) {
      walkInline(item.children)
      if (item.list) walkList(item.list)
    }
  }
  for (const block of blocks) {
    if (block.kind === 'list') walkList(block)
    else if (block.kind === 'callout') found.push(...links(block.blocks))
    else if (block.kind === 'table') {
      for (const cells of [block.head, ...block.rows])
        for (const cell of cells) walkInline(cell)
    } else if (block.kind !== 'fence' && block.kind !== 'image') walkInline(block.children)
  }
  return found
}

function plain(nodes: MarkdownInline[]): string {
  return nodes
    .map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : plain(n.children)))
    .join('')
}

describe('blocks', () => {
  it('joins a wrapped paragraph and splits on the blank line', () => {
    const blocks = parseMarkdown('one line\nand its continuation\n\na second paragraph')
    expect(blocks).toHaveLength(2)
    expect(plain((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      'one line and its continuation',
    )
    expect(plain((blocks[1] as { children: MarkdownInline[] }).children)).toBe(
      'a second paragraph',
    )
  })

  it('nests a list by indent, not by marker', () => {
    const blocks = parseMarkdown('- one\n- two:\n    - inner a\n    - inner b\n- three')
    const list = blocks[0] as MarkdownList
    expect(list.kind).toBe('list')
    expect(list.items.map((i) => plain(i.children))).toEqual(['one', 'two:', 'three'])
    expect(list.items[1]!.list?.items.map((i) => plain(i.children))).toEqual([
      'inner a',
      'inner b',
    ])
    // The bullet after the nested pair closes it and returns to the outer list.
    expect(list.items[2]!.list).toBeUndefined()
  })

  it('keeps numbered and bulleted lists apart at one level', () => {
    const blocks = parseMarkdown('- a\n1. b')
    expect(blocks.map((b) => (b as MarkdownList).ordered)).toEqual([false, true])
  })

  it('continues a bullet from an indented line that carries no marker', () => {
    const list = parseMarkdown('- Takemura et al.\n  (2024)') as MarkdownList[]
    expect(list[0]!.items).toHaveLength(1)
    expect(plain(list[0]!.items[0]!.children)).toBe('Takemura et al. (2024)')
  })

  it('clamps heading depth, since a card has three useful sizes', () => {
    const blocks = parseMarkdown('# one\n\n###### six')
    expect(blocks.map((b) => (b as { level: number }).level)).toEqual([1, 3])
  })
})

describe('inlines', () => {
  it('reads a link whose target contains balanced parentheses', () => {
    // Truncating at the first `)` would produce a link that silently 404s.
    const found = links(parseMarkdown('see [the page](https://x.org/a_(b)_c) for more'))
    expect(found).toEqual([{ text: 'the page', href: 'https://x.org/a_(b)_c' }])
  })

  it('keeps a fragment-heavy neuroglancer URL intact', () => {
    const found = links(
      parseMarkdown(
        '[Scene](https://neuroglancer-demo.appspot.com/#!gs://flyem-views/base.json)',
      ),
    )
    expect(found[0]!.href).toBe(
      'https://neuroglancer-demo.appspot.com/#!gs://flyem-views/base.json',
    )
  })

  it('leaves an underscore inside a word alone', () => {
    const blocks = parseMarkdown('male_cns_v1 is one token')
    expect(plain((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      'male_cns_v1 is one token',
    )
    expect(
      (blocks[0] as { children: MarkdownInline[] }).children.some((n) => n.kind === 'em'),
    ).toBe(false)
  })

  it('treats an unclosed delimiter as the character it is', () => {
    const blocks = parseMarkdown('2 * 3 * 4 and a stray ` and [half](')
    expect(plain((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      '2 * 3 * 4 and a stray ` and [half](',
    )
  })
})

describe('what a hostile blurb cannot do', () => {
  it('refuses a script target and keeps the words as text', () => {
    const blocks = parseMarkdown('[click me](javascript:alert(1))')
    expect(links(blocks)).toEqual([])
    // Refused, not dropped: the label is still information, and losing it would hide that a
    // link had ever been written.
    expect(plain((blocks[0] as { children: MarkdownInline[] }).children)).toBe('click me')
  })

  it('refuses a scheme hidden behind control characters', () => {
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined()
    expect(safeHref('//evil.example')).toBeUndefined()
  })

  it('allows the schemes a citation actually uses', () => {
    expect(safeHref('https://doi.org/10.7554/eLife.57443')).toBe(
      'https://doi.org/10.7554/eLife.57443',
    )
    expect(safeHref('mailto:flyem@janelia.hhmi.org')).toBe('mailto:flyem@janelia.hhmi.org')
  })

  it('carries raw HTML through as text, so it can never become markup', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>')
    expect(plain((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      '<img src=x onerror=alert(1)>',
    )
  })
})

describe('the blurbs neuPrint actually publishes', () => {
  it('renders hemibrain as prose, a companion list and a citation', () => {
    const blocks = parseMarkdown(datasets['hemibrain:v1.2.1'].description)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list'])

    const list = blocks[1] as MarkdownList
    // "Companion sites:" carries the nested pair; the citation is a sibling of it.
    expect(list.items).toHaveLength(3)
    expect(list.items[1]!.list?.items).toHaveLength(2)

    expect(links(blocks).map((l) => l.href)).toEqual([
      'https://www.janelia.org/project-team/flyem/hemibrain',
      'https://neuroglancer-demo.appspot.com/#!gs://flyem-views/hemibrain/v1.2/base.json',
      'https://clio.janelia.org',
      'https://doi.org/10.7554/eLife.57443',
    ])
  })

  it('keeps all three MANC citations, which is the point of the card', () => {
    const blocks = parseMarkdown(datasets['manc:v1.2.3'].description)
    const citations = links(blocks).filter((l) => l.href.startsWith('https://doi.org/'))
    expect(citations.map((c) => c.text)).toEqual([
      'Takemura et al. (2024)',
      'Marin et al. (2024)',
      'Cheong et al. (2025)',
    ])
  })

  it('handles a dataset whose whole blurb is a sentence and one citation', () => {
    const blocks = parseMarkdown(datasets['mushroombody'].description)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list'])
    expect(links(blocks)).toEqual([
      { text: 'Takemura et al. (2017)', href: 'https://doi.org/10.7554/eLife.26975' },
    ])
  })
})
