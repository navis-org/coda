/**
 * What a wired annotation chain does to a dataset's schemas.
 *
 * **One statement, reachable from both sides of the seam**, which is the whole reason this file
 * exists rather than the rule living where either half wanted it. The edit-time half runs in
 * `src/nodes` (`schemasFromType`, so a column picker knows what to offer) and the run-time half
 * in `src/data` (`CaveSource`, so the table it builds matches). Written twice they were already
 * drifting: one took the id column off the source's own schema and the other hardcoded `str`,
 * agreeing only because every CAVE schema happens to declare `str` today. That is invariant 3 in
 * the direction nothing type-checks — a disagreement shows up after a run, as a picker offering
 * a column the table does not have.
 *
 * `src/data` may not import `src/nodes`, so it has to live on this side; `SourceSchemas` is
 * declared next door in `source.ts` and `src/nodes` reaches here freely.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { SourceSchemas } from '../source'

/**
 * Substitute a chain's columns for the dataset's own labels.
 *
 * **Replace, not merge**, which is the semantic the socket promises: whatever the chain produces
 * *is* the neuron table's label half. Merging would make the result depend on which columns the
 * backend happened to publish, so one source wired to two datastacks would give two different
 * tables. The id column survives either way — it is the one thing a chain cannot supply, since
 * it says what a neuron is *called* and the datastack says which neurons exist.
 *
 * Only `neurons` and `morphology` move: those are the two whose columns are *labels*. `points`
 * is kept on morphology because it is a fact about the geometry that was fetched, which an
 * annotation has nothing to say about.
 *
 * `connectivity` is deliberately left alone even though its `neuronType`/`partnerType` are read
 * out of the annotated index — those two are named by the seam rather than by the chain, so
 * substituting here would rename columns every downstream node addresses by name.
 */
export function withAnnotations(
  schemas: SourceSchemas,
  annotations: TableSchema | undefined,
): SourceSchemas {
  if (!annotations) return schemas
  const idColumn =
    schemas.neurons.columns.find((c) => c.name === ID_COLUMN_NAME) ??
    column(ID_COLUMN_NAME, 'str')
  const labels = annotations.columns.filter((c) => c.name !== ID_COLUMN_NAME)
  return {
    ...schemas,
    neurons: tableSchema(idColumn, ...labels),
    morphology: tableSchema(
      idColumn,
      ...labels,
      ...schemas.morphology.columns.filter((c) => c.name === 'points'),
    ),
  }
}
