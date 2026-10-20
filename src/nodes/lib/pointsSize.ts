/**
 * What a points value costs to build, and the guard every node building one goes through.
 *
 * Moved out of `skeletonPoints.ts` when a second node — the VFB pack's Load Expression — needed it:
 * a pack importing a skeleton module for fifteen lines of arithmetic pulled geometry distance, the
 * k-d tree, transforms and the Pyodide warp in behind it. The byte model is a fact about the value
 * shape (`PointsValue` with `ColumnData` attributes), not about where the points came from, so it
 * lives here, and each caller names its own lever.
 */

import type { Warner } from '../../core/limits'
import {
  formatBytes,
  overCrashFloor,
  refuseIfOverCrashFloor,
  warnOverThreshold,
} from '../../core/limits'

/**
 * Twelve bytes of coordinates plus one eight-byte cell per attribute column — the columns being
 * plain arrays (`ColumnData`), so a repeated string costs a reference, not a copy.
 */
const bytesPerPoint = (columns: number) => 12 + 8 * columns

/*
 * Five million points is about 300 MB of cloud at the default columns — inside the crash floor, so
 * the warning is seen before the refusal. For scale, 500 traced neurons at 1 µm is about that.
 */
const POINTS_WARN = 5_000_000

/**
 * Refuse past the crash floor, warn past `POINTS_WARN` — before anything is allocated. `lever` is
 * the sentence naming the caller's control that shrinks the cloud.
 */
export function checkPointsSize(
  ctx: Warner,
  points: number,
  columns: number,
  what: string,
  lever: string,
): void {
  const bytes = points * bytesPerPoint(columns)
  refuseIfOverCrashFloor(`About ${points.toLocaleString()} points${what}`, bytes, lever)
  if (points <= POINTS_WARN) return
  warnOverThreshold(ctx, {
    count: points,
    threshold: POINTS_WARN,
    unit: 'points',
    control: 'the usual size for this node',
    cost: `${formatBytes(bytes)} of point cloud${what}. ${lever}`,
  })
}

/**
 * Whether a cloud this size is past the crash floor — for a caller whose size grows as it fetches
 * and that must stop early, then refuse through `checkPointsSize`.
 */
export function pointsOverCrashFloor(points: number, columns: number): boolean {
  return overCrashFloor(points * bytesPerPoint(columns))
}
