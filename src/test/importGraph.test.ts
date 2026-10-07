/**
 * The import boundaries, followed all the way rather than one file deep.
 *
 * `eslint.config.js`' `no-restricted-imports` matches a *direct* import, and every property it
 * protects is transitive. That gap was not hypothetical: the assistant's `digest.ts` reuses
 * `describeTable`, and `describeOps` reached `ui/viewers/boxStats` for `quantileSorted`, which
 * reaches `ui/colors` — three files deep, lint clean, property false. And a Web Worker's graph
 * once reached the Pyodide engine twice over through a units sentence and a constant, which no
 * lint rule here even asks about.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SRC, reach, resolveImport, sourceFiles } from './importGraph'

/**
 * Every directory `eslint.config.js` holds headless. Checked against that file below, so a
 * directory added there is walked here — the list had fallen two behind (`umap`, `mcp`) while it
 * lived in the assistant's tests.
 */
const HEADLESS = ['assistant', 'core', 'data', 'layout', 'mcp', 'pyodide', 'umap']

/**
 * Two chains already in the tree when `src/mcp` joined this walk, both value imports out of
 * `src/mcp`'s Node build into `src/ui`. They are listed rather than allowed, so the next one fails
 * and these stay in view until each is moved out of `ui/` — `parseMarkdown` and `clusterColor`.
 */
const KNOWN_OFFENDERS = [
  'mcp/index.ts → help/registry.ts → ui/markdown.ts',
  'mcp/index.ts → nodes/index.ts → nodes/output/dendrogram.ts → ui/encoding.ts',
]

const isUiOrStore = (path: string) => path.startsWith('ui/') || path.startsWith('store/')

/**
 * Every Web Worker entry, found the bundler's way — the file a `new Worker(new URL('…'))` names —
 * rather than by a naming convention nothing enforces.
 */
const WORKERS = [
  ...new Set(
    sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/new Worker\(\s*new URL\(\s*'([^']+)'/g)].flatMap(
        ([, spec]) => resolveImport(file, spec!) ?? [],
      ),
    ),
  ),
]

describe('the headless boundary', () => {
  it('walks every directory the lint rule names', () => {
    const config = readFileSync(join(SRC, '../eslint.config.js'), 'utf8')
    const linted = [...config.matchAll(/'src\/(\w+)\/\*\*\/\*\.ts'/g)].map(([, dir]) => dir!)
    expect([...new Set(linted)].sort()).toEqual(HEADLESS)
  })

  it('reaches no UI or store module, at any depth, from any headless area', () => {
    const { offenders, visited } = reach(
      HEADLESS.flatMap((area) => sourceFiles(join(SRC, area))),
      isUiOrStore,
      { typeImports: true },
    )
    expect(offenders, 'no headless area may reach the UI or the store').toEqual(KNOWN_OFFENDERS)
    // A walk that visited almost nothing would pass for the wrong reason.
    expect(visited, 'the walk actually followed the import graph').toBeGreaterThan(150)
  })
})

/*
 * A worker has no DOM and no store, and only the Pyodide worker may run Python: a value import of
 * `src/pyodide` anywhere in another worker's graph puts the Pyodide engine — which spawns a worker
 * of its own — into that bundle. Type imports are erased, so they are not followed.
 */
describe('worker import graphs', () => {
  it('finds the workers', () => {
    expect(WORKERS).toContain(join(SRC, 'nodes/lib/arborDaylight.worker.ts'))
    expect(WORKERS).toContain(join(SRC, 'pyodide/worker.ts'))
  })

  it('follows the graph it is asked about, or every check below would pass for nothing', () => {
    const daylight = join(SRC, 'nodes/lib/arborDaylight.worker.ts')
    const { offenders } = reach([daylight], (path) => path === 'nodes/lib/arborOps.ts', {
      typeImports: false,
    })
    expect(offenders).toEqual([
      'nodes/lib/arborDaylight.worker.ts → nodes/lib/arborDaylight.ts → nodes/lib/arborLayout.ts → nodes/lib/arborOps.ts',
    ])
  })

  it.each(WORKERS.map((file) => [file.slice(SRC.length), file]))(
    '%s reaches no UI, store or (outside src/pyodide) Python module',
    (rel, file) => {
      const ownsPython = rel.startsWith('pyodide/')
      const { offenders, visited } = reach(
        [file],
        (path) => isUiOrStore(path) || (!ownsPython && path.startsWith('pyodide/')),
        { typeImports: false },
      )
      expect(offenders).toEqual([])
      expect(visited).toBeGreaterThan(1)
    },
  )
})
