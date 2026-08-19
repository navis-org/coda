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
