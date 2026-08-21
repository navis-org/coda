/**
 * Annotation sources: where a neuron's *labels* come from, when they do not come from the
 * connectome server.
 *
 * A neuPrint dataset carries its own annotation — `type`, `class`, `hemilineage` are properties
 * on the neuron node. CAVE does not work that way: a datastack is a segmentation plus whatever
 * tables somebody attached to it, and for several of them the annotations are not in CAVE at
 * all. FlyWire's live cell typing is a SeaTable base; Aedes has no CAVE annotation table
 * whatsoever, so its type, class and side live in FlyTable and nowhere else. So "which
 * connectome" and "which annotations" are two questions, and this is the second one.
 *
 * **A wired source replaces the dataset's own annotations rather than adding to them.** That is
 * the sharper semantic and it is what makes a chain readable: whatever the chain produces *is*
 * the neuron table's label half. Within a chain each source adds its columns to the ones before
 * it, so `CAVEtable → FlyTable → Dataset` is the union of the two, and the datastack's built-in
 * table is used only when nothing is wired at all.
 *
 * **Every provider answers in the same shape**: a table keyed by `neuronId`, with whatever
 * columns it was asked for beside it. That is the only thing the dataset source needs to know,
 * which is what keeps `CaveSource` free of the word "SeaTable".
 */

import type { TableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'

/**
 * The serialisable identity of one annotation source.
 *
 * It has to be serialisable and it has to be *stable*, because two different things read it:
 * the provenance key of every node downstream of the dataset, and the cache key of the
 * annotation table itself. A ref that stringified differently between two equal configurations
 * would re-run a graph that had not changed.
 *
 * `provider` selects the implementation; everything else is that provider's own configuration,
 * kept as plain strings so a `.coda.json` round-trips it. Deliberately **no credential** — a
 * token lives in `localStorage` beside the other two and is never written into a graph.
 */
export interface AnnotationRef {
  readonly provider: string
  readonly config: Readonly<Record<string, string>>
}

/**
 * A stable string for a ref, for cache keys and for comparing two chains.
 *
 * Keys are sorted, so a ref built by a node whose params happen to be in a different order
 * keys the same. `JSON.stringify` on the raw object would not promise that.
 */
export function refKey(ref: AnnotationRef): string {
  const config = Object.keys(ref.config)
    .sort()
    .map((k) => `${k}=${ref.config[k] ?? ''}`)
    .join('&')
  return `${ref.provider}:${config}`
}

/**
 * What a provider must be able to do.
 *
 * Two methods and the split between them is the same one `schemasFor`/`findNeurons` makes on the
 * `DataSource` seam: **`peekColumns` is synchronous and may not fetch**, because column pickers
 * downstream resolve at edit time and inference cannot await (invariant 2). It answers
 * `undefined` until discovery has landed and starts that discovery the first time it cannot
 * answer — once per ref, never once per peek, because inference runs on every graph mutation.
 */
export interface AnnotationProvider {
  readonly id: string
  readonly label: string
  /**
   * The columns this ref would produce, if known.
   *
   * `undefined` means "not yet", which is a different answer from an empty schema and callers
   * are expected to keep them apart — the same distinction `columnSchemaFor` draws.
   */
  peekColumns(ref: AnnotationRef): TableSchema | undefined
  /**
   * The whole annotation table: `neuronId` plus the ref's columns, one row per neuron.
   *
   * Implementations cache and deduplicate concurrent callers, like `neuronIndex`. The id column
   * is **`neuronId` and text**, whatever the provider calls it — invariant 8 at this seam, and
   * free on both providers as it happens: CAVE hands ids to `parseCaveJson` and SeaTable stores
   * them as strings already.
   */
  fetch(ref: AnnotationRef, options: AnnotationFetchOptions): Promise<TableValue>
}

export interface AnnotationFetchOptions {
  refresh?: boolean
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/**
 * Coda's own names for the two columns nodes address *by name*.
 *
 * `neuronId` and `type`. Every provider already renamed onto the first — an id column is
 * whatever the base calls it and has to become `neuronId` — and none renamed onto the second,
 * which is the same rule half-applied. `data/cave/schema.ts` states it for the datastack's own
 * table (`{ pt_root_id: neuronId, cell_type: 'type' }`) and an annotation chain is the other
 * route to the same neuron table.
 *
 * The cost of missing it is entirely silent: `typesOf` reads `index.data.type` by literal name,
 * so `neuronType`/`partnerType` come back null on **every** connectivity row while the schema
 * still declares them; Explore's `PRIMARY = ['type', 'instance']` falls through to a guess; and
 * Profile's type roll-ups empty. Reachable on the demonstration case — point a CAVE table node
 * at the table the datastack's own spec uses and every type-by-name consumer goes blank.
 *
 * Deliberately just these two. Everything else is a passthrough only a column picker ever names,
 * which is the rule neuPrint's `PROPERTY_NAMES` follows for `cellBodyFiber` and `somaSide`.
 */
const CODA_NAMES: Record<string, string> = {
  cell_type: 'type',
  celltype: 'type',
}

/**
 * What identifies a chain, for anything keyed on which labels it carries.
 *
 * Three call sites derived this independently and two separators were already in use (`+` and
 * `|`), so a change to what makes two chains different — a `refKey` component, an ordering rule
 * — had to be found in three files. What it keys is real: two graphs on one datastack with
 * different annotations hold genuinely different tables, and sharing an entry serves the first
 * one looked at to the other for the session.
 *
 * Empty for no chain, which is a distinct key from any chain's.
 */
export function chainKey(annotations: { sources: readonly string[] } | undefined): string {
  return annotations?.sources.join('+') ?? ''
}

/** What Coda calls an annotation column. Identity for everything but the cell type. */
export function annotationColumn(name: string): string {
  return CODA_NAMES[name] ?? name
}

/**
 * The columns a ref names, as written in its `columns` param: comma-separated, trimmed, and never
 * the id column — which every provider adds itself, under Coda's name rather than the base's.
 *
 * Empty means *decide for me*, the `chips` idiom, and the two providers decide differently: a
 * SeaTable ref takes every column the base publishes, a CAVE one every annotation kind it finds.
 * That difference is the only part worth writing twice.
 */
export function namedColumns(columns: string, idColumn: string): string[] {
  return columns
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && c !== idColumn)
}
