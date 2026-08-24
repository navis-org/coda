/**
 * The help documents: which nodes have one, and how to read it.
 *
 * A node gets a `?` button because a file exists, and for no other reason. Nothing in the node
 * definition says "I have a document", nothing lists the documents, and adding one is dropping
 * `src/help/nodes/<node type>.md` into place. The alternative — a flag on `NodeDefinition`, or a
 * registry file naming each document — is two things to keep in step, and the failure when they
 * drift is a `?` button that opens nothing.
 *
 * ## Why `import.meta.glob`, and why the two calls differ
 *
 * The **keys** of a glob are known at build time without any file being loaded, so
 * `hasHelp(type)` costs zero bytes: the app ships a list of node types and nothing else until
 * somebody presses `?`. The values are dynamic imports, so each document is its own lazy chunk
 * and a long one about NBLAST is not in the bundle of a session that never opens it.
 *
 * Images are the opposite and are globbed **eagerly**, because what an eager `?url` glob yields
 * is not the image — it is the *hashed path* Vite gave it, a short string per file. Loading it
 * lazily would buy a few hundred bytes and cost the renderer the ability to resolve `![](x.png)`
 * synchronously while it draws.
 *
 * ## Documents are text, not code
 *
 * A document is markdown, parsed by `src/ui/markdown.ts` in its extended mode, and everything
 * that makes a figure appear is a fenced block resolved against the node registry — see
 * `figures.ts`. There is no path by which a document executes anything, which is what makes
 * "drop a file in a folder" a safe contribution model.
 */

import type { MarkdownBlock } from '../ui/markdown'
import { parseMarkdown } from '../ui/markdown'

/**
 * Every document, keyed by the node type its filename names.
 *
 * The glob pattern is a literal on purpose — Vite resolves it statically, and a pattern built
 * from a variable silently matches nothing.
 */
const SOURCES = import.meta.glob('./nodes/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/**
 * Figure images, resolved to their built URLs.
 *
 * A document writes `![A heatmap](nblast-heatmap.png)` and gets the file of that name from
 * `src/help/images/`. Deliberately a bare filename rather than a path: a document is not at a
 * URL, so a relative path in one has no honest meaning — `./images/x.png` would resolve against
 * whatever page the app happens to be served from, which is not where the file is.
 */
const IMAGES = import.meta.glob('./images/*.{png,jpg,jpeg,svg,webp,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function typeOfPath(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.md$/, '')
}

const BY_TYPE = new Map(Object.entries(SOURCES).map(([path, load]) => [typeOfPath(path), load]))
const IMAGE_URLS = new Map(
  Object.entries(IMAGES).map(([path, url]) => [path.replace(/^.*\//, ''), url]),
)

export interface HelpDoc {
  /** The node type this document is about — its filename, and the key everything uses. */
  type: string
  blocks: MarkdownBlock[]
  /** The unparsed text, so a test can assert about a document without walking an AST. */
  source: string
}

/** Whether this node type has a document, and so whether its card draws a `?`. */
export function hasHelp(type: string): boolean {
  return BY_TYPE.has(type)
}

/** Every documented node type, sorted. The order matters only to tests and to listings. */
export function helpTypes(): string[] {
  return [...BY_TYPE.keys()].sort()
}

/** The built URL for a figure image, or `undefined` if `src/help/images` holds no such file. */
export function helpImageUrl(name: string): string | undefined {
  return IMAGE_URLS.get(name.replace(/^.*\//, ''))
}

/**
 * Parsed documents, kept for the session.
 *
 * Keyed on the *promise* rather than on the result, so two `?` presses in flight at once share
 * one fetch instead of racing to fill the same slot.
 */
const CACHE = new Map<string, Promise<HelpDoc>>()

export function loadHelpDoc(type: string): Promise<HelpDoc | undefined> {
  const cached = CACHE.get(type)
  if (cached) return cached
  const load = BY_TYPE.get(type)
  if (!load) return Promise.resolve(undefined)
  const pending = load().then((source) => ({
    type,
    source,
    blocks: parseMarkdown(source, { extended: true }),
  }))
  CACHE.set(type, pending)
  return pending
}
