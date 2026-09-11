/**
 * What an Explore Dataset export decides about its two derived ports, before either language
 * says it: which search fills Hits, and which neurons fill Selected.
 *
 * The node holds a whole neuron table and searches it locally, and each document ports that
 * search as a helper — so what is left to decide is when there is a search at all, when it is
 * capped, and when nothing is ticked. Both emitters walked those three tests in the same order;
 * the download itself, and where it comes from, is each backend's and stays with its renderer.
 *
 * The cap rides as a number rather than a note: both documents need it to cut the hits, and each
 * says in its own words that its cut keeps table order where the card keeps relevance.
 */

import type { NeutralContext, Noted } from '../neutral'
import { pickedIds } from './viewers'

export interface ExplorePlan {
  /** The search behind Hits, or — as `note` — the note saying an empty box keeps every row. */
  hits: Noted<{ query: string; cap?: number }>
  /** Resolved against the whole table rather than the hits, exactly as the node does. */
  selected: Noted<{ ids: string[] }>
}

export function explorePlan(ctx: Pick<NeutralContext, 'params'>): ExplorePlan {
  const query = String(ctx.params.query).trim()
  const limit = Number(ctx.params.limit)
  return {
    // An empty search is every neuron, which is what the node's own `Hits` port answers.
    hits: query
      ? { query, cap: limit > 0 ? limit : undefined }
      : { note: 'The search box is empty, so Hits is the whole table.' },
    selected: pickedIds(ctx, 'neuron.explore'),
  }
}
