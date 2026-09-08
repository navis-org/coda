/**
 * Read one rule out of a stylesheet's source.
 *
 * Several suites assert a CSS declaration rather than a rendered result, because vitest applies
 * no stylesheet and jsdom performs no layout — `runRing.placement.test.tsx` sets the standing.
 * Each had written this three-line reader itself, which is four regexes over one file format
 * with four opinions about comments; the next one is written by copying whichever was found
 * first.
 *
 * Comments are stripped: a rule's own prose is where the argument lives, and matching an
 * assertion against an explanation of the bug is a fine way to test nothing.
 */
export function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no rule for ${selector}`)
  return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
}
