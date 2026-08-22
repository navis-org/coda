/**
 * Text notes placed around a hand-built graph.
 *
 * Shared by the bundled examples and by the starter graphs, which is the whole reason it is its
 * own module: both write notes as indented template literals in TypeScript source, and both have
 * to strip that indentation the same way. Two copies of `dedent` is two answers to what counts
 * as a heading.
 *
 * Positioned absolutely rather than on the node grid: a pipeline node occupies one column, while
 * a note spans several of them and belongs above or below the whole row. Sizes are explicit
 * because the text is known at the call site — a note left at the definition's default clips its
 * own last line.
 */

import type { GraphNode } from '../core/graph'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'

const NOTE_TYPE = 'note.text'

/**
 * Strip the source indentation off a note written as an indented template literal.
 *
 * Not cosmetic: the markdown parser recognises a heading only at the start of a line, so a `###`
 * indented to match the surrounding code is not a heading at all — it is a paragraph that begins
 * with three hashes. The common indent is measured and removed rather than every leading space,
 * so a nested list in a future note still nests.
 */
export function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length)
  const common = indents.length ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(common))
    .join('\n')
    .trim()
}

export interface NotePlacement {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
}

export function noteNode({ id, x, y, width, height, text }: NotePlacement): GraphNode {
  return {
    id,
    type: NOTE_TYPE,
    position: { x, y },
    params: { ...defaultParams(requireNodeDef(NOTE_TYPE)), text: dedent(text) } as ParamValues,
    size: { width, height },
  }
}
