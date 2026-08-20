/**
 * R literals and identifiers.
 *
 * The counterpart of `python/py.ts`, and the same rule applies: nothing else may build a
 * literal, because the moment two places do it they disagree about quoting on the first value
 * that needs it.
 */

import type { ParamValue } from '../../core/node'

/**
 * An R string literal.
 *
 * Double-quoted, which is what R itself prints and what every style guide there settles on —
 * the opposite of `py.ts`'s preference, and worth not "fixing" into agreement. Non-ASCII is
 * emitted raw; R source is UTF-8 and escaping a neuron type makes the chunk unreadable.
 */
export function rStr(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

/**
 * An R numeric literal.
 *
 * R spells the non-finite values as bare names rather than through a constructor, which is the
 * one place this is simpler than Python. JS's exponential form (`1e+21`) is valid R.
 */
export function rNum(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Inf'
  if (value === -Infinity) return '-Inf'
  if (Object.is(value, -0)) return '0'
  return String(value)
}

/** A `ParamValue` as an R literal. */
export function rValue(value: ParamValue | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return rNum(value)
  if (Array.isArray(value)) return rVector(value)
  return rStr(value)
}

/**
 * A `c(...)` vector.
 *
 * An empty one is **not** `c()`: that is `NULL` in R, which silently drops an argument rather
 * than passing an empty set — so a filter of nothing would read as no filter at all. The typed
 * zero-length constructors say "empty" and keep their type.
 */
export function rVector(values: readonly ParamValue[]): string {
  if (values.length === 0) return 'character(0)'
  return `c(${values.map((v) => rValue(v)).join(', ')})`
}

/** A vector wrapped across lines once it stops fitting — an `ids` param holds thousands. */
export function rLongVector(
  values: readonly ParamValue[],
  indent = '  ',
  width = 88,
): string[] {
  if (values.length === 0) return ['character(0)']
  const items = values.map((v) => rValue(v))
  // Measured rather than built: a select-all is 10,000 ids, and materialising the single-line
  // form purely to read its `.length` is the one allocation here big enough to notice.
  const oneLine = items.reduce((n, item) => n + item.length + 2, 3)
  if (oneLine + indent.length <= width) return [`c(${items.join(', ')})`]

  const lines: string[] = ['c(']
  let current = indent
  for (const item of items) {
    const piece = `${item},`
    if (current.length + piece.length > width && current !== indent) {
      lines.push(current.trimEnd())
      current = indent
    }
    current += `${piece} `
  }
  if (current.trim()) lines.push(current.trimEnd().replace(/,$/, ''))
  lines.push(')')
  return lines
}

/**
 * Reserved names, and why this list is longer and more dangerous than Python's.
 *
 * R has no namespaces at the call site: `library(dplyr)` puts `filter` and `select` on the
 * search path, so a variable named after either **masks the verb the next chunk calls**. And
 * the node labels are literally "Filter" and "Select". Python's `filter` shadowing is a
 * nuisance; here it breaks the document.
 *
 * Also note `T` and `F` — legal abbreviations for TRUE/FALSE that are ordinary bindings, so
 * assigning to them is both legal and quietly catastrophic.
 */
const RESERVED = new Set([
  // Reserved words.
  'if',
  'else',
  'repeat',
  'while',
  'function',
  'for',
  'next',
  'break',
  'TRUE',
  'FALSE',
  'NULL',
  'Inf',
  'NaN',
  'NA',
  'in',
  // dplyr/tidyr verbs a node label maps straight onto.
  'filter',
  'select',
  'arrange',
  'mutate',
  'summarise',
  'summarize',
  'rename',
  'group_by',
  'slice',
  'pull',
  'count',
  'union',
  'intersect',
  'setdiff',
  'bind_rows',
  // Base functions a node label or port name maps onto.
  'c',
  't',
  'q',
  'T',
  'F',
  'data',
  'table',
  'sort',
  'sample',
  'max',
  'min',
  'sum',
  'mean',
  'range',
  'rev',
  'names',
  'length',
  'dim',
  'list',
  'matrix',
  'vector',
  'factor',
  'levels',
  'rep',
  'seq',
  'paste',
  'format',
  'print',
  'plot',
  'merge',
  'split',
  'order',
  'which',
  'nrow',
  'ncol',
  'head',
  'tail',
  'apply',
  'lapply',
  'sapply',
  'do.call',
  'Reduce',
  // Bindings the setup chunk makes.
  'conn',
])

/**
 * A node title as an R identifier.
 *
 * Snake case, which is what the tidyverse writes. A masking or reserved name takes a `_df`
 * suffix rather than a trailing underscore: `filter_df` reads as an R object where `filter_`
 * reads as a typo, and the whole point is that somebody has to be able to read this.
 */
export function rIdent(text: string, fallback = 'step'): string {
  let slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (!slug) slug = fallback
  // R forbids a leading digit, and a leading dot followed by one.
  if (/^[0-9]/.test(slug)) slug = `n_${slug}`
  if (RESERVED.has(slug)) slug = `${slug}_df`
  return slug
}

/**
 * A knitr chunk label.
 *
 * Deliberately not `rIdent`: knitr **errors on a duplicate label**, and its labels are
 * conventionally hyphenated rather than snake case. Uniqueness is the caller's job, which it
 * gets for free by passing the variable name it already deduplicated.
 */
export function chunkLabel(name: string): string {
  return name.replace(/_/g, '-')
}

/** Comment lines, wrapped. Same contract as `pyComment`. */
export function rComment(text: string, width = 76): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      out.push('#')
      continue
    }
    let line = '#'
    for (const word of paragraph.split(/\s+/)) {
      if (line.length + word.length + 1 > width && line !== '#') {
        out.push(line)
        line = '#'
      }
      line += ` ${word}`
    }
    out.push(line)
  }
  return out
}
