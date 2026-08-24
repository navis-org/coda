/**
 * The help documents, checked against the registry they describe.
 *
 * A document is prose in a file, which is the whole point — anybody can add one without touching
 * code — and also the whole risk: nothing about a file failing to name a real node, or drawing a
 * figure with a port that no longer exists, would show up as an error. It would show up as a
 * `?` button opening a page with a complaint in the middle of it, months later, in front of
 * somebody who came to learn what the node does.
 *
 * So everything a document asserts about the registry is asserted here instead. What is *not*
 * checked is the prose, which is the half a test has nothing to say about.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { getNodeDef } from '../core/registry'
import type { MarkdownBlock } from '../ui/markdown'
import { parseMarkdown } from '../ui/markdown'
import { FIGURE_FIT_WIDTH, buildFigure, isFigureLang, parseFigureSource } from './figures'
import { helpImageUrl, helpTypes, loadHelpDoc } from './registry'

/** Every block in a document, callouts flattened, so a figure inside one is still checked. */
function allBlocks(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  return blocks.flatMap((block) =>
    block.kind === 'callout' ? [block, ...allBlocks(block.blocks)] : [block],
  )
}

function fragmentLinks(blocks: readonly MarkdownBlock[]): string[] {
  const out: string[] = []
  const walkInline = (nodes: readonly { kind: string }[]): void => {
    for (const node of nodes) {
      const any = node as { kind: string; href?: string; children?: { kind: string }[] }
      if (any.kind === 'link' && any.href?.startsWith('#')) out.push(any.href.slice(1))
      if (any.children) walkInline(any.children)
    }
  }
  for (const block of allBlocks(blocks)) {
    if (block.kind === 'paragraph' || block.kind === 'heading') walkInline(block.children)
    else if (block.kind === 'list') {
      const walkList = (list: typeof block): void => {
        for (const item of list.items) {
          walkInline(item.children)
          if (item.list) walkList(item.list)
        }
      }
      walkList(block)
    } else if (block.kind === 'table') {
      for (const cells of [block.head, ...block.rows])
        for (const cell of cells) walkInline(cell)
    }
  }
  return out
}

const TYPES = helpTypes()

describe('the documents in src/help/nodes', () => {
  it('has at least one, or nothing below is testing anything', () => {
    expect(TYPES.length).toBeGreaterThan(0)
  })

  it.each(TYPES)('%s names a registered node type', (type) => {
    expect(getNodeDef(type), `src/help/nodes/${type}.md names no registered node`).toBeDefined()
  })

  it.each(TYPES)('%s: every figure builds with no problems', async (type) => {
    const doc = await loadHelpDoc(type)
    expect(doc).toBeDefined()
    for (const block of allBlocks(doc!.blocks)) {
      if (block.kind !== 'fence' || !isFigureLang(block.lang)) continue
      const figure = buildFigure(block.lang, block.text, { focusType: type })
      expect(figure.problems, `${type}: ${block.lang}`).toEqual([])
    }
  })

  /*
   * Two things a figure can get wrong that nothing else would notice.
   *
   * **Overlapping cards** would be a layout bug rather than a document one, and jsdom performs
   * no layout — so if it is not asserted against the model it is asserted nowhere at all.
   * **Too wide** is a document bug: the figure still renders and scrolls inside its own box,
   * which reads as a figure with cards missing off the right-hand edge.
   */
  it.each(TYPES)('%s: every figure fits, and no two cards overlap', async (type) => {
    const doc = await loadHelpDoc(type)
    for (const block of allBlocks(doc!.blocks)) {
      if (block.kind !== 'fence' || !isFigureLang(block.lang)) continue
      const figure = buildFigure(block.lang, block.text, { focusType: type })
      if (figure.kind !== 'graph') continue
      for (const a of figure.cards) {
        for (const b of figure.cards) {
          if (a === b) continue
          const overlap =
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height
          expect(overlap, `${type}: ${a.alias} overlaps ${b.alias}`).toBe(false)
        }
      }
      expect(
        figure.width,
        `${type}: this figure scrolls sideways in the overlay — use fewer stages`,
      ).toBeLessThanOrEqual(FIGURE_FIT_WIDTH)
    }
  })

  it.each(TYPES)('%s: every cross-reference points at a documented node', async (type) => {
    const doc = await loadHelpDoc(type)
    for (const target of fragmentLinks(doc!.blocks)) {
      expect(TYPES, `${type} links to #${target}`).toContain(target)
    }
  })

  it.each(TYPES)('%s: every image is a file in src/help/images', async (type) => {
    const doc = await loadHelpDoc(type)
    for (const block of allBlocks(doc!.blocks)) {
      if (block.kind !== 'image') continue
      expect(helpImageUrl(block.src), `${type} shows ${block.src}`).toBeDefined()
    }
  })

  /*
   * A documented node's `guide` is printed above the document under a `TL;DR` label, so it has
   * an upper bound that an undocumented node's does not: 400 characters is three sentences with
   * room, and a nine-sentence paragraph labelled TL;DR is a lie about itself. `nodeGuide.test.ts`
   * holds the floor (120) for every node; this holds the ceiling for the handful that get read
   * twice. NBLAST's was 830 characters before its document existed.
   */
  it.each(TYPES)('%s: its guide is short enough to be the TL;DR the overlay calls it', (type) => {
    const guide = getNodeDef(type)?.guide ?? ''
    expect(guide.length, `${type}'s guide is ${guide.length} characters`).toBeLessThanOrEqual(400)
  })

  /*
   * The overlay draws the node's name in its own header, so a document opening with one would
   * say it twice — which is what makes the top level of a document `##` rather than a style
   * preference. Asserted rather than written down, because a convention nothing checks is one
   * the tenth document breaks.
   */
  it.each(TYPES)(
    '%s: has no level-1 heading, since the overlay draws the title',
    async (type) => {
      const doc = await loadHelpDoc(type)
      const tops = allBlocks(doc!.blocks).filter((b) => b.kind === 'heading' && b.level === 1)
      expect(tops).toEqual([])
    },
  )
})

