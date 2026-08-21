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
 */

import type { CodaType, TableSchema } from '../../core/types'
import { T } from '../../core/types'
import type { AnnotationsValue, Value } from '../../core/values'
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
  type: T.annotations(),
  required: false,
}

/**
 * The schema a wired chain publishes, for the dataset type to carry.
 *
 * Undefined for an unwired socket *and* for a chain whose columns are not known yet — the two
 * are the same answer here on purpose, because both mean "do not substitute". A partial schema
 * would be worse than either: every column picker downstream would configure against it and
 * then have it change underneath them.
 */
export function annotationSchemaFrom(type: CodaType | undefined): TableSchema | undefined {
  return type?.kind === 'annotations' ? type.schema : undefined
}

/**
 * The annotations half of a `DatasetValue`, spread into it.
 *
 * A spread rather than a field, so a dataset with nothing wired carries no key at all — which is
 * what keeps a saved graph from gaining an `annotations: undefined` it never had.
 */
export function annotationsFrom(value: Value | undefined): { annotations?: AnnotationsValue } {
  return value?.kind === 'annotations' ? { annotations: value } : {}
}
