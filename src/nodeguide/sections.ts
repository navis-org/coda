/**
 * How the node guide groups the registry, shared by the two things that render it.
 *
 * Lifted out of `main.ts` when `appendix.ts` arrived. Both draw every node grouped the same way
 * — the interactive grid in the browser, the static index at build time — and a second copy of
 * this table is a second answer to "which section is Normalize in", with the copy that drifts
 * being whichever one is read less. `main.ts` still owns the *drawing*; this is only the shape.
 *
 * Pure data with no imports beyond a type, so it costs the page nothing.
 */

import type { GuideNode } from './data'

export interface Section {
  /** Position in the pipeline, or empty for the one that sits outside it. */
  n: string
  title: string
  note: string
  cats: readonly GuideNode['category'][]
}

/**
 * The four sections are the pipeline's own order — dataset, query, transform, viewer — which is
 * what makes numbering them information rather than decoration. Utility genuinely sits outside
 * that sequence (bring your own table, write a file, leave a note) and is not numbered.
 *
 * Categories map onto sections here and nowhere else; `analysis` joins Transform because
 * Normalize and Build Network are steps in the middle of a chain, whatever their palette
 * grouping says.
 */
export const SECTIONS: readonly Section[] = [
  {
    n: '1',
    title: 'Datasets',
    note: 'Where the data comes from. One node per published connectome, plus a custom deployment.',
    cats: ['dataset'],
  },
  {
    n: '2',
    title: 'Query',
    note: 'Ask a dataset a question. These reach the network, so they go stale and wait for Run.',
    cats: ['query'],
  },
  {
    n: '3',
    title: 'Transform',
    note: 'Reshape what came back — filter, join, aggregate, pivot, build a network.',
    cats: ['transform', 'analysis'],
  },
  {
    n: '4',
    title: 'Visualise & output',
    note: 'Draw it. Every viewer passes its input through, so it can sit anywhere in the chain.',
    cats: ['visualisation'],
  },
  {
    n: '',
    title: 'Utility',
    note: 'Outside the pipeline: bring your own table, write a file, leave a note on the canvas.',
    cats: ['utility'],
  },
]

export const CAT_LABEL: Record<GuideNode['category'], string> = {
  dataset: 'Dataset',
  query: 'Query',
  transform: 'Transform',
  analysis: 'Analysis',
  visualisation: 'Visualisation',
  utility: 'Utility',
}
