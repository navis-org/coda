/**
 * Which NeuronBridge libraries a Coda dataset is.
 *
 * A body id is only an identity *within* a dataset — `by_body/11442` is three neurons in MANC,
 * male-CNS and the VNC pilot — so everything read from NeuronBridge is filtered to the libraries
 * the wired dataset corresponds to, and nothing is ever chosen by position.
 *
 * The library list itself is **not** written here: `config.json` publishes each EM library with a
 * `publishedNamePrefix` (`male-cns:v0.9`), and that prefix's family half is the one thing that has
 * to be mapped by hand, since NeuronBridge and Coda name the same connectome differently —
 * `flywire_fafb` is Coda's CAVE family `flywire_fafb_public`. So a release adding a new version
 * of a dataset Coda already knows needs no change at all, and the version half is compared rather
 * than assumed.
 */

import { backendOf } from '../source'
import type { NbConfig } from './client'

interface Correspondence {
  /** NeuronBridge's family, the part of `publishedNamePrefix` before the colon. */
  readonly nb: string
  /** The Coda backend and family serving the same connectome. */
  readonly backend: string
  readonly family: string
  /** For sentences. */
  readonly label: string
}

const CORRESPONDENCES: readonly Correspondence[] = [
  { nb: 'hemibrain', backend: 'neuprint', family: 'hemibrain', label: 'hemibrain' },
  { nb: 'male-cns', backend: 'neuprint', family: 'male-cns', label: 'male CNS' },
  { nb: 'manc', backend: 'neuprint', family: 'manc', label: 'MANC' },
  { nb: 'flywire_fafb', backend: 'cave', family: 'flywire_fafb_public', label: 'FlyWire FAFB' },
  {
    nb: 'flywire_banc',
    backend: 'cave',
    family: 'brain_and_nerve_cord_public',
    label: 'BANC',
  },
]

/** The datasets NeuronBridge covers, as one sentence — for a card wired to anything else. */
export const COVERED_DATASETS = CORRESPONDENCES.map((c) => c.label).join(', ')

function splitId(datasetId: string): [family: string, version: string] {
  const at = datasetId.indexOf(':')
  return at === -1 ? [datasetId, ''] : [datasetId.slice(0, at), datasetId.slice(at + 1)]
}

function correspondenceFor(sourceId: string, datasetId: string): Correspondence | undefined {
  const [family] = splitId(datasetId)
  const backend = backendOf(sourceId)
  return CORRESPONDENCES.find((c) => c.backend === backend && c.family === family)
}

/**
 * Whether NeuronBridge could have matches for this dataset at all. Synchronous and network-free,
 * for `validate`: it asks the static correspondence, never the config.
 */
export function isCoveredDataset(sourceId: string, datasetId: string): boolean {
  return correspondenceFor(sourceId, datasetId) !== undefined
}

/** `v1.2.1`, `1.2.1` and `783` all compare as what they are. */
function normaliseVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/** What a dataset is in one NeuronBridge release: its libraries, and whether the versions agree. */
export interface NbDatasetLibraries {
  /** Library names, for filtering records by `libraryName`. Empty when this release has none. */
  readonly names: ReadonlySet<string>
  /** The dataset version NeuronBridge matched, e.g. `v0.9` — from the prefix, as published. */
  readonly nbVersion: string | undefined
  /** The wired dataset's own version, as its id spells it. */
  readonly datasetVersion: string
  /**
   * The two disagree. Not a refusal — a body id that exists in both releases is looked up anyway —
   * but a card must say so, because an id kept through an edit names a body whose shape changed.
   */
  readonly versionMismatch: boolean
}

export function datasetLibraries(
  config: NbConfig,
  sourceId: string,
  datasetId: string,
): NbDatasetLibraries | undefined {
  const correspondence = correspondenceFor(sourceId, datasetId)
  if (!correspondence) return undefined
  const [, datasetVersion] = splitId(datasetId)
  const libraries = config.emLibraries.filter(
    (library) => splitId(library.publishedNamePrefix)[0] === correspondence.nb,
  )
  const nbVersion =
    libraries.length > 0 ? splitId(libraries[0]!.publishedNamePrefix)[1] : undefined
  return {
    names: new Set(libraries.map((library) => library.name)),
    nbVersion,
    datasetVersion,
    versionMismatch:
      nbVersion !== undefined &&
      datasetVersion !== '' &&
      normaliseVersion(nbVersion) !== normaliseVersion(datasetVersion),
  }
}
