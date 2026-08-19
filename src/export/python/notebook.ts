/**
 * `.ipynb` rendering.
 *
 * nbformat 4.5. The only two things here that are not obvious from the schema: every cell
 * needs an `id` at 4.5 and up, and Jupyter's `source` is a list of lines each *keeping* its
 * trailing newline except the last — write it as a plain array of lines and the file opens
 * as one run-on line.
 */

import type { Cell } from './types'

export interface Notebook {
  cells: unknown[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

/** Lines to Jupyter's source array: newline-terminated, except the last. */
function sourceLines(lines: string[]): string[] {
  return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\n`))
}

export function buildNotebook(cells: Cell[]): Notebook {
  return {
    cells: cells.map((cell, i) => {
      // Deterministic rather than random: golden files are the whole test strategy here, and
      // a uuid per cell would make every export differ from the last.
      const id = `coda-${String(i + 1).padStart(3, '0')}`
      if (cell.kind === 'markdown') {
        return { cell_type: 'markdown', id, metadata: {}, source: sourceLines(cell.source) }
      }
      return {
        cell_type: 'code',
        execution_count: null,
        id,
        metadata: {},
        outputs: [],
        source: sourceLines(cell.source),
      }
    }),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

/** Serialised the way Jupyter writes it: two-space indent, trailing newline. */
export function serializeNotebook(notebook: Notebook): string {
  return `${JSON.stringify(notebook, null, 2)}\n`
}
