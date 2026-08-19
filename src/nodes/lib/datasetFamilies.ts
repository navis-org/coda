/**
 * The dataset families Coda ships a node for, and how a family's versions are resolved.
 *
 * ## Why the list is static and the versions are not
 *
 * Node types must exist at module load: the store resolves them the moment it deserialises the
 * autosaved graph, so a type registered later would make a saved graph momentarily — and
 * visibly — lose its nodes. A dataset listing is a network call. Those two facts cannot both be
 * satisfied by generating nodes from the live listing, so the split is:
 *
 *  - the **family list here is static** — one entry per dataset family, carrying only
 *    presentation (label, blurb, glyph);
 *  - everything that actually changes — which versions exist, their ROIs, their column schemas,
 *    their neuron counts — is read live from the source and never hard-coded.
 *
 * A family Janelia adds later has no node until a line is added below, and `Custom neuPrint`
 * covers it in the meantime. That is the cost of the trade, and it is a line of code against a
 * class of silent load-order bug.
 */

import type { DatasetInfo } from '../../data/source'
import { getSource } from '../../data/source'

/** Which silhouette the node's thumbnail placeholder draws. Falls back to `specimen`. */
export type DatasetGlyph = 'brain' | 'vnc' | 'cns' | 'optic' | 'specimen'

export interface DatasetFamily {
  /** Node type suffix and stable id: `dataset.<key>`. Never change one that has shipped. */
  key: string
  /** Registered source this family lives in. */
  sourceId: string
  /**
   * Family half of a `family:version` dataset id — `male-cns` for `male-cns:v1.0`. For sources
   * whose ids carry no version (the mock), this is the whole id.
   */
  family: string
  label: string
  description: string
  glyph: DatasetGlyph
  /**
   * Generated in the browser rather than reconstructed by anyone.
   *
   * The only thing this changes is that a synthetic dataset node arrives without the
   * Description companion: that card exists to carry the credit and the citation a published
   * connectome asks for, and there is nobody to cite for a connectome Coda made up on load.
   */
  synthetic?: boolean
}

/**
 * neuPrint's families, as published at `/api/dbmeta/datasets`. Verified against the live
 * listing: fib19:v1.0, hemibrain:v1.1, hemibrain:v1.2.1, male-cns:v0.9, male-cns:v1.0,
 * manc:v1.0, manc:v1.2.1, manc:v1.2.3, mushroombody, optic-lobe:v1.0.1, optic-lobe:v1.1.
 */
const NEUPRINT_FAMILIES: DatasetFamily[] = [
  {
    key: 'malecns',
    sourceId: 'neuprint',
    family: 'male-cns',
    label: 'MaleCNS',
    description: 'Whole central nervous system of an adult male fly — brain and ventral nerve cord.',
    glyph: 'cns',
  },
  {
    key: 'hemibrain',
    sourceId: 'neuprint',
    family: 'hemibrain',
    label: 'Hemibrain',
    description: 'Central brain of an adult female fly. The most heavily annotated fly connectome.',
    glyph: 'brain',
  },
  {
    key: 'manc',
    sourceId: 'neuprint',
    family: 'manc',
    label: 'MANC',
    description: 'Male adult nerve cord — the ventral nerve cord, motor and premotor circuits.',
    glyph: 'vnc',
  },
  {
    key: 'opticlobe',
    sourceId: 'neuprint',
    family: 'optic-lobe',
    label: 'Optic Lobe',
    description: 'The right optic lobe: medulla, lobula and lobula plate, columnar to the core.',
    glyph: 'optic',
  },
  {
    key: 'fib19',
    sourceId: 'neuprint',
    family: 'fib19',
    label: 'FIB-19',
    description: 'An early FIB-SEM volume of the mushroom body and surrounds. Small and partial.',
    glyph: 'brain',
  },
  {
    key: 'mushroombody',
    sourceId: 'neuprint',
    family: 'mushroombody',
    label: 'Mushroom Body',
    description: 'Mushroom body reconstruction. Carries no version in its dataset id.',
    glyph: 'brain',
  },
]

