import type { TableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import type { DotMotifResult } from '../../pyodide/dotmotif'

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

export function dotmotifTable(result: DotMotifResult): TableValue {
  return {
    kind: 'table',
    schema: dotmotifSchema(),
    data: { matchId: result.matchId, variable: result.variable, nodeId: result.nodeId },
    length: result.matchId.length,
  }
}
