/**
 * A suggestion set's manifest: where SEAM's merge candidates are, and what they were made with.
 *
 * The manifest is SEAM's own `fixture.json`, unchanged — it already carries the snapshot, the
 * datastack, the neurons, every frozen fit of the pipeline and the counts, which is exactly what
 * `src/ml/manifest.ts` carries for a model. Reading it rather than inventing a Coda-side wrapper
 * is what keeps the node's input the same shape on the day a service answers instead of a
 * directory of files.
 *
 * ## The fits are carried, not parsed
 *
 * `pipeline` reaches this type as `unknown`. Phase 1 publishes what SEAM computed; Phase 4
 * recomputes stages 7-9 in the browser and is the thing that needs `ref`, `p_tip`, the cutoff and
 * the isotonic steps as numbers. Parsing them now would be a schema nobody reads, going stale
 * against a file SEAM refits whenever a stage changes.
 *
 * What *is* read here is only what Phase 1 shows or checks: the snapshot (a suggestion is tied to
 * one, and the neurons have been edited since), the datastack, the neuron list, the commit, and
 * the counts the probe asserts against.
 *
 * ## The cutoff is read, never written down
 *
 * `shown` arrives as a column, so nothing here needs the cutoff to decide anything. It is read
 * only to *say* — a card that prints "97 of 2,708 above 0.2084" has to get the number from the
 * file, because SEAM refits it whenever a stage changes and a hard-coded 0.2084 would be right
 * today and quietly wrong after the next run.
 */

import { fetchText } from '../../data/fetchText'
import { suggestionsAddress } from './suggestionIndex'

/** The files a set is made of, resolved against the manifest's own URL. */
export const TIPS_FILE = 'tips.parquet'
export const CANDIDATES_FILE = 'candidates.parquet'

export interface SuggestionCounts {
  readonly tips: number
  readonly shown: number
  readonly candidates: number
}

export interface SuggestionSet {
  /** Where the manifest was read from. Every file resolves against it. */
  readonly manifestUrl: string
  /** ISO-ish, as SEAM writes it. Shown, never parsed: it is a label on an answer. */
  readonly snapshot: string
  readonly datastack: string
  readonly dataset: string
  /** The neurons this set covers, as text (invariant 8). */
  readonly neurons: readonly string[]
  /** The neuron held out of the cutoff's calibration, where the set names one. */
  readonly testNeuron: string | undefined
  /** SEAM's commit, with `-dirty` where it had uncommitted changes. The set's version. */
  readonly commit: string
  /** The absolute score at or above which a first candidate is shown. Read, never assumed. */
  readonly cutoff: number
  readonly counts: SuggestionCounts
}

/** The address of one of the set's files. */
export function fileUrl(set: SuggestionSet, file: string): string {
  return new URL(file, set.manifestUrl).toString()
}

/**
 * Fetch and read a manifest.
 *
 * Through `fetchText`, which is the one reader that can tell "unreachable" from "CORS refused" —
 * the two failures a reader pointed at a URL meets, and the two that look identical in a bare
 * `fetch`.
 */
export async function loadSuggestionSet(
  raw: string,
  signal?: AbortSignal,
): Promise<SuggestionSet> {
  /*
   * Normalised here rather than by the caller, and that is a correction: it used to be the
   * caller's, and three different callers forgot — the node's first draft, the probe, and a
   * one-off script — each getting the host's `403` for a directory and reading it as the set
   * being unreachable. `suggestionsAddress` is idempotent, so a caller that has already done it
   * loses nothing, and one that has not can no longer be wrong.
   */
  const url = suggestionsAddress(raw)
  const text = await fetchText(url, { signal })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(
      `${url} is not JSON. A suggestion set's address is its manifest — SEAM's \`fixture.json\` — ` +
        `not the directory holding it.`,
    )
  }
  return parseSuggestionSet(json, url)
}

/**
 * Read a manifest's fields, or say which one is wrong.
 *
 * Every refusal names the field and the file, because the thing a reader has most likely done is
 * point this at the wrong JSON — a model manifest, a directory listing, an error page that
 * parsed. A set missing `counts` is a set this node cannot check itself against, so it is refused
 * rather than defaulted.
 */
export function parseSuggestionSet(json: unknown, manifestUrl: string): SuggestionSet {
  const root = asRecord(json, 'the manifest')
  /*
   * A directory's index, handed over where one set's manifest was wanted. Said in its own words
   * rather than as "needs `pipeline`", because the reader has not given a broken manifest — they
   * have given the right file for a different question, and the answer is which set they mean.
   */
  if (Array.isArray(root.sets)) {
    const ids = root.sets
      .map((entry) => (entry as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string')
    throw new Error(
      `${manifestUrl} is a directory index, not one set's manifest. ` +
        (ids.length > 0
          ? `It lists ${ids.join(', ')}; name one in \`Set\`.`
          : 'It lists no sets.'),
    )
  }
  const pipeline = asRecord(root.pipeline, 'pipeline')
  const show = asRecord(pipeline.show, 'pipeline.show')
  const counts = asRecord(root.counts, 'counts')
  const neurons = root.neurons
  if (!Array.isArray(neurons) || neurons.some((n) => typeof n !== 'string')) {
    // Not a convenience check: a numeric id in this list is already a different neuron by the
    // time anybody could notice (invariant 8), so a set carrying one is refused rather than read.
    throw new Error(
      `${manifestUrl}: \`neurons\` must be a list of root ids as text. A numeric id is a ` +
        `different neuron.`,
    )
  }
  return {
    manifestUrl,
    snapshot: asString(root.snapshot, 'snapshot', manifestUrl),
    datastack: asString(root.datastack, 'datastack', manifestUrl),
    dataset: asString(root.dataset, 'dataset', manifestUrl),
    neurons: neurons as string[],
    testNeuron: typeof root.test_neuron === 'string' ? root.test_neuron : undefined,
    commit: asString(root.commit, 'commit', manifestUrl),
    cutoff: asNumber(show.cutoff, 'pipeline.show.cutoff', manifestUrl),
    counts: {
      tips: asNumber(counts.tips, 'counts.tips', manifestUrl),
      shown: asNumber(counts.shown, 'counts.shown', manifestUrl),
      candidates: asNumber(counts.candidates, 'counts.candidates', manifestUrl),
    },
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`A suggestion set's manifest needs \`${what}\`, and this one has none.`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, field: string, url: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${url}: \`${field}\` must be a non-empty string.`)
  }
  return value
}

function asNumber(value: unknown, field: string, url: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${url}: \`${field}\` must be a number.`)
  }
  return value
}
