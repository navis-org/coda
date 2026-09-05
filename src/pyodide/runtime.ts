/**
 * The Python side: booted once, called many times.
 *
 * Imported by the worker and by nothing else — `engine.ts` is the seam the rest of the app
 * uses. The split is `layout/engine.ts`'s: orchestration (which thread, which request, what
 * Cancel does) apart from the thing being run.
 *
 * **Nothing here is in the bundle's dependency graph at rest.** Pyodide is fetched from a CDN
 * at first use and is not an npm dependency, so `pnpm build` never sees it and the main chunk
 * does not move. What a first Run costs, measured against Pyodide 314.0.5:
 *
 * | | raw | over the wire |
 * | --- | --- | --- |
 * | `pyodide.asm.wasm` | 9.6 MB | 3.44 MB |
 * | `python_stdlib.zip` | 2.5 MB | 2.5 MB |
 * | numpy | 2.92 MB | 2.92 MB |
 * | **navis-fastcore** | **1.10 MB** | **1.10 MB** |
 *
 * About ten megabytes, **of which the algorithm is one** — nine tenths is CPython and numpy.
 * That is the number to have in mind before the first Python-backed node, and equally the
 * reason every one after it is nearly free: this instance is a module-level singleton, so a
 * second capability pays a `runPython` of its own file plus whatever packages it declares that
 * are not already installed — nothing for one that also wants numpy and fastcore. Measured:
 * the 387 ms `nblast.py` takes is almost entirely its `import numpy` / `import navis_fastcore`,
 * which a second module does not repeat.
 *
 * **The wheel tag is not Pyodide-specific.** `pyemscripten_2026_0_wasm32` is the emscripten ABI
 * tag and Pyodide 314.x's lock declares `abi_version: 2026_0`. They match today; a Pyodide bump
 * that moves the ABI needs a wheel built against it, which is why `sources.json` pins both.
 */

import LINKAGE_PY from './linkage.py?raw'
import MATCHES_PY from './matches.py?raw'
import MESHES_PY from './meshes.py?raw'
import NBLAST_PY from './nblast.py?raw'
import SKELETONS_PY from './skeletons.py?raw'
import TOPOLOGY_PY from './topology.py?raw'
import WARP_PY from './warp.py?raw'
import sources from './sources.json'
import type { PyArg, PyResult } from './types'

/** How far along, and what is happening. Both halves reach the node's status bar. */
type Report = (fraction: number, note?: string) => void

/**
 * Every Python file this app can run, and what each needs installed.
 *
 * The **packages belong to the module, not to the boot**. `boot()` loading numpy and a 1.1 MB
 * fastcore wheel unconditionally would be right only for as long as every capability happens
 * to want exactly those: the next one needing scipy would edit the boot, and one needing
 * neither would pay for the wheel. Here a capability declares its own, and a module nothing
 * calls costs nothing.
 *
 * Sources are imported statically rather than dynamically: they are a few kilobytes of text
 * each and all live in the worker chunk anyway, so a dynamic import would code-split something
 * already off the main thread and off the main bundle.
 */
interface PyModule {
  source: string
  /** Package names Pyodide resolves from its own lock, or a wheel URL. */
  packages: string[]
  /** What to call the download in the node's status bar. */
  label: string
}

