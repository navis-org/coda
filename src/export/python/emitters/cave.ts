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
 * What each node decides — which datastack it reads, its refusals — is `plans/cave.ts`, which the R
 * document's `r/emitters/cave.ts` renders too. The query half (Find Neurons, Explore, Synapses
 * Between) lives with the other query emitters; Connectivity and the morphology nodes are not
 * written for CAVE and decline through `emitterBackends` (`export/backends.ts`).
 */

import type { CaveTarget } from '../../../nodes/lib/caveParams'
import { isDefaultCaveServer, normaliseCaveServer } from '../../../data/cave/deployments'
import { DATASET_FAMILIES } from '../../../nodes/lib/datasetFamilies'
import { namedColumns } from '../../../data/annotations/types'
import { SEATABLE_HOSTS } from '../../../data/annotations/credentials'
import type { CaveDatasetPlan, CaveTargetPlan } from '../../plans/cave'
import {
  CAVE_TEXT,
  caveFamilyDatasetPlan,
  caveInfoTable,
  caveNodeDatasetPlan,
  caveTablePlan,
  caveTargetPlan,
  rootIdsMethodPlan,
} from '../../plans/cave'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** Backends these emitters are written against. */
const CAVE_ONLY = { backends: ['cave'] }

/**
 * A `CAVEclient` pinned to a datastack and materialization, on the deployment it lives on.
 *
 * **`server_address` only where the deployment is not the default**, and that asymmetry is the
 * point rather than a saving. caveclient's own default global server is `global.daf-apis.com`, so
 * leaving it out there is exactly what the canvas does — and the goldens, every exported FlyWire
 * notebook, and the line a reader would have written by hand all stay as they were. Anywhere else
 * it is the difference between the notebook asking the right info service and asking
 * `global.daf-apis.com` about a datastack it has never heard of: H01's `h01_c3_flat` is listed by
 * `global.brain-wire-test.org` alone, which is also what navis' `h01.py` passes.
 */
function caveClient(target: CaveTarget): string {
  const address = isDefaultCaveServer(target.deployment)
    ? ''
    : `, server_address=${pyStr(normaliseCaveServer(target.deployment))}`
  return `CAVEclient(${pyStr(target.datastack)}${address}, version=${target.version})`
}

/**
 * The client a planned target spells: the bound dataset's `.client`, or a fresh `CAVEclient`
 * under `local` — with a note where it is borrowed from a reference whose cell comes later, the
 * wiring references exist for (`CAVE table → Update root IDs → Dataset`).
 */
