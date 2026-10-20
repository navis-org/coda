/**
 * VFB Driver Lines: the split-GAL4, GAL4 and LexA lines Virtual Fly Brain records as labelling
 * each cell type in a table.
 *
 * Reads the `fbbtId` column VFB Neurons adds, so `VFB Neurons → VFB Driver Lines` needs nothing
 * set. A line labels a type when VFB records one of the line's parts as an instance of that type
 * (`data/vfb/bridge.ts`, `fetchLines`): curated "this line labels X" assertions, and single-neuron
 * images VFB typed.
 *
 * **`targets` is a column, not a filter applied silently**: a line labelling one type is genetic
 * access to that type, one labelling twelve is not, and the reader decides where the line is —
 * `Max types labelled` is the control, off by default. The sort order is `linesTable`'s.
 */

import { distinctStrings } from '../../core/collections'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { getColumn, isTableValue } from '../../core/values'
import type { DriverKind } from '../../data/vfb/bridge'
import { DRIVER_KINDS, fetchLines } from '../../data/vfb/bridge'
import { plural } from '../../style/format'
import { LINES_SCHEMA, linesTable, pickedColumn, TYPE_COLUMN_PARAM } from './ops'

const KIND_LABELS: Record<DriverKind, string> = {
  split: 'Split-GAL4',
  GAL4: 'GAL4',
  LexA: 'LexA',
  other: 'Other',
}

export const linesNode = packNode({
  type: 'vfb:lines',
  label: 'VFB Driver Lines',
  category: 'query',
  description: 'The driver lines Virtual Fly Brain records as labelling each cell type.',
  guide:
    'Lists the split-GAL4, GAL4 and LexA lines that Virtual Fly Brain records as labelling each ' +
    'FBbt cell type in a table, one row per type and line. Wire it after VFB Neurons. The ' +
    '`targets` column says how many cell types a line labels in all, so a line for your type ' +
    'alone reads 1; VFB Expression Images takes the lines on to their registered images.',
  cost: 'expensive',

  inputs: [{ id: 'types', label: 'Types', type: T.table() }],
  outputs: [{ id: 'out', label: 'Lines', type: T.table(LINES_SCHEMA) }],

  params: [
    TYPE_COLUMN_PARAM,
    {
      id: 'kinds',
      kind: 'multiEnum',
      label: 'Drivers',
      help: 'Which kinds of driver line to list.',
      default: [...DRIVER_KINDS],
      options: DRIVER_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] })),
      optionsWithoutPeek: true,
      emptyLabel: 'None — nothing is listed',
      noun: 'driver',
    },
    {
      id: 'maxTargets',
      kind: 'int',
      label: 'Max types labelled',
      help: 'Only list lines that label at most this many cell types in all. 0 lists every line.',
      default: 0,
      min: 0,
    },
  ],

  inferOutputs: () => ({ out: T.table(LINES_SCHEMA) }),

  evaluate: async (ctx) => {
    const table = ctx.input('types')
    if (!isTableValue(table)) throw new Error('Types input is not a table')
    const typeColumn = pickedColumn(ctx, 'typeColumn', 'FBbt type ids')
    if (!typeColumn) return { out: linesTable([], []) }
    const typeIds = distinctStrings(getColumn(table, typeColumn))
    ctx.progress(0.1, `reading lines for ${plural(typeIds.length, 'type')}`)
    const kinds = new Set(ctx.params.kinds as DriverKind[])
    const maxTargets = Number(ctx.params.maxTargets)
    const lines = (await fetchLines(typeIds, ctx.signal)).filter(
      (l) => kinds.has(l.kind) && (maxTargets <= 0 || l.targets <= maxTargets),
    )
    const covered = new Set(lines.map((l) => l.classId))
    const without = typeIds.filter((id) => !covered.has(id)).length
    if (without > 0) {
      ctx.warn(
        `${plural(without, 'type has', 'types have')} no driver line in Virtual Fly Brain ` +
          `matching these settings.`,
      )
    }
    ctx.progress(1, plural(lines.length, 'line'))
    return { out: linesTable(typeIds, lines) }
  },
})
