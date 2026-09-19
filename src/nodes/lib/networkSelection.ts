/**
 * What a network viewer's `Selected` port carries.
 *
 * Two viewers draw a `NetworkValue` and both hand back the nodes somebody clicked —
 * `out.network` and `out.flowChart` — and both had their own copy of this derivation. It is the
 * schema half of invariant 3 for each of them, so a copy means the `neuronId`-in-front rule has
 * to be changed in two files and only one of them carries the argument for it.
 *
 * **The argument, once.** The output is typed `Neurons`, which promises `neuronId`, but a network
 * node id is a string that may be a neuron id at neuron level or a cell type name at type level.
 * So `neuronId` is derived from the id, and a type-level selection flows downstream as type names
 * — failing loudly at the next query rather than quietly passing for neurons.
 *
 * **Only the schema is shared, and the two fills genuinely differ.** `out.network` emits `null`
 * for an id that is not a neuron id, on the grounds that `LC4` under a column called `neuronId`
 * fails silently three nodes downstream; `out.flowChart` writes the name through, on the grounds
 * that it then fails *loudly* at the next query. Both are argued and both are tested, so lifting
 * the fill would be picking a winner rather than removing a duplicate.
 *
 * What they may not do is differ on the *id*. `out.network` decided the question with
 * `Number(id)`, which rounds an 18-digit root id to a different neuron before answering it —
 * invariant 8's failure, and visible only once the schema here declared the column `str`. Both
 * now go through `core/ids.ts`.
 */

import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'

export function networkSelectionSchema(nodeSchema: TableSchema | undefined): TableSchema {
  const extra = (nodeSchema?.columns ?? []).filter((c) => c.name !== 'neuronId')
  return tableSchema(column('neuronId', 'str'), ...extra)
}
