import { registerNode } from '../../core/registry'
import { selectRows } from '../../core/values'
import { T } from '../../core/types'
import { requireDataset, schemasFromType, sourceLabel, sourceSupports } from '../lib/datasetParam'
import {
  SEARCH_SYNTAX_HELP,
  parseSearch,
  runSearch,
  searchIndexFor,
  validateSearch,
} from '../lib/neuronSearch'
import { rowsWithIds } from '../lib/tableOps'

/**
 * Browse and search a whole dataset.
 *
 * The counterpart to Find Neurons, and deliberately a different shape of thing. Find Neurons
 * is procedural: you state a regex and get a result. Explore is a *place to look* — it holds
 * the dataset's entire neuron table, searches it as you type, and lets you page through and
 * tick individual neurons. That is why it is the node a new graph starts with: it answers
 * "what is even in here?", which is the question a regex box cannot.
 *
 * Three outputs, because browsing, picking and *having the table* are all real intentions:
 *
 *   Hits      every neuron matching the current query — Explore as a nicer Find Neurons.
 *   Selected  only the neurons ticked in the list, regardless of the current query.
 *   All       the dataset's whole neuron index, unsearched and uncapped.
 *
 * Selection is resolved against the whole index rather than the current hits, so refining a
 * search does not silently drop neurons already chosen.
 *
 * `All` costs nothing that has not already been paid. The index is downloaded once and cached
 * (see `data/neuronIndex.ts`), and this node has it in hand the moment it evaluates — so the
 * dataset's every-neuron-every-property table becomes an ordinary Coda table for group-bys,
 * joins and charts without a second query against a shared production Neo4j. It is the *same*
 * value the loader returned rather than a copy, which columns being immutable makes safe.
 * Neither `query` nor `limit` touches it: a port called All that quietly returned the first
 * hundred rows of a search would be the worst of both.
 *
 * Expensive, like every node that can touch the network: the widget's list updates on every
 * keystroke from its own copy of the index, but *downstream* results wait for Run. Pagination
 * is presentational, so turning a page never invalidates anything.
 */

/**
 * The `refresh` nonce, per dataset, as last evaluated.
 *
 * Cache keys in Coda are provenance, so a node cannot see that a server's data changed — the
 * sanctioned escape hatch is a nonce param, exactly as the Dataset node does. The wrinkle here
 * is that bumping the nonce must reach *past* Coda's cache into the index's own persistent
 * cache, so evaluate has to know whether the nonce it was handed is new. Undefined on first
 * evaluation means "use whatever is cached", which is the point of caching it.
 */
const lastRefresh = new Map<string, number>()

/**
 * The most neurons one "select all" click may add.
 *
 * A selection is provenance, not a view: it lands in the saved file and in the cache key of
 * every node downstream, so `stableStringify` walks the whole array on every graph edit. Ten
 * thousand body ids is ~110 kB of string per key computation, which is affordable; the whole
 * of male-CNS is 165,122 of them and about 1.9 MB, which is not — it would make typing in an
 * unrelated node stutter.
 *
 * A ceiling on the *click*, deliberately, not on the param. Ticking rows by hand can still
 * carry the total past it, and a graph loaded from a file is never rewritten. What is being
 * refused is the one gesture that can add six figures of ids without meaning to.
 */
export const MAX_SELECT_ALL = 10_000

