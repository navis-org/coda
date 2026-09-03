/**
 * The word for each node category, in the app.
 *
 * Its own module because three surfaces read it — the browser's chips and rows, the add menu's
 * rail, and the command palette's group headings — and a `Record<NodeCategory, string>` copied
 * into any of them is a seventh category appearing in one place and not the others. The palette
 * is the reason this is a table rather than a function: it derived its headings by capitalising
 * the category id, which agreed with the other two only for as long as every label happened to
 * be its id with a capital letter. `nodeguide/sections.ts` keeps its own copy on purpose — that
 * page is a separate vite entry with no UI code in its bundle.
 */

import type { NodeCategory } from '../../core/node'

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  dataset: 'Dataset',
  query: 'Query',
  transform: 'Transform',
  analysis: 'Analysis',
  visualisation: 'Visualisation',
  utility: 'Utility',
}
