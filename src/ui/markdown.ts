/**
 * A small markdown subset, parsed to an AST.
 *
 * Exists for one job: rendering the blurb a data source publishes about a dataset — a couple of
 * paragraphs, a nested bullet list of companion sites, and the citations. Those are written by
 * the people who made the data, arrive over the network, and are the whole reason the
 * Description node exists, so they have to render as prose with working links rather than as a
 * wall of `[text](url)`.
 *
 * **Why not a markdown library.** Two reasons, and the second is the real one. `marked` plus a
 * sanitiser is ~50 kB for a feature that renders three block kinds, against ~250 lines here.
 * More importantly, every library in that shape produces an **HTML string**, so the safety of
 * the whole path rests on a sanitiser being configured correctly and staying that way. This
 * produces an AST that `Markdown.tsx` turns into React elements, so there is no
 * `dangerouslySetInnerHTML` anywhere and raw HTML in the source is text rather than markup. A
 * hostile blurb — from a compromised deployment someone points a Custom neuPrint node at —
 * cannot inject a script by construction rather than by configuration.
 *
 * Deliberately unsupported: images, tables, block quotes, fenced code, reference links, raw
 * HTML. Anything unrecognised falls through as literal text, which is the right failure: a stray
 * `>` reads as a stray `>` and nothing silently disappears.
 */

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: MarkdownInline[] }
  | { kind: 'em'; children: MarkdownInline[] }
  | { kind: 'link'; href: string; children: MarkdownInline[] }

export interface MarkdownList {
  kind: 'list'
  ordered: boolean
  items: MarkdownItem[]
}

export interface MarkdownItem {
  children: MarkdownInline[]
  /** A list nested under this item, built from more deeply indented lines below it. */
  list?: MarkdownList
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; children: MarkdownInline[] }
  | { kind: 'paragraph'; children: MarkdownInline[] }
  | MarkdownList

/** Schemes a link may use. Everything else renders as plain text — see `safeHref`. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * Vet a link target, returning it unchanged or `undefined` if it may not be linked.
 *
 * The scheme is tested against a copy with whitespace and control characters removed while the
 * value returned is the original: `java\tscript:…` is a scheme browsers accept and a naive test
 * does not, so stripping before the test and not after it errs towards refusing.
 *
 * A URL with no scheme at all is relative and allowed; `//host` is not, because it inherits the
 * page's scheme while reading like a path.
 */
export function safeHref(raw: string): string | undefined {
  const url = raw.trim()
  if (!url) return undefined
  // Built by code point rather than by a regex range, because a character class holding the
  // control characters is itself what `no-control-regex` is there to catch.
  const bare = [...url].filter((ch) => ch.codePointAt(0)! > 0x20).join('')
  if (bare.startsWith('//')) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare)
  if (!scheme) return url
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase()) ? url : undefined
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** `- `, `* `, `+ `, `1. ` or `1) `, with the indent that positions it in a nested list. */
const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING_LINE = /^(#{1,6})\s+(.*)$/

/** A tab indents as far as four spaces, which is what the published blurbs assume. */
function indentWidth(prefix: string): number {
  let width = 0
  for (const ch of prefix) width += ch === '\t' ? 4 : 1
  return width
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  /** Open lists by depth, outermost first; `indent` is the column their markers sit at. */
  const stack: { indent: number; list: MarkdownList }[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    // Joined with a space: a single newline inside a paragraph is a soft break in markdown,
    // and every published blurb wraps mid-sentence.
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  const closeLists = () => {
    stack.length = 0
  }

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flushParagraph()
      closeLists()
      continue
    }

    const heading = HEADING_LINE.exec(line)
    if (heading) {
      flushParagraph()
      closeLists()
      blocks.push({
        kind: 'heading',
        // Clamped at 3: this renders inside a node card, where an h4 and an h6 would be the
        // same size anyway and the extra levels only add markup.
        level: Math.min(heading[1]!.length, 3),
        children: parseInline(heading[2]!),
      })
      continue
    }

    const item = LIST_LINE.exec(line)
    if (item) {
      flushParagraph()
      appendListItem(blocks, stack, {
        indent: indentWidth(item[1]!),
        ordered: /\d/.test(item[2]!),
        text: item[3]!,
      })
      continue
    }

    // An indented line under an open list continues that bullet rather than starting a
    // paragraph, which is what keeps a wrapped citation on one line of the list.
    const open = stack[stack.length - 1]
    const last = open?.list.items[open.list.items.length - 1]
    if (last && /^\s/.test(line)) {
      last.children = [
        ...last.children,
        { kind: 'text', text: ' ' },
        ...parseInline(line.trim()),
      ]
      continue
    }

    closeLists()
    paragraph.push(line.trim())
  }

  flushParagraph()
  return blocks
}

