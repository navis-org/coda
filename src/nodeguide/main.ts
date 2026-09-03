/**
 * The node guide.
 *
 * Plain TypeScript, no React and no store, deliberately — this is a third vite entry and
 * reaching into the editor would put the whole app bundle behind a document that draws none of
 * it. The node cards here are CSS, not React Flow, and their tokens come from `theme.css`, so
 * the two cannot drift on what a Dataset socket looks like. Same construction as the tutorial
 * page, and the same rule: verify with `pnpm build` that `nodes.html` references no `main-*`
 * chunk. It does carry `ui/glyphs.ts` — 8.6 kB gzipped, measured, in a chunk it shares with the
 * app — which is the page's own content rather than a leak: it draws 101 node tiles.
 *
 * Everything below the control bar is rendered from `virtual:node-guide-data`, which is the
 * node registry read at build time — see `vite/nodeGuideData.ts` for why it arrives that way
 * rather than by importing `src/nodes` here (660 kB, measured). The consequence worth stating:
 * nothing in this file names a node, a socket or a parameter. A node added next month gets a
 * tile, a preview card and a settings list without anyone opening this directory.
 */

import './nodeguide.css'
import NODE_DATA from 'virtual:node-guide-data'
import type { GuideData, GuideNode, GuideParam, GuidePort } from './data'
import { CAT_LABEL, SECTIONS } from './sections'
/*
 * The one import that reaches into the editor, and it is affordable because it reaches into
 * a table: `ui/glyphs.ts` is drawing data with no React, no store and no registry behind it.
 * Before this the page kept its own transcription of the six category glyphs — fine at six,
 * and 101 chances to drift once every node had one of its own.
 */
import { GLYPH_STROKE_WIDTH, GLYPH_VIEWBOX, glyphMarkup, glyphShapes } from '../ui/glyphs'

/* Asserted rather than declared: see `virtual.d.ts` for why the ambient declaration cannot
   carry the type itself, and `nodeGuide.test.ts` for where the shape is actually checked. */
const { nodes: NODES } = NODE_DATA as GuideData

/**
 * The socket vocabulary, in the order somebody meets it going left to right through a pipeline.
 *
 * Hand-written rather than derived from the nodes, because it is a *lesson* rather than an
 * inventory — the point is what the shapes mean, and a list generated from whatever types
 * happen to be in the registry would put `layout` between `network` and `skeletons` with
 * nothing to say about it.
 */
const LEGEND: ReadonlyArray<[fam: string, shape: string, name: string, why: string]> = [
  ['dataset', 'square', 'Dataset', 'a connectome to query'],
  ['table', 'circle', 'Neurons', 'a table guaranteed to have neuron IDs'],
  ['table', 'ring', 'Table', 'rows and typed columns'],
  ['matrix', 'diamond', 'Matrix', 'labelled rows × columns'],
  ['matrix', 'hex', 'Network', 'nodes and links'],
  ['geometry', 'circle', 'Geometry', 'skeletons, meshes, synapse points'],
]

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c)

function glyph(node: GuideNode, size: number): string {
  const d = glyphMarkup(glyphShapes(node.type, node.category, node.datasetGlyph))
  return `<svg class="tile__glyph" width="${size}" height="${size}" viewBox="${GLYPH_VIEWBOX}" fill="none"
    stroke="currentColor" stroke-width="${GLYPH_STROKE_WIDTH}" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${d}</svg>`
}

const pip = (p: GuidePort): string =>
  `<span class="pip" data-fam="${p.family}" data-shape="${p.shape}" data-req="${p.required ? 1 : 0}"></span>`

/**
 * Ranges are merged before wrapping, so two overlapping terms cannot nest one `<mark>` inside
 * another and leave stray tags on the page.
 */
