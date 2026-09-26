/**
 * The changelog's tripwires.
 *
 * The page is a static document, so nothing in the app fails when an entry goes wrong — a demo
 * link naming a node that was renamed opens the wrong workflow or none, an image that was never
 * captured is a broken icon, and a markdown `summary` shows its asterisks in the What's New card,
 * which renders none. Each of those is checked here against the table, because the table is where
 * somebody writing an entry will make the mistake.
 *
 * Layout is not asserted, the standing rule for these documents: the timeline's marker and its
 * phone form are geometry, which jsdom does not do.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import '../nodes'
import { registerBuiltinSources } from '../data/builtins'
import { getNodeDef } from '../core/registry'
import { demoFragment, parseShareFragment } from '../data/share/fragment'
import { useGraphStore } from '../store/graphStore'
import { CURATED, isSynthetic } from '../wizard/curated'
import { demoGraph } from '../wizard/demo'
import { DAY_MS } from './dates'
import { CHANGELOG, type ChangelogEntry } from './entries'
import { CAPTURE_DENSITY, depictsCard, thumbFile } from './images'
import { changelogHTML, imageSize, timelineSpan } from './render'

registerBuiltinSources()

const HTML = readFileSync(new URL('../../changelog.html', import.meta.url), 'utf8')
const DATE = /^\d{4}-\d{2}-\d{2}$/

const changes = (e: ChangelogEntry) => [...(e.features ?? []), ...(e.items ?? [])]
// Every demo is on a feature or an item; a capture is taken on its own feature's demo.
const demos = CHANGELOG.flatMap((e) => changes(e).flatMap((c) => (c.demo ? [c.demo] : [])))

describe('the changelog table', () => {
  it('is newest first, one entry per date', () => {
    const dates = CHANGELOG.map((e) => e.date)
    for (const d of dates) expect(d).toMatch(DATE)
    expect(dates).toEqual([...dates].sort().reverse())
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('dates every change on or before its entry', () => {
    for (const e of CHANGELOG) {
      for (const c of changes(e)) {
        expect(c.date, `${e.date}: ${c.title}`).toMatch(DATE)
        expect(c.date <= e.date, `${e.date}: ${c.title} is dated after its entry`).toBe(true)
      }
    }
  })

  /* The What's New card renders `summary` as text, so markdown would show its punctuation. */
  it('keeps every summary plain text', () => {
    for (const e of CHANGELOG) expect(e.summary, e.date).not.toMatch(/[*`[\]]/)
  })

  it('has an image on disk for every image it names', () => {
    for (const e of CHANGELOG) {
      for (const f of e.features ?? []) {
        if (!f.image) continue
        const file = new URL(`../../public/changelog/${f.image.file}`, import.meta.url)
        expect(
          existsSync(file),
          `${f.image.file} is missing — run \`pnpm changelog:shots\`, or add it by hand`,
        ).toBe(true)
        expect(f.image.alt.length, `${f.image.file} needs alt text`).toBeGreaterThan(0)
      }
    }
  })

  /* The What's New card draws thumbnails, which the capture script writes beside each image. */
  it('has a thumbnail beside every captured image the card can show', () => {
    for (const e of CHANGELOG) {
      for (const f of e.features ?? []) {
        if (!f.image?.capture || depictsCard(f.image.capture)) continue
        const thumb = new URL(
          `../../public/changelog/${thumbFile(f.image.file)}`,
          import.meta.url,
        )
        expect(
          existsSync(thumb),
          `${thumbFile(f.image.file)}: run \`pnpm changelog:shots\``,
        ).toBe(true)
      }
    }
  })

  /*
   * A malformed plan is dropped without a word by `parseShareFragment` and a plan that no longer
   * builds by `demoGraph`, both deliberately — so a typo here would open *some* workflow rather
   * than fail. Hence the plan is asserted to survive the parse, and the build to contain the node.
   */
  it.each(demos)('opens demo %s', (demo) => {
    const ref = parseShareFragment(demoFragment(demo))
    if (ref.kind !== 'demo') throw new Error(`${demo} is not a demo link`)
    expect(getNodeDef(ref.type), `${ref.type} is not a registered node`).toBeDefined()
    if (demo.split('/').length > 1)
      expect(ref.plan, `${demo}: the plan did not parse`).toBeDefined()
    const graph = demoGraph(ref.type, ref.plan)
    expect(graph?.nodes.some((n) => n.type === ref.type)).toBe(true)
  })

  // A demo on real data is one the node guide and `?` open too, curated on a published dataset.
  it('takes a capture needing a sign-in only on a demo curated on a published dataset', () => {
    for (const e of CHANGELOG) {
      for (const f of e.features ?? []) {
        if (!f.image?.capture?.signIn) continue
        const spec = CURATED.find((c) => f.demo && c.types.includes(f.demo))
        expect(spec && !isSynthetic(spec), f.title).toBe(true)
      }
    }
  })

  it('captures only with things that exist', () => {
    const state = useGraphStore.getState() as unknown as Record<string, unknown>
    for (const e of CHANGELOG) {
      for (const f of e.features ?? []) {
        const c = f.image?.capture
        if (!c) continue
        if (c.expand) expect(getNodeDef(c.expand), c.expand).toBeDefined()
        for (const p of c.params ?? []) {
          const def = getNodeDef(p.type)
          expect(def, p.type).toBeDefined()
          expect(
            def?.params?.some((d) => d.id === p.param),
            `${p.type}.${p.param}`,
          ).toBe(true)
        }
        if (c.open) expect(typeof state[c.open], `store action ${c.open}`).toBe('function')
      }
    }
  })
})

