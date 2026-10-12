import { CRASH_FLOOR_BYTES, crashFloorIssue } from '../../core/limits'
import type { TableSchema } from '../../core/types'
import { escapeRegex } from '../../data/terms'
import type { CellValue, NetworkValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { DotMotifHost, MatchColumns } from './dotmotifHost'
import { dotmotifHost } from './dotmotifHost'
import { linkEnds, nodeIds } from './networkOps'

/** Long rather than wide: downstream column pickers work before Python parses the DSL. */
export function dotmotifSchema(): TableSchema {
  return {
    columns: [
      { name: 'matchId', dtype: 'i64' },
      { name: 'variable', dtype: 'str' },
      { name: 'nodeId', dtype: 'str' },
    ],
  }
}

/** The Matches table, from `matchColumns`. */
export function dotmotifTable(columns: MatchColumns): TableValue {
  return makeTable(dotmotifSchema(), columns)
}

/** The network's keys, with its ids read by the same rule `induceSubnetwork` reads them by. */
export function networkHost(network: NetworkValue): DotMotifHost {
  const { sources, targets } = linkEnds(network)
  return dotmotifHost(nodeIds(network), sources, targets, network.directed)
}

/**
 * The attribute columns worth cloning to the worker: those whose name appears in the query as a
 * word. A superset of what the query reads — an attribute has to be written to be read — with
 * Python's own list of the constraints as the exact filter. Saves cloning every column of a large
 * network for a query, like the default triangle, that reads none.
 *
 * A word, so `side` does not clone `id`: a boundary is asserted only where the name's own end is
 * a word character, which keeps a quoted key such as `A["cell type"]` matching.
 */
export function queriedColumns(
  data: Readonly<Record<string, CellValue[]>>,
  query: string,
): Record<string, CellValue[]> {
  const named = (name: string): boolean => {
    const escaped = escapeRegex(name)
    const before = /^\w/.test(name) ? '(?<!\\w)' : ''
    const after = /\w$/.test(name) ? '(?!\\w)' : ''
    return new RegExp(before + escaped + after).test(query)
  }
  return Object.fromEntries(Object.entries(data).filter(([name]) => named(name)))
}

/**
 * What one accepted match costs, priced per role because both halves grow with it. GrandIso keeps
 * every match as a Python dict until the search ends — measured in Pyodide at 1M matches as 225, 293
 * and 374 bytes for 3, 6 and 10 roles, about 160 plus 22 a role — and the table built afterwards is
 * 24 bytes a row, one row per role. Rounded up from the sum.
 */
const MATCH_BYTES = 192
const ROLE_BYTES = 48
/** The fewest roles a query can have: required edges connect every role, and there is one at least. */
const MIN_ROLES = 2

function affordable(roles: number): number {
  return Math.floor(CRASH_FLOOR_BYTES / (MATCH_BYTES + ROLE_BYTES * roles))
}

/**
 * The most `Max matches` may ask for, at the fewest roles: 1,864,135. The output is the one thing on
 * this card whose size nothing else bounds — a share link or a typo of fifty million would otherwise
 * end the worker in an out-of-memory error with no sentence.
 */
export const MAX_DOTMOTIF_MATCHES = affordable(MIN_ROLES)

/**
 * Why `Max matches` cannot run, or nothing: one sentence for the card and the Run. The card asks at
 * the fewest roles, since only the parse knows the count; the Run asks again with the parsed one.
 */
export function maxMatchesIssue(maxMatches: number, roles = MIN_ROLES): string | undefined {
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1) {
    return 'Max matches must be a positive whole number.'
  }
  const ofRoles = roles > MIN_ROLES ? ` of ${roles} roles` : ''
  return crashFloorIssue(
    `Up to ${maxMatches.toLocaleString()} matches${ofRoles}`,
    maxMatches * (MATCH_BYTES + ROLE_BYTES * roles),
    `Lower \`Max matches\` to ${affordable(roles).toLocaleString()} or fewer.`,
  )
}

/** The most roles `maxMatches` can afford: Python compares the parsed count before searching. */
export function maxRolesFor(maxMatches: number): number {
  return Math.floor((CRASH_FLOOR_BYTES / maxMatches - MATCH_BYTES) / ROLE_BYTES)
}
