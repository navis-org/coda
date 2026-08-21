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

/**
 * The backends a dataset can be served by.
 *
 * A table rather than a flag, because "which backend" is now three separate things a reader
 * needs — the suffix in the node's name, the tint on its card, and the mark on its browser tile
 * — and a fourth backend should be one entry here rather than four edits spread across the UI.
 *
 * It exists at all because the backends stopped being interchangeable. A neuPrint dataset
 * carries its own annotation and answers a path query server-side; a CAVE datastack has neither
 * and takes its labels from whatever is wired to it. Those are different enough that reading a
 * graph means knowing which you are looking at — and **one dataset can be served by both**, so
 * the name has to say.
 */
export interface DatasetBackend {
  /** Stable id. Also the `data-backend` attribute, and the CSS token suffix. */
  id: string
  /** What goes in a node's name: `MaleCNS (neuPrint)`. Empty adds no suffix. */
  label: string
  /**
   * Whether its dataset nodes take an Annotations socket.
   *
   * neuPrint carries its own cell typing as properties on the neuron, so there is nothing for a
   * source to replace and a socket would be a control that changes nothing. A CAVE datastack
   * takes its labels from a table, which is exactly the thing an annotation source *is* — and
   * for several datastacks there is no such table at all.
   */
  acceptsAnnotations?: boolean
}

export const BACKENDS: Record<string, DatasetBackend> = {
  neuprint: {
    id: 'neuprint',
    label: 'neuPrint',
  },
  cave: {
    id: 'cave',
    label: 'CAVE',
    acceptsAnnotations: true,
  },
  /*
   * The synthetic families get a backend too, and its label is deliberately empty: `Hemibrain
   * (mini)` already says what it is, and `Hemibrain (mini) (Mock)` is the kind of name a rule
   * produces when nobody checked it against the values. The tint and the tile mark still apply.
   */
  mock: {
    id: 'mock',
    label: '',
  },
}

/** Which silhouette the node's thumbnail placeholder draws. Falls back to `specimen`. */
export type DatasetGlyph = 'brain' | 'vnc' | 'cns' | 'optic' | 'specimen'

