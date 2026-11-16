/**
 * No test may reach a chunkedgraph edit endpoint (`docs/seam-merge-plan.md`, phase 2).
 *
 * The writer (`src/data/cave/edits.ts`) is tested against a stubbed `fetch`, and a test that
 * forgot its stub would otherwise send a real merge with whatever token the environment holds.
 * So `setup.ts` installs this under every test file: the `fetch` a test finds is the real one
 * behind a check that refuses an edit request **and** records it, and an `afterEach` fails the
 * test that made it. Recording matters as much as refusing: the writer reads a thrown `fetch` as an
 * unreachable host, so a refusal alone would come back as an `unknown` outcome a test might accept.
 *
 * A test that stubs `fetch` replaces this, which is the point: a stub is not a server.
 *
 * The routes are every chunkedgraph route that writes (`isChunkedgraphEdit`, shared with the
 * sandbox fence) — not only the two Coda sends.
 */

import { afterAll, afterEach } from 'vitest'

import { isChunkedgraphEdit, requestUrl } from './sandboxWrites'

const attempts: string[] = []

/** The edit requests refused since the last call, which it clears. */
export function takeWriteAttempts(): string[] {
  return attempts.splice(0)
}

/** Registered, so a fresh load of this module still recognises a wrapper an earlier one installed. */
const GUARD = Symbol.for('coda.writeGuard')

/**
 * Put the check in front of the `fetch` this process has, and fail any test that tripped it.
 * Called per test file. A run without isolation calls it again over the same `fetch`: the wrapper
 * is not stacked a second time, but the check is registered for every file.
 */
export function installWriteGuard(): void {
  if (!(GUARD in globalThis.fetch)) {
    const real = globalThis.fetch
    const guarded = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (isChunkedgraphEdit(url)) {
        attempts.push(url)
        return Promise.reject(new Error(`A test reached a chunkedgraph edit endpoint: ${url}`))
      }
      return real(input, init)
    }
    globalThis.fetch = Object.assign(guarded, { [GUARD]: true })
  }
  // `afterAll` as well: a write a test started and did not await can land after its `afterEach`.
  afterEach(failIfTripped)
  afterAll(failIfTripped)
}

function failIfTripped(): void {
  const tripped = takeWriteAttempts()
  if (tripped.length > 0) {
    throw new Error(`A test reached a chunkedgraph edit endpoint: ${tripped.join(', ')}`)
  }
}
