/**
 * The CAVE nodes, in caveclient.
 *
 * The second backend, and it is a different library rather than a different dialect: neuPrint is
 * a Neo4j behind an HTTP API that answers about neurons, and a CAVE datastack is a segmentation
 * plus a bag of annotation tables with nothing marking which of them means "neuron". So every
 * signature here is caveclient's, read off **8.2.1** by introspection rather than recalled.
 *
 * Three of those are not what an experienced user would guess:
 *
 * - **`CAVEclient(datastack, version=N)` pins the materialization for every later query**, and
 *   also sets `client.timestamp` to that materialization's own instant. That is what makes the
 *   dataset cell the only place a version appears, and what `Update root IDs` asks its
 *   chunkedgraph questions *at*.
 * - **`client.materialize.version` reads back off the frameworkclient** rather than holding its
 *   own, so pinning on the constructor really does reach `query_table`. Checked in the source,
 *   because the alternative — a per-call `materialization_version=` on every query — is a lot of
 *   argument for something that would silently query "latest" if the inheritance did not hold.
 * - **There is no token argument.** caveclient reads
 *   `~/.cloudvolume/secrets/cave-secret.json`, written once by `client.auth.setup_token()`,
 *   where neuprint-python takes one per client.
 *
 * What is *not* here yet is the query half: Find Neurons is below, and Connectivity, the
 * morphology nodes and Explore are not. Those decline through `emitterBackends` in the registry
 * rather than through a guard in each of them — see `emit.ts`, which turns an undeclared backend
 * into a TODO naming it.
 */

import { splitDatasetId, specFor } from '../../../data/cave/spec'
import { datasetRef } from '../../../core/types'
import { DATASET_FAMILIES, resolveDatasetId } from '../../../nodes/lib/datasetFamilies'
import { namedColumns } from '../../../data/annotations/types'
import { SEATABLE_HOSTS } from '../../../data/annotations/credentials'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** Backends these emitters are written against. */
const CAVE_ONLY = ['cave'] as const

// ---------------------------------------------------------------------------
// Reading a reference
// ---------------------------------------------------------------------------

/**
 * The client for a **reference** port, and the variable it took to get there.
 *
 * A reference names a node rather than consuming its output, so the referenced node's cell may
 * not have been written yet — and for the wiring references exist for it provably has not, since
 * there the dataset consumes the very node referencing it (`CAVE table → Update root IDs →
 * Dataset`). Two answers, one rule, in one place so the two readers cannot drift:
 *
 * - **The variable, where the walk bound one.** `dataset.client` reuses the connection and reads
 *   as what it is.
 * - **A fresh `CAVEclient` from the reference's *type*, where it did not.** That is exactly what
 *   a reference promises — a datastack and a materialization knowable from the referenced node's
 *   params alone — so it is a faithful equivalent rather than a guess, and the extra client costs
 *   an info call.
 *
 * Answers `undefined` where the type cannot say which datastack, which is invariant 2's ordinary
 * state on a cold session and a TODO the caller words for itself.
 */
