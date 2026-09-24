/**
 * Shortcuts: a way into Coda that makes sure a set of packs is switched on — `coda.science/cortex`
 * for somebody told "go and try the cortex tools".
 *
 * There is **one environment**. A shortcut is not a separate app with its own settings: following
 * one flips the same pack switches the Plugins dialog does, and the packs stay on afterwards
 * wherever Coda is opened. It adds; it never switches anything off, never narrows the datasets
 * offered and never changes what a workflow means, so a workflow made after following one opens
 * the same for everybody. `ui/packSwitches.ts`' `applyShortcut` is what follows one, and says
 * which packs it switched on.
 *
 * A module list, like `packs/index.ts`, so `packs.test.ts` can refuse a shortcut naming a pack
 * nobody registered. Following one needs the packs registered first, which importing
 * `ui/packSwitches.ts` already ensures: it imports the graph store, which imports every node pack
 * for its side effect. None exists yet: the first arrives with the cortex pack, together with the
 * page entry (`cortex/index.html`) that calls `applyShortcut('cortex')`.
 */

export interface ShortcutDefinition {
  /** The path segment it is reached by: `cortex` for `/cortex`. */
  id: string
  /** The packs it makes sure are on. */
  packs: readonly string[]
}

export const SHORTCUTS: readonly ShortcutDefinition[] = []

export function shortcut(id: string): ShortcutDefinition | undefined {
  return SHORTCUTS.find((s) => s.id === id)
}
