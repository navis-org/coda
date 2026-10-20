/**
 * The Biophysics guide's drawn diagrams, written to `public/guides/biophys/` as SVG.
 *
 *   pnpm guide:diagrams
 *
 * Drawn rather than captured because they show what no screen does — a compartment as a circuit, a
 * voltage fading along a neurite, a spike's two currents — and generated rather than hand-drawn so
 * the curves are computed: the spike is our own solver running the squid HH point case
 * (`referenceCases.ts`' `hhPoint`, the one held to NEURON), the fading is the cable equation at the
 * "Drosophila PN" preset's constants. The renderer inlines them (`src/packguide/render.ts`), so
 * they draw in the page's colours: `currentColor` for ink, the theme's tokens for the rest.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCase, hhPoint } from '../src/biophys/referenceCases'
import { simulate } from '../src/biophys/solver'
import { MEMBRANE_PRESETS } from '../src/packs/biophys/presets'

const DIR = fileURLToPath(new URL('../public/guides/biophys/', import.meta.url))

/** Theme tokens, as the inlined SVG reads them. */
const INK = 'currentColor'
const MUTED = 'var(--text-muted)'
const ACCENT = 'var(--accent)'
const FAINT = 'var(--border-strong)'

const f = (x: number) => (Math.round(x * 10) / 10).toString()

