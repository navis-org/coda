/**
 * A wired edge list — a table or a table file on a node's Edges socket, the Custom Dataset's
 * today — made into an edge set on demand.
 *
 * Every connectivity question already has one answer for a user-supplied edge set — the funnel in
 * `data/queries.ts`, walking a `LoadedEdgeSet` — so a wired edge list becomes exactly that and
 * nothing downstream learns it came from a wire. What differs from an imported set is only where
 * the set lives: built in this tab from the input, never stored (`provideEdgeSet`), and built when
 * the first question asks rather than when the dataset node runs, so the node stays `cheap` and a
 * graph that never asks about connectivity never reads the file.
 *
 * ## The id is the input, not the content
 *
 * An imported set's id is a hash of its encoded arrays, which is only known after the read. A
 * wired one is named before anything is read, so its id is what decides its content: the input's
 * provenance key and the three columns chosen from it. Same key, same columns, same edges —
 * invariant 4's argument, one layer down.
 */

import type {
  ColumnData,
  DatasetEdges,
  TableFileRef,
  TableFileValue,
  TableValue,
} from '../../core/values'
import { isTableFileValue, tableFileName } from '../../core/values'
import { sliced } from '../../core/slice'
import { rowConditions } from '../files/filters'
import { fileSpec } from '../files/registry'
import type { EdgeColumns } from './encode'
import { EdgeSetBuilder, edgeIdCell, edgeWeightCell } from './encode'
import { readTableFileEdges } from './importer'
import type { EdgeSetLoader } from './store'
import type { ReadEdgesRequest } from './tableFile'
import { provideEdgeSet } from './store'

/**
 * Register a wired edge list and return the handle a dataset value carries.
 *
 * `inputKey` is the input's provenance key: with the columns, the whole of what decides the set's
 * content. `socket` names where an in-memory table was wired, for the refusal that names it.
 */
export function wiredEdges(
  input: TableValue | TableFileValue,
  columns: EdgeColumns,
  inputKey: string,
  socket = 'Edges',
): DatasetEdges {
  const content = [inputKey, columns.pre, columns.post, columns.weight ?? '']
  if (isTableFileValue(input)) {
    const { ref, fingerprint } = input
    return {
      id: provideEdgeSet(
        content,
        fileLoader(ref, { fingerprint, ...columns, filters: rowConditions(input) }),
      ),
      name: tableFileName(ref),
    }
  }
  return {
    id: provideEdgeSet(content, tableLoader(input, columns, socket)),
    name: `the ${socket} table`,
  }
}

/*
 * The two loaders are each built in a function of their own, and that is the point rather than
 * style: a loader is kept for as long as the store remembers its set, which can outlast the
 * scheduler's hold on the input, and V8 gives every closure made in one scope the same context. A
 * loader made in a scope that also reads the whole input would keep the whole input alive. So each
 * is made where only what a rebuild reads is in scope — a file's reference, a table's three columns.
 */

function fileLoader(ref: TableFileRef, request: ReadEdgesRequest): EdgeSetLoader {
  return async (signal) => readTableFileEdges(await fileSpec(ref, signal), request, { signal })
}

function tableLoader(table: TableValue, columns: EdgeColumns, socket: string): EdgeSetLoader {
  const absent = [columns.pre, columns.post, columns.weight].find(
    (name) => name !== undefined && !table.data[name],
  )
  if (absent !== undefined) throw new Error(`The ${socket} table has no column "${absent}".`)
  const { weight } = columns
  return columnLoader(
    table.length,
    table.data[columns.pre]!,
    table.data[columns.post]!,
    weight === undefined ? undefined : table.data[weight],
  )
}

/**
 * An in-memory table's edges, encoded, with the cell rules every edge list shares (`encode.ts`).
 *
 * On this thread: the table is already held, so what a worker would save is the walk, and the
 * walk costs what copying the columns across would. So the walk is `sliced`, yielding and seeing a
 * Cancel as any long loop in a run must; the compression after it is one step.
 */
function columnLoader(
  rows: number,
  pre: ColumnData,
  post: ColumnData,
  weight: ColumnData | undefined,
): EdgeSetLoader {
  return async (signal) => {
    const builder = new EdgeSetBuilder()
    await sliced(rows, { signal }, (row) =>
      builder.add(
        edgeIdCell(pre[row]),
        edgeIdCell(post[row]),
        weight ? edgeWeightCell(weight[row]) : 1,
      ),
    )
    return builder.finish()
  }
}
