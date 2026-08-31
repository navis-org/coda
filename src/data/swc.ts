/**
 * SWC, in the two spellings Coda receives it.
 *
 * neuPrint answers a Cypher result — `{ columns, data }` with `[rowId, x, y, z, radius, link]`
 * in arbitrary column order — while DVID answers the file itself, whitespace-separated text with
 * `#` comments. Both describe the same thing, and the part worth sharing is not the parsing but
 * the **walk**: turning `link`, which names a *row id*, into `parents`, which are indices, in an
 * order where a parent always precedes its child.
 *
 * **Not `skeletonTree.ts`'s `spanningForest`, and the difference is deliberate.** That one roots
 * an *undirected* edge list by BFS from the lowest unvisited index, which is right for a graph
 * with no stated parent. SWC states one: `link` is directed and authoritative, so delegating
 * would re-root any file whose root is not row 0 and invert every parent below it, and would
 * join an unrooted cycle where this deliberately breaks it. Two walks, two different inputs.
 *
 * That walk is load-bearing and was already written once. Everything that reads a skeleton —
 * cable length, the morphometrics, the SWC writer, the 3D viewer — assumes parent-before-child,
 * and `docs/backends.md` records what a surviving cycle does to a consumer that walks to a root:
 * it loops forever. So `skeletonFromRows` is one implementation with two front ends rather than
 * a second parser that gets the traversal nearly right.
 *
 * **Neither front end scales anything.** DVID's SWC is in voxels and its meshes are in
 * nanometres — measured on the same body in the same repo, `AL-VA1v` 1010, x 2,270…11,454
 * against a mesh at 18,043…91,635 — and neuPrint's SWC is in voxels too. Scaling belongs to
 * whoever knows the voxel size, which is the source; see `data/units.ts`.
 */

import type { NeuronId } from '../core/ids'
import type { SkeletonGeometry } from '../core/values'

/**
 * One SWC node, in the neutral form both front ends produce.
 *
 * `link` is a **row id**, not an index, and `-1` (or anything unmatched) is a root. Keeping the
 * file's own numbering here rather than resolving it early is what lets the walk below treat a
 * dangling link and an explicit root as the same case.
 */
export interface SwcRow {
  rowId: number
  x: number
  y: number
  z: number
  radius: number
  link: number
}

/**
 * SWC rows to a Coda skeleton, re-emitted in traversal order from each root.
 *
 * Defensive about real files, and each guard is a shape that exists in the wild: a `link`
 * pointing at a missing row becomes a root, a cycle terminates because a point is only visited
 * once, and a component with no root at all is emitted as its own tree rather than dropped —
 * silently losing half a neuron is worse than an arbitrary root.
 */
export function skeletonFromRows(id: NeuronId, rows: readonly SwcRow[]): SkeletonGeometry {
  const count = rows.length
  const rowIdToSlot = new Map<number, number>()
  rows.forEach((row, slot) => rowIdToSlot.set(row.rowId, slot))

  // Children per slot, so a traversal can go root -> leaf.
  const children: number[][] = Array.from({ length: count }, () => [])
  const roots: number[] = []
  rows.forEach((row, slot) => {
    const parent = rowIdToSlot.get(row.link)
    if (parent === undefined || parent === slot) roots.push(slot)
    else children[parent]!.push(slot)
  })

  const positions = new Float32Array(count * 3)
  const radii = new Float32Array(count)
  const parents = new Int32Array(count)

  let emitted = 0
  // A visited flag, not a mapping: nothing ever reads which point a slot became. Dense keys
  // `0…count-1`, so a typed array rather than a `Map` of boxed entries per node.
  const visited = new Uint8Array(count)
  const emit = (slot: number, parentPoint: number): number => {
    const row = rows[slot]!
    const point = emitted++
    visited[slot] = 1
    positions[point * 3] = row.x
    positions[point * 3 + 1] = row.y
    positions[point * 3 + 2] = row.z
    radii[point] = row.radius
    parents[point] = parentPoint
    return point
  }

  const stack: Array<{ slot: number; parentPoint: number }> = roots.map((slot) => ({
    slot,
    parentPoint: -1,
  }))
  while (stack.length) {
    const { slot, parentPoint } = stack.pop()!
    if (visited[slot]) continue // a cycle, or a row linked twice
    const point = emit(slot, parentPoint)
    for (const child of children[slot]!) stack.push({ slot: child, parentPoint: point })
  }

  // Anything left is in a cycle with no root.
  for (let slot = 0; slot < count; slot++) {
    if (!visited[slot]) emit(slot, -1)
  }

  return {
    id,
    positions: positions.subarray(0, emitted * 3),
    radii: radii.subarray(0, emitted),
    parents: parents.subarray(0, emitted),
  }
}

/**
 * Parse an SWC **file** — DVID's spelling, and the standard one.
 *
 * Columns are `id type x y z radius parent`, whitespace-separated, `#` comments. The `type`
 * column is read and discarded: Coda's `SkeletonGeometry` has nowhere to put a soma/axon label,
 * and inventing a field for it here would be a claim about data no viewer reads.
 *
 * A line with fewer than seven fields is skipped rather than defaulted. The files this reads are
 * written by NeuTu and carry a `#<json>{…}</json>` header line among the comments, so tolerating
 * junk is not hypothetical — but a short line is a *malformed node*, and defaulting its
 * coordinates to the origin would put a stray segment through the middle of the neuron, which is
 * the wrong-picture failure the thumbnail code is also shaped to avoid.
 */
export function parseSwcText(id: NeuronId, text: string): SkeletonGeometry {
  const rows: SwcRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s+/)
    if (fields.length < 7) continue
    const numbers = fields.map(Number)
    if (numbers.some((n) => !Number.isFinite(n))) continue
    rows.push({
      rowId: numbers[0]!,
      x: numbers[2]!,
      y: numbers[3]!,
      z: numbers[4]!,
      radius: numbers[5]!,
      link: numbers[6]!,
    })
  }
  return skeletonFromRows(id, rows)
}