describe('the figure source', () => {
  it('takes an alias, a title and settings, and defaults the alias to the type', () => {
    const src = parseFigureSource(
      ['neuron.nblast as nb "Shape scores" { symmetry: min }', 'out.heatmap'].join('\n'),
    )
    expect(src.nodes).toEqual([
      {
        alias: 'nb',
        type: 'neuron.nblast',
        title: 'Shape scores',
        params: { symmetry: 'min' },
      },
      { alias: 'out.heatmap', type: 'out.heatmap', params: {} },
    ])
  })

  it('reads a wire with and without ports, and ignores comments', () => {
    const src = parseFigureSource(['# a comment', 'a -> b', 'a:scores -> c:in'].join('\n'))
    expect(src.wires).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', fromPort: 'scores', to: 'c', toPort: 'in' },
    ])
  })

  it('reports a line that is neither, rather than dropping it', () => {
    expect(parseFigureSource('nblast heatmap').problems).toHaveLength(1)
  })
})

describe('building a figure', () => {
  const NBLAST_CHAIN = [
    'neuron.skeletons as s',
    'neuron.nblast as nb',
    'out.heatmap as hm',
    's -> nb',
    'nb -> hm',
  ].join('\n')

  it('reads sockets and settings off the definition', () => {
    const figure = buildFigure('coda-node', 'neuron.nblast')
    expect(figure.kind).toBe('graph')
    if (figure.kind !== 'graph') return
    const card = figure.cards[0]!
    expect(card.label).toBe('NBLAST')
    expect(card.inputs.map((p) => p.id)).toEqual(['query', 'target'])
    // `target` is `required: false`, and the figure has to be able to say so.
    expect(card.inputs.map((p) => p.required)).toEqual([true, false])
    expect(card.outputs[0]!.family).toBe('matrix')
  })

  it('picks the first input the source type actually fits', () => {
    // Skeletons' first input is a Dataset and its second is Neurons, so an unqualified wire
    // from Find Neurons has to skip the first — the case that made this rule worth having.
    const figure = buildFigure(
      'coda-graph',
      ['neuron.findNeurons as f', 'neuron.skeletons as s', 'f -> s'].join('\n'),
    )
    expect(figure.problems).toEqual([])
    if (figure.kind !== 'graph') return
    expect(figure.wires[0]!.toPort).toBe('neurons')
  })

  it('lays cards out left to right by depth, and gives every wire a path', () => {
    const figure = buildFigure('coda-graph', NBLAST_CHAIN)
    expect(figure.problems).toEqual([])
    if (figure.kind !== 'graph') return
    const x = figure.cards.map((c) => c.x)
    expect(x[0]).toBeLessThan(x[1]!)
    expect(x[1]).toBeLessThan(x[2]!)
    expect(figure.cards.every((c) => c.y >= 0)).toBe(true)
    expect(figure.wires.every((w) => w.path.startsWith('M '))).toBe(true)
  })

  it('is deterministic, so a figure is the same on every render', () => {
    expect(buildFigure('coda-graph', NBLAST_CHAIN)).toEqual(
      buildFigure('coda-graph', NBLAST_CHAIN),
    )
  })

  it('shows only the settings a graph figure names, and counts the rest', () => {
    const figure = buildFigure('coda-graph', 'neuron.nblast { symmetry: min }')
    if (figure.kind !== 'graph') return
    const card = figure.cards[0]!
    expect(card.params.map((p) => p.id)).toEqual(['symmetry'])
    // The option's *label*, not the stored value — what the picker on the card would say.
    expect(card.params[0]!.value).toBe('weaker direction')
    expect(card.params[0]!.called).toBe(true)
    expect(card.more).toBe(6)
  })

  it('shows a node figure the band the real card draws — advanced settings excluded', () => {
    const figure = buildFigure('coda-node', 'neuron.nblast')
    if (figure.kind !== 'graph') return
    expect(figure.cards[0]!.params.map((p) => p.id)).toEqual([
      'resample',
      'symmetry',
      'labelColumn',
    ])
  })

  it('complains rather than throwing, for every way a figure can be wrong', () => {
    expect(buildFigure('coda-graph', 'neuron.nosuchnode').problems).toEqual([
      'No node type "neuron.nosuchnode"',
    ])
    expect(
      buildFigure('coda-graph', ['neuron.nblast as nb', 'nb -> missing'].join('\n')).problems,
    ).toHaveLength(1)
    expect(buildFigure('coda-graph', 'neuron.nblast { nosuch: 1 }').problems).toEqual([
      '"neuron.nblast" has no setting "nosuch"',
    ])
    // A Matrix does not fit a Skeletons socket, and the figure says so rather than drawing a
    // wire that would be a lie about what the app allows.
    const bad = buildFigure(
      'coda-graph',
      ['neuron.nblast as nb', 'neuron.skeletons as s', 'nb -> s:neurons'].join('\n'),
    )
    expect(bad.problems).toHaveLength(1)
  })

  it('builds a settings figure carrying the app’s own help text', () => {
    const figure = buildFigure('coda-params', 'neuron.nblast: symmetry')
    expect(figure.kind).toBe('params')
    if (figure.kind !== 'params') return
    expect(figure.rows).toHaveLength(1)
    expect(figure.rows[0]!.label).toBe('Symmetry')
    expect(figure.rows[0]!.help).toContain('lie entirely inside')
  })
})

