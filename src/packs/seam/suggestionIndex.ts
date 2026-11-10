/**
 * A directory of suggestion sets, and the peek that fills the card's picker.
 *
 * ## Why a directory needs an index at all
 *
 * **A browser cannot list an HTTP directory.** There is no portable way: a web server serves
 * files, not listings, and Coda's only bucket-listing path is GCS-specific. So a directory a
 * pipeline deposits sets into has to advertise what it holds, the way a precomputed volume has
 * `info` and a Delta table has `_delta_log`. That document is this one, written by whatever
 * deposits the sets.
 *
 * The entries carry enough to *choose* without fetching each set's own manifest — the datastack,
 * the snapshot, the counts — because a picker that had to fetch N manifests to draw itself would
 * fetch them on every inference pass.
 *
 * ## The peek, and why it is not a fetch from `inferOutputs`
 *
 * An enum's options are read at edit time, synchronously, on every inference pass, and invariant
 * 2 says that path may not fetch. So this is the shape every dataset picker in Coda already has:
 * a synchronous read of a memo that **starts** the fetch it cannot answer, once per address, and
 * fires `reportSourceLearned` when it lands so the pass that drew an empty dropdown runs again
 * and fills it.
 *
 * A failure is remembered too. Without that, a card pointed at a typo would re-fetch on every
 * keystroke anywhere in the graph, which is the thing `memoPromise`'s `keep: 'resolved'` exists
 * to avoid elsewhere — here the memo is tiny and holding the error is what makes the refusal
 * sayable in `validate`.
 */

import { fetchText } from '../../data/fetchText'
import { reportSourceLearned } from '../../data/source'

/** What `reportSourceLearned` is told, so a filled listing re-runs inference. */
export const SUGGESTIONS_SOURCE = 'seam:suggestions'

/** One set in a directory, as the index describes it. */
export interface IndexEntry {
  /** Stable, and what the card stores. Unique within an index. */
  readonly id: string
  /** The set's manifest, relative to the index's own address. */
  readonly path: string
  /** For the dropdown. The id where the index gives none. */
  readonly label: string
  readonly datastack: string | undefined
  readonly snapshot: string | undefined
  /** How many tips, shown suggestions and neurons, where the index says. */
  readonly tips: number | undefined
  readonly shown: number | undefined
  readonly neurons: number | undefined
}

export interface SuggestionIndex {
  readonly url: string
  readonly sets: readonly IndexEntry[]
}

/** What a peek of an address has found so far. */
export type Peek =
  | { readonly state: 'pending' }
  | { readonly state: 'index'; readonly index: SuggestionIndex }
  /** The address is one set's manifest, not a directory index. */
  | { readonly state: 'single' }
  | { readonly state: 'failed'; readonly why: string }

/** What a directory's index is called, where an address names a directory rather than a file. */
export const INDEX_FILE = 'index.json'

/**
 * The address to actually read, from whatever somebody pasted.
 *
 * A reader copies a directory out of their browser's address bar, which gives
 * `…/suggestions/aedes/` — and that is the honest thing to paste, since the directory *is* what
 * the card points at. The index file's name is Coda's convention rather than part of the
 * address, so it is filled in here instead of being a rule everyone has to remember.
 *
 * An address whose last segment has no extension is a directory too: `…/suggestions/aedes` is
 * the same place as `…/suggestions/aedes/`, and a reader who left the slash off meant the same
 * thing. A segment with a dot in it is taken at its word, so a set's own `fixture.json` — and
 * an index somebody has named something else — still reach this unchanged.
 *
 * **One function, used by every caller**, because the alternative is the picker peeking at one
 * address while the run reads another, which would look like a directory that fills a dropdown
 * and then refuses.
 */
