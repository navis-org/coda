/** DotMotif's typed seam; the graph stays local to the existing Python worker. */
import type { CellValue } from '../core/values'
import { callPython } from './engine'
import type { CallOptions } from './engine'

export type DotMotifRequest = {
  directed: boolean
  // Plain columns, not transferable buffers: upstream cached tables remain untouched.
  nodes: Readonly<Record<string, CellValue[]>>
  edges: Readonly<Record<string, CellValue[]>>
  query: string
  maxMatches: number
}

export interface DotMotifResult {
  matchId: number[]
  variable: string[]
  nodeId: string[]
  count: number
  /** Reached the requested limit; there MAY be more, not a claim of truncation. */
  limitReached: boolean
}

export async function runDotMotif(
  request: DotMotifRequest,
  options: CallOptions = {},
): Promise<DotMotifResult> {
  const result = await callPython(
    { module: 'dotmotif', fn: 'coda_dotmotif_run', args: [request] },
    options,
  )
  const { matchId, variable, nodeId, count, limitReached } = result
  if (
    !Array.isArray(matchId) ||
    !Array.isArray(variable) ||
    !Array.isArray(nodeId) ||
    matchId.length !== variable.length ||
    matchId.length !== nodeId.length ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > request.maxMatches ||
    typeof limitReached !== 'boolean' ||
    limitReached !== (count === request.maxMatches) ||
    (count === 0) !== (matchId.length === 0) ||
    matchId.some((id) => !Number.isSafeInteger(id) || id < 1 || id > count) ||
    variable.some((v) => typeof v !== 'string') ||
    nodeId.some((id) => typeof id !== 'string')
  ) {
    throw new Error('DotMotif returned an invalid match table')
  }
  return { matchId, variable, nodeId, count, limitReached }
}