function clientLines(
  ctx: EmitContext,
  plan: Exclude<CaveTargetPlan, { refusal: string }>,
  local: string,
): { expr: string; setup: string[] } {
  if ('bound' in plan) return { expr: `${plan.bound}.client`, setup: [] }
  ctx.require('caveclient', 'CAVEclient')
  return {
    expr: local,
    setup: [
      ...(plan.borrowed
        ? ctx.note(
            'The Dataset wired here only names a datastack, and its cell comes after this one, so ' +
              'this cell builds its own client for the same datastack and materialization.',
          )
        : []),
      `${local} = ${caveClient(plan.fresh)}`,
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
 * has to carry both. See `caveHelpers.ts` for why `labels` is lazy rather than fetched here.
 */
function datasetCell(ctx: EmitContext, plan: CaveDatasetPlan): string[] {
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  ctx.require('caveclient', 'CAVEclient')
  ctx.helper('CodaCaveDataset')
  const out = ctx.output('dataset')
  const client = caveClient(plan.target)

  // A wired chain replaces the datastack's own labels, which is what the socket means on the
  // canvas — and the only way a datastack with no neuron table can say which neurons exist.
  const chain = ctx.input('annotations')
  if (chain) {
    return [
      ...ctx.note(CAVE_TEXT.chainReplaces),
      `${out} = CodaCaveDataset(`,
      `    ${client},`,
      `    labels=${chain},`,
      `)`,
    ]
  }
  if (!plan.neurons) {
    return [
      ...ctx.note(CAVE_TEXT.noNeuronTable(plan.target.datastack)),
      `${out} = CodaCaveDataset(${client})`,
    ]
  }
  const args = [
    `    neuron_table=${pyStr(plan.neurons.table)},`,
    `    id_column=${pyStr(plan.neurons.idColumn)},`,
  ]
  if (plan.annotations) {
    args.push(
      `    annotation_table=${pyStr(plan.annotations.table)},`,
      `    ref_column=${pyStr(plan.annotations.refColumn)},`,
      `    system_column=${pyStr(plan.annotations.systemColumn)},`,
      `    value_column=${pyStr(plan.annotations.valueColumn)},`,
    )
  }
  return [`${out} = CodaCaveDataset(`, `    ${client},`, ...args, `)`]
}

/*
 * The published families, on the same `DatasetFamily.notebook` test the neuPrint loop makes —
 * one statement of which families each exporter covers, read by `canExportNotebook` too.
 */
for (const family of DATASET_FAMILIES) {
  if (family.notebook?.python !== 'caveclient') continue
  registerEmitter(
    `dataset.${family.key}`,
    (ctx) => datasetCell(ctx, caveFamilyDatasetPlan(family, ctx.params)),
    CAVE_ONLY,
  )
}

registerEmitter(
  'dataset.cave',
  (ctx) => datasetCell(ctx, caveNodeDatasetPlan(ctx.params)),
  CAVE_ONLY,
)

// ---------------------------------------------------------------------------
// CAVE table — an annotation source
// ---------------------------------------------------------------------------

/**
 * A CAVE annotation table, read directly.
 *
 * Its Dataset input is a **reference**: it names the datastack to read the table out of and
 * consumes nothing, which is what lets `Dataset → CAVE table → Dataset` exist on the canvas at
 * all. Unwired, the `datastack` param names one — so the cell may build a second client, rather
 * than reaching for the referenced one, because the whole point of the param is reading a table
 * out of a *different* datastack.
 */
registerEmitter(
  'annotation.caveTable',
  (ctx) => {
    const reading = caveTablePlan(ctx.params)
    if (reading.refusal !== undefined) return ctx.todo(reading.refusal)
    const target = caveTargetPlan(ctx, 'table')
    if (target.refusal !== undefined) return ctx.todo(target.refusal)
    const { expr, setup } = clientLines(ctx, target, '_cave')

    ctx.helper('coda_cave_table')
    const args = [
      `    ${expr},`,
      `    ${pyStr(reading.table)},`,
      `    id_column=${pyStr(reading.idColumn)},`,
    ]
    if (reading.columns.length > 0) args.push(`    columns=${pyList(reading.columns)},`)
    if (reading.pivot) {
      args.push(
        `    pivot_on=${pyStr(reading.pivot.on)},`,
        `    value_column=${pyStr(reading.pivot.value)},`,
      )
    }
    const out = ctx.output('annotations')
    const lines = [...setup, `${out} = coda_cave_table(`, ...args, `)`]

    // Sources chain, and a later one wins a collision — falling back to the earlier where it
    // has no value. `coda_join_annotations` is that rule; see its docstring.
    const upstream = ctx.input('annotations')
    if (upstream) {
      ctx.helper('coda_join_annotations')
      lines.push(`${out} = coda_join_annotations(${upstream}, ${out})`)
    }
    return lines
  },
  CAVE_ONLY,
)

// ---------------------------------------------------------------------------
// Update root IDs
// ---------------------------------------------------------------------------

/**
 * The repair, and the reason its Dataset input is a reference: it sits between an annotation
 * source and the dataset that source feeds, which at node granularity is a cycle. What it wants is
 * `dataset.client`, whose `timestamp` is the materialization the ids are brought forward *to*.
 */
registerEmitter(
  'cave.updateRootIds',
  (ctx) => {
    const method = rootIdsMethodPlan(ctx)
    if (method.refusal !== undefined) return ctx.todo(method.refusal)
    const target = caveTargetPlan(ctx, 'repair')
    if (target.refusal !== undefined) return ctx.todo(target.refusal)
    const { expr, setup } = clientLines(ctx, target, '_repair_at')

    // A majority vote reads no supervoxel; its helper is the canvas's `rootsByMajority`.
    const helper =
      method.supervoxelColumn === undefined
        ? 'coda_update_root_ids_majority'
        : 'coda_update_root_ids'
    ctx.helper(helper)
    return [
      ...setup,
      `${ctx.output('out')} = ${helper}(`,
      `    ${expr},`,
      `    ${ctx.wired('in')},`,
      `    id_column=${pyStr(ctx.column('idColumn') ?? 'neuronId')},`,
      method.supervoxelColumn === undefined
        ? `    sample=${method.sample},`
        : `    supervoxel_column=${pyStr(method.supervoxelColumn)},`,
      `)`,
    ]
  },
  CAVE_ONLY,
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
  const base = String(ctx.params.base).trim()
  const table = String(ctx.params.table).trim()
  if (!base || !table) return ctx.todo('This node has no `Base` or `Table` set.')

  ctx.require('os')
  ctx.require('seaserpent')
  ctx.helper('coda_seatable')

  const host = String(ctx.params.host).trim() || defaultHost
  const idColumn = String(ctx.params.idColumn).trim() || 'root_id'
  const columns = namedColumns(String(ctx.params.columns), idColumn)
  const out = ctx.output('annotations')
  const lines: string[] = []

  const workspace = String(ctx.params.workspace).trim()
  if (workspace) {
    lines.push(
      ...ctx.note(
        `sea-serpent finds the base by searching every workspace in the account, so ` +
          `\`Workspace\` ("${workspace}") is not passed. If two workspaces have a base ` +
          `called "${base}", sea-serpent will report it.`,
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
      `# Every column is downloaded and then narrowed, as in Coda. To fetch only these columns`,
      `# from the server (about 4x faster, but without sea-serpent's dtype conversion),`,
      `# replace the call below with:`,
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
 * anything in this file. Both take the datastack the way the nodes do — the wired reference, or
 * the `datastack` param when nothing is wired — which is `caveTargetPlan`'s `discovery` reading.
 * The work is in the helpers: two listing endpoints for the first, and for the second a metadata
 * read, two counts that disagree, and a one-row query whose `split_positions` argument is what
 * makes the answer the same one the app gives. See `caveHelpers.ts`.
 */
registerEmitter(
  'cave.tables',
  (ctx) => {
    const target = caveTargetPlan(ctx, 'discovery')
    if (target.refusal !== undefined) return ctx.todo(target.refusal)
    const { expr, setup } = clientLines(ctx, target, '_cave')
    ctx.helper('coda_cave_tables')
    // Passed rather than defaulted, so the cell states the node's setting.
    const includeViews = Boolean(ctx.params.includeViews)
    return [
      ...setup,
      `${ctx.output('out')} = coda_cave_tables(${expr}, include_views=${includeViews ? 'True' : 'False'})`,
    ]
  },
  CAVE_ONLY,
)

registerEmitter(
  'cave.tableInfo',
  (ctx) => {
    const info = caveInfoTable(ctx.params)
    if (info.refusal !== undefined) return ctx.todo(info.refusal)
    const target = caveTargetPlan(ctx, 'discovery')
    if (target.refusal !== undefined) return ctx.todo(target.refusal)
    const { expr, setup } = clientLines(ctx, target, '_cave')
    ctx.helper('coda_cave_table_info')
    return [
      ...ctx.note(
        'In Coda the card shows this table’s description and row counts. Here they are ' +
          'printed, and the cell’s output is the list of columns.',
      ),
      ...setup,
      `${ctx.output('columns')} = coda_cave_table_info(${expr}, ${pyStr(info.table)})`,
    ]
  },
  CAVE_ONLY,
)
