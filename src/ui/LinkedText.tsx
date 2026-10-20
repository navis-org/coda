/**
 * Text with its links followable: `splitLinks`' spans, drawn — and an identifier drawn as a link to
 * the URL `ui/columnLinks.ts` built for it.
 *
 * One module for every surface that shows text which may carry a URL — a refusal in `IssueText`, a
 * cell in `TableViewer` — so a link is drawn, guarded and stopped one way (`ExternalLink`). The
 * rule that makes this safe is `linkify.ts`': the visible text is the href, and only `http(s)`;
 * `IdLink` is the one exception and says why.
 */

import type { ReactNode, SyntheticEvent } from 'react'

import { splitLinks } from './linkify'

/** One handler for every link, rather than two fresh closures per link per render. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

/**
 * An anchor opening elsewhere, with what every link on a card needs: `nodrag` so a press is not
 * React Flow's drag, and the events stopped so the click neither selects the node nor — on a card
 * already selected — starts a drag from under the pointer.
 */
function ExternalLink({
  href,
  title,
  children,
}: {
  href: string
  title?: string
  children: ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="nodrag"
      title={title}
      onPointerDown={stop}
      onClick={stop}
    >
      {children}
    </a>
  )
}

export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((span, index) =>
        span.href ? (
          <ExternalLink key={index} href={span.href}>
            {span.text}
          </ExternalLink>
        ) : (
          // A bare string needs no key and no element of its own; the wrapper carries the styling.
          span.text
        ),
      )}
    </>
  )
}

/**
 * An identifier drawn as a link to a URL `ui/columnLinks.ts` built for it — `FBbt_00100234`
 * pointing at VFB's page. **The one exception to `linkify.ts`' rule that the visible text is the
 * href, and why it is safe:** the URL is a fixed-host template around the identifier, never a
 * server's choice, so whatever the label says the link goes to that host's page for that id. So the
 * label may be the identifier (a table column, where a column of URLs would hide the ids) or a name
 * the same answer gives for it (a term named in VFB's text) — at worst a mislabelled page on the
 * one host, never a different host.
 */
export function IdLink({ text, href }: { text: string; href: string }) {
  return (
    <ExternalLink href={href} title={href}>
      {text}
    </ExternalLink>
  )
}