function clientFor(
  ctx: EmitContext,
  portId: string,
  local: string,
): { expr: string; setup: string[] } | undefined {
  const bound = ctx.input(portId)
  if (bound) return { expr: `${bound}.client`, setup: [] }

  const datasetId = datasetRef(ctx.inputType(portId))?.datasetId
  const parsed = datasetId ? splitDatasetId(datasetId) : undefined
  if (!parsed) return undefined
  ctx.require('caveclient', 'CAVEclient')
  return {
    expr: local,
    setup: [
      ...ctx.note(
        'The Dataset wired here is a reference — it names a datastack rather than taking its ' +
          'value — and its cell is written below this one, so this builds its own client for ' +
          'the same datastack and materialization.',
      ),
      `${local} = CAVEclient(${pyStr(parsed.datastack)}, version=${parsed.version})`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/**
 * One `CodaCaveDataset` per dataset node — a client, and the labels Coda would put on it.
 *
 * The neuPrint side binds a bare `Client`, and this deliberately does not. A Coda dataset value
 * on CAVE is a client **and** a neuron table, because the datastack's labels live in an
 * annotation table that anything wired to the Annotations socket *replaces* — so one Python name
 * has to carry both. The helper's docstring says so; see `caveHelpers.ts` for why `labels` is
 * lazy rather than fetched here.
 */
function datasetCell(ctx: EmitContext, datasetId: string | undefined): string[] {
  if (!datasetId) {
    return ctx.todo(
      'This CAVE dataset could not be resolved to a datastack and materialization, so there ' +
        'is nothing to point a client at. Set a materialization on the node and export again.',
    )
  }
  const parsed = splitDatasetId(datasetId)
  if (!parsed) return ctx.todo(`"${datasetId}" is not a datastack and materialization.`)

  ctx.require('caveclient', 'CAVEclient')
  ctx.helper('CodaCaveDataset')

  const out = ctx.output('dataset')
  const client = `CAVEclient(${pyStr(parsed.datastack)}, version=${parsed.version})`

  /*
   * A wired chain replaces the datastack's own labels, which is what the socket means on the
   * canvas — so the frame goes straight in and nothing is fetched. Note this is the *only* way
   * a datastack with no neuron table (Aedes publishes synapses and nuclei and no annotations at
   * all) can say which neurons exist.
   */
  const chain = ctx.input('annotations')
  if (chain) {
    return [
      ...ctx.note(
        'Annotations are wired to this dataset on the canvas, so they replace the ' +
          "datastack's own labels rather than adding to them.",
      ),
      `${out} = CodaCaveDataset(`,
      `    ${client},`,
      `    labels=${chain},`,
      `)`,
    ]
  }

  const spec = specFor(parsed.datastack)
  if (!spec?.neurons) {
    return [
      ...ctx.note(
        `Coda has no table spec for "${parsed.datastack}", so this client can be queried by ` +
          'root id but cannot enumerate neurons. Pass `neuron_table=` and `id_column=` below, ' +
          'or wire an Annotations source on the canvas.',
      ),
      `${out} = CodaCaveDataset(${client})`,
    ]
  }

  const args = [
    `    neuron_table=${pyStr(spec.neurons.table)},`,
    `    id_column=${pyStr(spec.neurons.idColumn)},`,
  ]
  if (spec.annotations) {
    args.push(
      `    annotation_table=${pyStr(spec.annotations.table)},`,
      `    ref_column=${pyStr(spec.annotations.refColumn)},`,
      `    system_column=${pyStr(spec.annotations.systemColumn)},`,
      `    value_column=${pyStr(spec.annotations.valueColumn)},`,
    )
  }
  return [`${out} = CodaCaveDataset(`, `    ${client},`, ...args, `)`]
}

/*
 * The published families, on the same `DatasetFamily.notebook` test the neuPrint loop makes —
 * one statement of which families each exporter covers, read by `canExportNotebook` too, rather
 * than a source-id test that would part company with it.
 */
for (const family of DATASET_FAMILIES) {
  if (family.notebook?.python !== 'caveclient') continue
  registerEmitter(
    `dataset.${family.key}`,
    (ctx) => datasetCell(ctx, resolveDatasetId(family, ctx.params.version)),
    { backends: [...CAVE_ONLY] },
  )
}

registerEmitter(
  'dataset.cave',
  (ctx) => {
    const datastack = String(ctx.params.datastack ?? '').trim()
    if (!datastack) return ctx.todo('This CAVE node names no datastack.')
    const version = String(ctx.params.version ?? '').trim()
    if (!version) {
      /*
       * "Latest" is resolved by a network call the exporter has not made — the same gap the
       * neuPrint dataset emitter notes for an unpinned release, and a worse one here: a
       * materialization *expires*, so an unpinned notebook answers a different question every
       * few months with nothing saying so.
       */
      return [
        ...ctx.todo(
          `This node tracks the newest materialization of "${datastack}" and the exporter ` +
            'could not resolve which that is. Pin one on the node, or pass `version=` below.',
        ),
      ]
    }
    return datasetCell(ctx, `${datastack}:${version}`)
  },
  { backends: [...CAVE_ONLY] },
)

// ---------------------------------------------------------------------------
// CAVE table — an annotation source
// ---------------------------------------------------------------------------

/**
 * A CAVE annotation table, read directly.
 *
 * Its Dataset input is a **reference**: it names the datastack to read the table out of and
 * consumes nothing, which is what lets `Dataset → CAVE table → Dataset` exist on the canvas at
 * all. Unwired, the `datastack` param names one — so the emitted cell may have to build a second
 * client, and does so rather than reaching for the referenced one, because the whole point of
 * the param is reading a table out of a *different* datastack.
 */
registerEmitter(
  'annotation.caveTable',
  (ctx) => {
    const table = String(ctx.params.table ?? '').trim()
    if (!table) return ctx.todo('This CAVE table node names no table.')

    /*
     * A wired Dataset wins over the param, which is the precedence a socket always takes here and
     * the one `caveRef` applies on the canvas. Unwired, the param names the datastack — which is
     * the node's ordinary configuration, since the wire exists for the *cross-datastack* case.
     */
    const lines: string[] = []
    let client: string
    if (ctx.inputType('dataset')) {
      const resolved = clientFor(ctx, 'dataset', '_cave')
      if (!resolved) {
        return ctx.todo(
          'The Dataset wired to this CAVE table has not resolved to a datastack and ' +
            'materialization yet, so there is nothing to point a client at.',
        )
      }
      client = resolved.expr
      lines.push(...resolved.setup)
    } else {
      const datastackParam = String(ctx.params.datastack ?? '').trim()
      const parsed = splitDatasetId(datastackParam)
      if (!parsed) {
        return ctx.todo(
          `"${datastackParam || '(none)'}" is not a datastack and materialization. Name one as ` +
            '`flywire_fafb_public:783`, or wire a Dataset.',
        )
      }
      ctx.require('caveclient', 'CAVEclient')
      client = '_cave'
      lines.push(`_cave = CAVEclient(${pyStr(parsed.datastack)}, version=${parsed.version})`)
    }

    ctx.helper('coda_cave_table')
    const idColumn = String(ctx.params.idColumn ?? 'pt_root_id').trim() || 'pt_root_id'
    const pivotOn = String(ctx.params.pivotOn ?? '').trim()
    const valueColumn = String(ctx.params.valueColumn ?? '').trim()
    const columns = namedColumns(String(ctx.params.columns ?? ''), idColumn)

    const args = [`    ${client},`, `    ${pyStr(table)},`, `    id_column=${pyStr(idColumn)},`]
    if (columns.length > 0) args.push(`    columns=${pyList(columns)},`)
    if (pivotOn) {
      if (!valueColumn) {
        return ctx.todo('Pivot on is set on this CAVE table but the value column is not.')
      }
      args.push(`    pivot_on=${pyStr(pivotOn)},`, `    value_column=${pyStr(valueColumn)},`)
    }

    const out = ctx.output('annotations')
    lines.push(`${out} = coda_cave_table(`, ...args, `)`)

    // Sources chain, and a later one wins a collision — falling back to the earlier where it
    // has no value. `coda_join_annotations` is that rule; see its docstring.
    const upstream = ctx.input('annotations')
    if (upstream) {
      ctx.helper('coda_join_annotations')
      lines.push(`${out} = coda_join_annotations(${upstream}, ${out})`)
    }
    return lines
  },
  { backends: [...CAVE_ONLY] },
)

// ---------------------------------------------------------------------------
// Update root IDs
// ---------------------------------------------------------------------------

/**
 * The repair, and the reason its Dataset input is a reference.
 *
 * It sits between an annotation source and the dataset that source feeds, which at node
 * granularity is a cycle — so the port names the datastack rather than consuming its value.
 * Nothing here reads `dataset.labels`; what it wants is `dataset.client`, whose `timestamp` is
 * the materialization the ids are being brought forward *to*.
 */
registerEmitter(
  'cave.updateRootIds',
  (ctx) => {
    const supervoxel = ctx.column('supervoxelColumn')
    if (!supervoxel) {
      return ctx.todo(
        'No supervoxel column is set on this Update root IDs, and a supervoxel is the only ' +
          'stable handle a retired root id can be recovered from.',
      )
    }
    ctx.helper('coda_update_root_ids')
    const idColumn = ctx.column('idColumn') ?? 'neuronId'
    const version = String(ctx.params.version ?? '').trim()

    const lines: string[] = []
    let client: string
    if (version) {
      /*
       * A materialization named on the node overrides the dataset's, and `client.timestamp` is
       * read off the client — so honouring it means a second client rather than an argument.
       * Uncommon, and silently ignoring it would repair the ids to the wrong instant.
       */
      const datasetId = datasetRef(ctx.inputType('dataset'))?.datasetId
      const parsed = datasetId ? splitDatasetId(datasetId) : undefined
      if (!parsed) {
        return ctx.todo(
          'This Update root IDs pins a materialization, and the Dataset wired to it has not ' +
            'resolved to a datastack, so there is nothing to pin it against.',
        )
      }
      ctx.require('caveclient', 'CAVEclient')
      client = '_repair_at'
      lines.push(
        `_repair_at = CAVEclient(${pyStr(parsed.datastack)}, version=${Number(version)})`,
      )
    } else {
      const resolved = clientFor(ctx, 'dataset', '_repair_at')
      if (!resolved) {
        return ctx.todo(
          'The Dataset wired to this Update root IDs has not resolved to a datastack and ' +
            'materialization, so there is no instant to bring the ids forward to.',
        )
      }
      client = resolved.expr
      lines.push(...resolved.setup)
    }

    lines.push(
      `${ctx.output('out')} = coda_update_root_ids(`,
      `    ${client},`,
      `    ${ctx.wired('in')},`,
      `    id_column=${pyStr(idColumn)},`,
      `    supervoxel_column=${pyStr(supervoxel)},`,
      `)`,
    )
    return lines
  },
  { backends: [...CAVE_ONLY] },
)

// ---------------------------------------------------------------------------
// SeaTable — the other annotation source
// ---------------------------------------------------------------------------

/**
 * `FlyTable` and `SeaTable`, through **sea-serpent**.
 *
 * Two registrations over one emitter, exactly as the nodes are two registrations over one
 * implementation: the same API at two hosts, differing in the host and the name somebody looks
 * for. Everything below was verified live against FlyTable rather than read off a README.
 *
 * - **`Table(name, base=…)` resolves the base itself**, by enumerating the account's workspaces
 *   (`find_base`). So Coda's `Workspace` param has no argument to map onto — it exists because
 *   the REST API addresses a base by workspace *and* name, which is bookkeeping sea-serpent does
 *   for you. Where one is set on the canvas the cell says so rather than dropping it silently.
 * - **The credential is `SEATABLE_TOKEN`**, which sea-serpent reads from the environment itself;
 *   it is passed explicitly anyway, so the cell says out loud what it needs. Two deployments are
 *   two unrelated accounts, so a graph reading both wants two tokens and one env var cannot
 *   serve them — the note says which server each cell is pointed at.
 */
function seaTableCell(ctx: EmitContext, defaultHost: string): string[] {
  const base = String(ctx.params.base ?? '').trim()
  const table = String(ctx.params.table ?? '').trim()
  if (!base || !table) return ctx.todo('This node names no base and table.')

  ctx.require('os')
  ctx.require('seaserpent')
  ctx.helper('coda_seatable')

  const host = String(ctx.params.host ?? '').trim() || defaultHost
  const idColumn = String(ctx.params.idColumn ?? 'root_id').trim() || 'root_id'
  const columns = namedColumns(String(ctx.params.columns ?? ''), idColumn)
  const out = ctx.output('annotations')
  const lines: string[] = []

  const workspace = String(ctx.params.workspace ?? '').trim()
  if (workspace) {
    lines.push(
      ...ctx.note(
        `The node names workspace "${workspace}"; sea-serpent finds the base by enumerating the ` +
          'account\u2019s workspaces, so there is nothing to pass it. If two workspaces hold a ' +
          `base called "${base}" it will say so.`,
      ),
    )
  }

  lines.push(
    `_sea = ss.Table(`,
    `    ${pyStr(table)},`,
    `    base=${pyStr(base)},`,
    `    server=${pyStr(host)},`,
    `    auth_token=os.environ['SEATABLE_TOKEN'],`,
    `)`,
  )

  if (columns.length > 0) {
    /*
     * Offered as a comment rather than emitted, which is the Network viewer's layout idiom. The
     * whole-table read is what the canvas does and what `coda_seatable` mirrors, and it keeps
     * sea-serpent's sanitised dtypes — a `query` hands back raw records. Measured live: 3.3 s
     * for all 52 columns of FlyTable's `main.info`, 0.8 s for three.
     */
    const sql = [idColumn, ...columns].map((c) => `\`${c}\``).join(', ')
    lines.push(
      `# Every column is downloaded and then narrowed, as it is on the canvas. To narrow it`,
      `# server-side instead \u2014 measured at about 4x faster, at the cost of sea-serpent's`,
      `# dtype conversion \u2014 replace the call below with:`,
      `#     _rows = _sea.query('SELECT ${sql} FROM \`${table}\`', no_limit=True)`,
      `#     ${out} = coda_annotation_columns(pd.DataFrame(_rows), ${pyStr(idColumn)})`,
    )
  }

  lines.push(
    `${out} = coda_seatable(`,
    `    _sea,`,
    `    id_column=${pyStr(idColumn)},`,
    ...(columns.length > 0 ? [`    columns=${pyList(columns)},`] : []),
    `)`,
  )

  const upstream = ctx.input('annotations')
  if (upstream) {
    ctx.helper('coda_join_annotations')
    lines.push(`${out} = coda_join_annotations(${upstream}, ${out})`)
  }
  return lines
}

for (const [type, host] of [
  ['annotation.flyTable', SEATABLE_HOSTS.flytable],
  ['annotation.seaTable', SEATABLE_HOSTS.seatable],
] as const) {
  registerEmitter(type, (ctx) => seaTableCell(ctx, host))
}

// ---------------------------------------------------------------------------
// The two discovery nodes
// ---------------------------------------------------------------------------

/**
 * `List CAVE tables` and `CAVE table info`, which map onto caveclient about as directly as
 * anything in this file.
 *
 * Both take the datastack the same way the nodes do — a **reference** Dataset input that names a
 * datastack without consuming it, or the `datastack` param when nothing is wired — so `clientFor`
 * above is the whole of that logic and these two do not restate it. The wire wins, which is the
 * precedence every CAVE emitter here applies.
 *
 * The work is in the helpers rather than inline, because in both cases it is more than one call
 * and the interesting part is *which* calls: two listing endpoints for the first, and for the
 * second a metadata read, two counts that disagree, and a one-row query whose `split_positions`
 * argument is what makes the answer the same one the app gives. See `caveHelpers.ts`.
 */
function discoveryClient(ctx: EmitContext): { expr: string; setup: string[] } | undefined {
  // One local name, unlike `clientFor`'s caller above — `Update root IDs` needs `_repair_at`
  // because it may pin a *different* materialization than the dataset it hangs off.
  const local = '_cave'
  if (ctx.inputType('dataset')) return clientFor(ctx, 'dataset', local)
  const parsed = splitDatasetId(String(ctx.params.datastack ?? '').trim())
  if (!parsed) return undefined
  ctx.require('caveclient', 'CAVEclient')
  return {
    expr: local,
    setup: [`${local} = CAVEclient(${pyStr(parsed.datastack)}, version=${parsed.version})`],
  }
}

/** The sentence both of these say when neither the wire nor the field named a datastack. */
const NO_DATASTACK =
  'This node has no datastack and materialization — neither from the Dataset wired to it nor ' +
  'from its own field. Name one as `flywire_fafb_public:783`, or pin a materialization on the ' +
  'Dataset node, and export again.'

registerEmitter(
  'cave.tables',
  (ctx) => {
    const resolved = discoveryClient(ctx)
    if (!resolved) return ctx.todo(NO_DATASTACK)
    ctx.helper('coda_cave_tables')
    /*
     * `include_views` is passed rather than defaulted, so the cell states the node's setting even
     * where it matches the helper's default. A reader comparing the notebook against the canvas
     * should not have to know which way the default went.
     */
    const includeViews = Boolean(ctx.params.includeViews)
    return [
      ...resolved.setup,
      `${ctx.output('out')} = coda_cave_tables(${resolved.expr}, include_views=${includeViews ? 'True' : 'False'})`,
    ]
  },
  { backends: [...CAVE_ONLY] },
)

registerEmitter(
  'cave.tableInfo',
  (ctx) => {
    const table = String(ctx.params.table ?? '').trim()
    if (!table) return ctx.todo('This CAVE table info node names no table or view.')
    const resolved = discoveryClient(ctx)
    if (!resolved) return ctx.todo(NO_DATASTACK)
    ctx.helper('coda_cave_table_info')
    return [
      ...ctx.note(
        'The card in Coda shows this table’s description and row counts; here they are ' +
          'printed, and the column listing is what the cell binds.',
      ),
      ...resolved.setup,
      `${ctx.output('columns')} = coda_cave_table_info(${resolved.expr}, ${pyStr(table)})`,
    ]
  },
  { backends: [...CAVE_ONLY] },
)
