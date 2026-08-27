/**
 * Where a CATMAID neuron's *labels* come from, which is the hard half of this backend.
 *
 * neuPrint puts cell typing in properties on the neuron and CAVE puts it in an annotation table.
 * CATMAID has neither: a neuron carries a free-text **name** and a set of **annotations**, and
 * the annotations are a flat many-to-many bag with no schema anywhere saying which of them mean
 * what. `type` cannot be read off a field, because there is no field.
 *
 * What makes it tractable is that **annotations can themselves be annotated**, and instances use
 * that layer to say what a label is *for*. Measured across all 5,601 skeletons of VFB's public
 * FAFB:
 *
 * ```
 * meta-annotation      annotations   neurons   max per neuron
 * neuron name                 5601      5601                1
 * Cell type                    329      4244                1
 * Published                     26      5601                4
 * export: tags                  27      5601                4
 * publication_link: <doi>         1     1–1507              1     (×22, one per paper)
 * ```
 *
 * So the mechanism is **a meta-annotation names a field, and the annotations carrying it are that
 * field's values** — discovered by asking the instance, not hardcoded, which is the lesson CAVE
 * taught. What is *not* generic is which meta-annotation supplies the canonical columns: `neuron
 * name` is a convention of the labs that traced FAFB rather than something CATMAID enforces, so
 * it is a default here rather than an assumption. An instance without it does not fail and does
 * not go blank: `type` falls back to the neuron's own name, which is the only label such an
 * instance is offering. L1 is that case for all 5,013 of its neurons — see `labelsForSkeleton`.
 *
 * Everything below `Cell type` in that table is deliberately **not** given a column of its own.
 * `export: tags` and `Published` carry the same information by different routes, and
 * `publication_link: <doi>` is the `key: value` annotation idiom — 22 of them, each naming one
 * paper, none of them a field. A column per meta-annotation would put forty-odd columns in every
 * picker downstream, most of them describing a *paper* rather than a neuron. They all survive in
 * one `annotations` cell instead, joined with `JOIN_SEPARATOR`, which is exactly the shape
 * Explore's `Additional tags` control already splits back into chips.
 */

import { JOIN_SEPARATOR } from '../../core/values'
import type { AnnotationListResponse } from './api'

/**
 * The meta-annotation whose members name a neuron's type and instance.
 *
 * `Uniglomerular mALT VA6 adPN#R1`, `KC#12-a'b'`, `DNp32_R` — one per neuron, on every one of
 * FAFB's 5,601. The `#` splits type from instance.
 */
export const DEFAULT_TYPE_META = 'neuron name'

/** The meta-annotation whose members are ontology terms — `FBbt:00007447` on FAFB. */
export const DEFAULT_ONTOLOGY_META = 'Cell type'

export interface CatmaidVocabulary {
  /** Annotation ids that name a type/instance, and the label of each. */
  typeAnnotations: Map<number, string>
  /** Annotation ids that are ontology terms. */
  ontologyAnnotations: Map<number, string>
  /** Every meta-annotation the instance uses, for reporting what was found. */
  metaAnnotations: string[]
}

/**
 * Which annotations mean what, read off the instance's own meta-annotation layer.
 *
 * Both lookups are by *name* rather than by id because an annotation id is per-instance, and the
 * whole point is that a second CATMAID with the same conventions works with no configuration.
 */
export function readVocabulary(response: AnnotationListResponse): CatmaidVocabulary {
  const nameOf = (id: number): string | undefined => response.annotations[String(id)]
  const typeAnnotations = new Map<number, string>()
  const ontologyAnnotations = new Map<number, string>()
  const metaAnnotations = new Set<string>()

  for (const [annotationId, entry] of Object.entries(response.metaannotations)) {
    const id = Number(annotationId)
    const label = nameOf(id)
    if (label === undefined) continue
    for (const meta of entry.annotations) {
      const metaName = nameOf(meta.id)
      if (metaName === undefined) continue
      metaAnnotations.add(metaName)
      if (metaName === DEFAULT_TYPE_META) typeAnnotations.set(id, label)
      else if (metaName === DEFAULT_ONTOLOGY_META) ontologyAnnotations.set(id, label)
    }
  }

  return { typeAnnotations, ontologyAnnotations, metaAnnotations: [...metaAnnotations].sort() }
}