function highlight(text: string, terms: readonly string[]): string {
  if (!terms.length) return esc(text)
  const low = text.toLowerCase()
  const hits: Array<[number, number]> = []
  for (const t of terms) {
    let i = low.indexOf(t)
    while (i !== -1) {
      hits.push([i, i + t.length])
      i = low.indexOf(t, i + 1)
    }
  }
  const [first, ...rest] = hits.sort((a, b) => a[0] - b[0])
  if (!first) return esc(text)
  const merged: Array<[number, number]> = [first]
  for (const h of rest) {
    const last = merged[merged.length - 1]!
    if (h[0] <= last[1]) last[1] = Math.max(last[1], h[1])
    else merged.push(h)
  }
  let out = ''
  let at = 0
  for (const [s, e] of merged) {
    out += esc(text.slice(at, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>'
    at = e
  }
  return out + esc(text.slice(at))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Socket names, type kinds and setting names are all in the haystack, because that is how
 * somebody actually looks for a node: "matrix" to find what emits one, "hops" to find the node
 * with that control. Terms are ANDed.
 *
 * Example names are deliberately *not* in it, and that was measured rather than assumed. One
 * bundled example is called "Build an adjacency matrix from two searches", so including them had
 * a search for `matrix` light every node in that graph — the dataset, both Find Neurons, the
 * heatmap — beside the five that genuinely carry one. A graph lends its title to every node in
 * it, which is the opposite of what a search is for. (That example has been renamed since; it
 * still carries `matrix`, so the finding stands.)
 */
const HAY = new Map<string, string>(
  NODES.map((n) => [
    n.type,
    [
      n.label,
      n.type,
      n.description,
      n.guide,
      CAT_LABEL[n.category],
      ...n.inputs.map((p) => `${p.label} ${p.kind}`),
      ...n.outputs.map((p) => `${p.label} ${p.kind}`),
      ...n.params.map((p) => `${p.label} ${p.help ?? ''}`),
    ]
      .join('  ')
      .toLowerCase(),
  ]),
)

const BY_TYPE = new Map(NODES.map((n) => [n.type, n]))

/* The registry is never empty, but nothing in the type says so — and an empty one would mean
   the build-time load silently returned nothing, which is worth failing loudly on rather than
   rendering a page with no nodes on it. Narrowed at the declaration rather than by a preceding
   `if`, because a control-flow narrowing of a module-scope const does not reach into the
   functions below that read it. */
function noNodes(): never {
  throw new Error('The node registry produced no nodes — see vite/nodeGuideData.ts')
}
const FIRST: GuideNode = NODES[0] ?? noNodes()

const termsOf = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean)
const isMatch = (n: GuideNode, ts: readonly string[]): boolean => {
  const hay = HAY.get(n.type) ?? ''
  return ts.every((t) => hay.includes(t))
}

// ---------------------------------------------------------------------------
// The preview card
// ---------------------------------------------------------------------------

/** Beyond this the card would be taller than the node it is describing. */
const MAX_CARD_ROWS = 5

/**
 * Built the way the editor builds a card: a category-tinted header, one row per input/output
 * pair, then the params the card actually draws. Advanced ones stay off it and are counted into
 * the "… N more" line instead, which is exactly what the real card says — so a node whose every
 * setting is inspector-only (ROIs, Neuroglancer) correctly previews with no param band at all.
 */
function previewHTML(n: GuideNode): string {
  if (n.annotation) {
    return `<div class="note-card"><strong>Why this threshold</strong>
      Below 10 synapses the partner list is mostly noise — see the tail of the weight
      histogram two nodes back.</div>`
  }

  const rows = Math.max(n.inputs.length, n.outputs.length)
  const ports = Array.from({ length: rows }, (_, r) => {
    const i = n.inputs[r]
    const o = n.outputs[r]
    const left = i
      ? `${esc(i.label)}<i class="sock sock--in" data-fam="${i.family}" data-shape="${i.shape}"></i>`
      : ''
    const right = o
      ? `${esc(o.label)}<i class="sock sock--out" data-fam="${o.family}" data-shape="${o.shape}"></i>`
      : ''
    return `<div class="port"><span class="port__in">${left}</span><span class="port__out">${right}</span></div>`
  }).join('')

  const shown = n.params.filter((p) => !p.advanced).slice(0, MAX_CARD_ROWS)
  const hidden = n.params.length - shown.length
  const params = shown.length
    ? `<div class="node__params">${shown
        .map(
          (p) =>
            `<div class="prow"><span>${esc(p.label)}</span><b class="${p.picker ? 'is-picker' : ''}">${esc(p.value)}</b></div>`,
        )
        .join('')}</div>`
    : ''
  const more = hidden > 0 ? `<div class="node__more">… ${hidden} more</div>` : ''

  return `<div class="node" style="--cat: var(--cat-${n.category})">
    <div class="node__head"><span class="node__title">${esc(n.label)}</span><span class="node__play">▶</span></div>
    ${ports ? `<div class="node__ports">${ports}</div>` : ''}
    ${params}${more}
    <div class="node__foot"><span>${esc(n.type)}</span><span>${n.cost === 'cheap' ? 'live' : 'on run'}</span></div>
  </div>`
}

// ---------------------------------------------------------------------------
// The detail pane
// ---------------------------------------------------------------------------

const panelEl = document.getElementById('panel') as HTMLElement
const groupsEl = document.getElementById('groups') as HTMLElement
const chipsEl = document.getElementById('chips') as HTMLElement
const countEl = document.getElementById('count') as HTMLElement
const emptyEl = document.getElementById('empty') as HTMLElement
const emptyQEl = document.getElementById('emptyq') as HTMLElement
const qEl = document.getElementById('q') as HTMLInputElement

function portListHTML(n: GuideNode): string {
  const line = (p: GuidePort, dir: string): string => `<p class="portrow">
      <span class="dir">${dir}</span>
      <span class="nm">${pip(p)}<span>${esc(p.label)}</span></span>
      <span class="ty">${esc(p.kind)}${p.required ? '' : ' <span class="opt">optional</span>'}</span>
    </p>`
  const parts = [...n.inputs.map((p) => line(p, 'in')), ...n.outputs.map((p) => line(p, 'out'))]
  return parts.length
    ? parts.join('')
    : '<p class="hint">No sockets — this node stands on its own.</p>'
}

/**
 * A setting with help text becomes a disclosure button; one without stays a plain row.
 *
 * The alternative — printing every help string inline — reads well on Filter and turns the
 * Network viewer's pane into a wall: 33 settings, most of them carrying a sentence. The dotted
 * underline is what stops the two kinds of row looking identical, and it costs no width in a
 * column that is already tight.
 */
function settingHTML(p: GuideParam, index: number, nodeType: string): string {
  const flags = [p.advanced ? 'inspector' : '', p.presentational ? 'view only' : '']
    .filter(Boolean)
    .join(' · ')
  const name = `<span class="setting__name">${esc(p.label)}${flags ? ` <span class="setting__flag">${flags}</span>` : ''}</span>`
  const value = `<span class="setting__value">${esc(p.value)}</span>`

  if (!p.help) {
    return `<div class="setting"><p class="setting__row">${name}${value}</p></div>`
  }
  const id = `help-${nodeType.replace(/\W/g, '-')}-${index}`
  return `<div class="setting">
    <button type="button" class="setting__row" aria-expanded="false" aria-controls="${id}">${name}${value}</button>
    <p class="setting__help" id="${id}" hidden>${esc(p.help)}</p>
  </div>`
}

/** Eight, then a fold — nothing is dropped, because a control nobody can find is worse. */
const MAX_LISTED = 8

function settingsHTML(n: GuideNode): string {
  if (!n.params.length) return '<p class="hint">No settings.</p>'
  const row = (p: GuideParam, i: number): string => settingHTML(p, i, n.type)
  const head = n.params.slice(0, MAX_LISTED).map(row).join('')
  const tail = n.params.slice(MAX_LISTED)
  if (!tail.length) return head
  const rest = tail.map((p, i) => row(p, i + MAX_LISTED)).join('')
  return `${head}<details class="more">
    <summary>${tail.length} more</summary>
    <div class="plist">${rest}</div>
  </details>`
}

function costLine(n: GuideNode): string {
  return n.cost === 'cheap'
    ? 'Cheap — re-runs on its own as you edit, so a threshold moves the result live.'
    : 'Expensive — reaches the network or chews CPU, so it goes stale and waits for Run.'
}

let selected = 'neuron.connectivity'

function renderDetail(): void {
  const n = BY_TYPE.get(selected) ?? FIRST
  const ts = termsOf(qEl.value)
  panelEl.style.setProperty('--cat', `var(--cat-${n.category})`)

  const seen = n.workflows.length
    ? `<div class="sub"><p class="sub__h">Seen in</p><div class="seen">${n.workflows
        .map((e) => `<a href="./index.html">${esc(e)}</a>`)
        .join('')}</div></div>`
    : ''

  panelEl.innerHTML = `
    <div class="preview">${previewHTML(n)}</div>
    <div class="panel__head">
      <div class="panel__cat"><span class="eyebrow">${CAT_LABEL[n.category]}</span><span class="rule"></span></div>
      <h2 class="panel__title">${highlight(n.label, ts)}</h2>
      <p class="panel__desc">${highlight(n.guide, ts)}</p>
      <div class="panel__meta">
        <span class="badge" data-kind="type">${esc(n.type)}</span>
        <span class="badge" data-kind="${n.cost}">${n.cost}</span>
        <span class="badge">${n.inputs.length} in · ${n.outputs.length} out</span>
      </div>
    </div>
    <div class="panel__body">
      <div class="sub"><p class="sub__h">Sockets</p><div class="ports">${portListHTML(n)}</div></div>
      <div class="sub"><p class="sub__h">Settings</p><div class="plist">${settingsHTML(n)}</div></div>
      ${seen}
      <p class="hint">${costLine(n)}</p>
    </div>`
}

/* One listener on the pane rather than one per row: the pane is re-rendered on every
   selection, and per-row listeners would be re-attached each time. */
panelEl.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button.setting__row')
  if (!button) return
  const open = button.getAttribute('aria-expanded') === 'true'
  button.setAttribute('aria-expanded', String(!open))
  const help = document.getElementById(button.getAttribute('aria-controls') ?? '')
  if (help) help.hidden = open
})

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