describe('the rendered page', () => {
  const body = changelogHTML()

  it('has a section, a dot and a tick for everything in the table', () => {
    for (const e of CHANGELOG) {
      expect(body).toContain(`<section class="release" id="${e.date}"`)
      expect(body).toContain(`class="axis__entry" href="#${e.date}"`)
    }
    const ticks = body.match(/class="axis__tick"/g)?.length ?? 0
    expect(ticks).toBe(CHANGELOG.flatMap(changes).length)
    expect(body).not.toContain('undefined')
  })

  /*
   * Without its size an image draws at its file's pixel size — twice too large for a capture —
   * and the page grows under the timeline's marker as it loads.
   */
  it('gives every WebP or PNG image its display size', () => {
    for (const e of CHANGELOG) {
      for (const f of e.features ?? []) {
        if (!f.image || !/\.(webp|png)$/.test(f.image.file)) continue
        const size = imageSize(f.image.file)
        expect(size, `${f.image.file}: header not read`).toBeDefined()
        const w = Math.round(size!.width / (f.image.capture ? CAPTURE_DENSITY : 1))
        expect(body).toContain(`${f.image.file}" width="${w}"`)
      }
    }
  })

  /* A rename of the entry script builds green and serves a page with no marker and no filter. */
  it('is spliced into its own page, which loads its own script', () => {
    expect(HTML).toContain('<!--@changelog-->')
    expect(HTML).toContain('src="/src/changelog/main.ts"')
    expect(HTML).not.toContain('/src/main.tsx')
  })

  const entry = (date: string, kinds: ChangelogEntry['items']): ChangelogEntry => ({
    date,
    title: `Update ${date}`,
    summary: 'Something changed.',
    highlight: false,
    items: kinds,
  })

  it('stacks a busy day sideways and offers a filter only when there is a choice', () => {
    const one = changelogHTML([
      entry('2026-10-02', [
        { kind: 'node', date: '2026-10-01', title: 'A' },
        { kind: 'node', date: '2026-10-01', title: 'B' },
      ]),
    ])
    expect(one).toMatch(/--row:1"/)
    expect(one).not.toContain('class="filters"')

    const two = changelogHTML([
      entry('2026-10-02', [
        { kind: 'node', date: '2026-10-01', title: 'A' },
        { kind: 'changed', date: '2026-10-02', title: 'B' },
      ]),
    ])
    expect(two).toContain('class="filters"')
    expect(two).toContain('data-f="changed"')
    expect(two).not.toContain('data-f="chart"')
  })

  it('spans at least a fortnight, so a lone entry is not a dot on a bar of nothing', () => {
    const { start, end } = timelineSpan([entry('2026-10-02', [])])
    expect((end - start) / DAY_MS).toBeGreaterThanOrEqual(14)
  })
})
