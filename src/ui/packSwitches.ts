/**
 * Which node packs are switched off, and what that leaves offered.
 *
 * The same shape as `hints.ts` and for the same reasons: a preference about this reader rather
 * than about any document, so `localStorage` and not the file (a share link must never arrive with
 * somebody else's packs hidden) and not the graph store (a toggle has no business waking every
 * `useGraphStore` subscriber). A module-level `Set` replaced on every write, so the snapshot is
 * stable by identity (invariant 7).
 *
 * **One environment.** A pack starts at its own default (`PackDefinition.defaultOn`, absent
 * meaning on) and the reader's switch wins. What is stored is only the switches actually flipped —
 * by the reader in the Plugins dialog, or by a shortcut on their behalf (`applyShortcut`) — so a
 * pack a later build adds still arrives at its own default. The set everything reads is derived.
 *
 * What is offered is `core/packs.ts`' rule: a switched-off pack stays offered while the open
 * workflow uses it. `useOfferedNodeDefsByCategory` is that rule for the add surfaces; the wizard
 * asks with no workflow, since it mints a new one.
 */

import { useMemo, useSyncExternalStore } from 'react'

import type { CodaGraph } from '../core/graph'
import {
  effectiveOff,
  offeredPack,
  offeredType,
  packDependencies,
  packsOffByDefault,
  packsHiding,
  packsIn,
  packsNeeding,
} from '../core/packs'
import { nodeDefsByCategory, registeredPacks } from '../core/registry'
import type { PackDefinition } from '../core/registry'
import { channel } from '../data/channel'
import { useGraphStore } from '../store/graphStore'
import { shortcut } from '../packs/shortcuts'
import { loadPackChoices, savePackChoices, watchPackChoices } from '../store/persistence'

/** Lazy for `hints.ts`' reason: `localStorage` is not there under jsdom until a test stubs it. */
let choices: Readonly<Record<string, boolean>> | undefined
/** What each pack's own switch says: off by the reader, or by its default and never switched on. */
let own: ReadonlySet<string> | undefined
/** What is off once parts and requirements are applied (`core/packs.ts`' `effectiveOff`). */
let off: ReadonlySet<string> | undefined

const EMPTY: ReadonlySet<string> = new Set()
const changed = channel()

function ownOff(): ReadonlySet<string> {
  if (!own) {
    choices ??= loadPackChoices()
    const next = packsOffByDefault()
    for (const [id, on] of Object.entries(choices)) {
      if (on) next.delete(id)
      else next.add(id)
    }
    own = next
  }
  return own
}

function current(): ReadonlySet<string> {
  off ??= effectiveOff(ownOff())
  return off
}

/** The packs switched off, as a snapshot that changes only when the set does. */
export function useSwitchedOffPacks(): ReadonlySet<string> {
  return useSyncExternalStore(changed.subscribe, current, () => EMPTY)
}

/**
 * What each pack's own switch says — the Plugins dialog's switches, which remember a child's state
 * while its parent is off rather than all reading "off" with it.
 */
export function useOwnSwitchedOffPacks(): ReadonlySet<string> {
  return useSyncExternalStore(changed.subscribe, ownOff, () => EMPTY)
}

/**
 * Switch a pack on or off. Writes nothing when it is already so. On brings its parent and every
 * pack it needs on with it; off is refused while a pack that is on needs it.
 */
export function switchPack(id: string, on: boolean): void {
  if (on) switchOn([id])
  else if (!ownOff().has(id) && packsNeeding(id, current()).length === 0) flip([id], false)
}

/**
 * Switch these packs on, with their parents and everything they need, and return the packs that
 * went from off to on — the one path both a switch and a shortcut take, so a shortcut's notice
 * names exactly what changed.
 */
function switchOn(ids: readonly string[]): PackDefinition[] {
  const wanted = new Set(ids.flatMap((id) => [id, ...packDependencies(id)]))
  const flipping = [...wanted].filter((id) => ownOff().has(id))
  const before = current()
  if (flipping.length > 0) flip(flipping, true)
  return registeredPacks().filter((p) => before.has(p.id) && !current().has(p.id))
}

/**
 * Record switches the reader (or a shortcut) flipped: one save and one notify however many. This
 * tab's copy is current, `watchPackChoices` having dropped it when another tab last wrote.
 */
function flip(ids: readonly string[], on: boolean): void {
  choices = { ...choices, ...Object.fromEntries(ids.map((id) => [id, on])) }
  savePackChoices(choices)
  forget()
}

/** Drop every cached derivation and tell the subscribers. */
function forget(): void {
  own = undefined
  off = undefined
  changed.notify()
}

/*
 * Another tab flipped a switch: read the switches afresh the next time anything asks. Without it,
 * a tab open since before another switched ZapBench off would write its stale copy back over that
 * choice on its next flip.
 */
watchPackChoices(() => {
  choices = undefined
  forget()
})

