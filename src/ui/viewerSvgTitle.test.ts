/**
 * A source rule over every viewer in `src/ui`, kept at the root of the folder it sweeps rather than
 * inside `ui/viewers/` beside the tooltip it protects (`viewers/tooltipPoint.ts`).
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SRC, sourceFiles } from '../test/importGraph'

/**
 * The rule the hover card needs the *other* viewers to keep.
 *
 * A `<title>` that is a direct child of `<svg>` is a native browser tooltip over the whole
 * drawing, so it opens on top of the `chart-tooltip` that says what the pointer is actually on.
 * Every viewer under `src/ui` carries `aria-label` instead — the same accessible name, no tooltip — and
 * `serializeSvg` turns that back into a `<title>` for the exported file.
 *
 * Read off the **source** rather than by mounting nine charts, which is `help.test.ts`' approach
 * to a rule that lives in how a file is written: what has to hold is that nobody types the thing
 * again, and a tenth viewer would otherwise regress this silently — the symptom is a tooltip
 * covering another tooltip, which no assertion about rendered output would think to look for.
 *
 * The window is textual and deliberately generous. A per-mark `<title>` is a different thing and
 * is wanted — `DendrogramViewer` puts one on a renamed leaf and `Tiles` on a pie slice — and both
 * sit far from their `<svg>` tag, where this does not reach.
 */
describe('a chart names itself with aria-label, never a root <title>', () => {
  // Every viewer under `src/ui`, so a pack's own viewer (`ui/vfb/`, `ui/cortex/`) is swept too.
  const ui = join(SRC, 'ui')
  const files = sourceFiles(ui)
    .filter((path) => path.endsWith('Viewer.tsx'))
    .map((path) => [relative(ui, path), readFileSync(path, 'utf-8')])

  it('finds the viewers to check, so a rename cannot empty this sweep', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  // `it.each` spreads each row into the parameters, so the source travels with the name rather
  // than being looked back up out of the list it was just mapped off.
  it.each(files)('%s opens no <title> on its svg root', (_name, source) => {
    for (let at = source.indexOf('<svg'); at >= 0; at = source.indexOf('<svg', at + 1)) {
      expect(source.slice(at, at + 400)).not.toContain('<title>')
    }
  })

  it.each(files)('%s gives its svg root an accessible name', (_name, source) => {
    // Only the roots that claim to be an image: `PersistentCanvas` and the WebGL viewers mount a
    // `<canvas>`, and a decorative `<svg>` in a legend is not something to name.
    for (
      let at = source.indexOf('role="img"');
      at >= 0;
      at = source.indexOf('role="img"', at + 1)
    ) {
      expect(source.slice(Math.max(0, at - 400), at + 400)).toContain('aria-label')
    }
  })
})
