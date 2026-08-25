/**
 * The half of a Pyodide probe that is not about the capability being probed.
 *
 * Each `probe-*.mjs` runs one `src/pyodide/*.py` against the real navis-fastcore wheel, and
 * each needs the same handful of things before it can: find Pyodide, boot it, load the module,
 * seed a reproducible fixture, count failures, and exit on the tally. Only the request shapes
 * and the assertions differ, and those stay in the scripts.
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
 * Install a capability's packages and run its `.py`, with both timings.
 *
 * The fifth thing every probe needs, and it arrived the way the header describes the other
 * four arriving: five scripts had these seven lines, written by copying whichever one was
 * nearest. `probe-nblast.mjs` deliberately keeps its own two `loadPackage` calls, because
 * timing numpy and the wheel apart is one of the things it reports.
 *
 * `messageCallback` is silenced rather than left to Pyodide's default, which prints a line per
 * wheel and buries the probe's own output in CI.
 */
export async function loadModule(py, relative, packages = ['numpy', sources.fastcoreWheel]) {
  let t = performance.now()
  await py.loadPackage(packages, { messageCallback: () => {} })
  console.log(`packages             ${(performance.now() - t).toFixed(0)} ms`)

  t = performance.now()
  py.runPython(readRepoFile(relative))
  console.log(`${relative.split('/').pop().padEnd(20)} ${(performance.now() - t).toFixed(0)} ms`)
}

/**
 * A reproducible stream of numbers in `[0, 1)`, seeded.
 *
 * Six copies of this LCG had accumulated across the probes, each with its own `- 0.5` or `* 4`
 * inlined. The scaling stays at the call site — that part genuinely differs — and what is
 * shared is the one thing that must not: these probes pin assertions to specific fixtures, so
 * "reproducible" has to mean the same thing in all of them.
 */
export function lcg(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
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
