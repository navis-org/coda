/**
 * VFB Neurons: what Virtual Fly Brain knows about each neuron of a connectome table.
 *
 * The pack's entry point, and the direction it exists for — connectome → VFB (`docs/vfb-plan.md`).
 * Each row gets the VFB individual its neuron is, and that neuron's type as an FBbt class, which is
 * the key every other VFB node reads.
 *
 * Four decisions.
 *
 * **Version-exact.** A neuron id is an identity within one release, so the wired dataset is mapped
 * to a VFB site only when VFB holds that exact release (`data/vfb/sites.ts`), and refused by name
 * otherwise — at edit time, from the Dataset socket's type, before anything is fetched.
 *
 * **The type is `typeClass`'s**: the most specific class at or above VFB's asserted ones that some
 * connectome names, never a transmitter class like *adult cholinergic neuron*
 * (`data/vfb/classes.ts`). `fbbtClimbed` says how far above the asserted class it was found.
 *
 * **It annotates, it never drops.** A neuron VFB does not hold, or holds without a named type, keeps
 * its row with nulls, and each reason is counted in its own warning.
 *
 * **`expensive`.** It asks VFB's database a handful of batched statements — one cross-reference for
 * the whole table, then one per level of the class walk — against a shared production server
 * (invariant 6).
 */

import { distinctStrings } from '../../core/collections'
import type { InferContext } from '../../core/node'
import { packNode } from '../../core/registry'
import { idText, ID_COLUMN_NAME } from '../../core/ids'
import { T, isTabular, schemaOf } from '../../core/types'
import type { CodaType } from '../../core/types'
import { datasetIdentity, getColumn, isTableValue } from '../../core/values'
import { fetchClassGraph, fetchIndividuals } from '../../data/vfb/bridge'
import type { TypeAnswer } from '../../data/vfb/classes'
import { typeClass } from '../../data/vfb/classes'
import { siteLabel, siteRefusal, vfbSiteFor } from '../../data/vfb/sites'
import { requireDataset } from '../../nodes/lib/datasetParam'
import { plural } from '../../style/format'
import type { NeuronAnswer } from './ops'
import { pickedColumn, vfbNeuronsSchema, vfbNeuronsTable } from './ops'

/**
 * Why a neuron's VFB columns are empty or partial, each counted in a warning of its own, in the
 * order the warnings are given.
 */
const SHORTFALLS = {
  absent: (n, site) =>
    `${plural(n, 'neuron is', 'neurons are')} not in Virtual Fly Brain's ${site}; their rows ` +
    `are kept with empty VFB columns.`,
  untyped: (n) =>
    `${plural(n, 'neuron has', 'neurons have')} no cell type VFB names in any connectome, only ` +
    `general classes; their type is left empty rather than set to one.`,
  tied: (n) =>
    `${plural(n, 'neuron has', 'neurons have')} two unrelated named types in VFB; their type is ` +
    `left empty rather than chosen between them.`,
  twice: (n) =>
    `${plural(n, 'neuron is', 'neurons are')} in VFB twice; the first entry is used.`,
} satisfies Record<string, (n: number, site: string) => string>

type Shortfall = keyof typeof SHORTFALLS

function outType(input: CodaType | undefined): CodaType {
  const schema = vfbNeuronsSchema(isTabular(input) ? schemaOf(input) : undefined)
  return input?.kind === 'neurons' ? T.neurons(schema) : T.table(schema)
}

function refusal(ctx: InferContext): string | undefined {
  const dataset = datasetIdentity(ctx.inputs.dataset)
  return dataset ? siteRefusal(dataset.sourceId, dataset.datasetId) : undefined
}

