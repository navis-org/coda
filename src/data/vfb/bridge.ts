/**
 * Everything the VFB nodes ask of the PDB, each a parameterised read:
 *
 * - `fetchIndividuals` — a batch cross-reference. VFBquery's `/xref` takes one accession per
 *   call, so a thousand neurons would be a thousand requests; one PDB `MATCH` does the set.
 *   Accessions go in as text and come back as text (invariant 8). A neuron VFB does not hold is
 *   simply absent from the answer, and **the caller counts it** rather than dropping its row.
 * - `fetchClassGraph` — labels, direct parents and per-dataset names for a set of classes, walked
 *   upward level by level until nothing new appears or `MAX_CLIMB` is reached. The ontology above
 *   neuron types is shared, so the frontier converges quickly whatever the neuron count.
 * - `fetchReferences`, `fetchLines` and `fetchLineImages` — the papers, driver lines and
 *   registered images of a set of classes or lines, one statement each.
 */

import type { ClassGraph } from './classes'
import { MAX_CLIMB, NAME_IN_PREFIX, nameInKey } from './classes'
import { text, texts, vfbUrl } from './common'
import { cypher } from './pdb'

/**
 * Ids per statement. A cross-reference statement anchors on the site and reads every edge there
 * whatever the id count, so its cost is a fixed ~0.5 s plus the rows it returns (male-cns,
 * 2026-10-14: 0.50 s for 10 ids, 1.09 s for 20,000, 4.47 s for all 166,693). Fewer statements win,
 * and this is set to hold the largest site VFB has in one.
 */
const CHUNK = 200_000

/**
 * Every row `statement` answers for `ids`, each id asked once, `CHUNK` at a time, with `params`
 * beside them. No ids is no statement.
 */
async function rowsFor(
  statement: string,
  ids: readonly string[],
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>[]> {
  const unique = [...new Set(ids)]
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await cypher(statement, { ...params, ids: unique.slice(i, i + CHUNK) }, signal)
    // Row by row: spreading an answer into `push` overflows the stack at male-cns' 166,693 rows.
    for (const row of rows) out.push(row)
  }
  return out
}

/** One cross-referenced neuron. */
export interface VfbIndividual {
  /** The accession asked for, exactly as given. */
  readonly accession: string
  readonly vfbId: string
  /** `INSTANCEOF` classes, as VFB asserts them. */
  readonly classes: readonly string[]
}

const INDIVIDUALS = `
MATCH (n:Individual)-[r:database_cross_reference]->(:Site {short_form: $site})
WHERE any(a IN r.accession WHERE a IN $ids)
OPTIONAL MATCH (n)-[:INSTANCEOF]->(c:Class)
RETURN r.accession AS accession, n.short_form AS vfbId,
       collect(DISTINCT c.short_form) AS classes`

/**
 * The VFB individuals for a set of accessions at one site. An accession VFB does not hold has no
 * entry; one it holds twice (two individuals cross-referencing it) has both.
 */
export async function fetchIndividuals(
  site: string,
  accessions: readonly string[],
  signal?: AbortSignal,
): Promise<VfbIndividual[]> {
  const wanted = new Set(accessions)
  const out: VfbIndividual[] = []
  for (const row of await rowsFor(INDIVIDUALS, accessions, { site }, signal)) {
    const vfbId = text(row.vfbId)
    if (!vfbId) continue
    for (const accession of texts(row.accession)) {
      if (wanted.has(accession)) out.push({ accession, vfbId, classes: texts(row.classes) })
    }
  }
  return out
}

const LABELS_AND_NAMES = `
MATCH (c:Class) WHERE c.short_form IN $ids
OPTIONAL MATCH (c)-[s:has_reference]->(:pub)
  WHERE s.typ = 'syn' AND any(t IN s.has_synonym_type WHERE t STARTS WITH $prefix)
RETURN c.short_form AS id, c.label AS label,
       collect([s.value, s.has_synonym_type]) AS names`

