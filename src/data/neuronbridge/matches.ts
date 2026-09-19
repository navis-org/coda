/**
 * What a card does to a match file before drawing it: which collection each match came from, and
 * one entry per *line*.
 *
 * **A line, not an image, is the unit people ask about.** Measured on a hemibrain neuron: 2,085
 * CDS matches are 746 distinct lines, up to five images each, and its top twenty images are twelve
 * lines. Ranked by image, the first screen spends a third of its tiles repeating lines already on
 * it. So matches are grouped by the line they image and ranked by each line's *best* image — the
 * ordering NeuronBridge's own list would give its first image of each line — with the others kept
 * behind it for a reader who wants them.
 *
 * Headless and pure, so the ranking is testable without a DOM and cannot drift between the card
 * and anything that reads it later.
 */

import type { NbMatch } from './types'
import type { NbMethod } from './client'

/**
 * The four LM collections NeuronBridge matches against, as a closed vocabulary.
 *
 * Classified from the library's *name* because that is all a match carries, and the names are not
 * one spelling: the brain's MCFO is `FlyLight Gen1 MCFO v1.1` and the nerve cord's is
 * `FlyLight Gen1 MCFO`, and config spells both with underscores. Anything unrecognised is `other`
 * and **shown**, never hidden: a collection a later release adds must not vanish behind a filter
 * whose chips predate it.
 */
export type NbCollection = 'split' | 'omnibus' | 'mcfo' | 'annotator' | 'other'

export const COLLECTIONS: readonly { id: NbCollection; label: string; short: string }[] = [
  { id: 'split', label: 'Split-GAL4 Drivers', short: 'Split' },
  { id: 'omnibus', label: 'Split-GAL4 Omnibus Broad', short: 'Omnibus' },
  { id: 'mcfo', label: 'Gen1 MCFO', short: 'MCFO' },
  { id: 'annotator', label: 'Annotator Gen1 MCFO', short: 'Annot.' },
]

export function collectionOf(libraryName: string): NbCollection {
  const name = libraryName.replace(/_/g, ' ').toLowerCase()
  // Order matters: an annotator library is also MCFO, and an omnibus one is also split-GAL4.
  if (name.includes('annotator')) return 'annotator'
  if (name.includes('omnibus')) return 'omnibus'
  if (name.includes('split-gal4') || name.includes('split gal4')) return 'split'
  if (name.includes('mcfo')) return 'mcfo'
  return 'other'
}

export function collectionShort(collection: NbCollection): string {
  return COLLECTIONS.find((c) => c.id === collection)?.short ?? 'Other'
}

/**
 * A match's score, in the direction where larger is better.
 *
 * CDS publishes a normalised score where larger is better; PPPM publishes a *rank*, 0 best, beside
 * a score whose scale is not documented as comparable across files. So PPPM is ordered by rank,
 * negated, and the card prints the rank — one number per method, and never the two mixed in one
 * ordering.
 */
export function matchStrength(match: NbMatch, method: NbMethod): number {
  if (method === 'pppm') return match.pppmRank === undefined ? -Infinity : -match.pppmRank
  return match.normalizedScore ?? -Infinity
}

/** One line on a card: its best image, and the others behind it, best first. */
export interface NbLine {
  /** The line name, e.g. `SS02800`. */
  readonly line: string
  readonly best: NbMatch
  /** Every image of this line in the file, `best` first. */
  readonly images: readonly NbMatch[]
}

/**
 * Matches in the chosen collections, one entry per line, strongest line first.
 *
 * Ties keep file order, which is NeuronBridge's own order, so equal scores do not shuffle between
 * two renders.
 */
export function groupByLine(
  results: readonly NbMatch[],
  method: NbMethod,
  collections: ReadonlySet<NbCollection>,
): NbLine[] {
  const byLine = new Map<string, NbMatch[]>()
  for (const match of results) {
    const collection = collectionOf(match.image.libraryName)
    if (collection !== 'other' && !collections.has(collection)) continue
    const line = match.image.publishedName
    const held = byLine.get(line)
    if (held) held.push(match)
    else byLine.set(line, [match])
  }
  const lines: Array<NbLine & { order: number }> = []
  let order = 0
  for (const [line, images] of byLine) {
    const ranked = images
      .map((match, index) => ({ match, index }))
      .sort(
        (a, b) =>
          matchStrength(b.match, method) - matchStrength(a.match, method) || a.index - b.index,
      )
      .map((entry) => entry.match)
    lines.push({ line, best: ranked[0]!, images: ranked, order: order++ })
  }
  lines.sort(
    (a, b) =>
      matchStrength(b.best, method) - matchStrength(a.best, method) || a.order - b.order,
  )
  return lines.map(({ order: _order, ...line }) => line)
}

/** How many matches fall in each collection, for the chips' counts. Ignores the filter. */
export function collectionCounts(results: readonly NbMatch[]): Map<NbCollection, number> {
  const counts = new Map<NbCollection, number>()
  for (const match of results) {
    const collection = collectionOf(match.image.libraryName)
    counts.set(collection, (counts.get(collection) ?? 0) + 1)
  }
  return counts
}
