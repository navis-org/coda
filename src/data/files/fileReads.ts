/**
 * Rows out of a file value — the one way a reader on the page asks for them.
 *
 * Everything a read needs to know about the file is on the value: where it is, the fingerprint
 * its columns were read from, how many blocks it has, and the conditions any Filter Table left on
 * it. Taken off the value here rather than handed over by each caller, because a caller that
 * forgot the conditions would still compile and would hand back rows the Filter Table had
 * dropped — with nothing to say so.
 */

import type { JobRunOptions } from '../workerJob'
import type { TableFileValue } from '../../core/values'
import type { ReadRowsResult, ReadRowsRequest } from './read'
import { readTableFileRows } from './client'
import { rowConditions } from './filters'
import { fileSpec } from './registry'

/** What a reader keeps of a file value: plain facts, no rows. */
export type FileFacts = Pick<
  TableFileValue,
  'ref' | 'fingerprint' | 'blocks' | 'columns' | 'schema' | 'filters'
>

export async function readFileRows(
  file: FileFacts,
  request: Omit<ReadRowsRequest, 'fingerprint' | 'filters'>,
  options: JobRunOptions = {},
): Promise<ReadRowsResult> {
  return readTableFileRows(
    await fileSpec(file.ref, options.signal),
    { ...request, fingerprint: file.fingerprint, filters: rowConditions(file) },
    { ...options, blocks: file.blocks },
  )
}
