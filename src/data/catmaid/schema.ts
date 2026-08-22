/**
 * What a CATMAID table looks like, and which of its columns are Coda's rather than CATMAID's.
 *
 * Two names are cross-layer agreements and are mapped here at the source's own edge, which is
 * invariant 8's shape and the same thing `neuprint/schema.ts` and `cave/schema.ts` do:
 * **`neuronId`** is the skeleton id, and **`type`** is the label derived from the neuron-name
 * annotation. Everything else keeps a name of its own and is a passthrough only a column picker
 * ever addresses.
 *
 * `neuronId` is the **skeleton** id, never the neuron id, and the two genuinely differ —
 * `{'id': 27296, 'skeleton_ids': [27295]}` on FAFB. Every endpoint that takes an id takes the
 * skeleton, so a table keyed on the neuron would join to nothing and each id would be off by a
 * value or two, which is exactly the kind of wrong that looks right.
 */

import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { SourceSchemas } from '../source'

/**
 * The neuron table.
 *
 * `nodes` rather than `size`: neuPrint's `size` is a voxel count and CATMAID has no such
 * measure, so reusing the name would put two different quantities in one column across
 * backends. A traced skeleton's node count is the closest honest analogue and says what it is.
 *
 * `cableLength` is nanometres, which needs no conversion here — see `POINTS_ARE_NM`.
 *
 * There is deliberately **no `status`**. CATMAID has no such field; its review status is a
 * pair of node counts and is 0 across the whole of the public FAFB instance. Publishing an
 * always-null column would be worse than its absence, and `DatasetInfo.statuses` is empty so
 * the Find Neurons picker offers only `Any` — with `findNeurons` ignoring the parameter
 * outright, which is the half that matters. A source that publishes no statuses but still
 * *filters* on one drops every row for a default nobody chose.
 */
export const CATMAID_NEURON_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'i64'),
  column('name', 'str'),
  column('type', 'str'),
  column('instance', 'str'),
  column('ontologyId', 'str'),
  column('annotations', 'str'),
  column('nodes', 'i64'),
  column('cableLength', 'f64', 'nm'),
)

export const CATMAID_CONNECTIVITY_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'i64'),
  column('neuronType', 'str'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

export const CATMAID_MORPHOLOGY_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'i64'),
  column('name', 'str'),
  column('type', 'str'),
  column('instance', 'str'),
  column('points', 'i64'),
  column('cableLength', 'f64', 'nm'),
)

/**
 * Per-synapse attributes.
 *
 * **No `partnerId`**, and the absence is deliberate rather than pending. `connectors/links/`
 * answers the queried skeletons' own links; the partner on the other side of a connector belongs
 * to a *different* skeleton, so naming it means a second POST per connector set to
 * `connector/skeletons`. That is a real fetch with a real cost, and a cloud drawn in 3D or
 * counted by region needs none of it — so it is left out rather than paid for on every call.
 * `connectorId` is carried instead, which is what a caller would join on if they wanted it.
 */
export const CATMAID_SYNAPSE_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('connectorId', 'i64'),
  column('polarity', 'str'),
  column('confidence', 'i64'),
)

export const CATMAID_ROI_COUNTS_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('roi', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

export const CATMAID_SCHEMAS: SourceSchemas = {
  neurons: CATMAID_NEURON_SCHEMA,
  connectivity: CATMAID_CONNECTIVITY_SCHEMA,
  roiCounts: CATMAID_ROI_COUNTS_SCHEMA,
  morphology: CATMAID_MORPHOLOGY_SCHEMA,
  synapses: CATMAID_SYNAPSE_SCHEMA,
}
