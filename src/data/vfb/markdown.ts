/**
 * Virtual Fly Brain's markdown, read.
 *
 * VFB writes its text as markdown — a term's definition, comment, types and relationships — and a
 * term in it is a link whose target is an id rather than a URL: `[MBON01](FBbt_00100234)`. So a
 * client has to parse markdown to get an id back out, which is why it lives here alone and is
 * checked against recorded responses (`__fixtures__/`), and why asking VFB for structured fields is
 * in the plan (A6).
 *
 * Text is returned as text and never rendered as markdown: it is data from another server, and an
 * image in one would be a request to a third (CLAUDE.md, `parseMarkdown`).
 */

/** A run of VFB markdown: plain `text`, or a link to `target` labelled `text`. */
export interface MarkdownSpan {
  readonly text: string
  readonly target?: string
}

/** The index of the bracket closing the one at `open`, or -1. */
function closing(text: string, open: number, left: string, right: string): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === left) depth++
    else if (c === right && --depth === 0) return i
  }
  return -1
}

/**
 * VFB markdown as spans, in order: every top-level `[label](target)` a link, the text between them
 * plain. Brackets inside a label are balanced, which is what lets a thumbnail's nested image through
 * intact. The one reader of VFB's markdown: a term page's `Meta` strings, in `client.ts`.
 */
export function markdownSpans(text: string): MarkdownSpan[] {
  const out: MarkdownSpan[] = []
  let plainFrom = 0
  const plain = (to: number) => {
    if (to > plainFrom) out.push({ text: text.slice(plainFrom, to) })
  }
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('[', i)
    if (open === -1) break
    const end = closing(text, open, '[', ']')
    if (end === -1) break
    if (text[end + 1] !== '(') {
      i = end + 1
      continue
    }
    // An image is a link's *label*; a bare one is not a link and is never drawn — a VFB string is
    // another server's text — so it is reduced to its alt text, and its URL is dropped.
    if (open > 0 && text[open - 1] === '!') {
      const close = closing(text, end + 1, '(', ')')
      if (close === -1) break
      plain(open - 1)
      const alt = text.slice(open + 1, end)
      if (alt) out.push({ text: alt })
      i = plainFrom = close + 1
      continue
    }
    const close = closing(text, end + 1, '(', ')')
    if (close === -1) break
    plain(open)
    const label = text.slice(open + 1, end)
    const target = text.slice(end + 2, close).trim()
    out.push({ text: label, target })
    i = plainFrom = close + 1
  }
  plain(text.length)
  return out
}

/** The text a reader sees: every link reduced to its label. */
export const spansText = (spans: readonly MarkdownSpan[]) => spans.map((s) => s.text).join('')
