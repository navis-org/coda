/**
 * Match Cell Types — the correspondence two connectomes need before anything can be compared.
 *
 * The node around `matchCellTypes` ([typeMapping.ts](../lib/typeMapping.ts)), which holds the
 * algorithm and its reasoning. What lives here is everything the algorithm deliberately does not
 * know about: which datasets, which columns, where the rows come from, and what the answer looks
 * like as a table. See [comparative.md](../../../docs/comparative.md) for the decisions.
 *
 * Three of those decisions show up directly in this file.
 *
 * **It takes every dataset at once** (decision 2's prerequisite). A three-dataset mapping is not
 * two two-dataset mappings composed — cocoa's AOTU008 figures, and the reason the ports are
 * variadic rather than a pair. Nothing here lets a user chain two of these, because the chained
 * answer is finer than the true one with nothing on screen to say so.
 *
 * **It reads each dataset's whole annotation table, not the rows somebody wired in** (decision
 * 4). The evidence that `A_a` and `A_b` split from `X` very often sits entirely outside the
 * neurons you selected, so a mapper fed a selection would give a *different* answer for the same
 * two neurons depending on what else the surrounding graph happened to query. That is why the
 * inputs are Datasets rather than tables, why the node needs the `neuronIndex` capability, and
 * why it **refuses by name** where a source has not got one instead of falling back to something
 * smaller. A fallback here is a different answer wearing the same node.
 *
 * **`expensive` is a safety property, not a cost estimate** (invariant 6). Each input is a
 * multi-megabyte download from a shared server; on the cheap pass this would fire one per
 * keystroke in the ignore-labels box.
 *
 * The per-dataset type-column pickers are `types1..typesN` hidden past the current count with
 * `visibleIf`, which is the pattern `core/ports.ts` documents: ports are variadic, params are
 * not, and a hidden param is outside the provenance key so a picker past the arity cannot stale
 * a run.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { CodaType } from '../../core/types'
import {
  datasetRequest,
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import { parseTypedLabels } from '../lib/labelLookup'
import type { LabelMode, MapperDataset } from '../lib/typeMapping'
import {
  DEFAULT_NO_SPLIT_PREFIXES,
  LABEL_MODE_OPTIONS,
  MAPPER_LABELS_SCHEMA,
  MAPPER_REPORT_SCHEMA,
  UNMATCHED_WARN_FRACTION,
  synonymsFrom,
  mapperDatasetFrom,
  mapperLabelsTable,
  mapperReportTable,
  matchCellTypes,
} from '../lib/typeMapping'

/**
 * How many connectomes one mapping may span.
 *
 * Four, and it is a statement about the science rather than about the machine: FlyWire's two
 * hemispheres, the hemibrain and the maleCNS is the largest set anybody has actually asked to
 * map, and cocoa's own worked examples stop at three. Raising it costs nothing structural —
 * every port and picker is generated — but each input is a whole-brain annotation download, so
 * the number should follow a real use rather than lead it.
 */
const MAX_DATASETS = 4

/** `types1`, `types2`, … — the per-dataset column picker paired with the port at that index. */
function typesParamId(index: number): string {
  return `types${index}`
}

/**
 * The per-dataset type-column pickers, declared to `MAX_DATASETS` and hidden past the count.
 *
 * Built in a loop rather than written out four times: the four differ only in their index, and
 * four hand-written copies is four places for `from:` and `schemaFrom:` to disagree about which
 * port they read.
 */
const typeColumnParams = Array.from({ length: MAX_DATASETS }, (_, i) => {
  const index = i + 1
  // Once, not twice: `from` says which port must be connected and `schemaFrom` says where the
  // options come from, and a picker reading dataset 2's schema while resolving against dataset 3
  // shows an empty column list — which reads as a schema that has not arrived, not as a bug.
  const portId = `dataset${index}`
  return {
    id: typesParamId(index),
    kind: 'columns' as const,
    label: `Type columns ${index}`,
    from: portId,
    schemaFrom: (inputs: Readonly<Record<string, CodaType | undefined>>) =>
      schemasFromType(inputs[portId]).neurons,
    help: 'Every column naming a cell type, including the ones written in another dataset’s namespace — those cross-references are what the match is made of.',
    default: [] as string[],
    // Empty is refused by `validate` rather than by the picker, so the message can name which
    // dataset is missing its columns instead of four identical "required" marks.
    optional: true,
    visibleIf: (params: Record<string, unknown>) => Number(params.datasetCount ?? 2) >= index,
  }
})

