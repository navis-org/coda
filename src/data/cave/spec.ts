/**
 * Which tables in a datastack mean "neuron", "annotation" and "connection".
 *
 * **CAVE does not answer this for you, and that is the difference from neuPrint.** neuPrint's
 * graph has a `:Neuron` label with properties on it, so a source can ask "what does this
 * dataset call its neurons" and get an answer. A CAVE datastack is a bag of annotation tables
 * with no privileged one: `flywire_fafb_public` publishes six, of which `proofread_neurons` is
 * the neuron set, `hierarchical_neuron_annotations` is the cell typing, and
 * `valid_connection_v2` — a *view*, not a table — is the connectivity. Nothing in the metadata
 * says so; the schema types (`representative_point`, `cell_type_reference`) describe the shape
 * of a row, not the role of the table.
 *
 * So a datastack needs a small spec, and this is a deliberately faithful port of the idea
 * `connecto` arrived at in Python for the same problem. It is static, one entry per datastack,
 * for the reason `datasetFamilies.ts` is static: an entry is presentation and wiring, while
 * everything that actually changes — which materializations exist, which columns the
 * annotations carry, how many neurons there are — is read live and never hard-coded.
 *
 * **A datastack with no entry is not offered.** `listDatasets` returns specced datastacks only,
 * rather than everything the info service lists, because a dataset that appears in the picker
 * and then fails on the first Run is worse than one that is absent. Adding a datastack is an
 * entry below plus, usually, nothing else.
 */

/** Where a datastack's neuron identities come from. */
export interface NeuronTableSpec {
  table: string
  /** The column holding the root id. `pt_root_id` on every CAVE table Coda has seen. */
  idColumn: string
}

/**
 * A long-form annotation table: one row per (neuron, kind, value).
 *
 * FlyWire's `hierarchical_neuron_annotations` carries five kinds — `flow` and `super_class` on
 * every one of its 139,255 neurons, `cell_type` on 78%, `cell_class` on 77%, `cell_sub_class`
 * on 13%. Coda wants one row per neuron with a column per kind, so the source pivots it.
 *
 * **It is read one kind at a time, and that is forced rather than chosen.** The whole table is
 * over CAVE's 500,000-row result cap, so a single query comes back silently truncated; filtered
 * by kind, the largest is 139,255. The kinds come from discovery, which has already run by
 * then, so the split costs no extra round trip. Measured end to end against v783: 139,255
 * neurons in 6.7 s.
 *
 * `refColumn` is the join back to the neuron table's `id` — CAVE's reference-table convention,
 * and always `target_id` in practice.
 */
export interface AnnotationTableSpec {
  table: string
  refColumn: string
  /** Column naming the *kind* of annotation. Its distinct values become Coda's columns. */
  systemColumn: string
  /** Column holding the annotation itself. */
  valueColumn: string
}

/**
 * A pre-aggregated edge list, as a materialized view.
 *
 * This is the finding that makes CAVE connectivity affordable at all. `synapses_nt_v1` is
 * 244,358,226 rows and CAVE's query API has no `GROUP BY`, so an edge list built from synapses
 * would mean downloading a hemisphere's worth of them to count. `valid_connection_v2` is the
 * server doing that once: one row per ordered (pre, post) pair with `n_syn`, filterable by root
 * id and — the part that makes it usable — by `n_syn` itself, so a minimum weight is applied
 * before anything is sent. Measured on v783: one neuron's outputs are 4,818 partners and 410 kB
 * unfiltered, 183 rows and 16 kB at `n_syn >= 5`.
 *
 * A datastack without such a view has no connectivity here yet, and says so rather than
 * pretending. That is the honest state for Aedes, which publishes synapses and no roll-up.
 */
export interface ConnectionViewSpec {
  view: string
  preColumn: string
  postColumn: string
  weightColumn: string
}

/**
 * A synapse table: one row per synapse, with a position and a root id at each end.
 *
 * Positions are requested at `desired_resolution: [1, 1, 1]`, which is CAVE's own answer to
 * Coda's "geometry is nanometres" rule and is why nothing here scales anything. The table
 * stores 4x4x40 nm voxels — verified by asking for both and watching the values divide exactly
 * — so a client that took the raw column would put every synapse a factor out, with nothing
 * failing, because the cloud is internally consistent either way.
 */
/**
 * The column names of CAVE's standard `synapse` schema.
 *
 * Not a guess: a table whose registered schema is `synapse` has these by *definition* —
 * `emannotationschemas` defines the type — and both a declared table (`wclee_aedes_brain`'s
 * `synapses`) and a configured one (`flywire_fafb_public`'s `synapses_nt_v1`) were checked
 * against it live. `ctr_pt_position` is the cleft centre, which is the honest place to draw a
 * synapse; FlyWire's spec picks `pre_pt_position` instead, which is a choice rather than a
 * correction. `scoreColumn` is deliberately absent — a confidence column is per-table
 * (`cleft_score` on FlyWire, nothing comparable on Aedes, which has `size`).
 */
