/**
 * Which workflow a surface is drawing, for anything held per node beyond a render.
 *
 * Node ids are not unique across open workflows — two documents opened from one file carry the
 * same ids (`deserializeGraph` does not remap) — so a kept renderer or a remembered camera keyed
 * by node alone answers for both, and draws one document's scene in the other. Provided once, by
 * `App`, rather than read from the store by every viewer: one subscription instead of one per
 * preview, and a surface rendered outside the app (a test) gets the empty default and keys by node.
 */

import { createContext } from 'react'

export const WorkflowScope = createContext('')

/** A node's key within its workflow. */
export function scopedKey(workflowId: string, nodeId: string): string {
  return workflowId ? `${workflowId}:${nodeId}` : nodeId
}
