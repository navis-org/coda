/**
 * The Zoo index: what `navis-org/coda-zoo` publishes and Coda reads.
 *
 * The zoo is a public GitHub repository of workflows people deposited, and this module is the
 * contract between the two halves. It is pure — no fetching, no DOM — so both ends of the
 * contract can use it: `source.ts` parses what it downloads with `parseZooIndex`, and
 * `scripts/zoo-index.ts` builds what the repository publishes with `buildZooEntry`. One file
 * rather than a schema written twice is the point; a generator and a reader that disagree
 * produce an index that validates in CI and renders as nothing.
 *
 * **Why an index file at all**, rather than listing the repository: `raw.githubusercontent.com`
 * serves files and cannot list a directory, and `api.github.com` — which can — allows **60
 * requests an hour per IP** unauthenticated. Per *IP*, so a lab behind one NAT shares the
 * sixty between everybody in it, and the failure is a browser that suddenly shows an empty zoo
 * for reasons nobody in the building can see. A committed `index.json` is one request, no
 * quota, and cacheable. Measured 2026-08-26: raw carries `access-control-allow-origin: *` and
 * `cache-control: max-age=300`, so CORS is a non-issue and a merged PR is visible in minutes.
 *
 * **Everything here is third-party data.** An entry is written by whoever opened the pull
 * request, so `parseZooIndex` validates and *drops* in the same spirit as `deserializeGraph`:
 * one malformed entry loses that entry, never the index. The alternative — a throw — hands one
 * contributor the ability to blank the browser for everybody.
 */

/**
 * Bumped when the shape below changes incompatibly.
 *
 * Read rather than assumed: an index written by a newer generator than this build understands
 * is refused as a whole, with a sentence, instead of being parsed into a half-empty list. Same
 * reasoning as `c1.` naming the share format rather than the algorithm — an unrecognised
 * version should fail saying so.
 */
export const ZOO_INDEX_VERSION = 1

/**
 * Enough of a graph's shape to draw a card, and deliberately not one byte more.
 *
 * The card art is a minimap, so what it needs is where the nodes are and what joins them.
 * Positions are rounded flow coordinates — raw, not normalised — because the renderer is the
 * only party that knows the aspect ratio of the box it is fitting them into, and normalising
 * on two independent axes at generation time bakes in a distortion no reader can undo.
 *
 * **The node *type* travels, not its category.** The generator would have to load Coda's
 * registry to know that `out.network` is a visualisation; the renderer already has the registry
 * in memory. So the string crosses as-is and the colour is resolved at draw time — which also
 * means a type this build has never heard of draws in a neutral colour rather than vanishing,
 * and that is a *useful* signal: it is what registry drift looks like.
 */
export interface ZooLayout {
  /** `[x, y, nodeType]` per node, in the order the graph lists them. */
  nodes: [number, number, string][]
  /** Pairs of indices into `nodes`. Edges whose endpoints did not survive are dropped. */
  edges: [number, number][]
}

export interface ZooAuthor {
  name: string
  /** Login, without the `@`. Renders as a link; absent is fine. */
  github?: string
}

/** One workflow in the zoo. */
export interface ZooEntry {
  /** Directory name under `workflows/`, and the identity. Never reused for a different graph. */
  slug: string
  name: string
  /** One line. This is what the card shows and what search weighs most. */
  summary: string
  tags: string[]
  authors: ZooAuthor[]
  /**
   * Registered source ids the graph's dataset nodes reach for — `neuprint`, `cave`, `catmaid`,
   * `mock`. The browser shows this **before** the workflow opens, because most of what is worth
   * depositing needs a token and the worst version of this feature is one where every card
   * opens onto a graph that does nothing when you press Run.
   *
   * Declared in `meta.json` and *verified* by the generator against the graph, rather than
   * derived silently: a contributor who writes down what their workflow needs has thought about
   * it, and the check turns a wrong answer into a failed PR instead of a surprise.
   */
  requires: string[]
  /** Repository-relative path to the graph, e.g. `workflows/lc-survey/graph.coda.json`. */
  graph: string
  /** Repository-relative path to the long description, where the entry has one. */
  readme?: string
  /** Nodes in the graph, notes included — the count the card prints. */
  nodeCount: number
  layout: ZooLayout
  /** ISO 8601, from the last commit that touched the entry. */
  updatedAt: string
}