describe('the extended markdown, which only a help document gets', () => {
  it('parses a fence, keeping its body verbatim', () => {
    const blocks = parseMarkdown('```coda-graph\na -> b\n```', { extended: true })
    expect(blocks).toEqual([{ kind: 'fence', lang: 'coda-graph', text: 'a -> b' }])
  })

  it('parses a callout, recursively, with a default title from its tone', () => {
    const blocks = parseMarkdown('> [!WARNING]\n> Careful.\n> - and this', { extended: true })
    expect(blocks[0]).toMatchObject({ kind: 'callout', tone: 'warning', title: 'Warning' })
    if (blocks[0]?.kind !== 'callout') return
    expect(blocks[0].blocks.map((b) => b.kind)).toEqual(['paragraph', 'list'])
  })

  it('pads a short table row rather than leaving a hole in the table', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | ---: |\n| 1 |', { extended: true })
    expect(blocks[0]).toMatchObject({ kind: 'table', align: ['left', 'right'] })
    if (blocks[0]?.kind !== 'table') return
    expect(blocks[0].rows[0]).toHaveLength(2)
  })

  it('parses an image alone on a line, carrying its src unresolved', () => {
    const blocks = parseMarkdown('![A heatmap](x.png)', { extended: true })
    expect(blocks[0]).toEqual({ kind: 'image', src: 'x.png', alt: 'A heatmap' })
  })

  /*
   * The load-bearing one. A dataset blurb arrives from whatever deployment a Custom node is
   * pointed at, and every extended kind hands that source something it should not have — a
   * directive some renderer may act on, or an outbound request to a host of its choosing.
   */
  it('produces none of them without the flag, whatever a blurb contains', () => {
    const hostile =
      '```coda-graph\na -> b\n```\n\n![](https://tracker.example/p.gif)\n\n| a |\n| - |'
    const kinds = new Set(parseMarkdown(hostile).map((b) => b.kind))
    expect([...kinds].every((k) => k === 'paragraph' || k === 'list')).toBe(true)
  })
})
