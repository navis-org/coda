/**
 * The pack guides: the renderer's Markdown, and each guide held to the registry it describes — a
 * renamed node, a missing figure or a page nobody builds compiles fine and ships a broken document.
 */

import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import '../nodes'
import '../packs'
import { getNodeDef, registeredPacks } from '../core/registry'
import {
  GUIDED_PACKS,
  NODE_LINK,
  guideHTML,
  guideHeadHTML,
  packGuideHTML,
  packGuideHeadHTML,
} from './render'
import { GUIDE_SHOTS } from './shots'

const root = (path: string) => new URL(`../../${path}`, import.meta.url)

describe('the guide renderer', () => {
  const source = [
    '# A *title*',
    '',
    'The lead.',
    '',
    '## First part',
    '',
    'See [the model](#biophys:model), [open it](#!demo://biophys:fit) or [below](#second-part).',
    '',
    '> [!DETAIL]',
    '> For specialists.',
    '',
    '> [!DETAIL] Why `Ra`',
    '> Because.',
    '',
    '## Second part',
    '',
    '![A <caption>](shot.webp)',
  ].join('\n')

  it('puts the title and lead in the masthead and lists the sections', () => {
    expect(guideHeadHTML(source, 'x')).toBe(
      '<h1>A <em>title</em></h1>\n<div class="top__sub"><p>The lead.</p></div>',
    )
    const body = guideHTML(source, 'x')
    expect(body).toContain('<li><a href="#first-part">First part</a></li>')
    expect(body).toContain('<h2 id="second-part">Second part</h2>')
    expect(body).not.toContain('The lead.')
  })

  it('links a node to the node guide and a demo to the app', () => {
    const body = guideHTML(source, 'x')
    expect(body).toContain('href="./nodes.html#node-biophys-model"')
    expect(body).toContain('class="guide__open" href="./index.html#!demo://biophys:fit"')
    expect(body).toContain('<a href="#second-part">below</a>')
  })

  it('says "In depth" on every detail box, once, above any title it has', () => {
    const body = guideHTML(source, 'x')
    expect(body.match(/callout__kicker/g)).toHaveLength(2)
    expect(body).not.toContain('<p class="callout__title">In depth</p>')
    expect(body).toContain('<p class="callout__title">Why <code>Ra</code></p>')
  })

  it('escapes a caption and finds the figure under its guide’s folder, as a link to itself', () => {
    const html = guideHTML(source, 'x')
    expect(html).toContain('<img src="./guides/x/shot.webp" alt="A &lt;caption&gt;"')
    // Opened full-screen by the page's script, and by the plain link without one.
    expect(html).toContain('<a class="guide__zoom" href="./guides/x/shot.webp"')
  })
})

describe('every pack guide', () => {
  const guided = registeredPacks().filter((p) => p.guide)

  it('is one for every pack declaring one, and none for a pack that does not', () => {
    expect(guided.map((p) => p.id)).toContain('biophys')
    expect([...GUIDED_PACKS].sort()).toEqual(guided.map((p) => p.id).sort())
  })

  for (const pack of guided) {
    describe(pack.id, () => {
      const html = packGuideHTML(pack.id)

      it('is a page vite builds, with both slots naming its pack', () => {
        const page = readFileSync(root(pack.guide!.page), 'utf8')
        expect(page).toContain(`<!--@pack-guide-head:${pack.id}-->`)
        expect(page).toContain(`<!--@pack-guide:${pack.id}-->`)
        expect(packGuideHeadHTML(pack.id)).toMatch(/^<h1>/)
        expect(readFileSync(root('vite.config.ts'), 'utf8')).toContain(
          `'./${pack.guide!.page}'`,
        )
        expect(readFileSync(root('vite/seo.ts'), 'utf8')).toContain(`'${pack.guide!.page}'`)
      })

      it('links only to nodes that exist', () => {
        const source = readFileSync(root(`src/packs/${pack.id}/guide/guide.md`), 'utf8')
        // The renderer's own test of what a node link is, over every link target in the source.
        const targets = [...source.matchAll(/\]\((#[^)]*)\)/g)].map((m) => m[1]!)
        const types = targets.flatMap((t) => NODE_LINK.exec(t)?.[1] ?? [])
        const demos = [...source.matchAll(/\]\(#!demo:\/\/([^)/]+)/g)].map((m) => m[1]!)
        expect(types.length + demos.length).toBeGreaterThan(0)
        for (const type of [...types, ...demos]) expect(getNodeDef(type), type).toBeDefined()
      })

      it('links within itself only to its own headings', () => {
        const ids = new Set([...html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]))
        expect(ids.size).toBe([...html.matchAll(/<h\d id=/g)].length)
        for (const [, id] of html.matchAll(/href="#([^"!]+)"/g)) expect(ids, id).toContain(id)
      })

      it('has every figure it shows, each made by `pnpm guide:shots`', () => {
        const shown = [...html.matchAll(/<img src="\.\/([^"]+)"/g)].map((m) => m[1]!)
        for (const src of shown) expect(existsSync(root(`public/${src}`)), src).toBe(true)
        const table = GUIDE_SHOTS[pack.id] ?? {}
        expect(
          Object.keys(table)
            .map((f) => `guides/${pack.id}/${f}`)
            .sort(),
        ).toEqual([...shown].sort())
        for (const shot of Object.values(table)) {
          if (shot.demo) expect(getNodeDef(shot.demo), shot.demo).toBeDefined()
          // Exactly one picture: the canvas, a node expanded, or a dialog opened.
          const pictures = [
            shot.canvas === true,
            shot.expand !== undefined,
            shot.open !== undefined,
          ]
          expect(pictures.filter(Boolean), JSON.stringify(shot)).toHaveLength(1)
        }
      })

      it('inlines its drawn diagrams, so they take the page’s colours', () => {
        const source = readFileSync(root(`src/packs/${pack.id}/guide/guide.md`), 'utf8')
        const drawn = [...source.matchAll(/\]\(([\w-]+\.svg)\)/g)].length
        expect(html.match(/<figure class="guide__diagram"[^>]*><svg/g) ?? []).toHaveLength(
          drawn,
        )
        expect(html).not.toContain('<?xml')
      })

      it('leaves no Markdown unparsed', () => {
        expect(html).not.toMatch(/\[!\w+\]|^>|\]\(/m)
      })
    })
  }
})
