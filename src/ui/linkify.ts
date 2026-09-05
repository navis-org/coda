/**
 * Finding the links in a message somebody has to act on.
 *
 * A refusal is only a remedy if the reader can reach what it names, and Coda's messages had
 * started naming things: `middle_auth` answers a 403 with the terms-of-service form that lifts
 * it, so the CAVE client puts that URL in the sentence. On a node card that URL was
 * unclickable, unselectable text in a 10px band — a remedy somebody had to copy out by eye and
 * retype. This is the half that decides where the links are; `IssueText` draws them.
 *
 * **The visible text is the URL**, which is a safety property rather than a style. These
 * sentences are not always ours: `authRefusal` reads `tos_form_url` out of whatever deployment
 * a Custom node was pointed at, so a link here can be a remote server's choice. A reader who
 * sees the href they are about to follow cannot be sent somewhere by a mismatched label, which
 * is the only thing an anchor can lie about — the same reasoning that makes `parseMarkdown`'s
 * extended kinds opt-in rather than a default.
 *
 * **Two schemes and no others.** `http` and `https`: a lab's own CAVE or CATMAID is routinely
 * plain http, so requiring TLS would drop exactly the deployments least likely to be documented
 * anywhere else. Everything else — `javascript:`, `data:`, `file:` — is left as text, so a
 * server cannot get a scheme of its choosing into an `href` by writing one into an error body.
 */

/** A run of plain text, or a link whose text is its own href. */
export interface LinkSpan {
  text: string
  href?: string
}

/*
 * Deliberately stops at whitespace and at the handful of characters that end a URL in prose
 * rather than belonging to one. `<>"'` cannot appear unescaped in a URL; the brackets are
 * handled below, since one of them may legitimately be inside.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g

/**
 * Punctuation that ends the sentence rather than the URL.
 *
 * The case that forced it: "…/tos/3/accept. Your token is fine" — the greedy match takes the
 * full stop, and a trailing dot is enough to 404 the very page somebody was being sent to.
 * A closing bracket is only dropped when nothing opened it, so a URL that really contains one
 * survives.
 */
function trimTrailing(url: string): string {
  const text = url.replace(/[.,;:!?]+$/, '')
  const close = text.at(-1)
  if (close !== ')' && close !== ']') return text
  const open = close === ')' ? '(' : '['
  // Only when nothing opened it, so a URL that really contains one survives.
  const unopened = text.split(close).length > text.split(open).length
  return unopened ? trimTrailing(text.slice(0, -1)) : text
}

/**
 * Split a message into text and links, in order.
 *
 * Always returns at least one span, so a caller can render the result without a special case for
 * an empty message.
 */
export function splitLinks(message: string): LinkSpan[] {
  const spans: LinkSpan[] = []
  let at = 0
  for (const match of message.matchAll(URL_PATTERN)) {
    const start = match.index
    const href = trimTrailing(match[0])
    // A bare scheme is not a link anybody can follow — "https:// is a scheme" is prose.
    if (href.endsWith('//')) continue
    if (start > at) spans.push({ text: message.slice(at, start) })
    spans.push({ text: href, href })
    at = start + href.length
  }
  // The tail, and the whole of a message with no link in it — so a caller never has to special-
  // case an empty result.
  const tail = message.slice(at)
  if (tail || spans.length === 0) spans.push({ text: tail })
  return spans
}