const MODULES: Record<string, PyModule> = {
  nblast: {
    source: NBLAST_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  // The same two packages, which is what makes this one nearly free once NBLAST has run:
  // `loadPackage` is a no-op for what is already installed, so all a second module costs then
  // is `runPython` of its own definitions. It still declares them rather than leaning on the
  // first — a graph that clusters an Adjacency matrix never touches NBLAST at all.
  linkage: {
    source: LINKAGE_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  // The third, and the same two packages again — `TpsTransform` is in the wheel Coda already
  // pins, so a mirror on a runtime that has scored anything costs a `runPython` of one file.
  warp: {
    source: WARP_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  /*
   * Three more, and the same two packages every time — which by now is the finding rather
   * than a coincidence. Everything Coda asks Python for lives in one 1.1 MB wheel, so the
   * download that a first NBLAST pays is the download for all of them, and the table below
   * is seven identical rows because a capability that declared *fewer* packages would still
   * pay the same first-use cost the moment anything else in the graph needed the wheel.
   *
   * They stay six rows rather than becoming one shared constant: `MODULES` is the place a
   * reader looks to find out what a given node downloads, and an indirection there would
   * answer that question with a variable name.
   */
  skeletons: {
    source: SKELETONS_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  meshes: {
    source: MESHES_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  matches: {
    source: MATCHES_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
  // The seventh, and the same two packages — which by now is load-bearing rather than merely
  // repeated: Neuron Topology shows its cheap morphometrics with no Python at all, so the wheel
  // is downloaded only when somebody asks for the axon/dendrite split, and on a graph that has
  // already cleaned or NBLASTed anything it is not downloaded then either.
  topology: {
    source: TOPOLOGY_PY,
    packages: ['numpy', sources.fastcoreWheel],
    label: `numpy · navis-fastcore ${sources.fastcoreVersion}`,
  },
}

/*
 * Just enough of Pyodide's surface to call it, hand-written rather than depending on the
 * package for its types. Adding `pyodide` to package.json for `.d.ts` files alone would put a
 * 13 MB dependency in every install of a project that never imports it.
 */
interface PyProxy {
  (...args: unknown[]): PyProxy
  toJs(options?: {
    dict_converter?: (entries: Iterable<[string, unknown]>) => unknown
  }): unknown
  destroy(): void
}

interface PyodideApi {
  loadPackage(
    names: string | string[],
    options?: { messageCallback?: (message: string) => void },
  ): Promise<unknown>
  runPython(code: string): unknown
  globals: { get(name: string): PyProxy | undefined }
}

interface PyodideModule {
  loadPyodide(options: { indexURL: string }): Promise<PyodideApi>
}

let bootPromise: Promise<PyodideApi> | undefined
const loaded = new Set<string>()

async function boot(report: Report): Promise<PyodideApi> {
  if (!bootPromise) {
    bootPromise = (async () => {
      report(0.02, 'starting Python')
      /*
       * Through a variable and `@vite-ignore`, and for the same reason `layout/engine.ts`
       * spells its bundled-elk fallback that way: written as a literal, rollup resolves the
       * specifier at build time. Here it would try to resolve an https URL and fail the build
       * outright. The import is for the browser to make, at run time, from the CDN.
       */
      const specifier = `${sources.pyodideIndex}pyodide.mjs`
      const { loadPyodide } = (await import(/* @vite-ignore */ specifier)) as PyodideModule
      return loadPyodide({ indexURL: sources.pyodideIndex })
    })().catch((error: unknown) => {
      // Don't cache a failed boot: a chunk that failed to fetch once would otherwise make
      // every later run fail for the rest of the session. Same rule as the ELK engine.
      bootPromise = undefined
      throw error
    })
  }
  return bootPromise
}

/** Where the boot ends and the called function's own progress begins. */
const BOOT_SHARE = 0.22

/**
 * Call a Python function, loading its module if this is the first time.
 *
 * `report` is appended as the **last positional argument**, so every callable declares it —
 * `report=None` where it has nothing to say. A keyword would read better and would rest on
 * `callKwargs`, which is one more piece of Pyodide's surface to depend on for no gain.
 *
 * Every proxy taken here is released here. A `PyProxy` is a reference into the wasm heap and
 * the two garbage collectors cannot see each other, so a dropped one leaks until the tab
 * closes — and these are nodes somebody re-runs while sliding a parameter. The *result* needs
 * no such care: `toJs` copies out of the heap, which was checked rather than assumed.
 */
export async function callPython(
  module: string,
  fn: string,
  args: PyArg[],
  report: Report,
): Promise<PyResult> {
  const py = await boot(report)

  if (!loaded.has(module)) {
    const spec = MODULES[module]
    if (!spec) throw new Error(`No Python module called "${module}"`)
    report(0.1, spec.label)
    // One call, not one per package: these come from two different hosts, so awaited in turn
    // the second request's DNS, TLS and slow-start all wait on the first transfer finishing —
    // 2.9 MB and 1.1 MB, on the one path where the whole ten megabytes is already being paid.
    await py.loadPackage(spec.packages, { messageCallback: () => {} })
    py.runPython(spec.source)
    loaded.add(module)
  }

  const callable = py.globals.get(fn)
  if (!callable) throw new Error(`Python module "${module}" defines no "${fn}"`)

  let out: PyProxy | undefined
  try {
    out = callable(...args, (fraction: number, note?: string) => {
      report(BOOT_SHARE + (1 - BOOT_SHARE) * fraction, note)
    })
    return out.toJs({ dict_converter: Object.fromEntries }) as PyResult
  } finally {
    out?.destroy()
    callable.destroy()
  }
}
