/**
 * Why a dataset list is shorter than it was: a switched-off plugin, named, with the way back.
 *
 * Switching Connectome off empties New's dataset groups and the wizard's first question, and a
 * list that is simply shorter reads as datasets gone missing rather than as a switch somebody
 * flipped. So both say which plugin is off and open Plugins from where they are. Nothing draws
 * while nothing is hidden. The plugin named is the switch to flip — Connectome, not neuPrint, when
 * neuPrint is off only because Connectome is (`core/packs.ts`' `packsHiding`).
 */

import { listed } from '../../core/prose'
import type { PackDefinition } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { useDatasetsHiddenBy } from '../packSwitches'

/** "Connectome is switched off" / "neuPrint and CAVE are switched off". */
export function hiddenByText(packs: readonly PackDefinition[]): string {
  return `${listed(packs.map((p) => p.label))} ${packs.length > 1 ? 'are' : 'is'} switched off`
}

/** New's form, below the "Some datasets are hidden" heading of a row that opens Plugins. */
export function hiddenDatasetsBlurb(packs: readonly PackDefinition[]): string {
  return `${hiddenByText(packs)}. Open Plugins to switch ${packs.length > 1 ? 'them' : 'it'} back on.`
}

/**
 * The wizard's form: a line under the options, with a button that opens Plugins. `types` are the
 * dataset node types the list above it filters.
 */
export function HiddenDatasetsNote({ types }: { types: readonly string[] }) {
  const packs = useDatasetsHiddenBy(types)
  const openPlugins = useGraphStore((s) => s.openPlugins)
  if (packs.length === 0) return null
  return (
    <p className="hidden-datasets">
      Some datasets are hidden because {hiddenByText(packs)}.{' '}
      <button type="button" className="hidden-datasets__open" onClick={openPlugins}>
        Open Plugins
      </button>
    </p>
  )
}