function tileHTML(n: GuideNode): string {
  const ports = [...n.inputs.map(pip), '<span class="gap"></span>', ...n.outputs.map(pip)].join(
    '',
  )
  return `<button class="tile" type="button" data-type="${esc(n.type)}"
      style="--cat: var(--cat-${n.category})" aria-pressed="false">
    <span class="tile__top">${glyph(n, 17)}<span class="tile__label" data-label>${esc(n.label)}</span></span>
    <span class="tile__ports">${ports}<span class="tile__cost" data-cost="${n.cost}">${n.cost === 'cheap' ? 'live' : 'run'}</span></span>
  </button>`
}

groupsEl.innerHTML = SECTIONS.map((s) => {
  const defs = NODES.filter((n) => s.cats.includes(n.category))
  if (!defs.length) return ''
  const marker = s.n
    ? `<span class="group__n">${s.n}</span>`
    : '<span class="group__n" aria-hidden="true">·</span>'
  return `<section class="group">
    <div class="group__head">
      ${marker}
      <h2 class="group__title">${esc(s.title)}</h2>
      <p class="group__note">${esc(s.note)}</p>
    </div>
    <div class="group__rule"></div>
    <div class="grid">${defs.map(tileHTML).join('')}</div>
  </section>`
}).join('')

const activeCats = new Set<string>()
const CATS = Object.keys(CAT_LABEL) as Array<GuideNode['category']>

