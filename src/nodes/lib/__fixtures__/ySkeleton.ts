import type { SkeletonGeometry } from '../../../core/values'

/**
 * A Y in nanometres, rooted at 0 — the arbour tests' shared shape:
 *
 *     0 ── 1 ── 2 ── 3
 *               │
 *               4
 *               │
 *               5
 *
 * Edges are 1 µm, so every geodesic distance is a whole number of micrometres and can be read off
 * the picture. Its landmarks are 0 (root), 2 (branch point), 3 (leaf 1 µm beyond 2) and 5 (leaf
 * 2 µm beyond 2). Shared by every test of the arbour model, its layouts and the card's drawing.
 */
export function ySkeleton(
  radii = [500, 500, 500, 500, 500, 500],
  parents = [-1, 0, 1, 2, 2, 4],
): SkeletonGeometry {
  return {
    id: 'y',
    positions: Float32Array.from([
      0, 0, 0, 1000, 0, 0, 2000, 0, 0, 3000, 0, 0, 2000, 1000, 0, 2000, 2000, 0,
    ]),
    radii: Float32Array.from(radii),
    parents: Int32Array.from(parents),
  }
}
