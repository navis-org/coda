/**
 * The Annotate card's targets: one per tab, each a backend and a table, stored on the node.
 *
 * A list rather than the flat params one target had, because a selection from several datasets —
 * a BigClust project's male CNS, FlyWire and hemibrain neurons — wants a table each, and the card
 * routes each neuron to the tab whose `serves` names its dataset (`routing.ts`). Stored as one JSON
 * text per target in an `ids` param, the shape `nodes/lib/renames.ts` stores a list somebody
 * grows: everything a tab says is saved, undoable and part of the document.
 *
 * One side effect, on Clio: `instance` kept in step with `type`, as BigClust does. **Off by
 * default** (the user's call): a second column changing as a side effect is a choice of its own.
 */

import type { TargetConfig } from '../../data/annotations/targets'
import { SEATABLE_HOSTS } from '../../data/annotations/credentials'
import { NO_FILE_WRITES } from '../../data/files/editable'
import { hasFileHandles } from '../../data/files/remembered'
import type { SideEffects } from '../../data/annotations/targets/sideEffects'

const BACKENDS = ['seaTable', 'clio', 'csv'] as const
export type Backend = (typeof BACKENDS)[number]

export interface TargetSpec {
  backend: Backend
  /** SeaTable: the deployment, its base and table. */
  host: string
  workspace: string
  base: string
  table: string
  /** SeaTable and CSV: the column holding the neuron id. */
  keyColumn: string
  /** CSV: the file, by the id this browser holds it under (`holdEditableFile`), and its name. */
  file: string
  fileName: string
  /** Clio: the dataset, as Clio names it. */
  dataset: string
  /** The datasets this tab is for, comma-separated; empty takes every neuron. */
  serves: string
  /** The fields shown as columns, in order. */
  fields: string[]
  /** Clio: write `instance` as `{type}_{side}` when `type` is written. */
  instanceFromType: boolean
  /**
   * Clio and CSV: show an id with no record as an empty row, which can then be annotated — on
   * Clio a body nobody has annotated, in a CSV a row the file does not have (appended on its first
   * edit). Inert on SeaTable, whose target offers no blank rows.
   */
  unannotated: boolean
}

export function newSpec(): TargetSpec {
  return {
    backend: 'seaTable',
    host: SEATABLE_HOSTS.flytable,
    workspace: '',
    base: '',
    table: '',
    keyColumn: '',
    file: '',
    fileName: '',
    dataset: '',
    serves: '',
    fields: [],
    instanceFromType: false,
    unannotated: false,
  }
}

/** The spec's plain text settings — every field a text box edits. */
export type SpecTextKey = {
  [K in keyof TargetSpec]: string extends TargetSpec[K] ? K : never
}[keyof TargetSpec]

/** The spec's on/off settings — every field a checkbox edits. */
export type SpecBoolKey = {
  [K in keyof TargetSpec]: TargetSpec[K] extends boolean ? K : never
}[keyof TargetSpec]

/**
 * One stored target, or `undefined` for an entry that is not one. Each field is checked and one of
 * the wrong type takes its default, so a hand-edited `.coda.json` cannot put a list where the card
 * reads a string. Undeclared keys are dropped.
 */
function readSpec(text: string): TargetSpec | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const spec = newSpec()
  for (const key of Object.keys(spec) as Array<keyof TargetSpec>) {
    // Same type as the default: a string for a string, a boolean for a boolean. The one list is
    // checked entry by entry below.
    if (key !== 'fields' && typeof r[key] === typeof spec[key]) {
      ;(spec as unknown as Record<string, unknown>)[key] = r[key]
    }
  }
  if (!BACKENDS.includes(spec.backend)) spec.backend = 'seaTable'
  if (Array.isArray(r.fields)) spec.fields = r.fields.filter((f) => typeof f === 'string')
  return spec
}

/**
 * The stored targets, read tolerantly: an entry that is not a target is dropped, a field missing or
 * of the wrong type takes its default, and a node with none has one blank target — the card always
 * has a tab.
 */
export function readSpecs(stored: readonly string[]): TargetSpec[] {
  const specs = stored.flatMap((text) => readSpec(text) ?? [])
  return specs.length ? specs : [newSpec()]
}

export function writeSpecs(specs: readonly TargetSpec[]): string[] {
  return specs.map((spec) => JSON.stringify(spec))
}

/**
 * The target a spec names, which settings it still needs, or why it cannot work here at all — the
 * one decision of what "set up" means, read by `validate`, the tab strip and the card, so a tab
 * cannot draw a table while the node's badge says a setting is missing, nor ask for settings that
 * would never work. `refused` comes first: a CSV tab in a browser that cannot write to a file asks
 * for nothing.
 */
export function specConfig(
  spec: TargetSpec,
): { config: TargetConfig } | { missing: string[] } | { refused: string } {
  if (spec.backend === 'clio') {
    return spec.dataset.trim()
      ? { config: { backend: 'clio', dataset: spec.dataset.trim() } }
      : { missing: ['Dataset'] }
  }
  if (spec.backend === 'csv') {
    if (!hasFileHandles()) return { refused: `A CSV tab cannot work here: ${NO_FILE_WRITES}.` }
    const missing = [
      ...(spec.file ? [] : ['File']),
      ...(spec.keyColumn.trim() ? [] : ['Key column']),
    ]
    if (missing.length) return { missing }
    return {
      config: {
        backend: 'csv',
        file: spec.file,
        name: spec.fileName,
        keyColumn: spec.keyColumn.trim(),
      },
    }
  }
  const labelled = [
    ['host', 'Server'],
    ['base', 'Base'],
    ['table', 'Table'],
    ['keyColumn', 'Key column'],
  ] as const
  const missing = labelled.flatMap(([id, label]) => (spec[id].trim() ? [] : [label]))
  if (missing.length) return { missing }
  return {
    config: {
      backend: 'seaTable',
      host: spec.host.trim(),
      workspace: spec.workspace.trim(),
      base: spec.base.trim(),
      table: spec.table.trim(),
      idColumn: spec.keyColumn.trim(),
    },
  }
}

/** A tab's name: its table or its dataset, or that it names nothing yet. */
export function specLabel(spec: TargetSpec): string {
  if (spec.backend === 'clio')
    return spec.dataset.trim() ? `Clio · ${spec.dataset.trim()}` : 'Clio'
  if (spec.backend === 'csv') return spec.fileName ? `CSV · ${spec.fileName}` : 'CSV file'
  return spec.base.trim() && spec.table.trim()
    ? `${spec.base.trim()} / ${spec.table.trim()}`
    : 'New table'
}

/**
 * What a write on this tab writes besides the cell itself, as `withSideEffects` takes it: nothing
 * unless the tab switched a side effect on.
 */
export function specEffects(spec: TargetSpec): SideEffects {
  return spec.backend === 'clio' && spec.instanceFromType ? { instanceFromType: true } : {}
}