export const exploreNode = registerNode({
  type: 'neuron.explore',
  label: 'Explore',
  category: 'query',
  description:
    'Browse every neuron in a dataset. Fuzzy search across all fields, per-field filters, and a picker.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [
    { id: 'hits', label: 'Hits', type: T.neurons() },
    { id: 'selected', label: 'Selected', type: T.neurons() },
    // Last, so the two ports every existing graph is wired to keep their positions, and so a
    // link dragged off the node still starts from Hits.
    { id: 'all', label: 'All', type: T.neurons() },
  ],
  params: [
    {
      id: 'query',
      kind: 'string',
      label: 'Search',
      placeholder: 'DNp01   class==sensory   post>1000',
      help: SEARCH_SYNTAX_HELP,
      default: '',
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'neurons',
      help: `Neurons ticked in the list. Written by the widget; kept when the search changes. "Select all" adds at most ${MAX_SELECT_ALL.toLocaleString()} at a time.`,
      default: [],
    },
    {
      /*
       * Which fields the list shows as tags.
       *
       * In the inspector and not on the card: it is a control you reach for once per dataset,
       * and a multi-select above a list of neurons would spend the widget's width on its own
       * configuration. `presentational`, because it decides what the *widget draws* and cannot
       * change a byte of what either port carries — marking it otherwise would make restyling
       * a row invalidate every downstream result.
       *
       * Empty means "decide for me", which is what `rowFields` does from a priority list. A
       * default that is a real list rather than a blank would have to be written before anyone
       * knows which dataset this node points at.
       */
      id: 'chips',
      kind: 'columns',
      label: 'Tags',
      from: 'dataset',
      // A Dataset socket carries a source id, not a schema, so the picker is handed the
      // lookup: same neuron schema the outputs are inferred from, so the options are exactly
      // the columns the rows will have.
      schemaFrom: (inputs) => schemasFromType(inputs.dataset).neurons,
      help: 'Fields shown as tags on each neuron. Leave empty to choose automatically.',
      default: [],
      presentational: true,
      advanced: true,
    },
    {
      id: 'page',
      kind: 'int',
      label: 'Page',
      default: 0,
      min: 0,
      // Which page you are looking at cannot change what the ports carry, so paging must not
      // mark the node stale — otherwise browsing a dataset invalidates the whole graph.
      presentational: true,
      advanced: true,
    },
    {
      id: 'pageSize',
      kind: 'int',
      label: 'Rows per page',
      default: 25,
      min: 5,
      max: 200,
      step: 5,
      presentational: true,
      advanced: true,
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Max hits',
      help: 'Caps the Hits output only; the list itself, and the All output, always show everything. 0 means no cap.',
      default: 0,
      min: 0,
      step: 100,
      advanced: true,
    },
    {
      id: 'refresh',
      kind: 'int',
      label: 'Refresh',
      help: 'Bumped by the widget\'s reload button. Re-downloads the dataset index instead of reading the cached copy.',
      default: 0,
      min: 0,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => {
    const neurons = T.neurons(schemasFromType(ctx.inputs.dataset).neurons)
    return { hits: neurons, selected: neurons, all: neurons }
  },

  validate: (ctx) => {
    const issues = validateSearch(
      schemasFromType(ctx.inputs.dataset).neurons,
      parseSearch(String(ctx.params.query ?? '')),
    )
    if (!sourceSupports(ctx, 'neuronIndex')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      issues.push(`${label} cannot list a whole dataset — use Find Neurons instead`)
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.neuronIndex) {
      throw new Error(
        `${source.label} does not provide a neuron index, so it cannot be explored. Use Find Neurons.`,
      )
    }

    const datasetKey = `${dataset.sourceId}:${dataset.datasetId}`
    const nonce = Number(ctx.params.refresh ?? 0)
    const seen = lastRefresh.get(datasetKey)
    const refresh = seen !== undefined && seen !== nonce
    lastRefresh.set(datasetKey, nonce)

    ctx.progress(0.05, 'index')
    const index = await source.neuronIndex({
      datasetId: dataset.datasetId,
      refresh,
      // Compressed into the first three quarters: the local search that follows is
      // milliseconds, so letting it own a quarter of the bar would just look stuck at 75%.
      onProgress: (fraction, note) => ctx.progress(0.05 + fraction * 0.7, note),
      signal: ctx.signal,
    })

    ctx.progress(0.8, 'searching')
    const parsed = parseSearch(String(ctx.params.query ?? ''))
    const { rows } = runSearch(index, searchIndexFor(index), parsed)
    const limit = Number(ctx.params.limit ?? 0)
    const capped = limit > 0 ? rows.slice(0, limit) : rows

    return {
      hits: selectRows(index, capped),
      selected: rowsWithIds(index, ctx.params.selection),
      // The index itself, not a copy: nodes treat columns as immutable, and copying 165k rows
      // of twenty columns to hand back what we were just given is pure waste.
      all: index,
    }
  },
})

