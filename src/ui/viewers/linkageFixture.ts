/**
 * Trees to draw, for the two files that draw them.
 *
 * `dendrogramLayout.test.ts` needs one to check the window arithmetic and
 * `dendrogram.test.tsx` needs one to check the card's ceilings; they had the same builder under
 * two names, which is how a fixture acquires two behaviours the first time either is adjusted.
 */

import type { LinkageValue } from '../../core/values'
import { makeLinkage } from '../../core/values'

/**
 * A caterpillar of `n` leaves — each merge joining the last cluster to the next leaf.
 *
 * Enough shape to lay out and to draw, and cheap to build at the twenty thousand
 * `MAX_LEAVES_DRAWN` wants: heights ascend by `1 / n` so the tree is not flat, and the leaf
 * order is the identity so slot `i` is observation `i`.
 */
export function caterpillar(n: number): LinkageValue {
  const merges = new Float64Array((n - 1) * 4)
  for (let i = 0; i < n - 1; i++) {
    merges[i * 4] = i === 0 ? 0 : n + i - 1
    merges[i * 4 + 1] = i + 1
    merges[i * 4 + 2] = (i + 1) / n
    merges[i * 4 + 3] = i + 2
  }
  return makeLinkage(
    merges,
    Array.from({ length: n }, (_, i) => `n${i}`),
    Int32Array.from({ length: n }, (_, i) => i),
  )
}
