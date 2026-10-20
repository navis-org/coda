/**
 * A pack's guide, rendered at build time: the pack's `guide/guide.md`, parsed by the help's own
 * Markdown parser (`core/markdown.ts`, extended — the file is in this repository) and written out as
 * HTML that `vite/renderedPages.ts` splices into the guide's page. No client renderer: the page has
 * no state, and the point of a static page is that a crawler reads the document (`docs/seo.md`).
 *
 * What the guide's Markdown means here, beyond the help's:
 * - `## Heading` is a section, listed in the contents at the top; `###` a subsection.
 * - `> [!DETAIL] Title` is a box for specialists, set apart from the newcomer's reading and always
 *   open; `[!NOTE]`, `[!TIP]` and `[!WARNING]` as in the help.
 * - `[text](#biophys:simulate)`, a node's type, links to that node in the node guide.
 * - `[text](#!demo://biophys:simulate)` is a button opening that workflow in the app — the node
 *   guide's demo links, built on arrival from the app's own example graphs.
 * - `![caption](file.webp)` is a figure from `public/guides/<pack>/`, captured by
 *   `pnpm guide:shots` (`scripts/guide-shots.mjs`).
 *
 * Generic over packs: a guide is found by its pack's id, which the page's slot markers carry
 * (`<!--@pack-guide-head:<pack>-->`, `<!--@pack-guide:<pack>-->`). The next pack's guide is its
 * Markdown file, its HTML page carrying those markers, `PackDefinition.guide`, its shots, and the
 * page in `vite.config.ts`' inputs, `vite/seo.ts` and `knip.jsonc` — nothing in this file;
 * `render.test.ts` checks each.
 */

import { readFileSync } from 'node:fs'

import type { MarkdownBlock, MarkdownInline, MarkdownList } from '../core/markdown'
import { TONE_TITLE, parseInline, parseMarkdown, plainText } from '../core/markdown'
import { NODE_TYPE_PATTERN, nodeAnchor } from '../core/nodeType'
import { displaySize } from '../changelog/render'
import { CAPTURE_DENSITY } from '../changelog/images'
import { appHref, esc } from '../datasetguide/render'
import { slugify } from '../style/format'

/** Every pack's guide source, by pack id: `src/packs/<pack>/guide/guide.md`. */
const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../packs/*/guide/guide.md', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path.split('/')[2]!, text]),
)

/** The packs with a guide, by id. */
export const GUIDED_PACKS: readonly string[] = Object.keys(SOURCES)

function sourceOf(pack: string): string {
  const source = SOURCES[pack]
  if (source === undefined) throw new Error(`No guide for a pack called ${pack}.`)
  return source
}

/**
 * A diagram's SVG, read from `public/guides/<pack>/` at build time to be inlined: its `<?xml?>`
 * prologue dropped, and `aria-hidden`, the figure carrying its name.
 */
function diagram(images: string, file: string): string {
  const svg = readFileSync(
    new URL(`../../public/guides/${images}/${file}`, import.meta.url),
    'utf8',
  )
  return svg
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace('<svg', '<svg aria-hidden="true" focusable="false"')
}

/** A heading's anchor: its words, lower case, joined by hyphens. */
const slug = (text: string): string => slugify(text, '')

/** `#type`: a link to a node, by the registry's own grammar for a type id. */
export const NODE_LINK = new RegExp(`^#(${NODE_TYPE_PATTERN})$`)

/** Where a guide's link goes: a node in the node guide, a workflow in the app, or elsewhere. */
function link(href: string, inner: string): string {
  if (href.startsWith('#!demo://')) {
    return `<a class="guide__open" href="${esc(appHref(href))}" target="_blank" rel="noopener">${inner}</a>`
  }
  const node = NODE_LINK.exec(href)
  if (node) return `<a href="./nodes.html#${esc(nodeAnchor(node[1]!))}">${inner}</a>`
  if (href.startsWith('#')) return `<a href="${esc(href)}">${inner}</a>`
  return `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${inner}</a>`
}

function inline(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
          return esc(n.text)
        case 'code':
          return `<code>${esc(n.text)}</code>`
        case 'strong':
          return `<strong>${inline(n.children)}</strong>`
        case 'em':
          return `<em>${inline(n.children)}</em>`
        case 'link':
          return link(n.href, inline(n.children))
      }
    })
    .join('')
}

function list(l: MarkdownList): string {
  const tag = l.ordered ? 'ol' : 'ul'
  const items = l.items
    .map((item) => `<li>${inline(item.children)}${item.list ? list(item.list) : ''}</li>`)
    .join('')
  return `<${tag}>${items}</${tag}>`
}

function blocks(bs: readonly MarkdownBlock[], images: string): string {
  return bs.map((b) => block(b, images)).join('\n')
}

