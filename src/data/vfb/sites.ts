/**
 * Which Virtual Fly Brain site a Coda dataset is, and which dataset-name key VFB uses for it.
 *
 * VFB cross-references a connectome neuron through a `:Site` node, one per *release*:
 * `male_cns_v0_9` and `male_cns_v1_0` are both there (166,681 and 166,693 individuals on
 * 2026-10-14), as are `BANC626` and `BANC888`, and hemibrain v1.0.1 beside v1.2.1. A root id or
 * body id is an identity only within one release (a CAVE root id at another materialization is a
 * different neuron, `docs/backends.md`), so the mapping is **version-exact**. A dataset whose family
 * VFB holds but whose version it does not is answered `undefined` from `vfbSiteFor`, and
 * `siteRefusal` names the versions it does hold. It is never mapped to the nearest one.
 *
 * Type *names* are a different matter. FBbt classes carry curated per-dataset names as synonyms
 * (`fbbt#name_in_hemibrain`, `name_in_banc`, …), keyed by family rather than release, so every
 * release of a family carries the same `nameKey` and a name lookup needs no version at all.
 *
 * The table is typed, not discovered, for `libraries.ts`' reason in `data/neuronbridge`: VFB and
 * Coda name the same connectome differently, and that correspondence is the one thing nothing
 * publishes. `live.test.ts` asserts every `site` here exists in the PDB.
 */

import { listed } from '../../core/prose'
import { compareVersions, splitDataset } from '../../nodes/lib/datasetFamilies'
import { backendOf } from '../source'

export interface VfbSite {
  /** The `:Site` node's `short_form`, as the PDB spells it. */
  readonly site: string
  /** The Coda backend serving the same release. */
  readonly backend: string
  /** The Coda family: the part of a dataset id before `:`. */
  readonly family: string
  /**
   * The version as Coda's dataset id spells it (`v1.2.1`, `783`), so `label` reads like the
   * version picker. Matched with `compareVersions`, so a missing or extra `v` does not matter.
   */
  readonly version: string
  /** The connectome's name, without a version. */
  readonly name: string
  /** The suffix of FBbt's `name_in_*` synonym type for this family. */
  readonly nameKey: string
}

export const VFB_SITES: readonly VfbSite[] = [
  {
    site: 'neuprint_JRC_Hemibrain_1point2point1',
    backend: 'neuprint',
    family: 'hemibrain',
    version: 'v1.2.1',
    name: 'hemibrain',
    nameKey: 'hemibrain',
  },
  {
    site: 'male_cns_v0_9',
    backend: 'neuprint',
    family: 'male-cns',
    version: 'v0.9',
    name: 'male CNS',
    nameKey: 'male-cns',
  },
  {
    site: 'male_cns_v1_0',
    backend: 'neuprint',
    family: 'male-cns',
    version: 'v1.0',
    name: 'male CNS',
    nameKey: 'male-cns',
  },
  {
    site: 'neuprint_JRC_Manc',
    backend: 'neuprint',
    family: 'manc',
    version: 'v1.0',
    name: 'MANC',
    nameKey: 'manc',
  },
  {
    site: 'neuprint_JRC_Manc_1_2_1',
    backend: 'neuprint',
    family: 'manc',
    version: 'v1.2.1',
    name: 'MANC',
    nameKey: 'manc',
  },
  {
    site: 'neuprint_JRC_OpticLobe_v1_0_1',
    backend: 'neuprint',
    family: 'optic-lobe',
    version: 'v1.0.1',
    name: 'Optic Lobe',
    nameKey: 'neuprint_optic_lobe',
  },
  {
    site: 'flywire783',
    backend: 'cave',
    family: 'flywire_fafb_public',
    version: '783',
    name: 'FlyWire',
    nameKey: 'flywire_fafb',
  },
  {
    site: 'BANC626',
    backend: 'cave',
    family: 'brain_and_nerve_cord_public',
    version: '626',
    name: 'BANC',
    nameKey: 'banc',
  },
  {
    site: 'BANC888',
    backend: 'cave',
    family: 'brain_and_nerve_cord_public',
    version: '888',
    name: 'BANC',
    nameKey: 'banc',
  },
]

/** Name and version, for sentences: `hemibrain v1.2.1`, `BANC 888`. */
export const siteLabel = (s: VfbSite): string => `${s.name} ${s.version}`

/** The releases VFB holds of a dataset's family, and whether this exact one is among them. */
function lookup(sourceId: string, datasetId: string) {
  const [family, version] = splitDataset(datasetId)
  const backend = backendOf(sourceId)
  const held = VFB_SITES.filter((s) => s.backend === backend && s.family === family)
  return { version, held, exact: held.find((s) => compareVersions(s.version, version) === 0) }
}

/**
 * The VFB site for exactly this release, or `undefined`. Synchronous and network-free, so
 * `validate` and `inferOutputs` may ask it (invariant 2).
 */
export function vfbSiteFor(sourceId: string, datasetId: string): VfbSite | undefined {
  return lookup(sourceId, datasetId).exact
}

/**
 * Why a dataset has no VFB site, in one sentence, or `undefined` when it has one. The two cases
 * differ in what the reader can do: a family VFB never holds has no fix, and a version it does
 * not hold is fixed by choosing one it does.
 */
export function siteRefusal(sourceId: string, datasetId: string): string | undefined {
  const { version, held, exact } = lookup(sourceId, datasetId)
  if (exact) return undefined
  if (held.length === 0) {
    const covered = [...new Set(VFB_SITES.map((s) => s.name))]
    return `Virtual Fly Brain holds no neurons from this dataset. It covers ${listed(covered)}.`
  }
  return (
    `Virtual Fly Brain holds this dataset at ${listed(held.map(siteLabel))}, ` +
    `not at ${version || 'this version'}. Neuron ids are only identities within one release, ` +
    `so choose one of those versions.`
  )
}
