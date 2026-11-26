/**
 * How long the paths that write to a chunkedgraph wait, and the root read-back they share — the
 * merge batch (`mergeBatch.ts`) and the split gallery's Accept (`splitWrite.ts`). Read-only on
 * purpose: it sends nothing, so both writers can import it without widening the writer's fence
 * (`importGraph.test.ts`).
 */

import { errorMessage } from '../../core/errors'
import type { CaveRequestOptions } from './client'

/**
 * How long a read around a write may take before it is given up: a read changes nothing, so
 * stopping one is safe, and a check that never answers must not hold an overlay for good.
 */
export const READ_TIMEOUT_MS = 60_000

/** `options` with a time limit of their own (`READ_TIMEOUT_MS`): every read around a write. */
export function timedRead(options: CaveRequestOptions): CaveRequestOptions {
  return { ...options, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }
}

/**
 * How long a write may go unanswered before the caller stops waiting. **The request is not
 * cancelled** — that would only throw away the answer — and the write is read as `unknown`. Long,
 * since an edit with its remesh is slow.
 */
export const SEND_TIMEOUT_MS = 120_000

/** `work`'s answer, or `undefined` where none came within `waitMs`. The work is left to finish. */
export async function within<T>(work: Promise<T>, waitMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unanswered = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs)
  })
  try {
    return await Promise.race([work, unanswered])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Each supervoxel's root from `read`, or why they could not be read — never a throw. **One root
 * per supervoxel or it is no answer**: a short list read as two `undefined`s would equal each
 * other, and a lost reply would be recorded as made into no root at all.
 */
export async function rootsOrError(
  read: () => Promise<string[]>,
  count: number,
): Promise<string[] | string> {
  try {
    const roots = await read()
    return roots.length === count
      ? roots
      : `the root lookup answered ${roots.length} of ${count} supervoxels.`
  } catch (error) {
    return errorMessage(error)
  }
}

/** The ways Coda writes to a chunkedgraph (`importGraph.test.ts`' `CHAINS`). */
type WritePath = 'merge' | 'split'

/** Each path's answer to "is a write of yours out?": why, in a sentence, or undefined. */
const outs = new Map<WritePath, () => string | undefined>()

/**
 * Say how to ask whether `path` has a write out — asked, never pushed, so each path keeps its
 * own one truth. Registered once per path, at module load.
 */
export function registerWriteOut(path: WritePath, out: () => string | undefined): void {
  outs.set(path, out)
}

/**
 * Why `path` may not start a write now: another path's write is out (a merge batch, or a split
 * still unanswered), and two edits in flight to one neuron would apply one to a root the reader
 * never saw. Undefined where nothing else is out.
 */
export function otherWriteOut(path: WritePath): string | undefined {
  for (const [other, out] of outs) {
    if (other === path) continue
    const reason = out()
    if (reason) return reason
  }
  return undefined
}