export const matchTypesNode = registerNode({
  type: 'compare.matchTypes',
  label: 'Match Cell Types',
  category: 'analysis',
  description: 'Work out which cell types correspond between two or more connectomes.',
  guide:
    'Builds the correspondence that every cross-brain comparison needs: which cell types in one connectome are the same cells as which in another, given that type names are revised per dataset and not backported. Emits one labels table per dataset — that dataset’s own neuron ids against a shared label — plus a report, which is the part to actually read: a label with four neurons in one brain and forty in another is a mapping error rather than a finding, and the report is the only place that shows. Wire every dataset you mean to compare into one node rather than chaining two, because the answer genuinely depends on how many are in it: two subtypes stay distinct across two hemispheres that both name them and collapse the moment a third dataset knows only the coarse name.',
  cost: 'expensive',
  dataCache: true,

  inputs: [
    {
      repeat: 'datasetCount',
      ports: [{ id: 'dataset', label: 'Dataset {n}', type: T.dataset() }],
    },
    {
      id: 'extra',
      label: 'Synonyms',
      type: T.table(),
      required: false,
    },
  ],
  outputs: [
    {
      repeat: 'datasetCount',
      ports: [{ id: 'labels', label: 'Labels {n}', type: T.table(MAPPER_LABELS_SCHEMA) }],
    },
    { id: 'report', label: 'Report', type: T.table(MAPPER_REPORT_SCHEMA) },
  ],

  params: [
    {
      id: 'datasetCount',
      kind: 'int',
      label: 'Datasets',
      help: 'How many connectomes to map between. Two subtypes can stay distinct across two datasets and collapse when a third knows only the coarse label, so this is part of the question rather than a convenience.',
      default: 2,
      min: 2,
      max: MAX_DATASETS,
    },
    ...typeColumnParams,
    {
      id: 'labelMode',
      kind: 'enum',
      label: 'Name matches by',
      help: 'What a matched group is called. “Every name, joined” is the one to reach for when you want to see that two types were merged.',
      default: 'first',
      options: [...LABEL_MODE_OPTIONS],
    },
    {
      id: 'badLabels',
      kind: 'string',
      label: 'Ignore labels',
      help: 'Labels that are not cell types — “unknown”, “na”, a placeholder. Nothing in the data marks these, and left in they correspond like any other label and quietly assert that two neurons are the same cells. Commas or new lines.',
      default: '',
    },
    {
      id: 'compoundSeparator',
      kind: 'string',
      label: 'Compound separator',
      help: 'What joins two type names written in one field — “PS008,PS009”. Split into its parts so a dataset that kept them apart can match one that did not.',
      default: ',',
      advanced: true,
    },
    {
      id: 'noSplitPrefixes',
      kind: 'string',
      label: 'Never split starting with',
      help: 'Prefixes marking a label whose separator is part of its name: “(M_adPNm4,M_adPNm5)b” is one type, “CB.FB3,4A9” is a compartment path. Commas or new lines, so a prefix cannot itself contain one.',
      default: DEFAULT_NO_SPLIT_PREFIXES.join(', '),
      advanced: true,
    },
    {
      id: 'allowIndirect',
      kind: 'boolean',
      label: 'Allow indirect matches',
      help: 'Let a correspondence run through another neuron — A shares a group label with B, and B has the type that matches. Off, because that is a claim about A that the data made about B.',
      default: false,
      advanced: true,
    },
    {
      id: 'synonymLabel',
      kind: 'column',
      label: 'Synonym: label',
      from: 'extra',
      help: 'On the Synonyms table: the column holding one name.',
      default: 'label',
      /*
       * Optional, so that an empty picker means "no synonyms from this table" and stays that
       * way. Required, both of these would fall back to the *first compatible column* of
       * whatever is wired — which is the same column for both, so every row would assert that a
       * label is a synonym of itself and the port would silently do nothing.
       */
      optional: true,
      advanced: true,
    },
    {
      id: 'synonymOther',
      kind: 'column',
      label: 'Synonym: other name',
      from: 'extra',
      help: 'On the Synonyms table: the column holding the name it is the same as. The two are joined as equals; the order does not matter.',
      default: 'synonym',
      optional: true,
      advanced: true,
    },
  ],

  /*
   * No `inferOutputs`. Every schema this node publishes is a constant declared on the port
   * itself, and `outputTypesFor` already seeds each output from its declared type — so an
   * `inferOutputs` here would be a second derivation of the same two constants, kept in step
   * with the port list by hand. That is the parallel structure invariant 3 is about, in the one
   * form where it buys nothing.
   *
   * What makes the constants possible is that the *report* is long: one row per label per
   * dataset rather than a count column per dataset. See `MAPPER_REPORT_SCHEMA`.
   */

  validate: (ctx) => {
    const issues: string[] = []

    for (const port of ctx.inputPorts()) {
      if (port.group?.repeat !== 'datasetCount') continue
      const type = ctx.inputs[port.id]
      if (!type) continue
      const index = port.group.index

      /*
       * The capability, said at edit time on the card rather than at Run three layers down. A
       * source without a neuron index cannot answer "every neuron and its types", and decision 4
       * rules out falling back to whatever rows are around — so the honest thing is to name the
       * backend that cannot do it while there is still something to change.
       */
      if (!sourceSupports(type, 'neuronIndex')) {
        issues.push(
          `Dataset ${index}: ${sourceLabel(type) ?? 'This source'} cannot list a whole dataset, ` +
            `which is what matching types needs.`,
        )
      }
      if (ctx.columns(typesParamId(index)).length === 0) {
        issues.push(`Dataset ${index}: pick at least one column holding cell types.`)
      }
    }

    /*
     * Only worth saying once something is wired. The pickers are optional, so empty is a
     * decision everywhere else — but a *wired* Synonyms table with no columns chosen is a table
     * somebody went to the trouble of building and that this node is ignoring, which is the one
     * reading of "empty" that is never intended.
     */
    if (ctx.inputs.extra && (!ctx.column('synonymLabel') || !ctx.column('synonymOther'))) {
      issues.push('Synonyms: pick the two columns holding the names to treat as equivalent.')
    }
    return issues
  },

  evaluate: async (ctx) => {
    const ports = ctx.inputPorts().filter((port) => port.group?.repeat === 'datasetCount')

    /*
     * Resolved before anything is fetched, so a source that cannot answer is named while nothing
     * has been downloaded yet — four multi-megabyte indices followed by a refusal is the same
     * refusal, thirty seconds later.
     */
    const wanted = ports.map((port) => {
      const dataset = requireDataset(ctx.input(port.id), port.label ?? port.id)
      const source = ctx.resolveSource(dataset.sourceId)
      if (!source.neuronIndex) {
        throw new Error(
          `${source.label} does not publish a neuron index, so ${dataset.datasetId} cannot be ` +
            `matched on cell types. Matching reads every neuron's types, not just the ones wired ` +
            `in — see the node's guide.`,
        )
      }
      return { dataset, source, columns: ctx.columns(typesParamId(port.group!.index)) }
    })
    const names = wanted.map(({ dataset }) => dataset.datasetId)

    /*
     * Concurrently, and the progress is their mean. Each index is a separate host and separately
     * cached, so four sequential downloads would be four times the wait for no benefit — the
     * sequential version was measurably the whole cost of a first run.
     */
    const fractions = wanted.map(() => 0)
    const datasets: MapperDataset[] = await Promise.all(
      wanted.map(async ({ dataset, source, columns }, i) => {
        const index = await source.neuronIndex!({
          ...datasetRequest(dataset),
          refresh: ctx.refresh,
          onProgress: (fraction, note) => {
            fractions[i] = fraction
            const done = fractions.reduce((sum, f) => sum + f, 0) / fractions.length
            ctx.progress(done * 0.85, note ?? dataset.datasetId)
          },
          signal: ctx.signal,
        })
        return mapperDatasetFrom(index, columns)
      }),
    )

    ctx.progress(0.9, 'matching')
    const mapping = matchCellTypes(datasets, {
      badLabels: parseTypedLabels(ctx.params.badLabels),
      compoundSeparator: String(ctx.params.compoundSeparator ?? ','),
      noSplitPrefixes: parseTypedLabels(ctx.params.noSplitPrefixes),
      labelMode: ctx.params.labelMode as LabelMode,
      allowIndirect: ctx.params.allowIndirect === true,
      synonyms: synonymsFrom(
        ctx.input('extra'),
        ctx.column('synonymLabel'),
        ctx.column('synonymOther'),
      ),
      warn: ctx,
    })

    /*
     * How much of each dataset came out with no shared label — an attribution rather than a
     * threshold, in `docs/limits.md`'s sense. A mapping covering a tenth of a brain produces a
     * perfectly ordinary pair of tables, and every downstream comparison then silently describes
     * that tenth.
     */
    mapping.unmatched.forEach((count, i) => {
      const total = datasets[i]!.length
      if (!total || count / total < UNMATCHED_WARN_FRACTION) return
      ctx.warn(
        `${names[i]}: ${count.toLocaleString()} of ${total.toLocaleString()} neurons matched ` +
          `nothing in the other datasets. Anything built on this mapping describes only the rest.`,
      )
    })

    return Object.fromEntries(
      ctx
        .outputPorts()
        .map((port) => [
          port.id,
          port.group
            ? mapperLabelsTable(mapping.labels[port.group.index - 1]!)
            : mapperReportTable(mapping.report, names),
        ]),
    )
  },
})