/** The synthetic connectomes, which need no token and are what the examples run on. */
const MOCK_FAMILIES: DatasetFamily[] = [
  {
    key: 'mock.hemibrain',
    sourceId: 'mock',
    family: 'hemibrain-mini',
    label: 'Hemibrain (mini)',
    description: 'Synthetic mushroom-body-like connectome generated in the browser. No token needed.',
    glyph: 'brain',
    synthetic: true,
  },
  {
    key: 'mock.opticlobe',
    sourceId: 'mock',
    family: 'optic-lobe-mini',
    label: 'Optic Lobe (mini)',
    description: 'Synthetic optic-lobe-like connectome generated in the browser. No token needed.',
    glyph: 'optic',
    synthetic: true,
  },
]

export const DATASET_FAMILIES: DatasetFamily[] = [...NEUPRINT_FAMILIES, ...MOCK_FAMILIES]

export function datasetFamily(key: string): DatasetFamily | undefined {
  return DATASET_FAMILIES.find((f) => f.key === key)
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface DatasetVersion {
  /** Full dataset id to query with, e.g. `male-cns:v1.0`. */
  datasetId: string
  /** Version half, e.g. `v1.0`. Empty for an id that carries none. */
  version: string
  /** What the dropdown shows. */
  label: string
}

/** Split `family:version`; a dataset id without a colon is all family. */
export function splitDataset(id: string): [family: string, version: string] {
  const at = id.indexOf(':')
  return at === -1 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)]
}

/**
 * Order two version strings.
 *
 * Numeric segment by segment, so `v1.10` beats `v1.9` where a string compare would not, and
 * `v1.2.1` beats `v1.2`. Non-numeric segments compare as text, which is what keeps a
 * `mock-1.0` or a `2023-06` from collapsing to zero and tying with everything else.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[._-]/)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? ''
    const r = right[i] ?? ''
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn) && l !== '' && r !== '') {
      if (ln !== rn) return ln - rn
      continue
    }
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Versions of a family the source currently knows about, newest first.
 *
 * Synchronous and possibly empty: it reads `peekDatasets`, which is undefined until the first
 * listing resolves. Inference runs on every graph mutation and cannot await, so "not yet" has to
 * be an answer — the dropdown fills itself when the listing lands.
 */
export function versionsFor(family: DatasetFamily): DatasetVersion[] {
  const datasets = getSource(family.sourceId)?.peekDatasets() ?? []
  return datasets
    .filter((info) => splitDataset(info.id)[0] === family.family)
    .map((info) => versionOf(info))
    .sort((a, b) => compareVersions(b.version, a.version))
}

function versionOf(info: DatasetInfo): DatasetVersion {
  const [, version] = splitDataset(info.id)
  // A source whose ids carry no version can still report one in its metadata; showing that
  // beats an empty dropdown that looks broken.
  const shown = version || info.version || ''
  return {
    datasetId: info.id,
    version: shown,
    label: shown || 'only version',
  }
}

/**
 * Resolve the `version` param to a dataset id.
 *
 * An empty param means **latest**, resolved identically here at infer time and at eval time so
 * the provenance key cannot disagree with what actually ran. A stored version that is no longer
 * listed is kept rather than silently upgraded: a graph that says `v0.9` must keep meaning
 * `v0.9`, and `validate` reports it as missing instead.
 */
export function resolveDatasetId(family: DatasetFamily, version: unknown): string | undefined {
  const available = versionsFor(family)
  if (typeof version === 'string' && version) {
    const match = available.find((v) => v.version === version)
    if (match) return match.datasetId
    /*
     * Not listed — either the listing has not arrived, or this version is genuinely gone.
     * Trust the stored value and rebuild the id, because a graph that says v0.9 must keep
     * meaning v0.9; `validate` is what reports it as missing once the listing does arrive.
     * `family:version` is neuPrint's convention, and the only sources whose ids do not follow
     * it (the mock) always have their listing available synchronously, so this branch is
     * neuPrint's alone in practice.
     */
    return family.family === version ? version : `${family.family}:${version}`
  }
  return available[0]?.datasetId
}