const PARENTS = `
MATCH (c:Class)-[:SUBCLASSOF]->(p:Class) WHERE c.short_form IN $ids
RETURN c.short_form AS child, collect(DISTINCT p.short_form) AS parents`

/** Labels, parents and per-dataset names for `seeds` and every ancestor within `MAX_CLIMB`. */
export async function fetchClassGraph(
  seeds: readonly string[],
  signal?: AbortSignal,
): Promise<ClassGraph> {
  const labels = new Map<string, string>()
  const parents = new Map<string, string[]>()
  const names = new Map<string, Map<string, string[]>>()
  let frontier = [...new Set(seeds)]
  const seen = new Set(frontier)
  for (let depth = 0; depth <= MAX_CLIMB && frontier.length > 0; depth++) {
    const next: string[] = []
    // The last level's parents are past anything the walk reads, so they are not asked for.
    const last = depth === MAX_CLIMB
    const [described, parented] = await Promise.all([
      rowsFor(LABELS_AND_NAMES, frontier, { prefix: NAME_IN_PREFIX }, signal),
      last ? Promise.resolve([]) : rowsFor(PARENTS, frontier, {}, signal),
    ])
    for (const row of described) {
      const id = text(row.id)
      if (!id) continue
      labels.set(id, text(row.label) ?? id)
      // Each entry is one synonym: its values and its types. Only `name_in_*` types are kept.
      const synonyms = (Array.isArray(row.names) ? row.names : []) as unknown[][]
      for (const [values, kinds] of synonyms) {
        for (const kind of texts(kinds)) {
          const key = nameInKey(kind)
          if (!key) continue
          let byKey = names.get(id)
          if (!byKey) names.set(id, (byKey = new Map()))
          let list = byKey.get(key)
          if (!list) byKey.set(key, (list = []))
          for (const value of texts(values)) if (!list.includes(value)) list.push(value)
        }
      }
    }
    for (const row of parented) {
      const child = text(row.child)
      if (!child) continue
      const list = texts(row.parents)
      parents.set(child, list)
      for (const parent of list) {
        if (!seen.has(parent)) {
          seen.add(parent)
          next.push(parent)
        }
      }
    }
    frontier = next
  }
  return { labels, parents, names }
}

/**
 * Why a paper is attached to a class, as FBbt records it on the `has_reference` edge: `def` cites
 * the paper that defines the type, `syn` the source of one of its names, `nlp` a text-mined
 * mention. Across VFB on 2026-10-14: 50,978 `def`, 254,624 `syn`, 1,992 `nlp`.
 */
export const REFERENCE_ROLES = ['def', 'syn', 'nlp'] as const
export type ReferenceRole = (typeof REFERENCE_ROLES)[number]

/** One paper cited by one class, with every role it is cited in. */
export interface VfbReference {
  readonly classId: string
  readonly classLabel: string
  /** `FBrf0227179`, or `doi_10_1101_…` for a paper FlyBase has not curated. */
  readonly pubId: string
  /** `Aso et al., 2014, eLife 3: e04577`. */
  readonly citation: string
  readonly title?: string
  readonly doi?: string
  readonly pmid?: string
  readonly year?: number
  /** In `REFERENCE_ROLES` order. */
  readonly roles: readonly ReferenceRole[]
}

/** VFB's placeholder for a synonym with no source. A reference to nothing, so never returned. */
const UNATTRIBUTED = 'Unattributed'

const REFERENCES = `
MATCH (c:Class)-[r:has_reference]->(p:pub)
WHERE c.short_form IN $ids AND r.typ IN $roles AND p.short_form <> $unattributed
RETURN c.short_form AS classId, c.label AS classLabel, p.short_form AS pubId, collect(DISTINCT r.typ) AS roles,
       p.miniref AS citation, p.title AS title, p.DOI AS doi, p.PMID AS pmid, p.year AS year`

/**
 * The papers each class cites, in the roles asked for. One entry per (class, paper), however many
 * edges carry it: a paper defining a type and also the source of one of its names is one row
 * reading `def, syn`, not two.
 */
