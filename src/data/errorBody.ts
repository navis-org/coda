/**
 * The readable part of an error body that is not JSON — what a card says when a server fails.
 *
 * Written first inside CAVE's client, after a materialize service behind nginx answered a 503 as
 * a whole HTML document and the card read `CAVE returned 503: <html>` followed by four lines of
 * markup — which reads as Coda being broken rather than as a service being down. CATMAID,
 * SeaTable and neuPrint sit behind the same kind of proxy and were still slicing the raw body,
 * so the rule lives here now. Each client keeps its own JSON shapes; this is only what is left
 * after them.
 */

/** A served HTML page rather than anything an API would send: those answer in JSON or text. */
export function looksLikeHtml(body: string): boolean {
  return /^\s*<(?:!doctype|html|head)\b/i.test(body)
}

/**
 * The `<title>` of an HTML error page, or `undefined` for anything that is not one.
 *
 * Deliberately only the title, and only when the body looks like a document: a general tag
 * stripper turns a page with a stylesheet in it into a paragraph of CSS, which is worse than the
 * markup it replaced.
 */
function htmlTitle(body: string): string | undefined {
  if (!looksLikeHtml(body)) return undefined
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim()
  return title || undefined
}

/** An HTML page's title, else the body's first 300 characters, else a word for nothing at all. */
export function bodyExcerpt(body: string): string {
  return htmlTitle(body) ?? (body.slice(0, 300) || '(empty response)')
}
