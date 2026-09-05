/**
 * Profile: a structured view of one neuron at a time.
 *
 * The counterpart to Explore, one level in. Explore answers "what is in this dataset?";
 * Profile answers "what is this cell?" — identity, classification, synaptic partners rolled
 * up by type, regional distribution, transmitter, shape. It takes a whole neuron collection
 * and pages through it, which is what makes it useful on an Explore selection or a
 * Connectivity result rather than only on a single hand-picked body.
 *
 * Three things about its shape are deliberate.
 *
 * **It is `cheap` despite the widget fetching.** `evaluate` here touches no network at all —
 * it passes the input table through and slices out the pinned row. The connectivity, ROI and
 * geometry requests belong to the widget, which issues them per neuron *viewed*, caches them
 * and never blocks a graph run. Same split as `out.neuroglancer`, and for the same reason:
 * what a viewer fetches for itself is not what the scheduler has to reason about.
 *
 * **Browsing and committing are two different params.** `page` is presentational, so paging
 * through twenty-seven neurons costs nothing and invalidates nothing downstream. `selection`
 * is not — it is what `Current` emits, and it changes only when someone pins a neuron. Had
 * the page index fed `Current` directly, every press of the pager would mark the whole
 * downstream graph stale; with auto-run on it would fire a full pass per page turn. This is
 * the same live-widget / committed-param split that makes Explore feel like a browser.
 *
 * **A subject is a neuron or a group of them, and grouping is presentational too.** With
 * `groupBy` set, the pager pages cell types (or hemilineages, or clusters) and every tile shows
 * a mean across the members with its spread beside it. That could reach the ports and does not,
 * because a pin resolves the group to its member ids before writing them: `selection` is a list
 * of neurons either way, `evaluate` is unchanged, and `Current` still emits neurons rather than
 * acquiring a second meaning. The arithmetic is `profileStats`' subject layer, which is the
 * single-neuron roll-ups run per member and folded — so the two modes cannot drift apart.
 *
 * **`minWeight` and `topN` are presentational, and that is not an oversight.** Neither can
 * change a byte of what the ports carry — the outputs are the pass-through and the pinned
 * row, and no threshold touches either. They decide what the widget *draws*, so marking them
 * otherwise would make raising a threshold invalidate every downstream result (invariant 4).
 */

