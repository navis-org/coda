/**
 * Publications: the papers Virtual Fly Brain cites for each cell type in a table.
 *
 * Use case 1 of `docs/vfb-plan.md`: a neuron somebody has on the canvas → the papers that describe
 * its type. Reads the `fbbtId` column VFB Neurons adds, so `Find Neurons → VFB Neurons →
 * Publications` needs nothing set.
 *
 * Two decisions.
 *
 * **A paper is cited in a role, and the role is a column.** FBbt records why each paper is attached
 * to a class: `def` (it defines the type), `syn` (it is the source of one of its names) and `nlp`
 * (a text-mined mention). Text-mined mentions land on general classes as readily as on cell types,
 * so the default is `def` and `syn`, and `nlp` is a tick box.
 *
 * **These are papers about the type, not the neuron.** The output is keyed by `fbbtId`, with a
 * `neurons` count saying how many input rows carry that type, so nothing reads as a paper about one
 * particular body.
 */

import { countStrings } from '../../core/collections'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { getColumn, isTableValue } from '../../core/values'
import type { ReferenceRole } from '../../data/vfb/bridge'
import { REFERENCE_ROLES, fetchReferences } from '../../data/vfb/bridge'
import { plural } from '../../style/format'
import { pickedColumn, PUBLICATIONS_SCHEMA, publicationsTable, TYPE_COLUMN_PARAM } from './ops'

const ROLE_LABELS: Record<ReferenceRole, string> = {
  def: 'Defines the type',
  syn: 'Source of a name',
  nlp: 'Text-mined mention',
}

export const publicationsNode = packNode({
  type: 'vfb:publications',
  label: 'VFB Publications',
  category: 'query',
  description: 'The papers Virtual Fly Brain cites for each cell type, with DOI and PubMed id.',
  guide:
    'Lists the papers Virtual Fly Brain cites for each FBbt cell type in a table, one row per ' +
    'type and paper, with the role the paper plays: defining the type, naming it, or a text-mined ' +
    'mention. Wire it after VFB Neurons. The papers describe the type, not any one neuron, which ' +
    'is why each row also counts how many of your neurons carry that type.',
  cost: 'expensive',

  inputs: [{ id: 'types', label: 'Types', type: T.table() }],
  outputs: [{ id: 'out', label: 'Publications', type: T.table(PUBLICATIONS_SCHEMA) }],

  params: [
    TYPE_COLUMN_PARAM,
    {
      id: 'roles',
      kind: 'multiEnum',
      label: 'Cited as',
      help: 'Which kinds of citation to list. Text-mined mentions are often about broad classes rather than one cell type, so they are off by default.',
      default: ['def', 'syn'],
      options: REFERENCE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
      optionsWithoutPeek: true,
      emptyLabel: 'None — nothing is listed',
      noun: 'role',
    },
  ],

  inferOutputs: () => ({ out: T.table(PUBLICATIONS_SCHEMA) }),

  evaluate: async (ctx) => {
    const table = ctx.input('types')
    if (!isTableValue(table)) throw new Error('Types input is not a table')
    const typeColumn = pickedColumn(ctx, 'typeColumn', 'FBbt type ids')
    if (!typeColumn) return { out: publicationsTable([], []) }
    // Each type once, in the order it first appears, with how many rows carry it.
    const types = [...countStrings(getColumn(table, typeColumn))].map(([id, neurons]) => ({
      id,
      neurons,
    }))
    const roles = ctx.params.roles as ReferenceRole[]
    ctx.progress(0.1, `reading papers for ${plural(types.length, 'type')}`)
    const references = await fetchReferences(
      types.map((t) => t.id),
      roles,
      ctx.signal,
    )
    const cited = new Set(references.map((r) => r.classId))
    const silent = types.filter((t) => !cited.has(t.id)).length
    if (silent > 0) {
      ctx.warn(
        `${plural(silent, 'type has', 'types have')} no papers cited in the chosen roles ` +
          `(of ${plural(types.length, 'type')}).`,
      )
    }
    ctx.progress(1, plural(references.length, 'paper'))
    return { out: publicationsTable(types, references) }
  },
})
