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

import type { PopulationFilter } from '../../core/types'
import type { DatasetInfo } from '../../data/source'
/*
 * `backendOf` used to live here and now lives beside the source registry that mints these ids,
 * because `src/data` needs it too — `data/transforms/spaces.ts` decides a dataset's template
 * space, and the backend behind a source id is half of what identifies one. Re-spelling the
 * colon rule there would be the exact drift `backendName` below records happening to the table
 * it reads.
 */
import { getSource } from '../../data/source'
import { L1_CATMAID_SOURCE_ID } from '../../data/catmaid/registry'

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
   * What a *menu group* of this backend's datasets is headed. Absent means `label`.
   *
   * Two fields because they answer two questions, and only the mock needs both: a node's name
   * suffix must be empty there (`Demo Data (Mock)` is a name a rule produces and nobody checked),
   * while a heading of `''` is a group with no title at all. The New menu used to reach past
   * this and read a *source* label instead, which meant the heading of every group depended on
   * which source a backend's first family happened to name.
   */
  heading?: string
  /**
   * Whether its dataset nodes take an Annotations socket.
   *
   * neuPrint carries its own cell typing as properties on the neuron, so there is nothing for a
   * source to replace and a socket would be a control that changes nothing. A CAVE datastack
   * takes its labels from a table, which is exactly the thing an annotation source *is* — and
   * for several datastacks there is no such table at all.
   */
  acceptsAnnotations?: boolean
  /**
   * Whether its dataset nodes offer an attached edge set. Absent means yes.
   *
   * Weaker than `acceptsAnnotations`, and the difference is worth keeping straight. That flag is
   * structural — neuPrint has nothing for an annotation source to *replace*, so the control
   * would do nothing. This one is a product judgement: `data/queries.ts` is backend-agnostic, so
   * a user edge list would answer perfectly well on any of them, and CATMAID is off because
   * nobody is expected to want one there rather than because it could not work. One character
   * to reverse.
   */
  edgeSets?: boolean
  /**
   * Whether its dataset nodes offer the **population** checkboxes. Absent means no.
   *
   * Structural, like `acceptsAnnotations` and unlike `edgeSets`: the controls compile against
   * `status`, `superclass` and the `*type` columns, which are neuPrint's vocabulary. A CAVE
   * datastack spells the same ideas `super_class` and `cell_type` and gets its proofreading
   * state from a column its spec may or may not name; CATMAID has no segmentation to proofread
   * at all. Offering the boxes there would be the old `Traced` default again — filtering on
   * fields the dataset does not have, and answering nothing for a value nobody chose.
   *
   * Off by default so a backend added later has to say yes deliberately rather than inherit
   * filters nobody chose for it.
   */
  population?: boolean
}

/**
 * `precomputed` is deliberately **not** here, though `PrecomputedSource` registers under it and
 * `backendOf` reads it.
 *
 * This table is not a list of backends: `NodeThumbnail`'s `BACKEND_IDS` is `Object.keys` of it and
 * draws one pip per entry, so an entry is a slot in a positional mark on every dataset tile in the
 * browser. Adding one for a backend no *node type* maps to — `backendForNodeType` reads
 * `DATASET_FAMILIES` and `CUSTOM_DATASET_NODES`, and `dataset.ngsource` is in neither — gives every
 * existing tile a fifth pip that can never light, and shifts the slot `mock` had.
 *
 * What an entry would have bought is one capital letter: `backendName` falls back to `|| id`, so
 * an exporter's TODO says "precomputed" rather than "neuroglancer". That fallback exists for
 * exactly this case, and it is the cheaper of the two.
 */
