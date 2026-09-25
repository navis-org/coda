/**
 * The changelog, rendered to HTML at build time.
 *
 * `vite/renderedPages.ts` calls `changelogHTML()` in Node and splices the result into
 * `changelog.html` in place of `<!--@changelog-->`, the dataset guide's arrangement and for its
 * reason: a page whose content arrives with the script is a page most crawlers never read. So
 * every entry, the timeline and its ticks are all in the shipped file, and `main.ts` only adds
 * what a document cannot do from markup — the moving marker, the filter, and "new since your
 * last visit".
 *
 * ## The timeline is to scale
 *
 * Each entry is a dot at its date and each change a tick at the day it landed, positioned as a
 * fraction of the span (`--t`, 0 at the newest end) so the stylesheet can lay the same numbers
 * out vertically beside the page or horizontally across a phone. Days that shipped several
 * changes stack their ticks sideways (`--row`), which is what makes a busy day look busy.
 *
 * The span is at least `MIN_SPAN_DAYS`, or a single entry would sit alone at the top of a bar
 * that means nothing; a long history is simply compressed, and `main.ts` thins the labels and
 * the day marks when they stop fitting.
 *
 * The prose helpers are the dataset guide's (`inline`, `paragraphs`, `esc`, `appHref`), imported rather than
 * copied: the link rule inside `inline` is a safety property, and two copies of it drift.
 */

import { readFileSync } from 'node:fs'

import { demoFragment } from '../data/share/fragment'
import { appHref, esc, inline, paragraphs } from '../datasetguide/render'
import { DAY_MS, dayOf, longDate, monthYear, ms, shortDate, shortMonth } from './dates'
import { CAPTURE_DENSITY } from './images'
import {
  CHANGELOG,
  type ChangeKind,
  type ChangelogEntry,
  type ChangelogFeature,
  type ChangelogItem,
} from './entries'

const MIN_SPAN_DAYS = 14
/** Ticks on one day stack sideways up to this slot, then share it, short of the entry labels. */
const MAX_ROW = 5

/** The word on each kind's tag, and on its filter. Shape comes from the stylesheet. */
const KIND_LABEL: Readonly<Record<ChangeKind, { tag: string; filter: string }>> = {
  node: { tag: 'Nodes', filter: 'Nodes' },
  chart: { tag: 'Charts', filter: 'Charts' },
  data: { tag: 'Data', filter: 'Data sources' },
  editor: { tag: 'Editor', filter: 'Editor' },
  changed: { tag: 'Changed', filter: 'Behaviour changes' },
}

/** Markdown down to the words, for a `title` attribute. */
const plain = (md: string): string =>
  md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/[.:]\s*$/, '')

/** Where **Open example** goes: a demo tail is `demoFragment`'s own `type[/plan]` spelling. */
const hrefOf = (c: { demo?: string }): string | undefined =>
  c.demo ? appHref(demoFragment(c.demo)) : undefined

/**
 * The pixel size of a WebP or PNG under `public/changelog/`, or undefined for anything else.
 *
 * Read so the `<img>` can carry its **display** size: captures are taken at twice the density, and
 * a `srcset` saying `2x` is not enough on its own — a browser on an ordinary screen counts the
 * plain `src` as the 1x candidate and draws the file at full size. Width and height attributes
 * also hold the image's box before it loads, which keeps the timeline's marker from being thrown
 * by the page growing under it. Only the header is parsed; this runs in Node at build time.
 */
export function imageSize(file: string): { width: number; height: number } | undefined {
  let b: Buffer
  try {
    b = readFileSync(new URL(`../../public/changelog/${file}`, import.meta.url))
  } catch {
    return undefined
  }
  if (b.toString('ascii', 1, 4) === 'PNG')
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP')
    return undefined
  const chunk = b.toString('ascii', 12, 16)
  if (chunk === 'VP8 ')
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X')
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  return undefined
}

/** A change as the timeline and the filter see it: a kind, a day, and where it is on the page. */
interface Change {
  id: string
  kind: ChangeKind
  date: string
  label: string
}