export interface ZooIndex {
  version: number
  /**
   * ISO 8601 of the newest entry — the zoo's own last-modified.
   *
   * Derived rather than stamped with a wall clock, and that is what makes `index.json` a pure
   * function of the directory it was built from. A generated file carrying `Date.now()` differs
   * from itself on every run, so CI cannot tell "the index is out of date" from "the index was
   * rebuilt", and the check that catches a contributor who forgot to regenerate stops working.
   */
  updatedAt: string
  workflows: ZooEntry[]

  /*
   * Deliberately no `repo`/`ref`. They were here, generated and parsed, and nothing ever read
   * them: every link in the browser goes through `zooRawUrl`/`zooEntryUrl`, which take the
   * `ZooSource` the index was *fetched from* and therefore already know. A document restating
   * where it lives is a second copy of that fact, on a wire format every visitor downloads, that
   * can disagree with the one the reader used to get here.
   */
}

/** What `parseZooIndex` hands back: what survived, and what did not. */
export interface ParsedZooIndex {
  index: ZooIndex
  /** One line per dropped entry. Surfaced in the browser's footer, not thrown. */
  dropped: string[]
}

/**
 * The coercions, exported because **they are part of the contract**.
 *
 * "What counts as a string here" is a rule the generator and the reader have to agree on, in the
 * same way the field names are. They were written twice — `str`/`strings`/`author` here and
 * `text`/`textList`/`authors` in `publish.ts`, character for character — in the file pair whose
 * entire stated purpose is that the schema exists once.
 */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(str).filter((entry): entry is string => entry !== undefined)
}

export function authorList(value: unknown): ZooAuthor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const name = str((raw as { name?: unknown }).name)
    if (!name) return []
    const github = str((raw as { github?: unknown }).github)
    return [github ? { name, github } : { name }]
  })
}

/**
 * A slug: the entry's directory name, and its permanent identity.
 *
 * One pattern, checked on both sides. Written twice it was a generator and a reader that could
 * come to disagree about what a valid slug is — which is the exact failure this file exists to
 * make impossible.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * A layout with some of its nodes removed, and the edges re-indexed to match.
 *
 * The remap is the whole of it, and it is why this is a function rather than a `filter` at each
 * call site: dropping a node shifts every index after it, so an edge kept by its original index
 * joins the wrong two boxes — a picture that is wrong rather than one that is missing something.
 *
 * Two callers with unrelated reasons to drop a node. `parseZooIndex` drops what it cannot read;
 * `ZooThumbnail` drops the text notes, which are wider than the pipeline and would squeeze it
 * into a band across the middle of the card. Same hazard, so the same code.
 */
export function filterLayout(
  layout: ZooLayout,
  keep: (node: ZooLayout['nodes'][number]) => boolean,
): ZooLayout {
  const moved = new Map<number, number>()
  const nodes: ZooLayout['nodes'] = []
  layout.nodes.forEach((node, index) => {
    if (!keep(node)) return
    moved.set(index, nodes.length)
    nodes.push(node)
  })

  const edges: ZooLayout['edges'] = []
  for (const [from, to] of layout.edges) {
    const a = moved.get(from)
    const b = moved.get(to)
    if (a === undefined || b === undefined || a === b) continue
    edges.push([a, b])
  }

  return { nodes, edges }
}

/**
 * A layout, with anything unusable dropped.
 *
 * Non-finite coordinates are the case worth naming: `NaN` in a position propagates through the
 * bounds computation and collapses the *whole* minimap to a single point, so one bad node in an
 * entry that is otherwise fine takes the picture with it. Coerced to a sentinel here and dropped
 * by `filterLayout`, which is what re-indexes the edges around the hole.
 */
const UNREADABLE: ZooLayout['nodes'][number] = [0, 0, '']

function layout(value: unknown): ZooLayout {
  if (!value || typeof value !== 'object') return { nodes: [], edges: [] }
  const raw = value as { nodes?: unknown; edges?: unknown }

  const nodes: ZooLayout['nodes'] = (Array.isArray(raw.nodes) ? raw.nodes : []).map((entry) => {
    if (!Array.isArray(entry)) return UNREADABLE
    const [x, y, type] = entry as [unknown, unknown, unknown]
    const nodeType = str(type)
    if (!nodeType || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)))
      return UNREADABLE
    return [Math.round(Number(x)), Math.round(Number(y)), nodeType]
  })

  const edges: ZooLayout['edges'] = (Array.isArray(raw.edges) ? raw.edges : []).flatMap(
    (entry) => {
      if (!Array.isArray(entry)) return []
      const from = Number((entry as unknown[])[0])
      const to = Number((entry as unknown[])[1])
      return Number.isInteger(from) && Number.isInteger(to)
        ? [[from, to] as [number, number]]
        : []
    },
  )

  return filterLayout({ nodes, edges }, (node) => node !== UNREADABLE)
}