export const BACKENDS: Record<string, DatasetBackend> = {
  neuprint: {
    id: 'neuprint',
    label: 'neuPrint',
    population: true,
  },
  cave: {
    id: 'cave',
    label: 'CAVE',
    acceptsAnnotations: true,
  },
  /*
   * CATMAID takes no Annotations socket, which puts it with neuPrint rather than with CAVE.
   * The distinction `acceptsAnnotations` draws is whether a dataset's labels come from a table
   * something else could supply: CAVE reads them from an annotation table, so replacing it is
   * meaningful, while neuPrint carries them as properties on the neuron. CATMAID carries them as
   * annotations *on* the neuron — intrinsic in the same way, and derived through its own
   * meta-annotation layer (see `data/catmaid/annotations.ts`), so there is nothing for an
   * external table to replace.
   */
  catmaid: {
    id: 'catmaid',
    // Not a capability gap: an edge list would answer here as it does anywhere. CATMAID gives
    // you the connectors directly and its public instances are curated subsets, so a supplied
    // edge list has nothing to add. See `DatasetBackend.edgeSets`.
    edgeSets: false,
    label: 'CATMAID',
  },
  /*
   * The synthetic family gets a backend too, and its label is deliberately empty: `Demo Data`
   * already says what it is, and `Demo Data (Mock)` is the kind of name a rule produces when
   * nobody checked it against the values. The tint and the tile mark still apply.
   */
  mock: {
    id: 'mock',
    label: '',
    heading: 'Mock connectome',
  },
}

/**
 * How a backend is spelled in prose, since a source id is lower case and a name is not.
 *
 * Read off `BACKENDS` rather than restated: that was a second table of the same fact and it had
 * already fallen behind — a third backend arrived and the exporter's TODOs would have read
 * "has no catmaid equivalent yet". The `|| id` keeps a source id nobody has registered a
 * backend for readable rather than blank, and it is also what gives the mock its own name back:
 * its label is deliberately empty, because `Demo Data (Mock)` is the kind of name a rule
 * produces when nobody checked it against the values.
 */
export function backendName(id: string): string {
  return BACKENDS[id]?.label || id
}

/**
 * Which silhouette the node's thumbnail placeholder draws. Falls back to `specimen`.
 *
 * Species first, then the coarse anatomical kind: a bare `brain` reads as "any brain", which is
 * how a mouse cortex volume came to wear the fly one. The drawings are in
 * `ui/nodes/DatasetPreview.tsx`, and the rule for adding to this list is there too.
 */
export type DatasetGlyph =
  | 'fly_brain'
  | 'fly_vnc'
  | 'fly_cns'
  | 'fly_optic'
  | 'fly_hemibrain'
  | 'mouse_brain'
  | 'fly_larva'
  | 'specimen'

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
  /**
   * Which population checkboxes a *newly added* node of this family arrives with ticked.
   *
   * A per-family default because the useful starting population is a fact about the dataset
   * rather than about the backend: hemibrain is thoroughly typed, so `typed` is the cut that
   * separates its named neurons from the untraced fragments that make up most of its 186,061
   * `:Neuron`s; male-CNS classifies everything it has looked at by `superclass`, which hemibrain
   * does not publish at all. A family naming none gets every box off, which is the honest
   * default for a dataset nobody has made this judgement about.
   *
   * Only a **default**. It is written into a node when the node is created and read back off the
   * params from then on, so this table can change without touching a graph anybody saved — and
   * `absentMeans` is what keeps that true for a graph saved before the boxes existed.
   */
  population?: readonly PopulationFilter[]
  synthetic?: boolean
  /**
   * Whether this family is offered as a *starting point*. Absent means yes.
   *
   * Read by the two surfaces that build a starter graph — the toolbar's New menu and the start
   * page's dataset rail — and by nothing else. It is a statement about **where somebody begins**,
   * not about the dataset: the node is registered either way, `Add ▸ Dataset` lists all of
   * them, and a saved graph holding one opens exactly as before.
   *
   * The three it is set on are neuPrint's specialist volumes: FIB-19 is a superseded pilot,
   * Mushroom Body is a single dedicated reconstruction, and Optic Lobe is one lobe. Somebody who
   * wants one of those knows they want it and will reach for the node; somebody opening the New
   * menu is choosing a connectome to work in, and six neuPrint entries make that a longer
   * decision than it is.
   *
   * One flag for both surfaces rather than a filter in each, because they build the *same*
   * starter through `buildStarter` — a family worth starting from in one and not the other is
   * the kind of split that ends up depending on which file somebody edited last.
   */
  starter?: boolean
  /**
   * Which client library each exporter builds on. A language absent means it cannot emit this
   * family at all, and `canExportNotebook` refuses that format.
   *
   * Stated once here rather than tested at each site that cares, because there are three and
   * they used to disagree: both dataset emitters keyed on the *source id* while
   * `canExportNotebook` refused on `synthetic` alone — so a CAVE graph passed the refusal, its
   * dataset cell emitted a TODO, and every node after it cascaded to "nothing upstream produced
   * a value". The Save menu offered an export that produces a document of nothing but TODOs,
   * which is exactly the outcome `canExport.ts` exists to prevent.
   *
   * **Per language, which it was not at first**, and the day the comment here predicted has
   * arrived: FlyWire emits caveclient in Python and nothing in R, because R's route in is
   * `fafbseg` rather than the natverse's neuPrint client and no emitter has been written for it.
   * One flag for both formats would either refuse an export Python can produce or offer an R
   * document of nothing but TODOs.
   *
   * Deliberately not derived from `sourceId`: what decides this is whether an emitter has been
   * written, not which backend the data comes from.
   */
  notebook?: ExportClients
}