function svg(width: number, height: number, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none" stroke-linecap="round" stroke-linejoin="round" font-size="13">`,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}

const text = (x: number, y: number, s: string, opts: { anchor?: string; color?: string; size?: number } = {}) =>
  `<text x="${f(x)}" y="${f(y)}" text-anchor="${opts.anchor ?? 'start'}" style="fill:${opts.color ?? INK}"${opts.size ? ` font-size="${opts.size}"` : ''}>${s}</text>`

const line = (x1: number, y1: number, x2: number, y2: number, color = INK, width = 1.5, dash = '') =>
  `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" style="stroke:${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`

const path = (d: string, color = INK, width = 1.5) =>
  `<path d="${d}" style="stroke:${color}" stroke-width="${width}"/>`

/** A resistor's zigzag from (x, y) to (x + len, y), or downwards with `vertical`. */
function resistor(x: number, y: number, len: number, vertical = false): string {
  const lead = len * 0.2
  const zig = len - 2 * lead
  const n = 6
  const pts: [number, number][] = [[0, 0], [lead, 0]]
  for (let i = 0; i < n; i++) pts.push([lead + (zig * (i + 0.5)) / n, i % 2 ? 5 : -5])
  pts.push([lead + zig, 0], [len, 0])
  const d = pts
    .map(([a, b], i) => `${i ? 'L' : 'M'}${f(vertical ? x + b : x + a)},${f(vertical ? y + a : y + b)}`)
    .join(' ')
  return path(d)
}

/** A capacitor across (x, y) to (x, y + len), plates in the middle. */
function capacitor(x: number, y: number, len: number): string {
  const mid = y + len / 2
  return [
    line(x, y, x, mid - 4),
    line(x - 9, mid - 4, x + 9, mid - 4, INK, 2),
    line(x - 9, mid + 4, x + 9, mid + 4, INK, 2),
    line(x, mid + 4, x, y + len),
  ].join('')
}

/** A battery (E leak) across (x, y) to (x, y + len): a long and a short plate. */
function battery(x: number, y: number, len: number): string {
  const mid = y + len / 2
  return [
    line(x, y, x, mid - 3),
    line(x - 9, mid - 3, x + 9, mid - 3, INK, 1.5),
    line(x - 5, mid + 3, x + 5, mid + 3, INK, 3),
    line(x, mid + 3, x, y + len),
  ].join('')
}

// ---------------------------------------------------------------------------------------------
// 1. A neurite cut into compartments, and each compartment as a circuit.
// ---------------------------------------------------------------------------------------------

function compartments(): string {
  const W = 760
  const H = 330
  const body: string[] = []
  // The neurite: a soma and a tube cut into five compartments, every other one shaded.
  const tubeY = 52
  const x0 = 120
  const cw = 110
  body.push(`<circle cx="70" cy="${tubeY}" r="30" style="fill:var(--surface-2);stroke:${INK}" stroke-width="1.5"/>`)
  body.push(text(70, tubeY + 50, 'soma', { anchor: 'middle', color: MUTED }))
  for (let i = 0; i < 5; i++) {
    body.push(
      `<rect x="${x0 + i * cw}" y="${tubeY - 12}" width="${cw}" height="24" style="fill:${i % 2 ? 'var(--surface-3)' : 'var(--surface-2)'};stroke:${INK}" stroke-width="1.5"/>`,
    )
  }
  body.push(text(x0 + 2.5 * cw, tubeY - 22, 'a neurite, cut into compartments', { anchor: 'middle', color: MUTED }))
  // Each compartment's centre drops to its node in the circuit below.
  const nodeY = 140
  const groundY = 280
  for (let i = 0; i < 5; i++) {
    const cx = x0 + i * cw + cw / 2
    body.push(line(cx, tubeY + 12, cx, nodeY - 8, FAINT, 1, '3 4'))
    body.push(`<circle cx="${f(cx)}" cy="${nodeY}" r="3.5" style="fill:${INK}"/>`)
    // Membrane: capacitance and leak (resistance and battery) in parallel, to the outside.
    body.push(line(cx - 22, nodeY, cx + 22, nodeY))
    body.push(capacitor(cx - 22, nodeY, groundY - nodeY))
    body.push(resistor(cx + 22, nodeY, (groundY - nodeY) * 0.55, true))
    body.push(battery(cx + 22, nodeY + (groundY - nodeY) * 0.55, (groundY - nodeY) * 0.45))
    body.push(line(cx - 22, groundY, cx + 22, groundY))
    // Axial resistance to the next compartment.
    if (i < 4) body.push(resistor(cx, nodeY, cw))
  }
  body.push(line(x0 + cw / 2 - 30, groundY, x0 + 4.5 * cw + 30, groundY, MUTED, 1.5))
  body.push(text(x0 + 4.5 * cw + 36, groundY + 4, 'outside', { color: MUTED }))
  // Labels on the first compartment's parts, and the first axial resistor.
  const c0 = x0 + cw / 2
  body.push(text(c0 - 34, nodeY + 75, 'Cm', { anchor: 'end', color: ACCENT }))
  body.push(text(c0 + 34, nodeY + 45, 'Rm', { color: ACCENT }))
  body.push(text(c0 + 34, nodeY + 118, 'E leak', { color: ACCENT }))
  body.push(text(c0 + cw / 2, nodeY - 14, 'Ra', { anchor: 'middle', color: ACCENT }))
  body.push(text(W / 2, H - 12, 'each compartment: a patch of membrane, joined to the next through the cytoplasm', { anchor: 'middle', color: MUTED }))
  return svg(W, H, body)
}

// ---------------------------------------------------------------------------------------------
// 2. A steady voltage fading along a neurite, thick and thin, at the PN preset's constants.
// ---------------------------------------------------------------------------------------------

function attenuation(): string {
  const W = 640
  const H = 300
  const pn = MEMBRANE_PRESETS.find((p) => p.id === 'drosophila-pn')!
  // λ = √(Rm·d / 4Ra), d in cm, λ in µm.
  const lambda = (dUm: number) => Math.sqrt((pn.rm * dUm * 1e-4) / (4 * pn.ra)) * 1e4
  const left = 70
  const top = 24
  const pw = 520
  const ph = 200
  const xMax = 600
  const X = (um: number) => left + (um / xMax) * pw
  const Y = (share: number) => top + (1 - share) * ph
  const body: string[] = []
  body.push(line(left, top, left, top + ph, MUTED, 1))
  body.push(line(left, top + ph, left + pw, top + ph, MUTED, 1))
  for (const um of [0, 200, 400, 600]) body.push(text(X(um), top + ph + 18, String(um), { anchor: 'middle', color: MUTED }))
  for (const s of [0, 0.5, 1]) body.push(text(left - 8, Y(s) + 4, `${s * 100}%`, { anchor: 'end', color: MUTED }))
  body.push(text(left + pw / 2, H - 8, 'distance from where the voltage is held (µm)', { anchor: 'middle', color: MUTED }))
  body.push(text(left, top - 8, 'share of the voltage that arrives', { color: MUTED }))
  // Each curve named near its start: the thick one just above its line, the thin one in the open
  // space beneath both, where its steep start cannot cross it.
  const curves: [number, string, string, (l: number) => number][] = [
    [1, INK, '1 µm thick', (l) => Y(Math.exp(-70 / l)) - 10],
    [0.25, ACCENT, '0.25 µm thick', () => Y(0.3)],
  ]
  for (const [d, color, label, labelY] of curves) {
    const l = lambda(d)
    const pts = Array.from({ length: 121 }, (_, i) => (i / 120) * xMax)
      .map((x, i) => `${i ? 'L' : 'M'}${f(X(x))},${f(Y(Math.exp(-x / l)))}`)
      .join(' ')
    body.push(path(pts, color, 2))
    // The length constant: where the voltage has fallen to 1/e, 37%.
    body.push(line(X(l), Y(Math.exp(-1)), X(l), top + ph, color, 1, '3 4'))
    body.push(`<circle cx="${f(X(l))}" cy="${f(Y(Math.exp(-1)))}" r="3.5" style="fill:${color}"/>`)
    body.push(text(X(l) + 8, Y(Math.exp(-1)) - 8, `λ ≈ ${Math.round(l)} µm`, { color }))
    body.push(text(X(d === 1 ? 70 : 20), labelY(l), label, { color }))
  }
  return svg(W, H, body)
}

// ---------------------------------------------------------------------------------------------
// 3. A spike: our solver running the squid HH point, with what each channel does marked.
// ---------------------------------------------------------------------------------------------

function spike(): string {
  const W = 640
  const H = 300
  const c = hhPoint('guide', 6.3, 10)
  const run = simulate(buildCase({ ...c, duration: 30 }).request)
  const v = run.v[0]!
  const dt = c.dt
  const t0 = 3
  const t1 = 24
  const left = 70
  const top = 20
  const pw = 520
  const ph = 190
  const vMin = -80
  const vMax = 50
  const X = (t: number) => left + ((t - t0) / (t1 - t0)) * pw
  const Y = (mv: number) => top + ((vMax - mv) / (vMax - vMin)) * ph
  const body: string[] = []
  body.push(line(left, top, left, top + ph, MUTED, 1))
  body.push(line(left, top + ph, left + pw, top + ph, MUTED, 1))
  for (const mv of [-60, 0, 40]) {
    body.push(text(left - 8, Y(mv) + 4, `${mv}`, { anchor: 'end', color: MUTED }))
    body.push(line(left, Y(mv), left + pw, Y(mv), FAINT, 0.5, '2 4'))
  }
  body.push(text(left - 46, top + ph / 2, 'mV', { color: MUTED }))
  const pts: string[] = []
  for (let i = 0; i < v.length; i++) {
    const t = i * dt
    if (t < t0 || t > t1) continue
    pts.push(`${pts.length ? 'L' : 'M'}${f(X(t))},${f(Y(v[i]!))}`)
  }
  body.push(path(pts.join(' '), INK, 2))
  // The first spike's peak, and where its fall crosses −20 mV, read off the trace: each label sits
  // just right of the part of the curve it names.
  let peak = 0
  for (let i = 0; i < v.length; i++) if (i * dt > t0 && i * dt < 15 && v[i]! > v[peak]!) peak = i
  let fall = peak
  while (fall < v.length - 1 && v[fall]! > -20) fall++
  const tp = peak * dt
  const tf = fall * dt
  body.push(text(X(tp) + 12, Y(v[peak]!) + 4, 'sodium channels open: Na⁺ flows in', { color: ACCENT }))
  body.push(text(X(tf) + 12, Y(-20) + 4, 'potassium channels open: K⁺ flows out', { color: ACCENT }))
  // The current step that drives it, under the axis.
  const stepY = top + ph + 34
  body.push(path(`M${f(X(t0))},${stepY} L${f(X(5))},${stepY} L${f(X(5))},${stepY - 12} L${f(X(t1))},${stepY - 12}`, MUTED, 1.5))
  body.push(text(X(t1), stepY + 14, 'current injected', { anchor: 'end', color: MUTED }))
  body.push(text(left + pw / 2, H - 6, 'time (ms)', { anchor: 'middle', color: MUTED }))
  return svg(W, H, body)
}

const DIAGRAMS: Record<string, () => string> = {
  'compartments.svg': compartments,
  'attenuation.svg': attenuation,
  'spike.svg': spike,
}
for (const [file, draw] of Object.entries(DIAGRAMS)) writeFileSync(DIR + file, draw())
console.error(`${Object.keys(DIAGRAMS).length} diagrams → ${DIR}`)