/**
 * The type half of a neuron-name **annotation**.
 *
 * `Uniglomerular mALT VA6 adPN#R1` → `Uniglomerular mALT VA6 adPN`; a label with no `#` is its
 * own type, which is what `DNp32_R` and `Mi1_R` are. The instance keeps the whole string, so
 * nothing is lost — worth saying because the convention puts real distinctions on the right of
 * the `#`: `KC#12-a'b'` yields type `KC`, and the a'b' subtype survives only in the instance.
 * Coda is not the right place to decide that `a'b'` is a type and `12` is not.
 *
 * **Never applied to a free-text neuron name**, and that is measured rather than cautious. The
 * `#` convention belongs to the controlled label an instance meta-annotates, not to the name
 * field beside it. On L1, 53 of 5,013 names contain a `#` and none of them mean this: they are
 * a tracer's cross-reference to another skeleton — `BC: presynaptic -medial - paired with
 * #3801211`, `RG Hugin Input left-> paired with #5613144?` — so splitting there truncates a
 * sentence mid-word and calls the remainder a cell type. See `labelsForSkeleton`.
 */
export function typeFromLabel(label: string): string {
  const hash = label.indexOf('#')
  return hash === -1 ? label : label.slice(0, hash)
}

/** One neuron's labels, as the neuron table's columns want them. */
export interface CatmaidLabels {
  /** The neuron's free-text name — CATMAID's one name field. Always exactly one. */
  name: string | null
  /**
   * Coda's cross-backend type column: the meta-annotated label where the instance has one, and
   * the neuron's own name where it does not. See `labelsForSkeleton`.
   */
  type: string | null
  instance: string | null
  ontology: string | null
  /** Everything else the neuron carries, joined. Null rather than `''` when there is nothing. */
  annotations: string | null
}

/**
 * Read one skeleton's labels out of an annotation-list response.
 *
 * Order is preserved as the server gave it, which for the `annotations` cell is the only order
 * available — CATMAID returns a bag. Deduplicated, because an annotation can be applied by two
 * users and comes back once per link.
 */
export function labelsForSkeleton(
  response: AnnotationListResponse,
  vocabulary: CatmaidVocabulary,
  skeletonId: number,
): CatmaidLabels {
  const entry = response.skeletons[String(skeletonId)]
  const name = response.neuronnames[String(skeletonId)] ?? null

  let instance: string | null = null
  let ontology: string | null = null
  const rest = new Set<string>()

  // `entry?.` rather than an early return: a skeleton the annotation graph never mentioned is
  // the same neuron as one it mentions with nothing on it, and stating that twice is two places
  // to edit the next time `CatmaidLabels` grows a field.
  for (const { id } of entry?.annotations ?? []) {
    const asType = vocabulary.typeAnnotations.get(id)
    if (asType !== undefined) {
      // First wins on the vanishingly rare double — measured at exactly one per neuron across
      // all 5,601, so this is a guard rather than a policy.
      instance ??= asType
      continue
    }
    const asOntology = vocabulary.ontologyAnnotations.get(id)
    if (asOntology !== undefined) {
      ontology ??= asOntology
      continue
    }
    const label = response.annotations[String(id)]
    if (label !== undefined) rest.add(label)
  }

  /*
   * **The name is the type on an instance that publishes no vocabulary at all**, which is the
   * one place this module translates rather than reads.
   *
   * A CATMAID neuron always has exactly one name and any number of annotations, and `type` is
   * Coda's cross-backend column rather than CATMAID's field — so the question is which of the
   * two a row carries. Where an instance meta-annotates its labels the answer is the annotation,
   * because that is a controlled vocabulary and the name is not: FAFB's skeleton 430 is *named*
   * `La Grosse Cellule LGC 431 JS` and *annotated* `DNp32_R`, and only the second joins to
   * anything. That branch is unchanged and still wins.
   *
   * Where an instance meta-annotates nothing there is no such answer, and the fallback matters
   * more than it looks: L1 uses neither `neuron name` nor `Cell type`, so `type` was null on all
   * 5,013 of its neurons and Explore — whose headline is `type`, never `name` — drew every row
   * as `untyped` while the label sat unused in the next column. A name is a weaker claim than a
   * curated type, but it is the claim the instance is making.
   *
   * **Keyed on the instance's vocabulary, not on this neuron's `instance` being null**, and the
   * difference is the whole care in it. On an annotated instance an untyped neuron is *news* —
   * one nobody has typed yet — and the same fallback there would replace that with prose, in
   * `partnerType`, in Group By keys and in the labels Find Neurons matches on. So a deployment
   * that types its neurons keeps the right to say a neuron is untyped.
   *
   * Whole, not split: see `typeFromLabel`. And `instance` stays **null**, deliberately — an
   * instance is one named individual *within* a type, which is precisely the distinction the `#`
   * encodes and precisely what an instance with no vocabulary has not drawn. Filling it with the
   * name would put the same string on the headline and the line under it.
   */
  const untypedInstance = vocabulary.typeAnnotations.size === 0
  return {
    name,
    type: instance !== null ? typeFromLabel(instance) : untypedInstance ? name : null,
    instance,
    ontology,
    annotations: rest.size ? [...rest].join(JOIN_SEPARATOR) : null,
  }
}
