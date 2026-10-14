/**
 * Virtual Fly Brain's VFBquery API, read from the browser.
 *
 * VFBquery (`https://v3-cached.virtualflybrain.org`) is the API VFB recommends: read-only GETs
 * returning JSON, no credential, `access-control-allow-origin: *` (measured 2026-10-14). Its
 * machine-readable endpoint list is `/docs.json`. Like `data/neuronbridge`, this is a data module a
 * node calls and **not** a `DataSource`: it answers no `findNeurons` and no `fetchConnectivity`.
 *
 * What VFBquery cannot do in one request — a batch of cross-references, a class's ancestry and
 * per-dataset names — goes to the PDB instead (`bridge.ts`).
 *
 * A cold query is slow there, so every call waits as long as `common.ts`' `vfbJson` does and says
 * *run it again* when that runs out. The table viewer's term hover reads it (`ui/vfb/TermHover.tsx`,
 * `docs/vfb-plan.md` G4), and so does the VFB Info card, which shows the rest of the answer.
 */

import { memoPromise } from '../memoPromise'
import { nameInKey } from './classes'
import { isObject, nonEmpty, texts, vfbJson, vfbUrl } from './common'
import type { MarkdownSpan } from './markdown'
import { markdownSpans, spansText } from './markdown'
import { templateRank } from './templates'

const VFBQUERY = 'https://v3-cached.virtualflybrain.org'

const HINT =
  'Virtual Fly Brain’s query service answers cross-origin reads; check that it is up.'

/** One GET, parsed. Parameters with an `undefined` value are left out. */
async function vfbGet(
  path: string,
  params: Readonly<Record<string, string | number | undefined>> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, VFBQUERY)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return vfbJson(url.href, HINT, signal)
}

/** One image of a term in one template, as term info lists it. */
export interface VfbImage {
  readonly id: string
  readonly label: string
  readonly template: string
  readonly thumbnail?: string
  readonly obj?: string
  readonly nrrd?: string
  readonly swc?: string
}

/** A term named by another: a parent type, a relationship's target. */
export interface VfbRef {
  readonly id: string
  readonly label: string
}

/** One relationship and its targets: `has soma location` → `adult superior brain cell body rind`. */
export interface VfbRelation {
  readonly relation: string
  readonly targets: readonly VfbRef[]
}

/** A name for the term, and where it is used. */
export interface VfbSynonym {
  readonly label: string
  /** The connectome a `name_in_*` synonym is that dataset's name in: `male-cns`, `hemibrain`. */
  readonly dataset?: string
}

/** A paper cited for the term. */
export interface VfbPaper {
  readonly title: string
  /** FlyBase's reference id, `FBrf0235522`, which VFB has a page for. */
  readonly id?: string
  readonly doi?: string
  readonly pmid?: string
}

/** A link out to another resource's record of the term. */
export interface VfbXref {
  readonly label: string
  readonly url: string
}

/** What a node needs out of `get_term_info`. The full answer has more. */
export interface VfbTermInfo {
  readonly id: string
  /** VFB's short name: the symbol where the term has one (`MBON01`), else its label. */
  readonly name: string
  /** The full label, `mushroom body output neuron 1`. */
  readonly label: string
  readonly isClass: boolean
  /** One thumbnail for the term: JRC2018U brain's if it has one, else its first. */
  readonly thumbnail?: string
  /** Template id → images. A term can have images in several templates. */
  readonly images: ReadonlyMap<string, readonly VfbImage[]>
  /** The named queries VFB offers from this term (`SplitsTargeting`, …). */
  readonly queries: readonly string[]
  /** VFB's definition, its links kept: `spansText` reads it as plain text. */
  readonly definition: readonly MarkdownSpan[]
  readonly comment: readonly MarkdownSpan[]
  /** The classes VFB asserts the term is a kind of (or, for an individual, an instance of). */
  readonly parents: readonly VfbRef[]
  readonly relations: readonly VfbRelation[]
  readonly tags: readonly string[]
  readonly synonyms: readonly VfbSynonym[]
  readonly papers: readonly VfbPaper[]
  readonly xrefs: readonly VfbXref[]
}

const readSpans = (markdown: unknown): MarkdownSpan[] => markdownSpans(nonEmpty(markdown) ?? '')

/** The links of a markdown list, `[a](id); [b](id)`, as references. */
const readRefs = (markdown: unknown): VfbRef[] =>
  readSpans(markdown).flatMap((s) => (s.target ? [{ id: s.target, label: s.text }] : []))

/**
 * `Meta.Relationships`: `[has soma location](RO_…): [rind](FBbt_…); [develops from](RO_…): …`. A
 * link followed by a colon names a relationship, and the links after it are its targets.
 */
function readRelations(markdown: unknown): VfbRelation[] {
  const spans = readSpans(markdown)
  const relations: { relation: string; targets: VfbRef[] }[] = []
  spans.forEach((span, i) => {
    if (span.target === undefined) return
    if (spans[i + 1]?.target === undefined && spans[i + 1]?.text.startsWith(':')) {
      relations.push({ relation: span.text, targets: [] })
    } else relations.at(-1)?.targets.push({ id: span.target, label: span.text })
  })
  return relations.filter((r) => r.targets.length > 0)
}

