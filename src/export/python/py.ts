/**
 * Python literals and identifiers.
 *
 * Everything the emitters put into a cell goes through here. The rule is the same one
 * `cypher.ts` follows for query strings: nothing else may build a literal, because the
 * moment two places do it they disagree about quoting on the first value that needs it.
 */

import type { ParamValue } from '../../core/node'

/**
 * A Python string literal.
 *
 * Single-quoted by preference — that is what `repr` produces and what every style guide
 * here settles on — switching to double quotes when the value contains a single quote and
 * no double, which is also `repr`'s rule. Non-ASCII is emitted raw: Python 3 source is
 * UTF-8 by definition, and escaping a neuron type with a Greek letter in it makes the cell
 * unreadable for no gain.
 */
export function pyStr(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  if (escaped.includes("'") && !escaped.includes('"')) return `"${escaped}"`
  return `'${escaped.replace(/'/g, "\\'")}'`
}

/**
 * A Python numeric literal.
 *
 * The three non-finite values have no literal form at all — `Infinity` is a JS spelling and
 * `NaN` is not a Python name — so they go through `float()`. Everything else takes JS's own
 * formatting, whose exponential form (`1e+21`) is valid Python float syntax.
 */
export function pyNum(value: number): string {
  if (Number.isNaN(value)) return "float('nan')"
  if (value === Infinity) return "float('inf')"
  if (value === -Infinity) return "float('-inf')"
  if (Object.is(value, -0)) return '0'
  return String(value)
}

/** A `ParamValue` as a Python literal. */
export function pyValue(value: ParamValue | null | undefined): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return pyNum(value)
  if (Array.isArray(value)) return pyList(value)
  return pyStr(value)
}

/** A Python list literal, one line. Callers wanting a wrapped list use `pyLongList`. */
export function pyList(values: readonly ParamValue[]): string {
  return `[${values.map((v) => pyValue(v)).join(', ')}]`
}

/**
 * A list literal wrapped across lines once it stops fitting.
 *
 * An `ids` param routinely holds thousands of body ids, and a single line that long is a
 * cell nobody can read and no diff can show. Returns lines rather than a string, since the
 * caller has to indent them into whatever expression it is building.
 */
export function pyLongList(values: readonly ParamValue[], indent = '    ', width = 88): string[] {
  const items = values.map((v) => pyValue(v))
  // Measured rather than built: an Explore select-all is 10,000 ids, and materialising the
  // ~120 kB single-line form purely to read its `.length` is the one allocation here big
  // enough to notice.
  const oneLineWidth = items.reduce((n, item) => n + item.length + 2, 2)
  if (oneLineWidth + indent.length <= width) return [`[${items.join(', ')}]`]

  const lines: string[] = ['[']
  let current = indent
  for (const item of items) {
    const piece = `${item},`
    if (current.length + piece.length > width && current !== indent) {
      lines.push(current.trimEnd())
      current = indent
    }
    current += `${piece} `
  }
  if (current.trim()) lines.push(current.trimEnd())
  lines.push(']')
  return lines
}

/**
 * Reserved names, and why the list is longer than Python's keyword list.
 *
 * A variable name here is slugged from a node's title, and the titles collide with builtins
 * far more often than with keywords: `Filter`, `Sort`, `Join`, `Table` and `Format` are all
 * node labels, and `filter = ...` shadows a builtin the very next cell might want. PEP 8's
 * answer is a trailing underscore, which is what `pyIdent` applies.
 */
const RESERVED = new Set([
  // Keywords.
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield', 'match', 'case',
  // Builtins a node title can realistically produce.
  'abs', 'all', 'any', 'bool', 'bytes', 'dict', 'dir', 'filter', 'float', 'format', 'hash',
  'id', 'input', 'int', 'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object', 'open',
  'print', 'range', 'round', 'set', 'slice', 'sorted', 'str', 'sum', 'tuple', 'type', 'vars',
  'zip',
  // Module aliases the setup cell binds.
  'pd', 'np', 'nx', 'plt', 'sns', 'navis', 'os', 'client',
])

/**
 * A node title as a Python identifier.
 *
 * Lowercased and underscored, which is what a reader expects a dataframe to be called;
 * a leading digit gets a prefix because `2_hop` is a syntax error and a silent rename to
 * something unrecognisable is worse than a visible one.
 */
export function pyIdent(text: string, fallback = 'step'): string {
  let slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (!slug) slug = fallback
  if (/^[0-9]/.test(slug)) slug = `n_${slug}`
  if (RESERVED.has(slug)) slug = `${slug}_`
  return slug
}

/**
 * Comment lines, wrapped.
 *
 * Emitters hand this whole sentences — a TODO explaining why a node has no equivalent runs
 * to several lines — and a comment that overruns the cell's width is the one thing in a
 * generated file that reads as carelessness.
 */
export function pyComment(text: string, width = 76): string[] {
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