export async function fetchReferences(
  classIds: readonly string[],
  roles: readonly ReferenceRole[],
  signal?: AbortSignal,
): Promise<VfbReference[]> {
  if (roles.length === 0) return []
  const out: VfbReference[] = []
  const rows = await rowsFor(
    REFERENCES,
    classIds,
    { roles, unattributed: UNATTRIBUTED },
    signal,
  )
  for (const row of rows) {
    const classId = text(row.classId)
    const pubId = text(row.pubId)
    if (!classId || !pubId) continue
    const found = new Set(texts(row.roles))
    // A citation VFB stores bracketed (`[Berg et al., 2025]`) reads the same as the others.
    const citation = text(row.citation)?.replace(/^\[(.*)\]$/, '$1') ?? pubId
    const year = Number(text(row.year))
    out.push({
      classId,
      classLabel: text(row.classLabel) ?? classId,
      pubId,
      citation,
      title: text(row.title),
      doi: text(row.doi),
      pmid: text(row.pmid),
      year: Number.isInteger(year) && year > 0 ? year : undefined,
      roles: REFERENCE_ROLES.filter((role) => found.has(role)),
    })
  }
  return out
}

/**
 * What kind of driver a line is: `split` from VFB's `:Split` label, the rest read off FlyBase's
 * construct name (`docs/vfb-plan.md` has the open question of a structural signal for them).
 */
export const DRIVER_KINDS = ['split', 'GAL4', 'LexA', 'other'] as const
export type DriverKind = (typeof DRIVER_KINDS)[number]

/** One expression pattern VFB records as labelling a cell type. */
export interface VfbLine {
  readonly classId: string
  readonly classLabel: string
  /** `VFBexp_…`: the expression pattern class. */
  readonly lineId: string
  /** The line's short name, `MB074C`, or its construct where VFB has no short name. */
  readonly line: string
  /** FBbt's construct name: `P{R12C11-GAL4.DBD} ∩ PBac{R21D02-p65.AD} expression pattern`. */
  readonly construct: string
  readonly kind: DriverKind
  /** How many FBbt cell types VFB records this line as labelling: 1 is a line for this type alone. */
  readonly targets: number
  /** Whole-line images VFB holds, across templates. */
  readonly images: number
}

/**
 * A line labels a type when one of its parts is an instance of that type:
 * `(type)<-[:INSTANCEOF]-(part)-[:part_of]->(line)`. The parts are VFB's curated "this line labels
 * X" assertions, plus images of single neurons that VFB typed. `targets` counts FBbt classes only:
 * a line's image fragments are also its parts, typed `VFBext_0000004` (*expression pattern
 * fragment*), which is VFB's bookkeeping rather than a cell type.
 *
 * Measured 2026-10-14: this reproduces VFBquery's `SplitsTargeting` for MBON01 (two splits), and
 * also finds the GAL4 and LexA lines VFB links the same way (fifteen more for MBON01).
 */
const LINES = `
MATCH (c:Class)<-[:INSTANCEOF]-(:Individual)-[:part_of]->(e:Class:Expression_pattern)
WHERE c.short_form IN $ids
WITH DISTINCT c, e
OPTIONAL MATCH (e)<-[:part_of]-(:Individual)-[:INSTANCEOF]->(t:Class)
  WHERE t.short_form STARTS WITH 'FBbt_'
WITH c, e, count(DISTINCT t) AS targets
RETURN c.short_form AS classId, c.label AS classLabel, e.short_form AS lineId,
       e.symbol AS symbol, e.label AS construct, e:Split AS split, targets,
       size([(e)<-[:INSTANCEOF]-(i:Individual:has_image) | i]) AS images`

function driverKind(split: boolean, construct: string): DriverKind {
  if (split) return 'split'
  if (/-GAL4\b/i.test(construct)) return 'GAL4'
  if (/-lexA\b/i.test(construct)) return 'LexA'
  return 'other'
}

