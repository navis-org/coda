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
 * it is a default here rather than an assumption, and an instance without it degrades to a
 * neuron table with names and no types instead of failing.
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
 * The type half of a neuron-name annotation.
 *
 * `Uniglomerular mALT VA6 adPN#R1` → `Uniglomerular mALT VA6 adPN`; a label with no `#` is its
 * own type, which is what `DNp32_R` and `Mi1_R` are. The instance keeps the whole string, so
 * nothing is lost — worth saying because the convention puts real distinctions on the right of
 * the `#`: `KC#12-a'b'` yields type `KC`, and the a'b' subtype survives only in the instance.
 * Coda is not the right place to decide that `a'b'` is a type and `12` is not.
 */
export function typeFromLabel(label: string): string {
  const hash = label.indexOf('#')
  return hash === -1 ? label : label.slice(0, hash)
}

/** One neuron's labels, as the neuron table's columns want them. */
export interface CatmaidLabels {
  name: string | null
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
  if (!entry) return { name, type: null, instance: null, ontology: null, annotations: null }

  let instance: string | null = null
  let ontology: string | null = null
  const rest = new Set<string>()

  for (const { id } of entry.annotations) {
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

  return {
    name,
    type: instance === null ? null : typeFromLabel(instance),
    instance,
    ontology,
    annotations: rest.size ? [...rest].join(JOIN_SEPARATOR) : null,
  }
}