import type { InferContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, columnNames, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { schemasFromType } from '../lib/datasetParam'
import { rowsWithIds } from '../lib/tableOps'

/**
 * The schema the profile reads a neuron's identity from.
 *
 * The incoming table's own schema first, because it is what the rows actually have — a table
 * that has been through Select carries fewer columns than the dataset publishes, and offering
 * the dataset's full set would advertise fields the profile then renders as blanks. The
 * dataset's neuron schema is the fallback for a table whose schema is not yet known.
 */
function profileSchema(ctx: InferContext): TableSchema {
  return schemaOf(ctx.inputs.neurons) ?? schemasFromType(ctx.inputs.dataset).neurons
}

export const profileNode = registerNode({
  type: 'out.profile',
  label: 'Neuron Profile',
  category: 'visualisation',
  /*
   * Longer than most, for `core.groupBy`'s reason: the assistant's catalogue renders param
   * `help` only at `full` detail and defaults to `lean`, so in the prompt the model actually
   * sees this node has a bare `groupBy column` line and nothing saying what it does. Whatever a
   * planner must know to *choose* this node has to be here. The first sentence is still the
   * one-liner the palette shows.
   */
  description:
    'Inspect one neuron at a time: identity, partners by type, regions, transmitter and shape. ' +
    'Set Group by to a column and it profiles whole groups instead — one cell type per page, ' +
    'every number a mean with a spread across the members.',
  // Capped at 400 characters — `help.test.ts` holds it to being a TL;DR rather than the page.
  guide:
    'Inspect one neuron at a time: identity, partners by type in both directions, synapses by ' +
    'region, transmitter, and a 3D view. Set Group by to a column and it pages those groups ' +
    'instead — a cell type, a hemilineage, a cluster — every number a mean with its spread. ' +
    'Paging is free; pinning sends what you are looking at, a whole type when grouped, out of ' +
    'the Current port and marks the graph stale.',
  cost: 'cheap',
  defaultSize: { width: 560, height: 620 },
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    /*
     * Typed `table` rather than `neurons`, so a plain Table connects too — `neurons` is a
     * subtype, so both are accepted by one port. What the profile actually needs is a
     * `neuronId` column, and that is reported by `validate` with a message naming the columns
     * the table does have, which is far easier to act on than a link the editor silently
     * refuses to make.
     */
    { id: 'neurons', label: 'Neurons', type: T.table() },
  ],
  outputs: [
    { id: 'out', label: 'Neurons', type: T.table() },
    { id: 'current', label: 'Current', type: T.neurons() },
  ],
  params: [
    {
      id: 'page',
      kind: 'int',
      label: 'Neuron',
      help: 'Which neuron of the incoming table is shown. Browsing never invalidates anything.',
      default: 0,
      min: 0,
      // The whole point of the pin: paging is looking, not deciding, so it stays out of the
      // provenance key and downstream results survive it. The pager writes it, so it is also
      // nothing anybody set — see `ParamBase.internal`.
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      /*
       * The subject the profile is about: one neuron per row, or one per distinct value here.
       *
       * A column picker rather than a `Show types` boolean, and the difference is not taste. A
       * boolean has to name `type`, which is the one thing the widget's own rule forbids — no
       * tile here names a column that must be present, because datasets disagree about nearly
       * all of them. CAVE and CATMAID spell it differently, a table through Select may not carry
       * it at all, and `Match Cell Types` publishes a *shared* label that is the only sensible
       * subject for a cross-brain profile. The same control then also profiles by hemilineage,
       * by class, or by a cluster id out of `Cut Tree`, for nothing extra.
       *
       * **Presentational, and that is a real claim about the ports.** Grouping cannot reach
       * either output because pinning resolves a group to its member ids *at pin time* — what
       * lands in `selection` is a list of neurons, so `evaluate` never learns grouping exists
       * and `Current` keeps meaning exactly what it always meant. Getting this wrong the other
       * way would put a presentational param in the provenance key (invariant 4).
       *
       * `optional`, so empty stays empty: `resolveColumn`'s rule 3 substitutes the first
       * compatible column for a *required* picker the schema has no default for, which here
       * would silently group every profile by whatever column happens to come first.
       */
      id: 'groupBy',
      kind: 'column',
      label: 'Group by',
      from: 'neurons',
      help: 'Profile every neuron sharing this column’s value together — means and spreads across a cell type rather than one cell. Leave empty for one neuron at a time.',
      default: '',
      optional: true,
      presentational: true,
    },
    {
      /*
       * Named `selection` rather than `pinned` on purpose: this is the same param the 3D and
       * network viewers write, so it travels down the write-back path the UI already has and
       * reads the same way in the inspector on every viewer.
       */
      id: 'selection',
      kind: 'ids',
      label: 'Pinned',
      noun: 'neurons',
      help:
        'The neurons the Current port emits. Written by the widget’s pin control — one neuron, ' +
        'or every member of the group when Group by is set. Kept when you page away.',
      default: [],
    },
    {
      /*
       * Which fields the identity tile shows as tags. Same param, same defaults and the same
       * `rowFields` priority list as Explore's rows, so a field is the same colour in both
       * places and neither has a private opinion about which fields matter.
       *
       * Unlike Explore's, this one reads the schema straight off the port: the incoming table
       * carries one, where a Dataset socket carries only ids. Empty means "decide for me".
       */
      id: 'chips',
      kind: 'columns',
      // "Fields" here too, and for Explore's reason: the value is a list of *columns*, and
      // Explore's neighbouring `Additional tags` names a column whose *values* are tags.
      // Leaving one of the pair called Tags would put the confusion one widget over.
      label: 'Fields',
      from: 'neurons',
      help: 'Which columns are shown as chips beside the neuron’s name. Leave empty to choose automatically.',
      default: [],
      // Empty is the normal state, so a table whose schema is not yet known must not raise a
      // warning about a control nobody has touched.
      optional: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min synapses',
      help: 'Partner connections below this are left out of the lists and the counts. Every heading says which threshold it counted at.',
      default: 1,
      min: 1,
      step: 1,
      presentational: true,
      advanced: true,
    },
    {
      id: 'topN',
      kind: 'int',
      label: 'Rows per list',
      help: 'How many entries the partner and region lists show.',
      default: 10,
      min: 3,
      max: 100,
      step: 1,
      presentational: true,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.neurons
    const schema = profileSchema(ctx)
    return {
      // Passed through as whatever came in, so a Profile dropped between two nodes does not
      // downgrade a Neurons edge into a Table one.
      out: input?.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
      current: T.neurons(schema),
    }
  },

  validate: (ctx) => {
    const input = ctx.inputs.neurons
    // Only complain when the schema is actually known — an unknown one (a raw Cypher result,
    // say) may well have a neuronId, and refusing it before anything has run would be a guess.
    if (!isTabular(input) || !input.schema) return []
    const names = columnNames(input.schema)
    if (names.includes('neuronId')) return []
    return [
      `Neuron Profile needs a "neuronId" column to identify a neuron. This table has: ${
        names.length ? names.join(', ') : '(no columns)'
      }`,
    ]
  },

  evaluate: (ctx) => {
    const table = ctx.input('neurons')
    if (!isTableValue(table)) throw new Error('Neurons input is not a table')

    return { out: table, current: rowsWithIds(table, ctx.params.selection) }
  },
})