/** The lines VFB records as labelling each class. */
export async function fetchLines(
  classIds: readonly string[],
  signal?: AbortSignal,
): Promise<VfbLine[]> {
  const out: VfbLine[] = []
  for (const row of await rowsFor(LINES, classIds, {}, signal)) {
    const classId = text(row.classId)
    const lineId = text(row.lineId)
    if (!classId || !lineId) continue
    const construct = text(row.construct) ?? lineId
    out.push({
      classId,
      classLabel: text(row.classLabel) ?? classId,
      lineId,
      // Not every line has a short name in VFB; its construct names it then, which reads far
      // better than the `VFBexp_…` id (one of MBON01's two splits has none, 2026-10-14).
      line: text(row.symbol) ?? construct.replace(/ expression pattern$/, ''),
      construct,
      kind: driverKind(row.split === true, construct),
      targets: Number(row.targets) || 0,
      images: Number(row.images) || 0,
    })
  }
  return out
}

/** One registered image of a line, in one template. */
export interface VfbLineImage {
  readonly lineId: string
  readonly imageId: string
  /** The specimen: `JRC_MB074C_Brain_20121210_31_D5_20x`. */
  readonly label: string
  /** A whole-line image, or a fragment of the line (a 63x tile, a single-neuron image). */
  readonly part: 'line' | 'fragment'
  /** The VFB template the image is registered to. */
  readonly template: string
  readonly obj?: string
  readonly thumbnail?: string
  readonly nrrd?: string
  readonly dataset?: string
  readonly license?: string
}

/**
 * Images and their files in one statement. The file URLs are on the `in_register_with` edge from
 * the image's channel to the template's, so nothing is asked per image and no URL is built by
 * hand: the folder belongs to the image individual, not to the line (`docs/vfb-plan.md`).
 *
 * **The template is read off the folder** (`…/i/0010/2chl/VFB_00101567/`), never by following the
 * template channel's `depicts` edge: a template is depicted by every image registered to it, and
 * that expansion took 9.4 s for one line where the folder test takes 0.18 s for the same 19 rows
 * (2026-10-14). The `WITH` keeps the planner starting from the line rather than the template.
 */
const IMAGES = `
MATCH (e:Class) WHERE e.short_form IN $ids
MATCH (e)<-[rel:INSTANCEOF|part_of]-(i:Individual:has_image)
WHERE type(rel) = 'INSTANCEOF' OR $fragments
WITH e, rel, i
MATCH (i)<-[:depicts]-(:Individual)-[r:in_register_with]->(:Individual)
WITH e, rel, i, r,
     [t IN $templates WHERE any(f IN r.folder WHERE f ENDS WITH '/' + t + '/')] AS matched
WHERE size(matched) > 0
OPTIONAL MATCH (i)-[:has_source]->(d:DataSet)
OPTIONAL MATCH (d)-[:has_license]->(l)
RETURN e.short_form AS lineId, i.short_form AS imageId, i.label AS label, type(rel) AS rel,
       matched[0] AS template, r.obj AS obj, r.thumbnail AS thumbnail, r.nrrd AS nrrd,
       d.label AS dataset, l.label AS license`

/** The registered images of each line, in the templates asked for. */
export async function fetchLineImages(
  lineIds: readonly string[],
  templates: readonly string[],
  fragments: boolean,
  signal?: AbortSignal,
): Promise<VfbLineImage[]> {
  if (templates.length === 0) return []
  const out: VfbLineImage[] = []
  const rows = await rowsFor(IMAGES, lineIds, { templates, fragments }, signal)
  for (const row of rows) {
    const lineId = text(row.lineId)
    const imageId = text(row.imageId)
    const template = text(row.template)
    if (!lineId || !imageId || !template) continue
    out.push({
      lineId,
      imageId,
      label: text(row.label) ?? imageId,
      part: row.rel === 'INSTANCEOF' ? 'line' : 'fragment',
      template,
      obj: vfbUrl(row.obj),
      thumbnail: vfbUrl(row.thumbnail),
      nrrd: vfbUrl(row.nrrd),
      dataset: text(row.dataset),
      license: text(row.license),
    })
  }
  return out
}