/** The two things a graph can be exported as. */
export type ExportLanguage = 'python' | 'r'

/**
 * The client library each exporter builds on, keyed by language.
 *
 * The *value* is what a refusal message names, so it is a closed set rather than a free string:
 * a family exported through a library nobody has named here is a library nobody installed.
 */
export type ExportClients = Partial<Record<ExportLanguage, 'neuprint' | 'caveclient'>>

/** Both exporters are built on the neuPrint clients, which is every family but FlyWire. */
const NEUPRINT_NOTEBOOK: ExportClients = { python: 'neuprint', r: 'neuprint' }

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
    notebook: NEUPRINT_NOTEBOOK,
    family: 'male-cns',
    population: ['superclass'],
    label: 'MaleCNS',
    description:
      'Whole central nervous system of an adult male fly — brain and ventral nerve cord.',
    guide:
      'The largest fly connectome published so far: 168k proofread neurons across brain and nerve cord, so a circuit can be followed from a sensory neuron to the motor neurons driving muscles.',
    glyph: 'fly_cns',
  },
  {
    key: 'hemibrain',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: NEUPRINT_NOTEBOOK,
    family: 'hemibrain',
    population: ['typed'],
    label: 'Hemibrain',
    description: 'Approximately half a central brain of an adult female fly.',
    guide:
      'Approximately one hemisphere of the central brain (with bits of the right optic lobe). Rich annotations: cell type, class, cell body fibre, soma radius, hemilineage, etc.',
    glyph: 'fly_hemibrain',
  },
  {
    key: 'manc',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: NEUPRINT_NOTEBOOK,
    family: 'manc',
    label: 'MANC',
    description: 'Nerve cord of a male adult fly.',
    guide:
      'The ventral nerve cord on its own: motor neurons, the premotor circuits driving them, and the descending neurons arriving from the brain.',
    glyph: 'fly_vnc',
  },
  {
    key: 'opticlobe',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: NEUPRINT_NOTEBOOK,
    family: 'optic-lobe',
    label: 'Optic Lobe',
    description:
      'The right optic lobe: medulla, lobula and lobula plate with bits of the central brain and the lamina',
    guide:
      'One optic lobe: medulla, lobula and lobula plate with bits of the central brain and the lamina. This is part of the MaleCNS dataset and was released before the full dataset. Mostly kept as reference for the early papers that used it.',
    glyph: 'fly_optic',
    // Superseded by MaleCNS: reached for deliberately, not started from. See `starter`.
    starter: false,
  },
  {
    key: 'fib19',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: NEUPRINT_NOTEBOOK,
    family: 'fib19',
    label: 'FIB-19',
    description:
      'Partial reconstruction of a female fly`s visual system: medulla, lobula and lobula plate.',
    guide:
      'A partial reconstruction covering portions of the fly medulla, lobula, and lobula plate to reveal connectivity patterns in the visual motion detection pathway.',
    glyph: 'fly_optic',
    starter: false,
  },
  {
    key: 'mushroombody',
    sourceId: 'neuprint',
    backend: 'neuprint',
    notebook: NEUPRINT_NOTEBOOK,
    family: 'mushroombody',
    label: 'Mushroom Body',
    description: 'Reconstruction of the mushroom body`s alpha lobe.',
    guide:
      'Dense reconstruction of the alpha (vertical) lobe of the mushroom body in a male Drosophila. One of the earliest fly connectomes, contains 983 neurons.',
    glyph: 'specimen',
    // One structure rather than a brain. See `starter`.
    starter: false,
  },
]

