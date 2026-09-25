/**
 * Which node types are *offered* — what the add surfaces list — given the packs a reader has
 * switched off and the workflow in front of them.
 *
 * Switching a pack off hides it; it never unregisters it. Every pack stays registered in every
 * build, so a workflow using a switched-off pack still opens, runs and saves exactly as it would
 * otherwise. What changes is only what is *offered* for new work, and a pack the open workflow
 * already uses stays offered while that workflow is in front of the reader: somebody extending a
 * ZapBench workflow wants the ZapBench nodes in the palette, whatever they chose for everything
 * else. That exception is derived from the graph rather than switched on for them, so opening a
 * link never changes a preference. See `docs/packs.md`.
 *
 * Headless, so the wizard's gate and the registry's listings ask the same question the UI does.
 */

import type { CodaGraph } from './graph'
import { getPack, packOfType, registeredPacks } from './registry'
import type { PackDefinition } from './registry'

/** The packs a graph's nodes belong to, sorted and without repeats. */
export function packsIn(graph: CodaGraph): string[] {
  const used = new Set<string>()
  for (const node of graph.nodes) {
    const pack = packOfType(node.type)
    if (pack) used.add(pack)
  }
  return [...used].sort()
}

/**
 * Whether a pack is offered: on, or used by the open workflow. The one statement of the rule, for
 * a type (`offeredType`) and for anything a pack owns that is not a node — a Connections tab.
 */
export function offeredPack(
  switchedOff: ReadonlySet<string>,
  inUse: readonly string[] = [],
): (pack: string) => boolean {
  return (pack) => !switchedOff.has(pack) || inUse.includes(pack)
}

/**
 * Whether a type is offered: built in, or from a pack that is on, or from one the open workflow
 * uses. Undefined when nothing is switched off, which every caller reads as "no filter" — so the
 * common case costs nothing and allocates nothing.
 */
export function offeredType(
  switchedOff: ReadonlySet<string>,
  inUse: readonly string[] = [],
): ((type: string) => boolean) | undefined {
  if (switchedOff.size === 0) return undefined
  const offered = offeredPack(switchedOff, inUse)
  return (type) => {
    const pack = packOfType(type)
    return pack === undefined || offered(pack)
  }
}

/*
 * Requirements (`PackDefinition.requires`) and parts (`PackDefinition.parent`), stated here so every
 * reader of a switched-off set applies them the same way. Two rules, and they point opposite ways:
 *
 * - **A pack is off when its parent is**, whatever its own switch says.
 * - **A required pack is on whenever anything needing it is on** — and so is its parent, a child
 *   being unusable without it. This one wins: it holds on what the first would take off.
 *
 * `ui/packSwitches.ts` stores the switches and asks these; nothing about them is a UI question.
 */

/**
 * The packs whose own switch starts off (`PackDefinition.defaultOn: false`) — where every reader's
 * switched-off set begins before anybody flips anything.
 */
export function packsOffByDefault(): Set<string> {
  return new Set(registeredPacks().flatMap((p) => (p.defaultOn === false ? [p.id] : [])))
}

/**
 * What switching this pack on has to switch on with it: its parent and what it requires, and theirs
 * in turn — a requirement's parent's own requirements included. The one walk of both relations, so
 * nothing reading them stops a level short.
 */
export function packDependencies(id: string): string[] {
  const out = new Set<string>()
  const walk = (pack: string) => {
    const def = getPack(pack)
    for (const next of [...(def?.parent ? [def.parent] : []), ...(def?.requires ?? [])]) {
      if (next === id || out.has(next)) continue
      out.add(next)
      walk(next)
    }
  }
  walk(id)
  return [...out]
}

/**
 * The packs a switched-off set leaves on that need this one — directly, or through a child of it
 * that they need, whose parent it is. Why switching it off is refused. Its own parts do not count:
 * they go off with it, so one part needing another is no reason to keep the parent on.
 */
export function packsNeeding(id: string, switchedOff: ReadonlySet<string>): string[] {
  return registeredPacks()
    .filter(
      (p) =>
        p.id !== id &&
        p.parent !== id &&
        !switchedOff.has(p.id) &&
        packDependencies(p.id).includes(id),
    )
    .map((p) => p.id)
}

/**
 * What is off, from what each pack's own switch says: children follow their parent off, and
 * anything a pack that is on needs is held on, with its parent. Settled by repeating, since holding
 * a parent on can bring its other children back — a handful of packs, a few passes at most.
 */
export function effectiveOff(ownOff: ReadonlySet<string>): Set<string> {
  const held = new Set<string>()
  for (;;) {
    const off = new Set<string>()
    for (const pack of registeredPacks()) {
      const parentOff = pack.parent !== undefined && off.has(pack.parent)
      if (!held.has(pack.id) && (ownOff.has(pack.id) || parentOff)) off.add(pack.id)
    }
    const before = held.size
    for (const pack of registeredPacks()) {
      if (off.has(pack.id)) continue
      // Its own parent comes along too, harmlessly: a pack not off has a parent not off, or is held.
      for (const dependency of packDependencies(pack.id)) held.add(dependency)
    }
    if (held.size === before) return off
  }
}

/**
 * The switched-off packs hiding these types, each named as the switch to flip: a part that is off
 * only because its parent is gives the parent — "Connectome", not "neuPrint", when Connectome is
 * what the reader switched off. For the notes that say why a list is shorter than it was.
 */
export function packsHiding(
  types: readonly string[],
  switchedOff: ReadonlySet<string>,
): PackDefinition[] {
  const hiding = new Set<string>()
  for (const type of types) {
    let pack = packOfType(type)
    if (pack === undefined || !switchedOff.has(pack)) continue
    const parent = getPack(pack)?.parent
    if (parent !== undefined && switchedOff.has(parent)) pack = parent
    hiding.add(pack)
  }
  return registeredPacks().filter((p) => hiding.has(p.id))
}