/** A change's anchor: what its timeline tick links to and what its element carries. */
const changeId = (entry: ChangelogEntry, part: 'f' | 'i', i: number): string =>
  `c-${entry.date}-${part}${i}`

function changesOf(entry: ChangelogEntry): Change[] {
  const of = (part: 'f' | 'i', list: readonly (ChangelogFeature | ChangelogItem)[] = []) =>
    list.map((c, i) => ({
      id: changeId(entry, part, i),
      kind: c.kind,
      date: c.date,
      label: plain(c.title),
    }))
  return [...of('f', entry.features), ...of('i', entry.items)]
}

/** The span the timeline covers, newest end first. */
export function timelineSpan(entries: readonly ChangelogEntry[]): {
  start: number
  end: number
} {
  const dates = entries.flatMap((e) => [e.date, ...changesOf(e).map((c) => c.date)]).map(ms)
  const newest = Math.max(...dates)
  const oldest = Math.min(...dates, newest - (MIN_SPAN_DAYS - 1) * DAY_MS)
  return { start: oldest - DAY_MS, end: newest + DAY_MS }
}

function spanLabel(start: number, end: number): string {
  const a = dayOf(start + DAY_MS)
  const b = dayOf(end - DAY_MS)
  if (a.slice(0, 7) === b.slice(0, 7)) return monthYear(b)
  const year = (d: string) => d.slice(0, 4)
  if (year(a) === year(b)) return `${shortMonth(a)} – ${shortMonth(b)} ${year(b)}`
  return `${shortMonth(a)} ${year(a)} – ${shortMonth(b)} ${year(b)}`
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function timelineHTML(entries: readonly ChangelogEntry[]): string {
  const { start, end } = timelineSpan(entries)
  const t = (date: string) => ((end - ms(date)) / (end - start)).toFixed(4)

  const days: string[] = []
  for (let at = start + DAY_MS; at < end; at += DAY_MS) {
    days.push(`<span class="axis__day" style="--t:${t(dayOf(at))}"></span>`)
  }

  const perDay = new Map<string, number>()
  const ticks = entries.flatMap(changesOf).map((c) => {
    const row = perDay.get(c.date) ?? 0
    perDay.set(c.date, row + 1)
    const label = esc(`${shortDate(c.date)} · ${c.label}`)
    return `<a class="axis__tick" href="#${c.id}" data-for="${c.id}" data-k="${c.kind}" style="--t:${t(c.date)};--row:${Math.min(row, MAX_ROW)}" title="${label}" aria-label="${label}"></a>`
  })

  const dots = entries.map(
    (
      e,
    ) => `<a class="axis__entry" href="#${e.date}" data-for="${e.date}" style="--t:${t(e.date)}">
      <span class="axis__dot"></span>
      <span class="axis__lbl"><time datetime="${e.date}">${shortDate(e.date)}</time><span class="axis__title">${esc(e.title)}</span><span class="axis__new" hidden>New</span></span>
    </a>`,
  )

  return `<aside class="tl" aria-label="Timeline">
    <div class="tl__inner">
      <div class="tl__head">${spanLabel(start, end)}</div>
      <div class="axis" data-days="${days.length}" data-start="${dayOf(start)}" data-end="${dayOf(end)}">
        <div class="axis__line"></div>
        <div class="axis__fill"></div>
        ${days.join('')}
        ${ticks.join('\n')}
        ${dots.join('\n')}
        <div class="axis__here" aria-hidden="true"><b></b></div>
      </div>
      <div class="tl__foot">Each tick is one change, on the day it shipped.</div>
    </div>
  </aside>`
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const tag = (kind: ChangeKind): string =>
  `<span class="tag" data-k="${kind}">${KIND_LABEL[kind].tag}</span>`

function featureHTML(f: ChangelogFeature, id: string): string {
  let figure = ''
  if (f.image) {
    const density = f.image.capture ? CAPTURE_DENSITY : 1
    const size = imageSize(f.image.file)
    const box = size
      ? ` width="${Math.round(size.width / density)}" height="${Math.round(size.height / density)}"`
      : ''
    figure = `<figure class="feature__fig"><img src="./changelog/${esc(f.image.file)}"${box} alt="${esc(f.image.alt)}" loading="lazy" decoding="async"></figure>`
  }
  const href = hrefOf(f)
  const actions = [
    href
      ? `<a class="btn btn--primary" href="${href}" target="_blank" rel="noopener">Open example</a>`
      : '',
    f.link
      ? `<a class="btn" href="${esc(f.link.href)}"${f.link.href.startsWith('./') ? '' : ' target="_blank" rel="noreferrer noopener"'}>${esc(f.link.label)}</a>`
      : '',
  ].join('')
  return `<article class="feature" id="${id}" data-k="${f.kind}" data-date="${f.date}">
    ${figure}
    <div class="feature__txt">
      ${tag(f.kind)}
      <h3>${inline(f.title)}</h3>
      ${paragraphs(f.body)}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>
  </article>`
}

function itemHTML(it: ChangelogItem, id: string): string {
  const href = hrefOf(it)
  const demo = href
    ? ` <a class="try" href="${href}" target="_blank" rel="noopener">Open example&nbsp;→</a>`
    : ''
  const body = it.body || demo ? `<p>${it.body ? inline(it.body) : ''}${demo}</p>` : ''
  return `<li id="${id}" data-k="${it.kind}" data-date="${it.date}"${it.kind === 'changed' ? ' class="changed"' : ''}>
    ${tag(it.kind)}<div><b>${inline(it.title)}</b>${body}</div>
  </li>`
}

function entryHTML(e: ChangelogEntry): string {
  const features = (e.features ?? []).map((f, i) => featureHTML(f, changeId(e, 'f', i)))
  const items = (e.items ?? []).map((it, i) => itemHTML(it, changeId(e, 'i', i)))
  const fixes = e.fixes ?? []
  return `<section class="release" id="${e.date}" data-date="${e.date}">
    <div class="release__date"><time datetime="${e.date}">${longDate(e.date)}</time><span class="release__new" hidden>New since your last visit</span></div>
    <h2>${esc(e.title)}</h2>
    <p class="release__intro">${esc(e.summary)}</p>
    ${features.join('\n')}
    ${items.length && features.length ? '<p class="release__label">Also in this update</p>' : ''}
    ${items.length ? `<ul class="items">${items.join('\n')}</ul>` : ''}
    ${
      fixes.length
        ? `<details class="fixes"><summary>${fixes.length === 1 ? '1 fix' : `${fixes.length} fixes`}</summary><ul>${fixes.map((f) => `<li>${inline(f)}</li>`).join('')}</ul></details>`
        : ''
    }
  </section>`
}

/** Filter chips for the kinds present, or nothing when there is only one kind to show. */
function filtersHTML(entries: readonly ChangelogEntry[]): string {
  const counts = new Map<ChangeKind, number>()
  for (const c of entries.flatMap(changesOf)) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1)
  if (counts.size < 2) return ''
  const chips = (Object.keys(KIND_LABEL) as ChangeKind[])
    .filter((k) => counts.has(k))
    .map(
      (k) =>
        `<button class="chip" type="button" data-f="${k}" aria-pressed="false"><span class="tag" data-k="${k}" aria-hidden="true"></span>${KIND_LABEL[k].filter} <span class="chip__n">${counts.get(k)}</span></button>`,
    )
  return `<div class="filters" role="group" aria-label="Show">
    <button class="chip" type="button" data-f="all" aria-pressed="true">Everything</button>
    ${chips.join('\n')}
  </div>`
}

export function changelogHTML(entries: readonly ChangelogEntry[] = CHANGELOG): string {
  return `<div class="shell layout">
    ${timelineHTML(entries)}
    <div class="content">
      ${filtersHTML(entries)}
      ${entries.map(entryHTML).join('\n')}
    </div>
  </div>`
}
