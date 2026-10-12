/** DotMotif's typed seam; the graph stays local to the existing Python worker. */
import type { CellValue } from '../core/values'
import { callPython } from './engine'
import type { CallOptions } from './engine'
import { int32From, numberFrom } from './types'

// A type rather than an interface: only a type alias is assignable to `PyArg`'s index signature.
export type DotMotifRequest = {
  directed: boolean
  query: string
  maxMatches: number
  /** `maxRolesFor(maxMatches)`: a query with more roles is refused before the search. */
  maxRoles: number
  /** `dotmotifHost`'s keys. Transferred, so detached the moment the call is posted. */
  keyOfRow: Int32Array
  sources: Int32Array
  targets: Int32Array
  linkRows: Int32Array
  /** `queriedColumns`' attribute columns: plain arrays, cloned rather than transferred. */
  nodes: Readonly<Record<string, CellValue[]>>
  edges: Readonly<Record<string, CellValue[]>>
}

export interface DotMotifMatches {
  count: number
  /** The motif's variables, sorted. Each match is one key per role, in this order. */
  roles: string[]
  /** Host node keys, `count * roles.length` of them. */
  keys: Int32Array
  /** The parsed query had more roles than `maxRoles`, so nothing was searched. */
  refused: boolean
}

export async function runDotMotif(
  request: DotMotifRequest,
  options: CallOptions = {},
): Promise<DotMotifMatches> {
  const nodeCount = request.keyOfRow.length // before the call, which detaches it
  const result = await callPython(
    { module: 'dotmotif', fn: 'coda_dotmotif_run', args: [request] },
    options,
  )
  const count = numberFrom(result, 'count')
  const keys = int32From(result, 'keys')
  const roles = result.roles
  if (
    !Array.isArray(roles) ||
    !roles.every((role) => typeof role === 'string') ||
    keys.length !== count * roles.length ||
    keys.some((key) => key < 0 || key >= nodeCount)
  ) {
    throw new Error('DotMotif returned an invalid match table')
  }
  return { count, roles: roles as string[], keys, refused: result.refused === true }
}
