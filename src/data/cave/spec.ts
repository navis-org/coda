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

export interface DatastackSpec {
  datastack: string
  label: string
  description: string
  neurons: NeuronTableSpec
  annotations?: AnnotationTableSpec
  connections?: ConnectionViewSpec
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
    label: 'FlyWire FAFB (public)',
    description:
      'The public FlyWire segmentation of a whole adult female fly brain (FAFB), with the ' +
      'hierarchical cell annotations published alongside it.\n\n' +
      'Please cite [Dorkenwald et al. 2024](https://doi.org/10.1038/s41586-024-07558-y) for ' +
      'the wiring diagram and [Schlegel et al. 2024](https://doi.org/10.1038/s41586-024-07686-5) ' +
      'for the annotations, and see FlyWire’s own ' +
      '[citation guidelines](https://flywire.ai/guidelines).',
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
  },
]

export function specFor(datastack: string): DatastackSpec | undefined {
  return DATASTACK_SPECS.find((s) => s.datastack === datastack)
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