export interface DatasetFamily {
  /** Node type suffix and stable id: `dataset.<key>`. Never change one that has shipped. */
  key: string
  /** Registered source this family lives in. */
  sourceId: string
  /**
   * Which backend serves it — a key of `BACKENDS`.
   *
   * Separate from `sourceId`, which names a *registered instance*: two neuPrint deployments are
   * two sources and one backend, and the distinction a reader cares about is the second.
   */
  backend: string
  /**
   * Family half of a `family:version` dataset id — `male-cns` for `male-cns:v1.0`. For sources
   * whose ids carry no version (the mock), this is the whole id.
   */
  family: string
  label: string
  description: string
  /** The node guide's paragraph. See `NodeDefinition.guide`. */
  guide: string
  glyph: DatasetGlyph
  /**
   * Generated in the browser rather than reconstructed by anyone.
   *
   * The only thing this changes is that a synthetic dataset node arrives without the
   * Description companion: that card exists to carry the credit and the citation a published
   * connectome asks for, and there is nobody to cite for a connectome Coda made up on load.
   */
  synthetic?: boolean
  /**
   * Which client library a generated notebook would be built on. Absent means none can be.
   *
   * Stated once here rather than tested at each site that cares, because there are three and
   * they used to disagree: both dataset emitters keyed on the *source id* while
   * `canExportNotebook` refused on `synthetic` alone — so a CAVE graph passed the refusal, its
   * dataset cell emitted a TODO, and every node after it cascaded to "nothing upstream produced
   * a value". The Save menu offered an export that produces a document of nothing but TODOs,
   * which is exactly the outcome `canExport.ts` exists to prevent.
   *
   * Deliberately not derived from `sourceId`: what decides this is whether an emitter has been
   * written, not which backend the data comes from, and those part company the day a caveclient
   * emitter lands.
   */
  notebook?: 'neuprint'
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
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'male-cns',
    label: 'MaleCNS',
    description:
      'Whole central nervous system of an adult male fly — brain and ventral nerve cord.',
    guide:
      'The largest fly connectome published so far: 165,122 traced neurons across brain and nerve cord, so a circuit can be followed from a sensory neuron to the muscle it drives without leaving the dataset. That size is also what you are paying for — an unbounded query here is a real load on a shared server, and Explore downloads about 7 MB before it can search.',
    glyph: 'cns',
  },
  {
    key: 'hemibrain',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'hemibrain',
    label: 'Hemibrain',
    description:
      'Central brain of an adult female fly. The most heavily annotated fly connectome.',
    guide:
      'The dataset most published fly circuit work is built on, and the one with the richest annotation: cell type, class, cell body fibre, soma radius, hemilineage. It is one hemisphere of the central brain, so a neuron whose partner sits on the other side has that partner truncated rather than missing — worth remembering before reading a low synapse count as weak.',
    glyph: 'brain',
  },
  {
    key: 'manc',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'manc',
    label: 'MANC',
    description: 'Male adult nerve cord — the ventral nerve cord, motor and premotor circuits.',
    guide:
      'The ventral nerve cord on its own: motor neurons, the premotor circuits driving them, and the descending neurons arriving from the brain. Pairs naturally with MaleCNS, which contains the same territory in a whole-animal volume; MANC is the older and more heavily curated reconstruction of it.',
    glyph: 'vnc',
  },
  {
    key: 'opticlobe',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'optic-lobe',
    label: 'Optic Lobe',
    description:
      'The right optic lobe: medulla, lobula and lobula plate, columnar to the core.',
    guide:
      'One optic lobe, reconstructed to the column — medulla, lobula and lobula plate. Columnar cell types repeat across the retinotopic array, so this is the dataset where a type is a population of hundreds rather than a handful, and where averaging across a type actually means something.',
    glyph: 'optic',
  },
  {
    key: 'fib19',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'fib19',
    label: 'FIB-19',
    description:
      'An early FIB-SEM volume of the mushroom body and surrounds. Small and partial.',
    guide:
      'An early FIB-SEM volume from before the hemibrain, covering the mushroom body and its surrounds. Small, partial and largely of historical interest — useful mainly as a fast dataset to try a pipeline on, or for comparing against the reconstructions that followed it.',
    glyph: 'brain',
  },
  {
    key: 'mushroombody',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: 'neuprint',
    family: 'mushroombody',
    label: 'Mushroom Body',
    description: 'Mushroom body reconstruction. Carries no version in its dataset id.',
    guide:
      'A dedicated mushroom body reconstruction: Kenyon cells, the output neurons and the dopaminergic neurons that modulate them. It is the one dataset here whose id carries no version, so its version dropdown has nothing to pin and the node simply names the dataset.',
    glyph: 'brain',
  },
]

/** The synthetic connectomes, which need no token and are what the examples run on. */
const MOCK_FAMILIES: DatasetFamily[] = [
  {
    key: 'mock.hemibrain',
    sourceId: 'mock',
    backend: 'mock',
    family: 'hemibrain-mini',
    label: 'Hemibrain (mini)',
    description:
      'Synthetic mushroom-body-like connectome generated in the browser. No token needed.',
    guide:
      'A connectome generated in the browser at load, shaped like a mushroom body — Kenyon cells, output neurons, a modulatory population. Nothing is fetched and no token is needed, which is what makes it the dataset the bundled examples run on and the right place to try a pipeline before pointing it at a real volume.',
    glyph: 'brain',
    synthetic: true,
  },
  {
    key: 'mock.opticlobe',
    sourceId: 'mock',
    backend: 'mock',
    family: 'optic-lobe-mini',
    label: 'Optic Lobe (mini)',
    description:
      'Synthetic optic-lobe-like connectome generated in the browser. No token needed.',
    guide:
      'A synthetic optic lobe, generated in the browser with the columnar repetition a real one has. Same standing as the mini hemibrain: no token, no network, deterministic from a seed — so a graph built on it gives the same answer on any machine.',
    glyph: 'optic',
    synthetic: true,
  },
]