export function suggestionsAddress(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    // Not a URL at all. `validate` says so in its own words; rewriting it here would only change
    // which nonsense the message quotes.
    return text
  }
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  if (last.includes('.')) return text
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${INDEX_FILE}`
  return url.toString()
}

const peeks = new Map<string, Peek>()

/**
 * What is known about an address, starting the fetch where nothing is.
 *
 * Synchronous by contract: every caller is on the edit-time path.
 */
export function peekSuggestions(url: string): Peek {
  const address = suggestionsAddress(url)
  if (!address) return { state: 'failed', why: 'no address' }
  const held = peeks.get(address)
  if (held) return held
  peeks.set(address, { state: 'pending' })
  void fetchText(address)
    .then((text) => {
      const json: unknown = JSON.parse(text)
      peeks.set(address, settle(json, address))
    })
    .catch((error: unknown) => {
      peeks.set(address, {
        state: 'failed',
        why: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => reportSourceLearned(SUGGESTIONS_SOURCE))
  return { state: 'pending' }
}

/**
 * Which kind of document arrived.
 *
 * Decided by its own fields rather than by the address, so one param takes either — a directory
 * of sets or a single set's manifest — and a reader who has one URL does not have to know which
 * kind of thing it is before pasting it. An index has `sets`; a manifest has `pipeline`.
 */
function settle(json: unknown, url: string): Peek {
  if (!json || typeof json !== 'object') {
    return { state: 'failed', why: `${url} is not a JSON object.` }
  }
  const root = json as Record<string, unknown>
  if (Array.isArray(root.sets)) {
    try {
      return { state: 'index', index: parseSuggestionIndex(json, url) }
    } catch (error) {
      return { state: 'failed', why: error instanceof Error ? error.message : String(error) }
    }
  }
  if (root.pipeline) return { state: 'single' }
  return {
    state: 'failed',
    why:
      `${url} is neither a suggestion set's manifest (which has \`pipeline\`) nor a directory ` +
      `index (which has \`sets\`).`,
  }
}

/** Forget every peek. For tests, and for a reader who has replaced a directory's contents. */
export function resetSuggestionPeeks(): void {
  peeks.clear()
}

/** Read an index document, or say what is wrong with it. */
export function parseSuggestionIndex(json: unknown, url: string): SuggestionIndex {
  const root = json as { sets?: unknown }
  if (!Array.isArray(root.sets)) {
    throw new Error(`${url}: a directory index needs a \`sets\` list.`)
  }
  const sets: IndexEntry[] = []
  const seen = new Set<string>()
  for (const [i, raw] of root.sets.entries()) {
    const entry = raw as Record<string, unknown>
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    const path = typeof entry?.path === 'string' ? entry.path.trim() : ''
    if (!id || !path) {
      throw new Error(`${url}: set ${i + 1} needs an \`id\` and a \`path\`.`)
    }
    // A card stores the id, so two sets sharing one would make a pinned card ambiguous — and it
    // would resolve to whichever came first, silently, for as long as the index kept its order.
    if (seen.has(id)) throw new Error(`${url}: two sets are called "${id}".`)
    seen.add(id)
    sets.push({
      id,
      path,
      label: typeof entry.label === 'string' && entry.label ? entry.label : id,
      datastack: text(entry.datastack),
      snapshot: text(entry.snapshot),
      tips: count(entry, 'tips'),
      shown: count(entry, 'shown'),
      neurons: count(entry, 'neurons'),
    })
  }
  return { url, sets }
}

/** A set in an index, by the id a card pinned. */
export function entryById(index: SuggestionIndex, id: string): IndexEntry | undefined {
  return index.sets.find((set) => set.id === id)
}

/** One line for a dropdown: what it is, and how much of it there is. */
export function entryLabel(entry: IndexEntry): string {
  const parts = [entry.label]
  if (entry.datastack) parts.push(entry.datastack)
  if (entry.shown !== undefined && entry.tips !== undefined) {
    parts.push(`${entry.shown.toLocaleString()} of ${entry.tips.toLocaleString()} tips shown`)
  }
  if (entry.snapshot) parts.push(entry.snapshot.slice(0, 10))
  return parts.join(' · ')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** A count from the entry or from its `counts` record, wherever the index put it. */
function count(entry: Record<string, unknown>, name: string): number | undefined {
  const counts = entry.counts as Record<string, unknown> | undefined
  const value = typeof entry[name] === 'number' ? entry[name] : counts?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