/** The synthetic connectome, which needs no token and is what the examples run on. */
const MOCK_FAMILIES: DatasetFamily[] = [
  {
    key: 'mock.opticlobe',
    sourceId: 'mock',
    backend: 'mock',
    // The family and dataset ids stay `optic-lobe-mini`: they are what a saved graph and a
    // share link carry, and what the data actually is. Only the name shown changed.
    family: 'optic-lobe-mini',
    label: 'Demo Data',
    description:
      'Synthetic optic-lobe-like connectome generated in the browser. No token needed.',
    guide:
      'A synthetic optic lobe, generated in the browser with the columnar repetition a real one has. Nothing is fetched and no token is needed — it is deterministic from a seed, so a graph built on it gives the same answer on any machine. This is the dataset the bundled examples run on and the right place to try a pipeline before pointing it at a real volume.',
    glyph: 'fly_optic',
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
    label: 'FlyWire FAFB public',
    description: 'Whole adult female fly brain (optic lobes + central brain).',
    guide:
      'Public FlyWire segmentation read through CAVE, so version is a materialization number. Cell annotations download once per dataset and search locally—first query waits, rest are instant. Meshes, synapses and skeletons work, the skeletons only on materialization 783, which is the one that publishes them. Paths and per-region counts do not; nodes that need them decline rather than fail.',
    glyph: 'fly_brain',
    /*
     * Python only. `caveclient` is a faithful route in — the dataset cell is a real `CAVEclient`
     * pinned to the materialization the node resolved — where R's would be `fafbseg`, which wraps
     * FlyWire specifically rather than CAVE generally and has no emitter here yet.
     */
    notebook: { python: 'caveclient' },
  },
  {
    key: 'banc',
    sourceId: 'cave',
    backend: 'cave',
    family: 'brain_and_nerve_cord_public',
    label: 'BANC public',
    description: 'Adult female fly brain and ventral nerve cord.',
    guide:
      'The public BANC segmentation read through CAVE. It exposes the full brain-and-nerve-cord volume, and the neuron table is the public cell list published alongside the stack.',
    glyph: 'fly_cns',
    notebook: { python: 'caveclient' },
  },
  {
    key: 'minnie65',
    sourceId: 'cave',
    backend: 'cave',
    family: 'minnie65_public',
    label: 'MICrONS Minnie65 public',
    description: 'A public mouse visual cortex volume from the MICrONS collaboration.',
    guide:
      'The public MICrONS Minnie65 segmentation read through CAVE. Version is a materialization number, and the neuron table is the stack’s published cell list.',
    glyph: 'mouse_brain',
    notebook: { python: 'caveclient' },
  },
]

/**
 * CATMAID's families.
 *
 * A CATMAID dataset is a **project**, and its id is the project's number as text — per-instance
 * rather than portable, because CATMAID is software rather than a service and there is no
 * cross-instance name to use. There is no version half, so `resolveDatasetId` takes the mock's
 * branch.
 *
 * **Both entries below are project `1`, and they are different connectomes.** One is FAFB on
 * `catmaid-fafb.virtualflybrain.org` and the other a first-instar larval CNS on
 * `l1em.catmaid.virtualflybrain.org` — the same organisation, two installations, and a project
 * number that means nothing outside the one it was read from. What tells them apart is the
 * `sourceId`, which is why this is the only backend whose families do not share one. A lab
 * server's project 1 is a third thing again, and `Custom CATMAID` is where it goes.
 *
 * Neither exporter emits it. pymaid is the obvious Python route and `natverse`'s `catmaid` the R
 * one, but no emitter has been written for either, so both languages refuse rather than
 * producing a document of TODOs — `DatasetFamily.notebook` absent is what says so.
 */
