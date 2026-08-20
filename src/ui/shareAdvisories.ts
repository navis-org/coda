/**
 * What a shared link does not carry, said before it is sent rather than discovered after.
 *
 * The counterpart to `export/canExport.ts`, in an advisory mood: nothing here refuses a share,
 * because unlike a notebook built on a connectome that does not exist outside this tab, a
 * workflow link is worth having in every one of these cases. What each one costs is not
 * obvious, though, and the moment to say so is while the sender still has the link in front of
 * them and can attach the file, or mention the token, or narrow the selection.
 *
 * Pure and headless, in `src/ui` for the same reason `export.ts` and `markdown.ts` are: it may
 * read the node registry, which `src/data` may not.
 */

import type { CodaGraph } from '../core/graph'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'

export interface ShareAdvisory {
  /** Stable id, so the dialog can key a list and a test can name one. */
  id: string
  /** One sentence. The whole advisory — there is no second line. */
  text: string
}

/**
 * Roughly where a link stops travelling reliably.
 *
 * Not a browser limit — Chrome carries about two megabytes and a fragment is never sent to a
 * server at all. It is the clients in between: mail wraps long lines, chat clients elide, and
 * an issue tracker linkifies as far as it feels like. Measured against the bundled examples,
 * which pack to 1,540–2,004 characters, this leaves ordinary workflows well clear and catches
 * the case that actually bites — an Explore selection, which packs to roughly 56,000.
 */
export const LONG_LINK_CHARS = 8_000

/**
 * Nodes holding a table that lives in this browser rather than in the document.
 *
 * The rows are in IndexedDB by content address (see `data/uploads.ts`), so a `.coda.json` has
 * always arrived without them and a link does the same. What the sender can do about it is send
 * the file too — so the advisory names the **file**, not the node and not the content hash,
 * because the filename is the only part of this anybody can act on.
 */
function uploadFiles(graph: CodaGraph): string[] {
  const names: string[] = []
  for (const node of graph.nodes) {
    if (node.type !== 'core.uploadTable') continue
    const file = node.params?.['fileName']
    names.push(typeof file === 'string' && file ? file : 'an uploaded table')
  }
  return names
}

/** Dataset nodes on a real connectome, i.e. the ones the recipient needs a token to query. */
function credentialledDatasets(graph: CodaGraph): string[] {
  const labels = new Set<string>()
  for (const node of graph.nodes) {
    const family = familyForNodeType(node.type)
    if (!family || family.synthetic) continue
    labels.add(family.label)
  }
  return [...labels]
}

/**
 * Everything worth saying about this link, most actionable first.
 *
 * `linkChars` is passed in rather than recomputed: the dialog has already built the link, and
 * encoding a graph twice to answer a question about the string it just produced is the kind of
 * duplication that ends with the advisory disagreeing with the box above it.
 */
export function shareAdvisories(
  graph: CodaGraph,
  linkChars: number | undefined,
): ShareAdvisory[] {
  const out: ShareAdvisory[] = []

  const files = uploadFiles(graph)
  if (files.length > 0) {
    out.push({
      id: 'uploads',
      text:
        files.length === 1
          ? `${files[0]} is stored in this browser, not in the workflow — send the file separately, and whoever opens the link can pick it up again on the Upload Table card.`
          : `${files.join(', ')} are stored in this browser, not in the workflow — send the files separately, and whoever opens the link can pick them up again on the Upload Table cards.`,
    })
  }

  const datasets = credentialledDatasets(graph)
  if (datasets.length > 0) {
    out.push({
      id: 'token',
      text: `Running this needs a neuPrint token of their own — ${datasets.join(', ')} ${datasets.length === 1 ? 'is a real connectome' : 'are real connectomes'}. The workflow opens without one; only Run needs it.`,
    })
  }

  if (linkChars !== undefined && linkChars > LONG_LINK_CHARS) {
    out.push({
      id: 'long',
      text: `This link is ${Math.round(linkChars / 1000)} kB long, which mail and chat clients often cut short. A gist keeps it to about forty characters however large the workflow is.`,
    })
  }

  return out
}
