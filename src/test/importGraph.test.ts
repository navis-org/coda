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
 * Every directory `eslint.config.js` holds headless, read off that file's boundary block rather
 * than copied, so a directory added there is walked here — a copied list had fallen two behind.
 */
const HEADLESS = (() => {
  const config = readFileSync(join(SRC, '../eslint.config.js'), 'utf8')
  const block = config.slice(config.indexOf('The architectural boundary'))
  const files = block.slice(block.indexOf('files: ['), block.indexOf('],'))
  return [...files.matchAll(/'src\/(\w+)\/\*\*\/\*\.ts'/g)].map(([, dir]) => dir!)
})()

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
  it('reaches no UI or store module, at any depth, from any headless area', () => {
    const { offenders, visited } = reach(
      HEADLESS.flatMap((area) => sourceFiles(join(SRC, area))),
      isUiOrStore,
      { typeImports: true },
    )
    expect(offenders, 'no headless area may reach the UI or the store').toEqual([])
    // A walk that visited almost nothing would pass for the wrong reason.
    expect(visited, 'the walk actually followed the import graph').toBeGreaterThan(150)
  })
})

/*
 * `src/style` reads a node's param vocabulary (`encodingParams`, `heatmapParams`), so the edge
 * has to run one way: a `nodes/lib` module reaching `src/style` closes a loop, and puts the whole
 * palette under every node's arithmetic. Anything outside `nodes/lib` may use it — the
 * Dendrogram's leaf colours.
 */