export const STANDARD_SYNAPSE_COLUMNS = {
  preColumn: 'pre_pt_root_id',
  postColumn: 'post_pt_root_id',
  positionColumn: 'ctr_pt_position',
} as const

export interface SynapseTableSpec {
  table: string
  preColumn: string
  postColumn: string
  /** Position column *stem*: the API splits it into `<stem>_x`, `_y`, `_z`. */
  positionColumn: string
  /** Per-synapse confidence, where the table has one. Offered as an attribute column. */
  scoreColumn?: string
}

export interface DatastackSpec {
  datastack: string
  label: string
  description: string
  /**
   * What was imaged, for `DatasetInfo.species` and the one line of Dataset Summary that shows it.
   *
   * Per datastack rather than a constant, because it was a constant — `'Drosophila melanogaster'`
   * hardcoded in `datasetInfoFor` back when FlyWire was the only entry. Adding `minnie65_public`
   * made the card describe a mouse visual cortex volume as a fly, which is the shape of error a
   * hardcoded field always eventually takes: silent, confident, and only wrong for the entries
   * added after it.
   *
   * Optional, and absent means *unknown* rather than unspecified — a hand-named datastack has
   * nobody to ask, and `DatasetInfo.species` is optional precisely so a card can leave the row
   * off instead of guessing.
   */
  species?: string
  /**
   * The table listing which neurons exist, if the datastack publishes one.
   *
   * **Optional, and its absence is a real configuration rather than a gap.** Not every datastack
   * has an equivalent of `proofread_neurons` — Aedes publishes synapses and nuclei and nothing
   * that enumerates neurons. Where it is absent the *annotation chain* is the neuron list, which
   * is the honest answer rather than a fallback: a base keyed by root id is exactly an
   * enumeration of neurons, and somebody wanting the union of two such lists chains two
   * annotation nodes, since `joinAnnotations` is a full outer join.
   *
   * Note what it is **not** needed for. Nothing queries *through* this table: connectivity reads
   * the roll-up view by root id, and skeletons, meshes and synapses take ids off a table. It is
   * read for exactly two columns — the root id, which becomes the index, and the annotation
   * table's own primary key, which is how `annotations.refColumn` joins back. So a datastack
   * without one still answers `Input IDs → Connectivity`; what it cannot do is enumerate.
   *
   * `annotations` therefore depends on it: that spec joins through this table's `id`, so a
   * datastack with no neuron table can have no built-in annotations either.
   */
  neurons?: NeuronTableSpec
  annotations?: AnnotationTableSpec
  connections?: ConnectionViewSpec
  synapses?: SynapseTableSpec
  /**
   * Flat published segmentations, one per materialization version.
   *
   * **A datastack's own `segmentation_source` is `graphene://`, and that is a chunkedgraph
   * rather than a bucket you can read by id.** It has to be: a root id is a *dynamic*
   * agglomeration, and CAVE needs it for supervoxel lookups and edits. But a released
   * materialization is frozen, and its publishers usually also flatten it into an ordinary
   * precomputed bucket with a mesh pyramid in it — which CAVE's metadata does not mention
   * anywhere, so nothing finds one by asking.
   *
   * What that is worth is measured rather than assumed, and it is the difference between
   * *levels* and *no levels*. A graphene mesh has one level: FlyWire answers 492 supervoxel
   * fragments and ~1.2 MB for one neuron, and `decimateMesh` is what makes a scene of them
   * survivable. `gs://flywire_v141_m783` answers the same neuron in **two range requests**, from
   * a 3-to-5 level pyramid whose coarsest level is one fragment of 73 kB to 1.44 MB across a
   * sample of eight. That is what makes `fetchCoarseGeometry` — thumbnails — possible at all,
   * and it is why `triangleBudget` can be honoured by choosing a level instead of by decimating.
   *
   * **Keyed by version, and sparsely, because a bucket is one materialization's ids.** A flat
   * segmentation is keyed by the root ids that were current when it was written, so v630's
   * bucket cannot answer for a v783 id. FlyWire publishes one for each; BANC publishes one for
   * 888 and none for 626. An absent entry is the ordinary case and means the graphene route,
   * which answers for any root id ever minted.
   *
   * **Not every flat bucket is worth using, and BANC's is the example.** Its
   * `neuron_meshes/meshes` is `neuroglancer_legacy_mesh` — a single level, full resolution —
   * measured at 28.4 MB and 60.8 MB for two v888 neurons, against ~200 kB of Draco for the same
   * neuron through graphene, whose meshing agglomerates across chunkedgraph layers 2–6 rather
   * than serving leaves. So it is left out: there is no level to draw a thumbnail from and the
   * Meshes node would be worse off. The rule is a pyramid, not a bucket.
   */
  flat?: Readonly<Record<number, string>>
}

/**
 * The datastacks Coda can currently read.
 *
 * FlyWire public is the pilot deliberately: its materialization 783 is a stable public release
 * that does not expire under a test suite (the server reports `expires_on: 2121-11-10`), its
 * annotation tables are CORS-open, and it publishes the connection view above. Building against
 * the datastack with the most capabilities is what forces the capability gating to be real
 * rather than assumed.
 */
