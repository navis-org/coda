/**
 * Which modules a set of entry files reaches through relative imports, at any depth — for the
 * boundary tests, since `eslint.config.js`' `no-restricted-imports` is per file and every boundary
 * here is transitive (`src/assistant` reaching `src/ui` three files deep was lint clean).
 *
 * One walk for every boundary test, because the copies drifted: one followed dynamic `import()`
 * and `.tsx` and the other did not, so the weaker one would have passed an
 * `await import('../pyodide/…')` that the stronger one exists to catch.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `src/`, with its trailing slash, as an absolute path. */
export const SRC = new URL('..', import.meta.url).pathname

/** Every non-test `.ts`/`.tsx` file under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(path)
  }
  return out
}

/*
 * A static import or re-export (its specifier list held to identifiers, braces and commas, so the
 * match cannot run on through a function body), a bare side-effect import, and a dynamic one —
 * a live idiom here, the assistant drawer loading `converse.ts` that way on purpose.
 */
const STATIC = /^\s*(?:import|export)\s+(type\s+)?[\w$*{},\s]*?\bfrom\s+'([^']+)'/gm
const BARE = /^\s*import\s+'([^']+)'/gm
const DYNAMIC = /import\(\s*'([^']+)'\s*\)/g

/** The file a relative specifier names, or undefined for a package or a non-source file. */
export function resolveImport(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = join(dirname(from), spec.replace(/\?.*$/, ''))
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ].find((c) => /\.tsx?$/.test(c) && existsSync(c))
}

export interface Reach {
  /** One line per import of a forbidden module: the chain to it, `src`-relative. */
  readonly offenders: string[]
  /** How many modules the walk visited — a walk that saw almost nothing passes for no reason. */
  readonly visited: number
}

/**
 * Walk from `entries`, reporting each module whose `src`-relative path `forbidden` refuses.
 * `typeImports: false` does not follow `import type`, which is erased at build — right for a
 * question about what a bundle *runs*, wrong for one about what a module may know of.
 */
export function reach(
  entries: readonly string[],
  forbidden: (relative: string) => boolean,
  options: { typeImports: boolean },
): Reach {
  const seen = new Set<string>()
  const offenders: string[] = []
  const walk = (file: string, trail: readonly string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    const rel = file.slice(SRC.length)
    const source = readFileSync(file, 'utf8')
    const specs: string[] = []
    for (const [, type, spec] of source.matchAll(STATIC)) {
      if (options.typeImports || !type) specs.push(spec!)
    }
    for (const [, spec] of source.matchAll(BARE)) specs.push(spec!)
    for (const [, spec] of source.matchAll(DYNAMIC)) specs.push(spec!)
    const here = [...trail, rel]
    for (const spec of specs) {
      const next = resolveImport(file, spec)
      if (!next) continue
      // Every edge into a forbidden module is reported, not only the first path to it: a fix that
      // cuts one import leaves the others, and a report naming one hid two more.
      const target = next.slice(SRC.length)
      if (forbidden(target)) offenders.push([...here, target].join(' → '))
      else if (!seen.has(next)) walk(next, here)
    }
  }
  for (const entry of entries) {
    const rel = entry.slice(SRC.length)
    if (forbidden(rel)) offenders.push(rel)
    else walk(entry, [])
  }
  return { offenders, visited: seen.size }
}