chipsEl.innerHTML = CATS.map((c) => {
  const n = NODES.filter((x) => x.category === c).length
  return `<button class="chip" type="button" data-cat="${c}" aria-pressed="false" style="--dot: var(--cat-${c})">
    <span class="chip__dot"></span>${CAT_LABEL[c]}<span class="chip__n">${n}</span></button>`
}).join('')

chipsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.chip')
  if (!b) return
  const c = b.dataset.cat as string
  if (activeCats.has(c)) activeCats.delete(c)
  else activeCats.add(c)
  b.setAttribute('aria-pressed', String(activeCats.has(c)))
  apply()
})

document.getElementById('legend')!.innerHTML = LEGEND.map(
  ([fam, shape, name, why]) =>
    `<p class="legend__row"><span class="pip" data-fam="${fam}" data-shape="${shape}"></span><span class="nm">${name}</span><span class="why">${why}</span></p>`,
).join('')

// ---------------------------------------------------------------------------
// Filtering, selection, keyboard
// ---------------------------------------------------------------------------

const tiles = [...document.querySelectorAll<HTMLElement>('.tile')]

/**
 * Filtering dims in place; it never removes a tile.
 *
 * The grid is a map of the whole registry, so a search that reflowed it would throw away the
 * one thing worth looking at — where in a pipeline the answer sits. Matches keep their colour
 * and take an amber edge, everything else recedes, and nothing moves.
 */
