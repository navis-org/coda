/**
 * Partner Vectors: a connectivity edge list as one feature vector per query neuron.
 *
 * The shape argument is in `nodes/lib/partnerVectors.ts` — why a query-relative table cannot be
 * assembled out of the existing table nodes without six of them, why the direction prefix is
 * unconditional, and why an untyped partner falls back to its own id rather than joining a
 * pooled bucket.
 *
 * What belongs here is the **absence of a Pivot**. This node's output is long, one row per
 * (neuron, feature) pair, and that is not a step on the way to a matrix — it *is* the matrix,
 * in the coordinate form `Similarity Matrix` reads. A thousand neurons against their partner
 * ids is 150 million cells wide and about a million cells full; pivoting it is refused by
 * `MAX_PIVOT_COLUMNS` before it is refused by the crash floor, and neither refusal is the
 * interesting part. Nothing downstream ever wants to *look* at the dense form.
 *
 * `cheap`, and genuinely so: one pass over the edges into a map, no network and no Python. The
 * fetch it reshapes is the expensive node upstream, which is what makes trying a different
 * grouping free.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { NUMERIC_DTYPES } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  PARTNER_BY_OPTIONS,
  UNTYPED_OPTIONS,
  WEIGHTING_OPTIONS,
  partnerVectorIssues,
  partnerVectorSchema,
  partnerVectorTable,
} from '../lib/partnerVectors'
import type { PartnerBy, UntypedPolicy, VectorWeighting } from '../lib/partnerVectors'
import { idColumn } from '../lib/tableOps'

export const partnerVectorsNode = registerNode({
  type: 'neuron.partnerVectors',
  label: 'Partner Vectors',
  category: 'analysis',
  description:
    'Turn a connectivity edge list into one feature vector per query neuron, ready to compare.',
  guide:
    'Reshapes a Connectivity result from an edge list into the long form Similarity Matrix ' +
    'reads: one row per neuron and partner, with upstream and downstream kept apart as ' +
    'separate features so a neuron that receives from a type is not counted as alike to one ' +
    'that projects to it. It aggregates as it goes, so no Group By and no Pivot in between — ' +
    'the long table already is the feature matrix, and the wide one would be mostly zeroes. ' +
    'The surprise is untyped partners: they fall back to their own ids rather than pooling ' +
    'into one bucket, because a shared "untyped" feature makes strangers look similar.',
  cost: 'cheap',

  inputs: [
    { id: 'in', label: 'Connections', type: T.table() },
    /*
     * Optional, and the difference is a rule rather than a fallback. Wired, this says outright
     * which neurons were asked about and every hop is usable. Unwired, the `direction` column
     * answers the same question for the first hop only — see the lib header.
     */
    { id: 'neurons', label: 'Neurons', type: T.neurons(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Vectors', type: T.table() }],

  params: [
    {
      id: 'partnerBy',
      kind: 'enum',
      label: 'Partners by',
      default: 'type',
      options: PARTNER_BY_OPTIONS,
      help: 'What counts as one feature. Cell type is the usual choice — comparing by neuron id only finds neurons that share literal partners, which across hemispheres or animals is nothing.',
    },
    {
      id: 'untyped',
      kind: 'enum',
      label: 'Untyped partners',
      default: 'id',
      options: UNTYPED_OPTIONS,
      visibleIf: (params) => params.partnerBy !== 'id',
      help: 'A partner the dataset has not named. Using its id keeps it as its own feature, which is what it is; dropping it means the vectors no longer account for all of a neuron’s synapses.',
    },
    {
      id: 'weight',
      kind: 'column',
      label: 'Weight',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: 'weight',
      help: 'The edge strength to accumulate. Repeats of one neuron/partner pair are summed, exactly as a Pivot set to sum would.',
    },
    {
      id: 'weighting',
      kind: 'enum',
      label: 'Weights',
      default: 'raw',
      options: WEIGHTING_OPTIONS,
      help: 'Fractions are per direction, so a neuron with far more input than output still has both halves of its vector count. Worth knowing that Cosine already ignores overall magnitude — this changes the balance between the two directions, not the scale.',
    },
  ],

  inferOutputs: (ctx) => ({
    out: T.table(
      partnerVectorSchema(ctx.schema('in'), {
        weighting: String(ctx.params.weighting ?? 'raw') as VectorWeighting,
        weightColumn: ctx.column('weight'),
      }),
    ),
  }),

  validate: (ctx) =>
    partnerVectorIssues(
      ctx.schema('in'),
      String(ctx.params.partnerBy ?? 'type') as PartnerBy,
      Boolean(ctx.inputs.neurons),
    ),

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const weight = ctx.column('weight')
    if (!weight) throw new Error('Pick a numeric weight column')

    /*
     * An empty wired table is a real answer — nobody was asked about — and is not the same as
     * no wire. `idColumn` skips cells that are not ids, which is `idList.ts`' rule: a wired
     * column is data, and one bad row is not grounds to refuse the run.
     */
    const neurons = ctx.input('neurons')
    const queries = isTableValue(neurons) ? new Set(idColumn(neurons)) : undefined

    return {
      out: partnerVectorTable(
        table,
        {
          partnerBy: String(ctx.params.partnerBy ?? 'type') as PartnerBy,
          untyped: String(ctx.params.untyped ?? 'id') as UntypedPolicy,
          weightColumn: weight,
          weighting: String(ctx.params.weighting ?? 'raw') as VectorWeighting,
          ...(queries ? { queries } : {}),
        },
        ctx,
      ),
    }
  },
})