const CATMAID_FAMILIES: DatasetFamily[] = [
  {
    /*
     * Backend-scoped, like `mock.hemibrain`. Family keys are a permanent flat namespace — the
     * node type is `dataset.<key>` and it is in every saved file — and FAFB is the *volume*
     * rather than this reconstruction of it: `dataset.flywire` is already "FlyWire FAFB" on the
     * same EM. A bare `fafb` would claim the volume's name for one of its two backends.
     */
    key: 'catmaid.fafb',
    sourceId: 'catmaid',
    backend: 'catmaid',
    family: '1',
    label: 'FAFB',
    description:
      'Early manual reconstructions in an female fly brain. Published data hosted by VFB.',
    guide:
      'A few thousand hand-traced neurons on the same image volume as FlyWire. Hosted by the Virtual Fly Brain at https://catmaid-fafb.virtualflybrain.org/.',
    glyph: 'fly_brain',
  },
  {
    // `catmaid.l1` for `catmaid.fafb`'s reason: the key is a permanent flat namespace, and `l1`
    // on its own names a developmental stage rather than a reconstruction of one.
    key: 'catmaid.l1',
    sourceId: L1_CATMAID_SOURCE_ID,
    backend: 'catmaid',
    family: '1',
    label: 'L1',
    description:
      'Whole central nervous system of a first-instar fly larva. Published data hosted by VFB.',
    guide:
      'The larval connectome: 5,013 hand-traced neurons across the whole first-instar central nervous system, brain to abdominal neuromeres, hosted by Virtual Fly Brain at https://l1em.catmaid.virtualflybrain.org/. Unlike FAFB this instance meta-annotates nothing, so a neuron\u2019s type is its own name and its large bag of annotations shows as Additional tags.',
    glyph: 'fly_larva',
  },
]

export const DATASET_FAMILIES: DatasetFamily[] = [
  ...NEUPRINT_FAMILIES,
  ...CAVE_FAMILIES,
  ...CATMAID_FAMILIES,
  ...MOCK_FAMILIES,
]

/** Node types are `dataset.<family key>`. Never change it; it is in every saved file. */
export const DATASET_NODE_PREFIX = 'dataset.'

/**
 * The families offered as a starting point, in table order. See `DatasetFamily.starter`.
 *
 * A function rather than a constant for `startCards`' reason: this is read by the UI, and a
 * module-level constant computed here would make import order load-bearing for nothing.
 */
export function starterFamilies(): DatasetFamily[] {
  return DATASET_FAMILIES.filter((family) => family.starter !== false)
}

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
 * nothing, which is what keeps `Demo Data` from becoming `Demo Data (Mock)`.
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
 * A backend's escape hatch: the node that names a server and a dataset by hand.
 *
 * One per backend, and the list is what stops the three drifting apart. They are **not**
 * families — a family is a dataset Coda ships an entry for, and the whole point of these is the
 * dataset it does not — but three surfaces need to treat them as one kind of thing: the New menu
 * offers one under each backend's heading, the canvas tints their cards, and a share advisory
 * names the credential they will need. Without a list, each of those was a hand-written `if` per
 * backend, and the CATMAID one was simply missing from all three.
 *
 * Nothing here is presentation. The label and the blurb come off the `NodeDefinition`, which is
 * where they are already written and the only place they can stay in step with the node.
 */
export interface CustomDatasetNode {
  /** Node type. In every saved file that holds one. */
  type: string
  /**
   * The *default* registered source for this backend.
   *
   * A custom node routinely points somewhere else — that is what it is for — and resolves its
   * own source from its params at infer time. What this names is the instance to ask a
   * backend-level question of, which is what a starter needs before any dataset is chosen.
   */
  sourceId: string
  /** Key of `BACKENDS`. */
  backend: string
}

export const CUSTOM_DATASET_NODES: CustomDatasetNode[] = [
  { type: 'dataset.neuprint', sourceId: 'neuprint', backend: 'neuprint' },
  { type: 'dataset.cave', sourceId: 'cave', backend: 'cave' },
  { type: 'dataset.catmaid', sourceId: 'catmaid', backend: 'catmaid' },
]

/**
 * The custom nodes, which are not families and still have a backend.
 *
 * Derived from the table above rather than restated, because a fourth backend adding its escape
 * hatch and forgetting the tint is a card that reads as an untinted one — a wrong signal rather
 * than a missing one.
 */
const CUSTOM_BACKENDS: Record<string, DatasetBackend | undefined> = {
  ...Object.fromEntries(
    CUSTOM_DATASET_NODES.map((custom) => [custom.type, BACKENDS[custom.backend]]),
  ),
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
