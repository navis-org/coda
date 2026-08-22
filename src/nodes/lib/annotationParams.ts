/**
 * The Annotations socket, shared by every dataset node that can take one.
 *
 * One declaration rather than a copy per node, for the reason `colorParams` is one factory: the
 * socket, the schema it publishes and the value it carries have to agree across nine dataset
 * nodes and the two custom ones, and a copy is how one of them comes to advertise columns it
 * does not deliver.
 *
 * **A wired source replaces the dataset's own annotations**, rather than adding to them — see
 * `data/annotations/types.ts` for why. So `annotationSchemaFrom` answering `undefined` is what
 * says "use the backend's own labels", and it is a real answer rather than a missing one.
 *
 * **The socket takes an ordinary table**, and that is the whole of what lets an annotation base
 * be cleaned up before it is used: `FlyTable → Filter → Sort → Dataset` is a wire the type
 * system now permits, along with `Upload Table → Dataset` for somebody's own cell typing. It was
 * its own `annotations` kind, which described the contract precisely and made every one of those
 * impossible.
 *
 * `T.table()` rather than `T.neurons()`, though every source does guarantee a `neuronId`: a
 * Select narrowing sixty columns to five is a legitimate clean-up and emits `table`, so the
 * stricter socket would accept Filter, Sort, Sample and Stack — which preserve neurons-ness —
 * and refuse the next op somebody reached for. "Has this column" is not a question assignability
 * answers here; `types.ts` says so, and `requireNeuronIdColumn` is the answer it points at.
 */

import type { CodaType, TableSchema } from '../../core/types'
import { T, schemaOf } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { DatasetAnnotations, Value } from '../../core/values'
import { isTableValue } from '../../core/values'
import type { PortDef } from '../../core/node'

/**
 * The socket itself.
 *
 * `required: false`, because a dataset with no annotation source is the ordinary case — every
 * neuPrint dataset and any CAVE datastack whose own table is good enough.
 */
export const ANNOTATIONS_INPUT: PortDef = {
  id: 'annotations',
  label: 'Annotations',
  type: T.table(),
  required: false,
}

/**
 * The schema a wired chain publishes, for the dataset type to carry.
 *
 * Undefined for an unwired socket *and* for a table whose columns are not known yet — the two
 * are the same answer here on purpose, because both mean "do not substitute". A partial schema
 * would be worse than either: every column picker downstream would configure against it and
 * then have it change underneath them.
 */
export function annotationSchemaFrom(type: CodaType | undefined): TableSchema | undefined {
  return schemaOf(type)
}

/**
 * The annotations half of a `DatasetValue`, spread into it.
 *
 * A spread rather than a field, so a dataset with nothing wired carries no key at all — which is
 * what keeps a saved graph from gaining an `annotations: undefined` it never had.
 *
 * The key is the caller's `ctx.inputKey('annotations')` and is required rather than optional:
 * a table with no identity would be served from — and to — whatever else had been cached under
 * the empty key, which is the silent cross-contamination this pairing exists to prevent. Both
 * arguments come off one context in one expression, so a call site cannot supply the table and
 * forget the key.
 *
 * **It refuses a table with no `neuronId`**, rather than dropping it. `annotationIssues` reports
 * the same thing at edit time, but `validate` produces *warnings* — the node still runs — and
 * the two things a run could do instead are both worse than stopping. Ignoring the wire is the
 * control that quietly does nothing, which is the failure the Network viewer's caption note and
 * `unmatchedLabels` both exist to prevent; carrying it on means `withAnnotations` merges a
 * schema whose id column is missing and every neuron comes back unlabelled, blamed on the
 * connectome. One funnel, so the two dataset nodes cannot disagree about which it does.
 */
export function annotationsFrom(
  value: Value | undefined,
  key: string | undefined,
): { annotations?: DatasetAnnotations } {
  if (!isTableValue(value)) return {}
  if (!value.schema.columns.some((c) => c.name === ID_COLUMN_NAME)) {
    throw new Error(
      `The Annotations table has no ${ID_COLUMN_NAME} column, so its labels cannot be matched ` +
        `to neurons. It has: ${value.schema.columns.map((c) => c.name).join(', ') || '(nothing)'}`,
    )
  }
  return { annotations: { key: key ?? 'unkeyed', table: value } }
}

/**
 * Whether a table wired to an Annotations socket can be used as one, as an edit-time issue.
 *
 * The `neuronId` requirement lives here rather than in the socket's type, which is the rule
 * `types.ts` states: a node needing a particular column reports it with a message naming the
 * column, instead of refusing a link and leaving somebody to work out why. Silence while the
 * schema is unknown, for `validateColumnParams`' reason — a Pivot upstream publishes nothing
 * until it has run, and warning there is a check that cries wolf.
 */
export function annotationIssues(type: CodaType | undefined): string[] {
  const schema = schemaOf(type)
  if (!schema || !schema.columns.length) return []
  if (schema.columns.some((c) => c.name === ID_COLUMN_NAME)) return []
  return [
    `The Annotations table has no ${ID_COLUMN_NAME} column, so its labels cannot be matched to neurons`,
  ]
}