/**
 * CAVE's families.
 *
 * One entry, and the pairing with `src/data/cave/spec.ts` is deliberate rather than redundant:
 * that table says which of a datastack's tables mean neurons and connections, this one says how
 * the datastack is *presented*. A datastack needs both to appear here, which is what stops the
 * picker offering one that would fail on the first Run.
 *
 * The version half of a CAVE dataset id is a **materialization number** rather than a release
 * name — `flywire_fafb_public:783` — and it needs no new control: `compareVersions` orders bare
 * integers correctly, so the existing dropdown reads `Latest (783)` and a pinned 630 stays 630.
 */
const CAVE_FAMILIES: DatasetFamily[] = [
  {
    key: 'flywire',
    sourceId: 'cave',
    backend: 'cave',
    family: 'flywire_fafb_public',
    label: 'FlyWire FAFB',
    description:
      'Whole adult female fly brain, publicly released. Proofread neurons with hierarchical cell annotations.',
    guide:
      'The public FlyWire segmentation of a whole female brain, read through CAVE rather than neuPrint — so it needs a CAVE token rather than a neuPrint one, and its version dropdown names a materialization rather than a release. Coda downloads its cell annotations once per dataset and searches them locally, so the first query waits and every one after it is immediate. Connectivity comes from a server-side roll-up of the synapse table; skeletons, meshes, synapses, paths and per-region counts are not wired up yet and the nodes that need them decline rather than failing.',
    glyph: 'brain',
  },
]

export const DATASET_FAMILIES: DatasetFamily[] = [
  ...NEUPRINT_FAMILIES,
  ...CAVE_FAMILIES,
  ...MOCK_FAMILIES,
]

/** Node types are `dataset.<family key>`. Never change it; it is in every saved file. */
export const DATASET_NODE_PREFIX = 'dataset.'

export function datasetFamily(key: string): DatasetFamily | undefined {
  return DATASET_FAMILIES.find((f) => f.key === key)
}

/**
 * The family behind a `dataset.<key>` node type, or undefined for anything else.
 *
 * The `dataset.` prefix is constructed in four places (`nodes/dataset`, `nodeBodies`,
 * `startCards`, the starters); this is the one place that reads it back, so it belongs beside
 * the table rather than as string surgery in whichever module happens to need it.
 */
export function familyForNodeType(type: string): DatasetFamily | undefined {
  return type.startsWith(DATASET_NODE_PREFIX)
    ? datasetFamily(type.slice(DATASET_NODE_PREFIX.length))
    : undefined
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
 * What a dataset node is called: the family's name, and which backend serves it.
 *
 * The suffix is not decoration. One dataset can be published on more than one backend — MANC is
 * on neuPrint today and is a plausible CAVE datastack tomorrow — so without it two nodes in the
 * Add menu would read identically and behave differently. A backend with an empty label adds
 * nothing, which is what keeps `Hemibrain (mini)` from becoming `Hemibrain (mini) (Mock)`.
 */
export function familyLabel(family: DatasetFamily): string {
  const backend = BACKENDS[family.backend]
  return backend?.label ? `${family.label} (${backend.label})` : family.label
}

/** The backend behind a node type, for the card tint and the browser tile. */
export function backendForNodeType(type: string): DatasetBackend | undefined {
  const family = familyForNodeType(type)
  if (family) return BACKENDS[family.backend]
  return CUSTOM_BACKENDS[type]
}

/**
 * The custom nodes, which are not families and still have a backend.
 *
 * `Custom neuPrint` and `Custom CAVE` name their own server and dataset by hand, so there is no
 * table entry to read a backend off — but a reader looking at the canvas needs the same signal
 * from them as from a named one.
 */
const CUSTOM_BACKENDS: Record<string, DatasetBackend | undefined> = {
  'dataset.neuprint': BACKENDS.neuprint,
  'dataset.cave': BACKENDS.cave,
  // The superseded generic picker, still registered so a saved graph loads.
  'neuron.dataset': BACKENDS.neuprint,
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
