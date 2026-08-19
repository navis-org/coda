/**
 * `.Rmd` rendering.
 *
 * Far simpler than the notebook renderer it mirrors: an R Markdown document is plain text, so
 * there is no JSON envelope, no per-cell ids and no newline-per-line convention to get wrong.
 * What it does have that `.ipynb` does not is a **YAML header**, and one rule that bites:
 * knitr aborts the render on a duplicate chunk label, so labels must be unique across the
 * document. They come from the walk's already-deduplicated variable names for exactly that
 * reason.
 */

import type { Cell } from './types'

export interface RmdOptions {
  title: string
  /** ISO 8601, or omitted. Injected rather than read from the clock so goldens are stable. */
  date?: string
}

/**
 * YAML needs the title quoted, and a title containing a quote needs it escaped.
 *
 * A graph called `LC4 "big" sweep` is not exotic — a name is free text — and an unescaped one
 * makes the whole document fail to parse before a line of R runs.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderRmd(cells: Cell[], options: RmdOptions): string {
  const lines: string[] = [
    '---',
    `title: ${yamlString(options.title)}`,
    ...(options.date ? [`date: ${yamlString(options.date)}`] : []),
    'output:',
    '  html_document:',
    '    toc: true',
    '    df_print: paged',
    '---',
    '',
  ]

  for (const cell of cells) {
    if (cell.kind === 'markdown') {
      lines.push(...cell.source, '')
      continue
    }
    lines.push(`\`\`\`{r ${cell.label}}`, ...cell.source, '```', '')
  }

  return `${lines.join('\n').replace(/\n{3,}$/, '\n')}`
}