/** How long a shortcut's notice stays up before it takes itself away. */
const SHORTCUT_NOTICE_MS = 8000

/**
 * Follow a shortcut: make sure its packs are on, and say which ones this switched on.
 *
 * A shortcut (`/cortex`) is a way *in*, not a separate app: it flips the same switches the Plugins
 * dialog does, in the one environment everybody shares, and the choice outlives the visit. The
 * packs a shortcut names bring what they need. The notice names only the packs it actually switched
 * on, requirements included — a returning reader whose packs are already on is told nothing — and
 * takes itself away after a few seconds unless something else has replaced it. An unknown id does
 * nothing, a stale link being no reason to put up an error.
 */
export function applyShortcut(id: string): void {
  const switched = switchOn(shortcut(id)?.packs ?? [])
  if (switched.length === 0) return
  const names = switched.map((p) => p.label).join(', ')
  const notice = `Switched on for you: ${names}. Change this under Plugins.`
  const { setNotice } = useGraphStore.getState()
  setNotice(notice)
  setTimeout(() => {
    if (useGraphStore.getState().notice === notice) setNotice(undefined)
  }, SHORTCUT_NOTICE_MS)
}

/*
 * The packs the open workflow uses, as one joined string cached on the graph's identity.
 *
 * A zustand selector runs on every store publish and a graph is a new object on every frame of a
 * node drag, so this is shaped for both: a publish that did not touch the graph is one identity
 * compare, a drag re-walks the nodes once however many surfaces ask, and the answer is a string —
 * compared by value, so a drag that changes no pack re-renders nothing (invariant 7). And while
 * nothing is switched off the answer cannot matter, so it is `''` without a walk at all.
 */
let seenGraph: CodaGraph | undefined
let seenKey = ''

function packsKey(graph: CodaGraph): string {
  if (graph !== seenGraph) {
    seenGraph = graph
    seenKey = packsIn(graph).join(',')
  }
  return seenKey
}

/**
 * The packs the open workflow uses — while any pack is switched off; empty otherwise, which is
 * also when nothing would read it. One subscription for the filter and for the switch's own note,
 * so the two cannot disagree about which packs are still offered.
 */
export function usePacksInUse(): readonly string[] {
  const anyOff = useSwitchedOffPacks().size > 0
  return usePacksKey(anyOff)
}

/**
 * The packs the open workflow uses, whatever is switched — for a surface that states the fact
 * rather than filtering by it: the Plugins dialog's "used here". Mounted only while that dialog is
 * open, so the walk the filter skips while nothing is off costs nothing the rest of the time.
 */
export function useWorkflowPacks(): readonly string[] {
  return usePacksKey(true)
}

function usePacksKey(walk: boolean): readonly string[] {
  const key = useGraphStore((s) => (walk ? packsKey(s.graph) : ''))
  return useMemo(() => (key ? key.split(',') : []), [key])
}

/**
 * What the add surfaces list: the registry's groups minus switched-off packs, keeping built-in
 * types, switched-on packs and the packs the open workflow uses. **The one seam** — a surface
 * offering nodes for new work reads this rather than `nodeDefsByCategory`, so a new one cannot
 * forget the filter by forgetting an optional argument.
 */
export function useOfferedNodeDefsByCategory(): ReturnType<typeof nodeDefsByCategory> {
  const switchedOff = useSwitchedOffPacks()
  const inUse = usePacksInUse()
  return useMemo(
    () => nodeDefsByCategory(offeredType(switchedOff, inUse)),
    [switchedOff, inUse],
  )
}

/** Whether a pack is offered here — on, or used by the open workflow (`core/packs.ts`' `offeredPack`). */
export function useOfferedPack(): (pack: string) => boolean {
  const switchedOff = useSwitchedOffPacks()
  const inUse = usePacksInUse()
  return useMemo(() => offeredPack(switchedOff, inUse), [switchedOff, inUse])
}

/**
 * The switched-off packs that leave these dataset node types out of a list new work starts from —
 * New, or the wizard's first question — as the plugins to switch back on. The caller hands in the
 * types *its* list filters (memoised), so the note beneath it cannot name a plugin for datasets that
 * list never showed. Empty when nothing is hidden, which is when the note does not draw.
 */
export function useDatasetsHiddenBy(types: readonly string[]): PackDefinition[] {
  const switchedOff = useSwitchedOffPacks()
  return useMemo(
    () => (switchedOff.size === 0 ? [] : packsHiding(types, switchedOff)),
    [switchedOff, types],
  )
}

/** The wizard's filter: it builds a new workflow, so only the switches count. */
export function useOfferedForNewWork(): ((type: string) => boolean) | undefined {
  const switchedOff = useSwitchedOffPacks()
  return useMemo(() => offeredType(switchedOff), [switchedOff])
}

/** Reset to the freshly-loaded state. Tests only. */
export function resetPackSwitchesForTest(): void {
  choices = undefined
  seenGraph = undefined
  forget()
}