function block(b: MarkdownBlock, images: string): string {
  switch (b.kind) {
    case 'heading': {
      const level = Math.min(4, Math.max(2, b.level))
      return `<h${level} id="${slug(plainText(b.children))}">${inline(b.children)}</h${level}>`
    }
    case 'paragraph':
      return `<p>${inline(b.children)}</p>`
    case 'list':
      return list(b)
    case 'fence':
      return `<pre><code>${esc(b.text)}</code></pre>`
    case 'callout': {
      // An "In depth" box always says so, above whatever it is titled; untitled, that is its title.
      const kicker =
        b.tone === 'detail' ? `<p class="callout__kicker">${TONE_TITLE.detail}</p>` : ''
      const title =
        b.tone === 'detail' && b.title === TONE_TITLE.detail
          ? ''
          : `<p class="callout__title">${inline(parseInline(b.title ?? ''))}</p>`
      return (
        `<aside class="callout callout--${b.tone}">${kicker}${title}` +
        blocks(b.blocks, images) +
        '</aside>'
      )
    }
    case 'table': {
      const cell = (tag: string, cells: MarkdownInline[][]) =>
        cells
          .map(
            (c, i) =>
              `<${tag} style="text-align:${b.align[i] ?? 'left'}">${inline(c)}</${tag}>`,
          )
          .join('')
      return (
        `<div class="guide__table"><table><thead><tr>${cell('th', b.head)}</tr></thead><tbody>` +
        b.rows.map((r) => `<tr>${cell('td', r)}</tr>`).join('') +
        '</tbody></table></div>'
      )
    }
    case 'image': {
      // A drawn diagram is inlined, so it draws in the page's own colours (`currentColor` and the
      // theme's tokens) in either theme; a screenshot is a link to itself, opened full-screen.
      if (b.src.endsWith('.svg')) {
        return (
          `<figure class="guide__diagram" role="img" aria-label="${esc(b.alt)}">${diagram(images, b.src)}` +
          `<figcaption>${esc(b.alt)}</figcaption></figure>`
        )
      }
      // Captured at the changelog's density, so drawn at its share of the file's size.
      const box = displaySize(b.src, `guides/${images}`, CAPTURE_DENSITY)
      // A link to the file, which `main.ts` opens full-screen instead: the plain link is what a
      // click does with no script, or in a new tab.
      const src = `./guides/${images}/${esc(b.src)}`
      return (
        `<figure><a class="guide__zoom" href="${src}" aria-label="${esc(b.alt)} (full size)">` +
        `<img src="${src}"${box} alt="${esc(b.alt)}" loading="lazy" decoding="async"></a>` +
        `<figcaption>${esc(b.alt)}</figcaption></figure>`
      )
    }
  }
}

/** A guide split as its page draws it: the title and lead in the masthead, the sections below. */
interface GuideParts {
  readonly title: readonly MarkdownInline[]
  readonly lead: readonly MarkdownBlock[]
  readonly body: readonly MarkdownBlock[]
}

/** The first `#` heading is the title, the paragraphs before the first `##` the lead. */
function parts(source: string): GuideParts {
  const parsed = parseMarkdown(source, { extended: true })
  const titleAt = parsed.findIndex((b) => b.kind === 'heading' && b.level === 1)
  const title = parsed[titleAt]
  const rest = parsed.slice(titleAt + 1)
  const at = rest.findIndex((b) => b.kind === 'heading' && b.level === 2)
  return {
    title: title?.kind === 'heading' ? title.children : [],
    lead: at < 0 ? rest : rest.slice(0, at),
    body: at < 0 ? [] : rest.slice(at),
  }
}

/** The masthead's half: the guide's title and its lead. */
export function guideHeadHTML(source: string, images: string): string {
  const { title, lead } = parts(source)
  return `<h1>${inline(title)}</h1>\n<div class="top__sub">${blocks(lead, images)}</div>`
}

/**
 * The page's half: a list of the sections, then the sections. `images` names the folder its
 * figures are in, under `public/guides/`.
 */
export function guideHTML(source: string, images: string): string {
  const { body } = parts(source)
  // Each `##` with the `###`s under it, which the contents fold away until hovered or read.
  const sections: { title: string; subsections: string[] }[] = []
  for (const b of body) {
    if (b.kind !== 'heading') continue
    if (b.level === 2) sections.push({ title: plainText(b.children), subsections: [] })
    else if (b.level === 3) sections.at(-1)?.subsections.push(plainText(b.children))
  }
  const entry = (title: string) => `<a href="#${slug(title)}">${esc(title)}</a>`
  return [
    '<div class="shell guide">',
    // A list rather than numbered: a guide numbers its sections in their headings, if at all.
    '<nav class="guide__contents" aria-label="Contents"><p class="guide__contents-title">Contents</p><ul>',
    ...sections.map(({ title, subsections }) =>
      subsections.length
        ? `<li>${entry(title)}<div class="guide__subsections"><ul>${subsections.map((t) => `<li>${entry(t)}</li>`).join('')}</ul></div></li>`
        : `<li>${entry(title)}</li>`,
    ),
    '</ul></nav>',
    `<article class="guide__body">${blocks(body, images)}</article>`,
    '</div>',
  ].join('\n')
}

/** A pack's guide's masthead, its figures in `public/guides/<pack>/`: what `<!--@pack-guide-head:<pack>-->` holds. */
export function packGuideHeadHTML(pack: string): string {
  return guideHeadHTML(sourceOf(pack), pack)
}

/** A pack's guide's body: what `<!--@pack-guide:<pack>-->` holds. */
export function packGuideHTML(pack: string): string {
  return guideHTML(sourceOf(pack), pack)
}