function apply(): void {
  const q = qEl.value.trim()
  const ts = termsOf(q)
  let hits = 0

  for (const el of tiles) {
    const n = BY_TYPE.get(el.dataset.type as string)
    if (!n) continue
    const on = (activeCats.size === 0 || activeCats.has(n.category)) && isMatch(n, ts)
    if (on) hits++
    el.dataset.dim = on ? '0' : '1'
    el.dataset.hit = ts.length && on ? '1' : '0'
    const label = el.querySelector('[data-label]')
    if (label) label.innerHTML = highlight(n.label, ts)
  }

  countEl.innerHTML =
    ts.length || activeCats.size
      ? `<b>${hits}</b> of ${NODES.length} nodes`
      : `<b>${NODES.length}</b> nodes · ${SECTIONS.length} groups`
  emptyEl.dataset.on = hits === 0 ? '1' : '0'
  emptyQEl.textContent = q
  renderDetail()
}

function select(type: string): void {
  selected = type
  for (const el of tiles) el.setAttribute('aria-pressed', String(el.dataset.type === type))
  renderDetail()
}

groupsEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('.tile')
  if (t?.dataset.type) select(t.dataset.type)
})

qEl.addEventListener('input', () => {
  apply()
  /* Following the first match keeps the pane in step with what is lit, which is what makes
     the search usable without touching the mouse. */
  const first = tiles.find((el) => el.dataset.dim !== '1')
  if (first?.dataset.type && qEl.value.trim()) select(first.dataset.type)
})

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== qEl) {
    e.preventDefault()
    qEl.focus()
    qEl.select()
    return
  }
  if (e.key === 'Escape' && document.activeElement === qEl) {
    qEl.value = ''
    apply()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const live = tiles.filter((el) => el.dataset.dim !== '1')
  if (!live.length) return
  e.preventDefault()
  const at = live.findIndex((el) => el.dataset.type === selected)
  const step = e.key === 'ArrowDown' ? 1 : live.length - 1
  const next = live[(at + step + live.length) % live.length]
  if (!next?.dataset.type) return
  select(next.dataset.type)
  next.scrollIntoView({ block: 'nearest' })
})

document.getElementById('stamp')!.textContent =
  `${NODES.length} node types · ${NODES.reduce((a, n) => a + n.params.length, 0)} settings`

apply()
select(selected)
