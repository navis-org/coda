import type { IssueFix } from './node'

/**
 * The one way this codebase turns a caught `unknown` into a message.
 *
 * `catch` binds `unknown`, so every handler that wants text was writing the same ternary —
 * eight of them, across all three layers. Headless, so the store, the sources and the viewers
 * can all reach it.
 */

/** A caught value's message, for anything that has to be shown or logged. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * An error that knows its remedy: the card draws `fix` as a button under the message, and the
 * run's notice draws it too (`Scheduler` keeps it on `NodeRunInfo.fix`).
 */
export class FixableError extends Error {
  readonly fix: IssueFix
  constructor(message: string, fix: IssueFix) {
    super(message)
    this.name = 'FixableError'
    this.fix = fix
  }
}

/**
 * A caught value's remedy, where it or an error it wraps (`cause`) carries one — so a wrapper that
 * rethrows with `{ cause }` keeps the button. One that rethrows a bare `Error`, or a worker's
 * `postMessage`, loses it: the fix survives only what keeps the original error.
 */
export function errorFix(error: unknown): IssueFix | undefined {
  for (let at = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof FixableError) return at.fix
  }
  return undefined
}