describe('the layer below src/style', () => {
  it('reaches no src/style module from nodes/lib, at any depth', () => {
    const entries = sourceFiles(join(SRC, 'nodes/lib'))
    const { offenders, visited } = reach(entries, (path) => path.startsWith('style/'), {
      typeImports: true,
    })
    expect(offenders).toEqual([])
    // Beyond its own entry files, or a walk following no import at all would pass.
    expect(visited, 'the walk followed the import graph').toBeGreaterThan(entries.length)
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

/*
 * The chunkedgraph writer is reachable only through the modules named here
 * (`docs/seam-merge-plan.md`, phases 2 and 5): a second importer is a second way to write to a
 * shared segmentation, and it fails here rather than in review. Tests are not walked
 * (`sourceFiles` skips them); `src/test/writeGuard.ts` is their guard. The sandbox merge test,
 * `scripts/probe-cave-merge.mjs`, imports it from `scripts/`, where this does not look; what holds
 * that script to the sandbox is `src/test/sandboxWrites.ts`' fence.
 *
 * **Three levels per path, one check.** Each way to write is a chain (`CHAINS`): the writer may be
 * imported by the chains' first modules alone, each of those by its own chain's second alone, and
 * that by its own chain's openers alone — a value import of the batch, or of the session that
 * starts one, is a way to write too, one step further out each. Per chain, so one path's opener
 * cannot reach the other's session unnoticed.
 * The walk follows value imports only, since a type import cannot send anything. The string search
 * beside it is stricter — any literal naming the file, a type import's included — which is why the
 * overlay's `MergeProgress` lives in the read-only `mergeRecord.ts`, not beside the batch.
 */
const WRITER = 'data/cave/edits.ts'

interface WriteChain {
  /** May import the writer. Adding a chain is adding a way to write. */
  readonly writes: string
  /** May import `writes`: the session that starts a write. */
  readonly starts: string
  /** May import `starts`. */
  readonly opens: readonly string[]
  /** A test importing each, proving the walk sees an importer where there is one. */
  readonly canaries: readonly [string, string]
}

const CHAINS: readonly WriteChain[] = [
  // Merges: the batch, the review card's Submit session (phase 6), its overlay and card.
  {
    writes: 'packs/seam/mergeBatch.ts',
    starts: 'ui/seam/mergeSession.ts',
    opens: ['ui/seam/MergeSubmitHost.tsx', 'ui/seam/ReviewBody.tsx'],
    canaries: ['packs/seam/mergeBatch.test.ts', 'ui/seam/mergeSession.test.ts'],
  },
  // Splits (`docs/split-gallery-plan.md`, phase 4): the write, Accept, the gallery's overlay.
  {
    writes: 'packs/seam/splitWrite.ts',
    starts: 'ui/seam/splitAccept.ts',
    opens: ['ui/seam/SplitGalleryHost.tsx'],
    canaries: ['packs/seam/splitWrite.test.ts', 'ui/seam/splitAccept.test.ts'],
  },
]

/** Each file's text, comments aside, read once for every level below. */
const texts = new Map<string, string>()
const textOf = (rel: string): string => {
  let text = texts.get(rel)
  if (text === undefined) {
    text = withoutComments(readFileSync(join(SRC, rel), 'utf8'))
    texts.set(rel, text)
  }
  return text
}

describe.each([
  {
    level: 'the writer',
    targets: [WRITER],
    allowed: CHAINS.map((chain) => chain.writes),
    canary: 'data/cave/edits.test.ts',
  },
  ...CHAINS.flatMap((chain) => [
    {
      level: chain.writes,
      targets: [chain.writes],
      allowed: [chain.starts],
      canary: chain.canaries[0],
    },
    {
      level: chain.starts,
      targets: [chain.starts],
      allowed: chain.opens,
      canary: chain.canaries[1],
    },
  ]),
])('the chunkedgraph writer, through $level', ({ targets, allowed, canary }) => {
  const isTarget = (path: string) => targets.includes(path)
  /** A string literal naming any target's file. */
  const names = targets.map((path) => path.split('/').at(-1)!.replace(/\.ts$/, ''))
  const NAMES = new RegExp(`['"\`][^'"\`\\n]*/(?:${names.join('|')})(?:\\.[jt]s)?['"\`]`)

  it('is imported by no module but the ones allowed to', () => {
    const entries = sourceFiles(SRC).filter((file) => !isTarget(file.slice(SRC.length)))
    const { offenders, visited } = reach(entries, isTarget, { typeImports: false })
    // Each offender is a chain ending at a target; the module before it is the importer.
    const importers = offenders.map((chain) => chain.split(' → ').at(-2)!)
    expect(importers.filter((file) => !allowed.includes(file))).toEqual([])
    expect(visited, 'the walk covered the source tree').toBeGreaterThan(500)
  })

  /*
   * The walk reads the specifiers Prettier writes. Anything it cannot read — a double-quoted or
   * template-literal specifier, one built at run time from a literal ending in the file's name —
   * is caught here instead: any string literal naming a target, comments aside, in any module but
   * the targets and the ones allowed to import them.
   */
  it('is named by no string the walk cannot read either', () => {
    const named = sourceFiles(SRC)
      .map((file) => file.slice(SRC.length))
      .filter((rel) => !isTarget(rel) && !allowed.includes(rel))
      .filter((rel) => NAMES.test(textOf(rel)))
    expect(named).toEqual([])
  })

  it('names the importer where there is one, or the checks above pass for nothing', () => {
    const { offenders } = reach([join(SRC, canary)], isTarget, { typeImports: false })
    expect(offenders).toEqual([`${canary} → ${canary.replace('.test.ts', '.ts')}`])
    expect(NAMES.test(textOf(canary)), 'the string search finds the canary’s import').toBe(true)
  })
})

describe('the comment stripper the string search reads through', () => {
  it('takes a /* inside a string for text, not for a comment hiding the code after it', () => {
    const source =
      "const g = 'src/**/*.ts'\nimport('../data/cave/edits')\nconst h = '*/' // gone"
    expect(withoutComments(source)).toContain("'../data/cave/edits'")
    expect(withoutComments(source)).not.toContain('gone')
    expect(withoutComments("a /* x 'edits' */ b")).toBe('a  b')
  })
})

/**
 * Source text without its comments. A scan, not two regular expressions, so that a `/*` or `//`
 * inside a string (a glob, a URL) is left alone rather than taken for a comment that swallows the
 * code after it — and, with it, a literal naming the writer. Strings and template literals are
 * kept whole; a `${…}` inside a template is kept as text. Regex literals and JSX text are not
 * parsed, so a quote there can pair wrongly — rare, and the walk above is the primary check.
 */
function withoutComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}