export const DATASTACK_SPECS: readonly DatastackSpec[] = [
  {
    datastack: 'flywire_fafb_public',
    species: 'Drosophila melanogaster',
    label: 'FlyWire FAFB (public)',
    description:
      'The public FlyWire segmentation of a whole adult female fly brain (FAFB), with the ' +
      'hierarchical cell annotations published alongside it.\n\n' +
      'Please cite [Dorkenwald et al. 2024](https://doi.org/10.1038/s41586-024-07558-y) for ' +
      'the wiring diagram and [Schlegel et al. 2024](https://doi.org/10.1038/s41586-024-07686-5) ' +
      'for the annotations, and see FlyWire’s own ' +
      '[citation guidelines](https://flywire.ai/guidelines).',
    /*
     * Both public materializations were flattened. 783 also publishes `skeletons_mip_1`, which
     * is the only skeleton this datastack has: it has no level-2 cache, and the skeleton service
     * it declares generates *from* that cache and is therefore empty. 630 publishes meshes only.
     */
    flat: {
      630: 'precomputed://gs://flywire_v141_m630',
      783: 'precomputed://gs://flywire_v141_m783',
    },
    neurons: { table: 'proofread_neurons', idColumn: 'pt_root_id' },
    annotations: {
      table: 'hierarchical_neuron_annotations',
      refColumn: 'target_id',
      systemColumn: 'classification_system',
      valueColumn: 'cell_type',
    },
    connections: {
      view: 'valid_connection_v2',
      preColumn: 'pre_pt_root_id',
      postColumn: 'post_pt_root_id',
      weightColumn: 'n_syn',
    },
    synapses: {
      table: 'synapses_nt_v1',
      preColumn: 'pre_pt_root_id',
      postColumn: 'post_pt_root_id',
      positionColumn: 'pre_pt_position',
      scoreColumn: 'cleft_score',
    },
  },
  {
    datastack: 'brain_and_nerve_cord_public',
    species: 'Drosophila melanogaster',
    label: 'BANC (public)',
    description:
      'The BANC (pronounced "bank") is the Brain And Nerve Cord, a GridTape transmission ' +
      'electron microscopy dataset of a female adult Drosophila melanogaster’s entire ' +
      'central nervous system. Visit https://banc.community for more information.',
    neurons: { table: 'backbone_proofread', idColumn: 'pt_root_id' },
    synapses: {
      table: 'synapses_v3',
      preColumn: 'pre_pt_root_id',
      postColumn: 'post_pt_root_id',
      positionColumn: 'ctr_pt_position',
    },
  },
  {
    datastack: 'minnie65_public',
    species: 'Mus musculus',
    label: 'MICrONS Minnie65 (public)',
    description:
      'The public MICrONS Minnie65 segmentation of a mouse visual cortex volume.\n' +
      'This is the second alignment of the IARPA "minnie65" dataset, completed in the spring of 2020 that used the seamless approach.',
    neurons: { table: 'proofreading_status_and_strategy', idColumn: 'pt_root_id' },
    synapses: {
      table: 'synapses_pni_2',
      preColumn: 'pre_pt_root_id',
      postColumn: 'post_pt_root_id',
      positionColumn: 'ctr_pt_position',
    },
  },
]

/**
 * Datastacks named by hand, registered at edit time.
 *
 * `Custom CAVE` is the escape hatch for a datastack this build has no entry for, and it has to
 * supply what the table above would have: which of its tables is the neuron set, and what the id
 * column is called. So the node registers a spec from its own params, the same way
 * `neuPrintSourceFor` registers a deployment — synchronously and with no network, which is what
 * makes it safe to call from `inferOutputs`.
 *
 * Separate from the static table rather than merged into it, because the two have different
 * lifetimes: this one is rebuilt from a node's params on every graph load and must not
 * accumulate, while the table above is what the Add menu is built from.
 */
const runtimeSpecs = new Map<string, DatastackSpec>()

export function registerDatastackSpec(spec: DatastackSpec): DatastackSpec {
  runtimeSpecs.set(spec.datastack, spec)
  return spec
}

export function specFor(datastack: string): DatastackSpec | undefined {
  return DATASTACK_SPECS.find((s) => s.datastack === datastack) ?? runtimeSpecs.get(datastack)
}

/** Test seam: drop hand-named datastacks between suites. */
export function resetRuntimeSpecs(): void {
  runtimeSpecs.clear()
}

/**
 * Split a Coda dataset id into the datastack and the materialization it names.
 *
 * `flywire_fafb_public:783`, following neuPrint's `family:version` convention exactly — which
 * is what lets the existing dataset node's version dropdown carry a CAVE materialization with
 * no new control. `compareVersions` orders bare integers correctly, so 783 sorts above 630.
 */
export function splitDatasetId(id: string): { datastack: string; version: number } | undefined {
  const at = id.lastIndexOf(':')
  if (at === -1) return undefined
  const version = Number(id.slice(at + 1))
  if (!Number.isInteger(version)) return undefined
  return { datastack: id.slice(0, at), version }
}

export function datasetIdFor(datastack: string, version: number): string {
  return `${datastack}:${version}`
}