function readSynonym(raw: unknown): VfbSynonym | undefined {
  if (!isObject(raw)) return undefined
  const label = nonEmpty(raw.label)
  if (!label) return undefined
  const dataset = nameInKey(nonEmpty(raw.type) ?? '')
  return { label, ...(dataset ? { dataset } : {}) }
}

function readPaper(raw: unknown): VfbPaper | undefined {
  if (!isObject(raw)) return undefined
  const title = nonEmpty(raw.title)
  if (!title) return undefined
  const refs = list(raw.refs, nonEmpty)
  const doi = refs.map((r) => /doi\.org\/(.+)$/.exec(r)?.[1]).find(Boolean)
  const pmid = refs.map((r) => /pubmed\/\?term=(\d+)/.exec(r)?.[1]).find(Boolean)
  const id = nonEmpty(raw.short_form)
  return { title, ...(id ? { id } : {}), ...(doi ? { doi } : {}), ...(pmid ? { pmid } : {}) }
}

function readXref(raw: unknown): VfbXref | undefined {
  if (!isObject(raw)) return undefined
  const url = nonEmpty(raw.link)
  // Linked by its URL, which is the visible text (`linkify.ts`' rule), so only http(s) is kept.
  if (!url || !/^https?:\/\//.test(url)) return undefined
  const label = [nonEmpty(raw.label), nonEmpty(raw.accession)].filter(Boolean).join(' ')
  return { label: label || url, url }
}

const list = <T>(raw: unknown, read: (entry: unknown) => T | undefined): T[] =>
  (Array.isArray(raw) ? raw : []).flatMap((entry) => read(entry) ?? [])

const IMAGE_FILES = ['thumbnail', 'obj', 'nrrd', 'swc'] as const

function readImage(raw: unknown, template: string): VfbImage | undefined {
  if (!isObject(raw)) return undefined
  const id = nonEmpty(raw.id)
  if (!id) return undefined
  const files: { [K in (typeof IMAGE_FILES)[number]]?: string } = {}
  for (const key of IMAGE_FILES) {
    const url = vfbUrl(raw[key])
    if (url) files[key] = url
  }
  return { id, label: nonEmpty(raw.label) ?? id, template, ...files }
}

/** Read `get_term_info`'s answer. */
export function readTermInfo(raw: unknown): VfbTermInfo {
  const id = isObject(raw) ? nonEmpty(raw.Id) : undefined
  if (!id || !isObject(raw)) {
    throw new Error('Virtual Fly Brain answered a term lookup without an "Id".')
  }
  const images = new Map<string, VfbImage[]>()
  // An individual's images are under `Images`; a class shows its examples under `Examples`.
  const imageBlock =
    isObject(raw.Images) && Object.keys(raw.Images).length > 0 ? raw.Images : raw.Examples
  if (isObject(imageBlock)) {
    for (const [template, entries] of Object.entries(imageBlock)) {
      const read = list(entries, (entry) => readImage(entry, template))
      if (read.length > 0) images.set(template, read)
    }
  }
  const queries = (Array.isArray(raw.Queries) ? raw.Queries : []).flatMap((q) =>
    isObject(q) ? texts(q.query) : [],
  )
  const meta = isObject(raw.Meta) ? raw.Meta : {}
  const thumbnail = imagesBrainFirst(images).find((image) => image.thumbnail)?.thumbnail
  return {
    id,
    name: nonEmpty(raw.Name) ?? id,
    // VFB's `Meta` strings are markdown; the label is the name's text, its link dropped.
    label: nonEmpty(spansText(readSpans(meta.Name))) ?? nonEmpty(raw.Name) ?? id,
    isClass: raw.IsClass === true,
    ...(thumbnail ? { thumbnail } : {}),
    images,
    queries: [...new Set(queries)],
    definition: readSpans(meta.Description),
    comment: readSpans(meta.Comment),
    parents: readRefs(meta.Types),
    relations: readRelations(meta.Relationships),
    tags: list(raw.Tags, nonEmpty),
    synonyms: dedupeSynonyms(list(raw.Synonyms, readSynonym)),
    papers: list(raw.Publications, readPaper),
    xrefs: list(raw.Xrefs, readXref),
  }
}

/**
 * A term's images in one list, by template in `VFB_TEMPLATES`' order — JRC2018U brain's first, the
 * template a connectome user's neurons are in — and any template not listed there last.
 */
export function imagesBrainFirst(images: VfbTermInfo['images']): VfbImage[] {
  return [...images]
    .sort(([a], [b]) => templateRank(a) - templateRank(b))
    .flatMap(([, list]) => list)
}

/** One entry per name and dataset: FBbt lists a name once per source that gives it. */
function dedupeSynonyms(synonyms: VfbSynonym[]): VfbSynonym[] {
  const seen = new Set<string>()
  return synonyms.filter((s) => {
    const key = `${s.dataset ?? ''}\u0000${s.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function fetchTermInfo(id: string, signal?: AbortSignal): Promise<VfbTermInfo> {
  return readTermInfo(await vfbGet('/get_term_info', { id }, signal))
}

const termInfoHeld = new Map<string, Promise<VfbTermInfo>>()

/** `fetchTermInfo`, once per term per session — for a hover, which asks again on every rest. */
export function termInfo(id: string): Promise<VfbTermInfo> {
  return memoPromise(termInfoHeld, id, () => fetchTermInfo(id), { keep: 'resolved' })
}
