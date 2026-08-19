/**
 * The matched characters of a fuzzy hit, marked up.
 *
 * Shared by the two add-node surfaces — the browser and the palette — which CLAUDE.md keeps
 * as a deliberate pair. They consume the same `matches: number[]` out of `fuzzy.ts`, so a
 * second copy meant a fix to how a hit reads landed in only one of them.
 */

/**
 * Adjacent characters are coalesced into runs rather than emitted one span each, so the
 * rendered label stays selectable text and a test can read it as one string.
 */
export function Highlight({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>
  const hit = new Set(matches)
  const runs: Array<{ text: string; matched: boolean }> = []

  for (let i = 0; i < text.length; i++) {
    const matched = hit.has(i)
    const last = runs.at(-1)
    if (last && last.matched === matched) last.text += text[i]
    else runs.push({ text: text[i]!, matched })
  }

  return (
    <>
      {runs.map((run, index) =>
        run.matched ? (
          <mark key={index} className="add-menu__match">
            {run.text}
          </mark>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  )
}