/**
 * One entry, or undefined with a reason.
 *
 * The required half is small on purpose — a slug, a name, a summary and a graph path. Anything
 * else missing is a card that reads a little thinner, and a contributor should not lose their
 * workflow over a forgotten tag.
 *
 * **The graph path is checked for shape, not just presence.** It is interpolated into a URL
 * under the zoo's own repository, so a `..` in it would walk out of the repository and a leading
 * slash or a scheme would leave the host entirely. That is the one field here where a bad value
 * is more than a cosmetic problem, so it is the one field with a pattern.
 */
function entry(value: unknown): { entry: ZooEntry } | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'not an object' }
  const raw = value as Record<string, unknown>

  const slug = str(raw.slug)
  if (!slug) return { error: 'no slug' }
  if (!SLUG_PATTERN.test(slug)) return { error: `slug "${slug}" is not kebab-case` }

  const name = str(raw.name)
  if (!name) return { error: `${slug}: no name` }

  const graph = str(raw.graph)
  if (!graph) return { error: `${slug}: no graph path` }
  if (!isRepoPath(graph))
    return { error: `${slug}: graph path "${graph}" is not repo-relative` }

  const readme = str(raw.readme)

  return {
    entry: {
      slug,
      name,
      summary: str(raw.summary) ?? '',
      tags: strings(raw.tags),
      authors: authorList(raw.authors),
      requires: strings(raw.requires),
      graph,
      readme: readme && isRepoPath(readme) ? readme : undefined,
      nodeCount: Number.isFinite(Number(raw.nodeCount))
        ? Math.max(0, Number(raw.nodeCount))
        : 0,
      layout: layout(raw.layout),
      updatedAt: str(raw.updatedAt) ?? '',
    },
  }
}

/**
 * Whether a path stays inside the repository it is relative to.
 *
 * Rejects an absolute path, a scheme, a protocol-relative `//host`, a backslash and any `..`
 * segment. Written as a whitelist of what a segment may contain rather than a blacklist of what
 * it may not, because the blacklist version of this check is the one that keeps acquiring a new
 * case every few years.
 */
export function isRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('://')) return false
  return path.split('/').every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
}

/**
 * Parse a downloaded index.
 *
 * Throws only for the two failures that are about the *document* rather than its contents:
 * unparseable JSON, and a version this build does not implement. Everything else degrades to a
 * dropped entry with a line saying which and why, because an index is a shared document and one
 * contributor's mistake must not be everybody's empty list.
 */
export function parseZooIndex(text: string): ParsedZooIndex {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The Zoo index is not valid JSON. The repository may be mid-publish.')
  }
  if (!raw || typeof raw !== 'object') throw new Error('The Zoo index is not an object.')

  const doc = raw as Record<string, unknown>
  const version = Number(doc.version)
  if (!Number.isFinite(version)) throw new Error('The Zoo index carries no format version.')
  if (version > ZOO_INDEX_VERSION) {
    throw new Error(
      `The Zoo index is format ${version}; this build of Coda reads ${ZOO_INDEX_VERSION}. Reload the page to pick up a newer Coda.`,
    )
  }

  const dropped: string[] = []
  const workflows: ZooEntry[] = []
  const seen = new Set<string>()

  for (const candidate of Array.isArray(doc.workflows) ? doc.workflows : []) {
    const result = entry(candidate)
    if ('error' in result) {
      dropped.push(result.error)
      continue
    }
    // A duplicate slug is a generator bug rather than a contributor one, but the first entry
    // wins deterministically instead of whichever the renderer happened to key last.
    if (seen.has(result.entry.slug)) {
      dropped.push(`${result.entry.slug}: duplicate slug`)
      continue
    }
    seen.add(result.entry.slug)
    workflows.push(result.entry)
  }

  return {
    index: {
      version,
      updatedAt: str(doc.updatedAt) ?? '',
      workflows,
    },
    dropped,
  }
}
