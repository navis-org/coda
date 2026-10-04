/**
 * The Storage tab's numbers: what Coda keeps in this browser between sessions, and the one thing
 * it offers to clear.
 *
 * ## Three sources, and only one of them measures
 *
 * **`navigator.storage.estimate()` is the browser's own figure**, and it answers for the whole
 * origin — every IndexedDB database, plus whatever the browser charges for its own bookkeeping.
 * Every browser has it; none breaks it down per database (Chrome's `usageDetails` stops at "all of
 * IndexedDB").
 *
 * **Per database is Coda's estimate** (`data/idb.ts`' `usage`): records are read and sized, except
 * where a shelf already records each entry's size (`SizedBy`). The data cache has no such figure,
 * and reading a neuron index is tens of MB, so this runs the first time the tab opens — the dialog
 * holds the reading — and never on the memory readout's clock.
 *
 * **`localStorage` is exact**, and is counted in the units its allowance is: code units, key and
 * value both (`LOCAL_STORAGE_BUDGET`). It is reported against that allowance because filling it is
 * a silent failure — the autosave swallows the quota error by design.
 *
 * ## What can be cleared here
 *
 * Only the data cache. It is the one store with no bound (a cached value is never evicted), and
 * the only one whose contents Coda can always fetch again. Everything else is either somebody's
 * work — saved workflows, recipes, uploads, edge sets, sign-ins, each managed where it is made — or
 * bounded and cleaned up on its own (the crash net: `MAX_SESSIONS`, `MAX_SLOTS`). The crash net
 * stays without a button for a second reason: a session belongs to a tab, and nothing here can
 * tell a closed tab from one open in another window, whose workflows a clear would lose on reload.
 */

import { cacheClear, cacheUsage } from '../data/cache'
import { edgeSetsUsage } from '../data/edges/store'
import { fileLinksUsage } from '../data/files/store'
import type { StoredUsage } from '../data/idb'
import { SIGN_INS, isSignInKey } from '../data/signIns'
import { uploadsUsage } from '../data/uploads'
import { libraryUsage } from '../store/library'
import { isAutosaveKey, isCodaKey } from '../store/persistence'
import { recipesUsage } from '../store/recipes'
import { sessionUsage } from '../store/session'

/** `localStorage`, in code units, split by what a reader would call each part. */
export interface LocalUse {
  /** The autosave: the shared key, every tab's slot, and the slot index. */
  autosave: number
  signIns: number
  /** Services with a credential actually stored, in `SIGN_INS` order. */
  services: string[]
  /** Every other `coda.` key. */
  preferences: number
  /** Keys this origin holds that are not Coda's. */
  other: number
}

/** Every key a storage holds with its cost in code units, key and value both. Throws without one. */
function* sized(storage: Storage): Iterable<[string, number]> {
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key !== null) yield [key, key.length + (storage.getItem(key) ?? '').length]
  }
}

function readLocalUse(): LocalUse | undefined {
  const use: LocalUse = { autosave: 0, signIns: 0, services: [], preferences: 0, other: 0 }
  try {
    for (const [key, units] of sized(localStorage)) {
      if (isAutosaveKey(key)) use.autosave += units
      else if (isSignInKey(key)) use.signIns += units
      else if (isCodaKey(key)) use.preferences += units
      else use.other += units
    }
  } catch {
    // No storage at all (a private window, a disabled site) — unknown, not empty.
    return undefined
  }
  use.services = SIGN_INS.filter((entry) => entry.stored()).map((entry) => entry.service)
  return use
}

/** Everything `localStorage` holds, which is what its allowance is charged for. */
export function localTotal(use: LocalUse): number {
  return use.autosave + use.signIns + use.preferences + use.other
}

/** `sessionStorage`, in code units: this tab's identity and which workflow was on screen. */
function readTabUse(): number {
  let units = 0
  try {
    for (const [, cost] of sized(sessionStorage)) units += cost
  } catch {
    /* none to count */
  }
  return units
}

/**
 * A shelf the tab reports and does not clear: somebody's work, managed where it is made.
 *
 * One table so a new shelf is one row here rather than a field, a destructured slot and a
 * hand-written row in the dialog.
 */
interface Shelf {
  name: string
  /** What one entry is called, for `plural`. */
  noun: string
  /** Where it is managed, or what to know about it. */
  note: string
  measure: () => Promise<StoredUsage | undefined>
}

const SHELVES: readonly Shelf[] = [
  {
    name: 'Saved workflows',
    noun: 'workflow',
    note: 'Manage them under Open ▸ Saved in this browser.',
    measure: libraryUsage,
  },
  {
    name: 'Recipes',
    noun: 'recipe',
    note: 'Manage them under + ▸ Saved recipes.',
    measure: recipesUsage,
  },
  {
    name: 'Uploaded files',
    noun: 'upload',
    note: 'Tables and meshes added with an Upload card. Removing the card does not delete them.',
    measure: uploadsUsage,
  },
  {
    name: 'Edge sets',
    noun: 'edge set',
    note: 'Manage them in the Edge data dialog, opened from a dataset card.',
    measure: edgeSetsUsage,
  },
  {
    name: 'Linked files',
    noun: 'linked file',
    note: 'The files themselves are read where they are on this computer, not copied.',
    measure: fileLinksUsage,
  },
]

export type ShelfUse = Omit<Shelf, 'measure'> & { usage: StoredUsage | undefined }

export interface StorageReading {
  /** The browser's figure for the whole site, and what it allows. Undefined where unreported. */
  site: { usage: number; quota: number } | undefined
  /** Whether the browser has promised not to clear this site's data. Undefined where unknown. */
  persisted: boolean | undefined
  /** The data cache, the one store the tab clears. */
  cache: StoredUsage | undefined
  /** The crash net's IndexedDB half; the autosave is its `localStorage` half, in `local`. */
  session: StoredUsage | undefined
  shelves: ShelfUse[]
  local: LocalUse | undefined
  /** `sessionStorage`, in code units. */
  tab: number
}

async function siteUse(): Promise<StorageReading['site']> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.usage === undefined || !estimate.quota) return undefined
    return { usage: estimate.usage, quota: estimate.quota }
  } catch {
    return undefined
  }
}

async function sitePersisted(): Promise<boolean | undefined> {
  try {
    return await navigator.storage?.persisted?.()
  } catch {
    return undefined
  }
}

/**
 * One reading of everything above. Started together, which overlaps the reads' I/O; the
 * deserialising and sizing still take turns on the main thread.
 */
export async function measureStorage(): Promise<StorageReading> {
  const [site, persisted, cache, session, shelves] = await Promise.all([
    siteUse(),
    sitePersisted(),
    cacheUsage(),
    sessionUsage(),
    Promise.all(
      SHELVES.map(async ({ measure, ...shelf }) => ({ ...shelf, usage: await measure() })),
    ),
  ])
  return { site, persisted, cache, session, shelves, local: readLocalUse(), tab: readTabUse() }
}

/** Clear the data cache, and re-read only what that moved: the cache and the site total. */
export async function clearDownloadedData(reading: StorageReading): Promise<StorageReading> {
  await cacheClear()
  const [site, cache] = await Promise.all([siteUse(), cacheUsage()])
  return { ...reading, site, cache }
}
