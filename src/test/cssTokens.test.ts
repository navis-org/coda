/**
 * Every CSS custom property the stylesheets read without a fallback is defined somewhere.
 *
 * An undefined one makes the whole declaration invalid, so the browser drops it in silence — a
 * background that is never drawn, a colour that is merely inherited — and jsdom applies no CSS, so
 * no other test can see it. Review Suggestions' row backgrounds named a `--surface-raised` no theme
 * had, and the hover highlight built on them showed nothing (user, 2026-11-19).
 *
 * "Defined" is read generously: a declaration in any stylesheet or page, or a name set from code
 * (a style object's key, `setProperty`). A name set only at run time from a computed string would
 * be missed; none is, today.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')

function filesUnder(dir: string, ends: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && ends.some((end) => entry.name.endsWith(end)))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('the stylesheets', () => {
  it('read no custom property that nothing defines', () => {
    const sheets = filesUnder(join(ROOT, 'src'), ['.css'])
    // Not the tests, which name properties in their prose.
    const code = filesUnder(join(ROOT, 'src'), ['.ts', '.tsx']).filter(
      (file) => !/\.test\.tsx?$/.test(file),
    )
    const pages = readdirSync(ROOT)
      .filter((name) => name.endsWith('.html'))
      .map((name) => join(ROOT, name))
    const defined = new Set<string>()
    // A declaration: in a stylesheet, or a `style` attribute in a page or in markup built in code.
    for (const file of [...sheets, ...pages, ...code]) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]!)
    }
    // From code, too: a style object's key, or `setProperty`.
    for (const file of code) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(match[1]!)
      for (const match of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)['"`]/g)) {
        defined.add(match[1]!)
      }
    }
    const undefinedUses: string[] = []
    for (const file of sheets) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!defined.has(match[1]!))
          undefinedUses.push(`${match[1]} in ${file.slice(ROOT.length + 1)}`)
      }
    }
    expect(undefinedUses).toEqual([])
  })
})
