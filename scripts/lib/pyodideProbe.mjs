/**
 * The half of a Pyodide probe that is not about the capability being probed.
 *
 * `probe-nblast.mjs` and `probe-linkage.mjs` each run one `src/pyodide/*.py` against the real
 * navis-fastcore wheel, and each needs the same four things before it can: find Pyodide, boot
 * it, count failures, and exit on the tally. Only the request shapes and the assertions differ,
 * and those stay in the scripts.
 *
 * It exists because the second probe was written by copying the first, which is how the
 * `PYODIDE_PATH` note below — earned once — came to be missing from one of them.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const root = join(here, '..', '..')

/**
 * Where the runtime comes from.
 *
 * Read, never copied: `sources.json` exists so the app and these scripts cannot disagree about
 * which runtime is being checked.
 */
export const sources = JSON.parse(readFileSync(join(root, 'src/pyodide/sources.json'), 'utf8'))

/*
 * Resolved to an absolute path: a bare `node_modules/pyodide/pyodide.mjs` is read by `import()`
 * as a *specifier* rather than a path, so it would fail and fall through to the package below —
 * which happens to work, and would mean the env var silently did nothing.
 */
const pyodidePath = process.env.PYODIDE_PATH ? resolve(process.env.PYODIDE_PATH) : undefined

async function loadRuntime() {
  const candidates = [pyodidePath ? join(pyodidePath, 'pyodide.mjs') : undefined, 'pyodide'].filter(
    Boolean,
  )
  for (const spec of candidates) {
    try {
      return await import(spec)
    } catch {
      /* try the next */
    }
  }
  console.error(
    'Pyodide is not installed here. `npm i pyodide` (or set PYODIDE_PATH to a directory\n' +
      'holding pyodide.mjs) and run again. Nothing was checked.',
  )
  process.exit(2)
}

/** Boot Pyodide, reporting what it cost. Pyodide is deliberately not a dependency of this app. */
export async function bootPyodide() {
  const t0 = performance.now()
  const { loadPyodide } = await loadRuntime()
  const py = await loadPyodide({ indexURL: pyodidePath ?? sources.pyodideIndex })
  console.log(`boot                 ${(performance.now() - t0).toFixed(0)} ms`)
  return py
}

/** Read a file under the repo root — the `.py` a probe is about to run, in practice. */
export function readRepoFile(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

/**
 * A failure tally and the two ways a probe records one.
 *
 * `check` states an expectation; `attempt` wraps a call so a Python exception surfaces as its
 * last few traceback lines rather than as the whole minified Pyodide bundle, which is not
 * something anyone reads, least of all in CI.
 */
export function probeReport() {
  let failures = 0
  return {
    check(what, ok) {
      if (!ok) {
        failures += 1
        console.error(`  FAIL  ${what}`)
      }
    },
    attempt(what, fn) {
      try {
        return fn()
      } catch (error) {
        failures += 1
        console.error(`  FAIL  ${what}`)
        for (const line of String(error?.message ?? error)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-6)) {
          console.error(`        ${line}`)
        }
        return undefined
      }
    },
    /** Print the heap, then exit non-zero if anything failed. Never returns. */
    finish(py) {
      console.log(`heap                 ${(py._module.HEAP8.length / 1048576).toFixed(0)} MB`)
      if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`)
        process.exit(1)
      }
      console.log('\nall checks passed')
    },
  }
}
