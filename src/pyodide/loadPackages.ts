/**
 * Load a Python module's packages, and say so when one did not arrive.
 *
 * ## Pyodide does not throw for a package it failed to load
 *
 * `loadPackage` catches each package's failure — a download that broke off, a checksum that did
 * not match — writes two lines to its error stream, and **resolves**. Read off the shipped
 * `pyodide.asm.mjs` (v314.0.5, `loadPackageInner`): `Failed to load pandas` on the message
 * stream, then `The following error occurred while loading pandas:` and the reason on the error
 * stream, which is `console.error` unless a caller passes `errorCallback`.
 *
 * Coda passed none, so a failed download went by in silence. The module's own source then ran
 * — a module that imports its packages on first use, as `cutoutSummary` does, runs fine without
 * them — and was kept for the session. Every later call failed inside Python with
 * `ModuleNotFoundError: No module named 'pandas'` and Pyodide's advice to call `micropip`, on a
 * node the reader had no way to fix but a reload. Found on Find Merge Candidates, 2026-11-16: twice in a
 * probe and once in the app, each time with the files themselves in place on the CDN.
 *
 * ## Tried twice, then said
 *
 * A package that failed is not marked loaded, so asking again fetches only what is missing. One
 * retry, after a short pause, absorbs a download that broke off; a second failure is thrown with
 * Pyodide's own reason, before the caller runs or keeps anything, so the next call starts from
 * the download again.
 *
 * Its own file, with the one thing it needs of Pyodide as a parameter, so it can be tested
 * without a worker or a network.
 */

/** The line Pyodide's error stream leads a failed package with; its reason is the line after. */
const FAILED = 'The following error occurred while loading'

/** As much of Pyodide as this reads. */
export interface PackageLoader {
  loadPackage(
    names: string[],
    options: {
      messageCallback?: (message: string) => void
      errorCallback?: (message: string) => void
    },
  ): Promise<unknown>
  /** `pyodide.loadedPackages`: every package now installed, by its name in the lock file. */
  loadedPackages: Readonly<Record<string, unknown>>
}

/** How many times a load is asked for before its failure is the caller's to hear. */
const ATTEMPTS = 2

/** Long enough for a connection that dropped to be back; short beside any download. */
const RETRY_AFTER_MS = 1500

/** PEP 503's rule, which is how Pyodide keys its lock file: case and `-_.` do not matter. */
const normalised = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/**
 * What did not arrive, in words, or `undefined` where everything did.
 *
 * **Two tests, because either alone is one upgrade away from the silence this file ends.** The
 * sentence on the error stream carries the reason, but it is Pyodide's wording, read off one
 * build. So the outcome is also asked directly: a package named from the lock file must be in
 * `loadedPackages` afterwards. A wheel asked for by URL cannot be checked that way — it is
 * installed under a name this cannot know — so for those the sentence is the only witness.
 */
function failure(
  said: readonly string[],
  names: readonly string[],
  py: PackageLoader,
): string | undefined {
  const reasons: string[] = []
  for (const [at, line] of said.entries()) {
    // Only this line is a failure: the same stream carries a `URI mismatch` notice for a wheel
    // Pyodide already holds, which loaded nothing wrongly.
    if (line.startsWith(FAILED)) reasons.push(`${line} ${said[at + 1] ?? ''}`.trim())
  }
  if (reasons.length > 0) return reasons.join(' ')
  const have = new Set(Object.keys(py.loadedPackages).map(normalised))
  const missing = names.filter((name) => !name.includes('/') && !have.has(normalised(name)))
  return missing.length > 0 ? `Not installed afterwards: ${missing.join(', ')}.` : undefined
}

/** What a caller may hand over; all of it has a default. */
export interface LoadOptions {
  /** Told when a load is being asked for again, so a card can say why it is still waiting. */
  note?: (text: string) => void
  /** The pause before the second ask. Here so a test does not sit through it. */
  wait?: (ms: number) => Promise<void>
  /** Where Pyodide's error stream goes besides being read. Here so a test stays quiet. */
  log?: (line: string) => void
}

export async function loadPackagesOrThrow(
  py: PackageLoader,
  names: string[],
  /** What the download is called on the card — the module's own label. */
  label: string,
  options: LoadOptions = {},
): Promise<void> {
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  // The console, as before this file existed: taking the stream must not make it vanish. A
  // `URI mismatch` is a wrong-version load somebody may need to see, and is no failure here.
  const log = options.log ?? ((line: string) => console.error(line))
  let reason = ''
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      options.note?.(`${label} — a download failed, trying again`)
      await wait(RETRY_AFTER_MS)
    }
    const said: string[] = []
    await py.loadPackage(names, {
      messageCallback: () => {},
      errorCallback: (message) => {
        said.push(message)
        log(message)
      },
    })
    const failed = failure(said, names, py)
    if (failed === undefined) return
    reason = failed
  }
  throw new Error(
    `Python could not load what this needs (${label}). ${reason} ` +
      'This is usually a download that broke off. Check the connection and run again.',
  )
}