/**
 * Place one bullet, opening and closing nesting levels as the indent demands.
 *
 * Two columns is the threshold for "deeper", so the four-space indents neuPrint publishes nest
 * and a stray single space does not.
 */
function appendListItem(
  blocks: MarkdownBlock[],
  stack: { indent: number; list: MarkdownList }[],
  item: { indent: number; ordered: boolean; text: string },
): void {
  while (stack.length > 1 && item.indent < stack[stack.length - 1]!.indent) stack.pop()

  let open = stack[stack.length - 1]
  if (!open) {
    const list: MarkdownList = { kind: 'list', ordered: item.ordered, items: [] }
    blocks.push(list)
    open = { indent: item.indent, list }
    stack.push(open)
  } else if (item.indent >= open.indent + 2) {
    const parent = open.list.items[open.list.items.length - 1]
    // A nested list with no bullet above it has nothing to nest *in*; treat it as a sibling.
    if (parent) {
      parent.list ??= { kind: 'list', ordered: item.ordered, items: [] }
      open = { indent: item.indent, list: parent.list }
      stack.push(open)
    }
  } else if (open.list.ordered !== item.ordered && stack.length === 1) {
    // Switching between bullets and numbers at one level starts a new list rather than a
    // mixed one, since the two are drawn with different markers.
    const list: MarkdownList = { kind: 'list', ordered: item.ordered, items: [] }
    blocks.push(list)
    stack.pop()
    open = { indent: item.indent, list }
    stack.push(open)
  }

  open.list.items.push({ children: parseInline(item.text) })
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

const PUNCTUATION = /[\\`*_[\]()#+\-.!]/

export function parseInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = []
  let text = ''
  let i = 0

  const flush = () => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }

  while (i < source.length) {
    const ch = source[i]!

    if (ch === '\\' && i + 1 < source.length && PUNCTUATION.test(source[i + 1]!)) {
      text += source[i + 1]
      i += 2
      continue
    }

    // Code first: inside a span everything is literal, delimiters included.
    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'code', text: source.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (ch === '[') {
      const link = readLink(source, i)
      if (link) {
        flush()
        out.push(link.node)
        i = link.next
        continue
      }
    }

    if (ch === '*' && source[i + 1] === '*') {
      const end = source.indexOf('**', i + 2)
      // An empty span (`****`) is literal asterisks, not emphasis of nothing.
      if (end > i + 2) {
        flush()
        out.push({ kind: 'strong', children: parseInline(source.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if ((ch === '*' || ch === '_') && opensEmphasis(source, i)) {
      const end = findEmphasisClose(source, i + 1, ch)
      if (end !== -1) {
        flush()
        out.push({ kind: 'em', children: parseInline(source.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    text += ch
    i += 1
  }

  flush()
  return out
}

/**
 * Read `[label](href)` starting at the `[`.
 *
 * The href scan tracks parenthesis depth rather than stopping at the first `)`, because DOIs and
 * wiki URLs carry balanced parens and truncating one produces a link that silently 404s.
 *
 * A target `safeHref` refuses degrades to the label as plain text: the words the author wrote
 * are still information, and dropping them would hide that anything had been there.
 */
function readLink(
  source: string,
  start: number,
): { node: MarkdownInline; next: number } | undefined {
  const close = source.indexOf(']', start + 1)
  if (close === -1 || source[close + 1] !== '(') return undefined

  let depth = 1
  let i = close + 2
  while (i < source.length) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') depth -= 1
    if (depth === 0) break
    i += 1
  }
  if (depth !== 0) return undefined

  const label = source.slice(start + 1, close)
  // `[text](url "title")` — the title is markdown's tooltip, which has nowhere to go here.
  const href = safeHref(source.slice(close + 2, i).replace(/\s+"[^"]*"$/, ''))
  const children = parseInline(label)
  return {
    node: href ? { kind: 'link', href, children } : { kind: 'text', text: label },
    next: i + 1,
  }
}

/** `_` may not open inside a word, so `male_cns_v1` stays one token. `*` may. */
function opensEmphasis(source: string, at: number): boolean {
  const next = source[at + 1]
  if (!next || /\s/.test(next) || next === source[at]) return false
  if (source[at] === '_' && /\w/.test(source[at - 1] ?? '')) return false
  return true
}

function findEmphasisClose(source: string, from: number, delim: string): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== delim) continue
    if (i === from) return -1
    if (/\s/.test(source[i - 1] ?? '')) continue
    if (delim === '_' && /\w/.test(source[i + 1] ?? '')) continue
    return i
  }
  return -1
}
