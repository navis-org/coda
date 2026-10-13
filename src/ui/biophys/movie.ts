/**
 * Playback's rules, as data: the colour scale, every compartment's colour at a frame, the traces
 * table under the scrubber, where the stored traces and the fired inputs land, and when inputs arrive. Pure, so they are tested without a DOM or a worker.
 *
 * **One colour scale for the whole run.** The ramp's ends come from every frame, never one frame's
 * — a per-frame scale makes every frame look equally eventful and a colour mean a different voltage
 * each time. Sequential from rest by default, or diverging about rest (`MovieScale`).
 */

import { column, tableSchema, uniqueName } from '../../core/types'
import type { CellModelValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { Mode } from '../../style/colors'
import type { SequentialLegend } from '../../style/encoding'
import { valueRamp } from '../../style/encoding'
import type { Arbor, SynapseProjection } from '../../nodes/lib/arborOps'
import { orientPlacement, pointOnEdge, rootNodeFor } from '../../nodes/lib/arborOps'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import { projectManual } from '../../nodes/lib/skeletonPoints'
import type { Domain } from '../viewers/scatterPlot'
import type { Movie, SimulateJob } from '../../packs/biophys/simulateJob'
import { SOMA_COLUMN } from '../../packs/biophys/simulateOps'
import { partnerDelays } from '../../packs/biophys/solverInputs'

/** Which partners the run fired, and when (ms): the job's own, for marking the inputs. */
export type Firing = SimulateJob['firing']

/**
 * How a movie's voltage is coloured: diverging about rest, depolarisation one hue and
 * hyperpolarisation the other, or sequential from rest up to the run's peak — the whole ramp spent
 * on depolarisation, which resolves a small EPSP that the diverging scale leaves as one colour.
 */
export type MovieScale = 'diverging' | 'sequential'

/**
 * mV a compartment must rise above its own rest for "from rest" to have anything to show: under
 * it, the run's "rise" is the settled state's drift, not a response.
 */
const RISE_FLOOR_MV = 0.01

/**
 * How far any compartment rose above **its own** rest (its frame 0) over the run, mV, at least 0.
 * Its own, because a model with channels does not settle uniform — the HH soma preset leaves the
 * dendrites 0.14 mV above the soma — and measured from one rest, that gradient is the whole ramp.
 */
export function largestRise(movie: Movie): number {
  return movieStats(movie).rise
}

/** A movie's voltage range and its largest rise, from one pass, kept per movie. */
export interface MovieStats {
  /** The lowest and highest voltage in any frame; undefined for a movie with none. */
  readonly extent: Domain | undefined
  readonly rise: number
}

/**
 * Weak, per movie: every view that opens one — the card, the expanded view, a pinned one — would
 * otherwise scan up to 128 MB again, twice (once for the range, once for the rise).
 */
const STATS = new WeakMap<Movie, MovieStats>()

export function movieStats(movie: Movie): MovieStats {
  const hit = STATS.get(movie)
  if (hit) return hit
  const { frames, count, length } = movie
  let min = Infinity
  let max = -Infinity
  let rise = 0
  for (let f = 0; f < length; f++) {
    const base = f * count
    for (let c = 0; c < count; c++) {
      const v = frames[base + c]!
      if (v < min) min = v
      if (v > max) max = v
      const up = v - frames[c]!
      if (up > rise) rise = up
    }
  }
  const stats = { extent: min <= max ? { min, max } : undefined, rise }
  STATS.set(movie, stats)
  return stats
}

/** Whether anything rose above rest in the run: what "from rest" has to show (`largestRise`). */
export function risesAboveRest(rise: number): boolean {
  return rise > RISE_FLOOR_MV
}

/**
 * The ramp for a whole movie, scanned once per movie rather than once per theme. Diverging, it
 * runs out to the furthest voltage either side of `rest` (`extent` being the movie's own), and
 * colours a voltage. Sequential, it colours a compartment's **rise above its own rest**, from 0 up
 * to `rise` — anything below rest the lowest colour — and with nothing risen it is held at 0, every
 * compartment the lowest colour, rather than falling back to an extent that would draw it upside
 * down. `frameColors` hands it the voltage or the rise to match (`baselineOf`).
 */
export function movieRamp(
  extent: Domain,
  rest: number,
  rise: number,
  mode: Mode,
  scale: MovieScale,
): { colorOf(v: number): string; legend: SequentialLegend } | undefined {
  if (scale === 'diverging') {
    return valueRamp(
      extent,
      { diverging: true, palette: 'coda', center: rest, limits: {} },
      mode,
      'membrane voltage (mV)',
    )
  }
  return valueRamp(
    { min: 0, max: risesAboveRest(rise) ? rise : 1 },
    { diverging: false, palette: 'coda', log: false, limits: { min: 0 } },
    mode,
    'rise above rest (mV)',
  )
}

/** What `frameColors` subtracts per compartment: each one's own rest under "from rest", else none. */
export function baselineOf(movie: Movie, scale: MovieScale): Float32Array | undefined {
  return scale === 'sequential' ? movie.frames.subarray(0, movie.count) : undefined
}

/**
 * Every compartment's colour at frame `f`, its voltage less `baseline` where there is one. A tick
 * colours compartments, not nodes or edges, of which there are many more: both views look a node's
 * colour up here through `nodeCompartment`.
 */
export function frameColors(
  movie: Movie,
  f: number,
  colorOf: (v: number) => string,
  baseline?: Float32Array,
): string[] {
  const base = f * movie.count
  return Array.from({ length: movie.count }, (_, c) =>
    colorOf(movie.frames[base + c]! - (baseline?.[c] ?? 0)),
  )
}

/**
 * How a movie's times are written: the decimals its frame interval needs (0.25 ms frames need
 * two, 0.2 ms one), the same for every frame, so the readout keeps one width as it plays rather
 * than `95.25` becoming `96` and reflowing the controls beside it.
 */
export function timeFormat(movie: Movie): (ms: number) => string {
  let decimals = 0
  while (
    decimals < 3 &&
    Math.abs(movie.frameMs * 10 ** decimals - Math.round(movie.frameMs * 10 ** decimals)) > 1e-6
  ) {
    decimals++
  }
  return (ms) => ms.toFixed(decimals)
}

/** One trace to draw under the scrubber: a name, and the compartment it reads. */
export interface MovieTrace {
  readonly label: string
  readonly compartment: number
}

/** `t`, then one column per trace, a row per frame — what the Line Chart draws. */
export function traceTable(movie: Movie, traces: readonly MovieTrace[]): TableValue {
  const frames = movie.length
  const t = Array.from({ length: frames }, (_, f) => f * movie.frameMs)
  const data: Record<string, number[]> = { t }
  for (const { label, compartment } of traces) {
    data[label] = Array.from(
      { length: frames },
      (_, f) => movie.frames[f * movie.count + compartment]!,
    )
  }
  return makeTable(
    tableSchema(
      column('t', 'f64', 'ms'),
      ...traces.map(({ label }) => column(label, 'f64', 'mV')),
    ),
    data,
  )
}

/** A trace added on the dendrogram, as it lands on this model: what it reads, and where it sits. */
export interface PlacedTrace extends MovieTrace {
  /** As stored on the node: a position on the neuron, and its name. */
  readonly point: ManualPoint
  /** On `arbor`: the node at the far end of its edge, and the share of the way along it. */
  readonly node: number
  readonly t: number
}

/**
 * The compartment a point on the arbour is traced at — its edge's nearer end, as it decides a root
 * (`rootNodeFor`) — or undefined off the modelled cable or at the soma, which is always drawn. One
 * rule for a click and for a stored trace placed again.
 */
export function traceCompartment(
  model: CellModelValue,
  arbor: Arbor,
  on: { readonly node: number; readonly t: number },
): number | undefined {
  const compartment = model.nodeCompartment[rootNodeFor(on, arbor.parent)]!
  return compartment < 0 || compartment === model.soma.compartment ? undefined : compartment
}

/**
 * The stored traces (`TRACES_PARAM`) placed on this model, read by the rule a click is
 * (`rootNodeFor`'s nearer end of the edge). Kept as positions, so they survive a re-run and a
 * rebuilt model; a trace of another neuron, too far from this one's cable, or at the soma (which
 * is always drawn) is counted in `off` rather than placed.
 */
export function placeTraces(
  model: CellModelValue,
  arbor: Arbor,
  stored: readonly ManualPoint[],
): { placed: PlacedTrace[]; off: number } {
  const mine = stored.filter((point) => point.neuron === model.neuronId)
  const at = orientPlacement(arbor, projectManual(model.skeleton, mine))
  const placed: PlacedTrace[] = []
  // Labels are the traces table's columns, so each is once — the soma's included.
  const taken = new Set([SOMA_COLUMN])
  mine.forEach((point, i) => {
    const node = at.node[i]!
    if (node < 0) return
    const t = at.t[i]!
    const compartment = traceCompartment(model, arbor, { node, t })
    if (compartment === undefined) return
    const label = uniqueName(taken, point.name ?? `branch ${i + 1}`, (n) => ` (${n})`)
    placed.push({ label, compartment, point, node, t })
  })
  return { placed, off: stored.length - placed.length }
}

/** The name the next trace takes: `branch N`, one past the highest N stored, so none repeats. */
export function nextTraceName(stored: readonly ManualPoint[]): string {
  let highest = 0
  for (const { name } of stored) {
    const n = /^branch (\d+)$/.exec(name ?? '')?.[1]
    if (n) highest = Math.max(highest, Number(n))
  }
  return `branch ${highest + 1}`
}

/** The synapses of the partners a run fired, where they sit on the skeleton (`sites`). */
export function firedSites(
  model: CellModelValue,
  firing: Firing,
): SynapseProjection & {
  /** Per fired site, 1 where it came on the inhibitory socket. */
  readonly inhibitory: Uint8Array
} {
  const fired = new Set(firing.map(([partner]) => partner))
  const rows = Array.from(model.synapses.partner.keys()).filter((s) =>
    fired.has(model.synapses.partner[s]!),
  )
  const { node, from, t } = model.sites
  return {
    child: Int32Array.from(rows, (s) => node[s]!),
    parent: Int32Array.from(rows, (s) => from[s]!),
    t: Float32Array.from(rows, (s) => t[s]!),
    distance: new Float32Array(rows.length),
    inhibitory: Uint8Array.from(rows, (s) =>
      model.synapseTypes[model.synapses.type[s]!]!.sign === 'inhibitory' ? 1 : 0,
    ),
  }
}

/**
 * When the fired partners' spikes reach their synapses, ms, ascending and each once: every spike at
 * every distinct delay of its partner's synapses (`partnerDelays`), so a partner on both sockets
 * ticks once per socket where the Input spikes table, read back as drive, lists the spike once.
 */
export function inputArrivals(model: CellModelValue, firing: Firing): number[] {
  const { each } = partnerDelays(model)
  const arrivals = new Set<number>()
  for (const [partner, times] of firing) {
    for (const delay of each[partner] ?? [])
      for (const time of times) arrivals.add(time + delay)
  }
  return [...arrivals].sort((a, b) => a - b)
}

/**
 * Where sites sit in the skeleton's frame, xyz interleaved: `t` of the way from each edge's start
 * to its end, the node itself where the edge has no start (the root). What the 3D view draws the
 * fired inputs at — on the cable, where the dendrogram's ticks are, rather than at the synapse
 * cloud's own positions, which the model does not keep.
 */
export function sitePositions(
  positions: Float32Array,
  sites: Pick<SynapseProjection, 'child' | 'parent' | 't'>,
): Float32Array {
  const out = new Float32Array(sites.child.length * 3)
  sites.child.forEach((node, s) =>
    out.set(pointOnEdge(positions, sites.parent[s]!, node, sites.t[s]!), s * 3),
  )
  return out
}