export const neuronsNode = packNode({
  type: 'vfb:neurons',
  label: 'VFB Neurons',
  category: 'query',
  description:
    'Look each neuron up in Virtual Fly Brain: its VFB id and its cell type as an FBbt term.',
  guide:
    'Adds four columns to a neuron table: the neuron’s Virtual Fly Brain id, its cell type as an ' +
    'FBbt term (`fbbtId`, `fbbtLabel`), and how far up the ontology that type was found. The ' +
    'FBbt term is what VFB Publications and the other VFB nodes read. VFB holds exact releases only, ' +
    'so a dataset version it does not hold is refused rather than matched to the nearest one.',
  cost: 'expensive',

  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Neurons', type: T.table() }],

  params: [
    {
      id: 'idColumn',
      kind: 'column',
      label: 'Neuron id column',
      from: 'neurons',
      default: ID_COLUMN_NAME,
      dtypes: ['str', 'i64'],
      // Optional, like every VFB picker (`vfbColumnParam`): a required one is handed the first
      // str/i64 column when the table has no `id`, and a `type` or `weight` column looked up as
      // accessions reads as neurons VFB does not hold rather than as the wrong column.
      optional: true,
      help: 'Which column holds the neuron ids of the wired dataset.',
    },
  ],

  inferOutputs: (ctx) => ({ out: outType(ctx.inputs.neurons) }),

  validate: (ctx) => {
    const issue = refusal(ctx)
    return issue ? [issue] : []
  },

  evaluate: async (ctx) => {
    const table = ctx.input('neurons')
    if (!isTableValue(table)) throw new Error('Neurons input is not a table')
    const dataset = requireDataset(ctx.input('dataset'))
    const site = vfbSiteFor(dataset.sourceId, dataset.datasetId)
    if (!site) throw new Error(siteRefusal(dataset.sourceId, dataset.datasetId))

    const idColumn = pickedColumn(ctx, 'idColumn', 'neuron ids')
    // An unresolved picker annotates nothing rather than blocking everything downstream
    // (invariant 5): the table passes through with the four columns empty.
    if (!idColumn) {
      return { out: vfbNeuronsTable(table, new Array(table.length).fill(null), new Map()) }
    }
    const ids = Array.from(getColumn(table, idColumn), (cell) => idText(cell))
    const wanted = distinctStrings(ids)

    ctx.progress(0.1, `looking up ${plural(wanted.length, 'neuron')} in ${site.name}`)
    const individuals = await fetchIndividuals(site.site, wanted, ctx.signal)
    ctx.progress(0.5, 'reading types')
    const graph = await fetchClassGraph(
      individuals.flatMap((i) => i.classes),
      ctx.signal,
    )

    const answers = new Map<string, NeuronAnswer>()
    const typed = new Map<string, TypeAnswer>()
    const short: Record<Shortfall, number> = { absent: 0, untyped: 0, tied: 0, twice: 0 }
    for (const individual of individuals) {
      // Two VFB individuals for one neuron: the first is kept and the rest are counted.
      if (answers.has(individual.accession)) {
        short.twice += 1
        continue
      }
      // Most neurons share their asserted classes with many others, so each set is typed once.
      const key = [...individual.classes].sort().join('\u0000')
      let type = typed.get(key)
      if (!type) {
        type = typeClass(graph, individual.classes)
        typed.set(key, type)
      }
      if (type.classId === undefined) {
        short[type.tied.length > 0 ? 'tied' : 'untyped'] += 1
        answers.set(individual.accession, { vfbId: individual.vfbId })
        continue
      }
      answers.set(individual.accession, {
        vfbId: individual.vfbId,
        fbbtId: type.classId,
        fbbtLabel: graph.labels.get(type.classId) ?? type.classId,
        climbed: type.climbed,
      })
    }
    short.absent = wanted.filter((id) => !answers.has(id)).length
    const label = siteLabel(site)
    for (const reason of Object.keys(SHORTFALLS) as Shortfall[]) {
      if (short[reason] > 0) ctx.warn(SHORTFALLS[reason](short[reason], label))
    }
    ctx.progress(1, `${plural(answers.size, 'neuron')} found`)
    return { out: vfbNeuronsTable(table, ids, answers) }
  },
})
