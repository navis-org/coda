/**
 * The Compartment Model's channel list: what the card stores (`CHANNELS_PARAM`, a row per channel
 * as JSON in an `ids` param, edited in the expanded view), the library as the editor offers it,
 * and how a row becomes the value's channel — a density per region, S/cm².
 *
 * **A row names regions, or none for everywhere.** Regions are the model's own names (`soma`,
 * `axon`, `dendrite`, `linker`; `regions.ts`' `regionLabels`), so a row means the same whether the
 * labels came from the source's SWC codes or the Axon/Dendrite Split — plus any painted in the
 * Regions tab (`paintedRegions`). There is no axon-terminal
 * region (decided for v1.5): a channel on `axon` covers the terminals too.
 *
 * **Density or total per cell.** "Total" is Vieira et al. 2026's comparison (their Fig. 1B): the
 * same conductance in nS, spread over the named regions by membrane area, so moving a channel
 * from the axon to everywhere keeps how much of it the cell has.
 */

import type { CellModelValue } from '../../core/values'
import { COMPARTMENT_KEYS } from '../../core/values'
import { agree, formatNumber, formatSigned, plural } from '../../style/format'
import { HH_GBAR, findChannel, gateSymbol } from '../../biophys/channels'

/** The param the expanded view edits: one `ChannelRow` as JSON per entry. */
export const CHANNELS_PARAM = 'channels'

export interface ChannelRow {
  /** A library channel's id (`channelById`). */
  readonly channel: string
  /** Region names; empty is every compartment. */
  readonly regions: readonly string[]
  /** `density` in mS/cm², or `total` per cell in nS spread over `regions` by area. */
  readonly mode: 'density' | 'total'
  readonly value: number
  /** mV the activation and inactivation gates are moved by: the ΔV50 experiments. 0 is none. */
  readonly activation: number
  readonly inactivation: number
}

/** A channel the editor offers: the library's id, what to call it, and a starting density. */
export interface ChannelOption {
  readonly id: string
  readonly label: string
  /** What it is and where its kinetics come from, for the row's "?". The numbers are derived. */
  readonly about: string
  /** mS/cm², what a row starts at, and what it is reset to when the channel is changed. */
  readonly density: number
  /**
   * Where a new row of it goes, and where a row still at its old channel's placement goes on being
   * switched to it: everywhere when absent. The fly set's is the axon, as their model's.
   */
  readonly regions?: readonly string[]
  /** Why that density, where it is somebody's. */
  readonly densitySource: string
}

/** The fly set's placement: the axon, where Günay et al.'s model put the channels. */
const FLY_REGIONS: readonly string[] = ['axon']

export const CHANNEL_OPTIONS: readonly ChannelOption[] = [
  {
    id: 'pospischil.na',
    label: 'Na (Pospischil)',
    about:
      'Fast sodium with Traub-style rates (Pospischil et al. 2008), as Jaxley implements it: the "default active sodium" of Vieira et al. 2026, Fig. 1. Not fitted to a fly neuron.',
    density: 30,
    densitySource: 'Vieira et al.’s axonal density in Fig. 1; Jaxley’s own default is 50',
  },
  {
    id: 'pospischil.k',
    label: 'K (Pospischil)',
    about:
      'Delayed-rectifier potassium with Traub-style rates (Pospischil et al. 2008), as Jaxley implements it, paired with its sodium in Vieira et al. 2026, Fig. 1. Not fitted to a fly neuron.',
    density: 5,
    densitySource: 'Jaxley’s default',
  },
  {
    id: 'hh.na',
    label: 'Na (squid HH)',
    about:
      'The squid giant axon’s fast sodium (Hodgkin & Huxley 1952), as NEURON’s hh.mod. Useful to ask whether inputs could drive a spike at all, not to predict a fly neuron’s firing.',
    density: HH_GBAR.na * 1000,
    densitySource: 'hh.mod’s',
  },
  {
    id: 'hh.k',
    label: 'K (squid HH)',
    about:
      'The squid giant axon’s delayed-rectifier potassium (Hodgkin & Huxley 1952), as NEURON’s hh.mod.',
    density: HH_GBAR.k * 1000,
    densitySource: 'hh.mod’s',
  },
  /*
   * Günay et al. 2015's four, fitted to voltage-clamp recordings from Drosophila neurons. A new row
   * is their reconstructed model's axon: on the axon (`FLY_REGIONS`) at its densities (Table 4,
   * "Recon. axon only"; their NEURON session sets the same in S/cm²). Placed on the whole cell,
   * NaT's window current keeps a cell with a weak leak firing on its own (the PN and optic-lobe
   * presets), where a leakier one rests near −60 mV — so the axon, where their model put them.
   */
  {
    id: 'gunay.nat',
    label: 'NaT (fly, Günay)',
    about:
      'Transient sodium of the Drosophila larval aCC motoneuron (Günay et al. 2015, Table 5): the para current, fitted to voltage-clamp recordings from fly neurons. A fly’s channel, though a motoneuron’s rather than a central brain neuron’s. A new row is their model’s axon, where they placed it: on the whole cell its window current can keep the cell firing on its own.',
    regions: FLY_REGIONS,
    density: 180,
    densitySource: 'their reconstructed model’s axon',
  },
  {
    id: 'gunay.nap',
    label: 'NaP (fly, Günay)',
    about:
      'Persistent sodium of the Drosophila larval aCC motoneuron (Günay et al. 2015, Table 5): it never inactivates, so tiny densities matter.',
    regions: FLY_REGIONS,
    density: 0.0001,
    densitySource: 'their reconstructed model’s axon, 0.1 µS/cm²',
  },
  {
    id: 'gunay.ks',
    label: 'Ks (fly, Günay)',
    about:
      'Slow delayed-rectifier potassium of the Drosophila larval aCC motoneuron (Günay et al. 2015, Table 5): the Shab current, non-inactivating, which repolarises the spike.',
    regions: FLY_REGIONS,
    density: 400,
    densitySource: 'their reconstructed model’s axon',
  },
  {
    id: 'gunay.kf',
    label: 'Kf (fly, Günay)',
    about:
      'Fast A-type potassium of the Drosophila larval aCC motoneuron (Günay et al. 2015, Table 5): the Shal current. It inactivates within milliseconds once depolarised and recovers slowly near rest. Their text mentions a second, slower inactivation that their table and code leave out, as here.',
    regions: FLY_REGIONS,
    density: 192.8,
    densitySource:
      'Ks’s 400 at their isopotential model’s Kf : Ks ratio, 24.1 : 50 nS; their reconstructed model has no Kf',
  },
]

/** A new row's everything but its channel and amount: everywhere, a density, unshifted. */
const NEW_ROW = { regions: [], mode: 'density', activation: 0, inactivation: 0 } as const

/**
 * How far one arrow press or one pixel of scrubbing moves a density, mS/cm²: the order of the
 * channel's starting density, never more than 1. Fixed per channel, so a press down and a press up
 * cancel and 0 is reachable — a step read off the row's value shrank tenfold at every decade on the
 * way down and never arrived. Persistent sodium, starting at 0.0001, moves by 0.0001 rather than by
 * ten thousand times itself; every other channel moves by 1.
 */
export function densityStep(channel: string): number {
  const start = startingDensity(channel)
  return start > 0 ? Math.min(1, 10 ** Math.floor(Math.log10(start))) : 1
}

/** mS/cm² a channel's row starts at: the option's own, 0 for a channel the editor does not offer. */
function startingDensity(channel: string): number {
  return channelOption(channel)?.density ?? 0
}

/** A new row: the channel at its own starting density, everywhere, unshifted. */
export function newChannelRow(channel: string): ChannelRow {
  return {
    ...NEW_ROW,
    channel,
    value: startingDensity(channel),
    regions: defaultRegions(channel),
  }
}

/** Where a channel's new row goes: its own regions, or everywhere. */
function defaultRegions(channel: string): readonly string[] {
  return channelOption(channel)?.regions ?? []
}

const sameRegions = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((r) => b.includes(r))

/**
 * A row moved to another channel: a density starts again at the new channel's own, since one
 * channel's density says nothing about another's; a total per cell is kept, there being no
 * per-channel default to reset it to.
 */
export function changeChannel(row: ChannelRow, channel: string): ChannelRow {
  return {
    ...row,
    channel,
    ...(row.mode === 'density' ? { value: startingDensity(channel) } : {}),
    // A row still where its channel puts one takes the new channel's placement; one placed by hand
    // keeps its own — whichever order the channels were chosen in.
    ...(sameRegions(row.regions, defaultRegions(row.channel))
      ? { regions: defaultRegions(channel) }
      : {}),
    // A ΔV50 is an experiment on one channel's gates, not something to carry onto another's.
    activation: 0,
    inactivation: 0,
  }
}

/** The squid HH soma, as two rows — what "Active soma" was before channels were a list. */
export const SQUID_SOMA: readonly ChannelRow[] = ['hh.na', 'hh.k'].map((id) => ({
  ...newChannelRow(id),
  regions: ['soma'],
}))

/** Superscript digits, for a gate's exponent: m³h. */
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const superscript = (n: number) => Array.from(String(n), (d) => SUPERSCRIPT[Number(d)]).join('')

/** The editor's option for a library channel, or undefined for one it does not offer. */
export function channelOption(id: string): ChannelOption | undefined {
  return CHANNEL_OPTIONS.find((o) => o.id === id)
}

/**
 * A channel's "?" text: what it is, then the facts read off the library — its gating, reversal and
 * temperature dependence — and the density a row starts at. Derived rather than written beside
 * the prose, so the explanation and the solver cannot disagree.
 */
export function describeChannel(option: ChannelOption): string[] {
  const spec = findChannel(option.id)
  const lines = [option.about]
  if (spec) {
    const gating = spec.gates
      .map((g) => `${gateSymbol(g.kinetics)}${g.power > 1 ? superscript(g.power) : ''}`)
      .join('')
    // Signed both ways: a reversal is read for its side of zero.
    const reversal = `${formatSigned(spec.eRev, { plus: true })} mV`
    const temperature = spec.q10
      ? `Rates ×${formatNumber(spec.q10.q10)} per 10 °C from ${formatNumber(spec.q10.temperature)} °C, set by Temperature.`
      : 'No temperature dependence.'
    lines.push(`Gating ${gating}, reversal ${reversal}. ${temperature}`)
  }
  lines.push(`Starts at ${formatNumber(option.density)} mS/cm² (${option.densitySource}).`)
  return lines
}

/**
 * The name of region 0 in every model's table: cable nobody labelled, which no row can name — a
 * channel reaches it only by being placed everywhere.
 */
export const UNLABELLED_REGION = 'unlabelled'

/**
 * Membrane per region, µm², indexed as `regionNames`: what says a region exists in a built model —
 * the channel rows placed on it, and the Model tab's figures alike.
 */
export function regionAreas(cable: {
  readonly regionNames: readonly string[]
  readonly region: ArrayLike<number>
  readonly area: ArrayLike<number>
}): Float64Array {
  const out = new Float64Array(cable.regionNames.length)
  for (let c = 0; c < cable.area.length; c++) out[cable.region[c]!]! += cable.area[c]!
  return out
}

/** Whether a row or a stroke can name a region: any name but unlabelled cable's, or none. */
export function isNameableRegion(name: string): boolean {
  return name !== '' && name !== UNLABELLED_REGION
}

/** The regions a row or a stroke can name, of a model's. */
export function nameableRegions(names: readonly string[]): readonly string[] {
  return names.filter(isNameableRegion)
}

/** The regions the editor offers before a model has run and named its own: every compartment kind. */
export const DEFAULT_REGIONS: readonly string[] = COMPARTMENT_KEYS

export function writeChannelRow(row: ChannelRow): string {
  return JSON.stringify(row)
}

/** The stored rows, any entry that does not read as one dropped. */
export function readChannelRows(raw: unknown): ChannelRow[] {
  if (!Array.isArray(raw)) return []
  const rows: ChannelRow[] = []
  for (const entry of raw) {
    try {
      const r = JSON.parse(String(entry)) as Record<string, unknown>
      if (typeof r.channel !== 'string' || !Number.isFinite(r.value)) continue
      rows.push({
        channel: r.channel,
        regions: Array.isArray(r.regions) ? r.regions.filter((x) => typeof x === 'string') : [],
        mode: r.mode === 'total' ? 'total' : 'density',
        value: Number(r.value),
        activation: Number(r.activation) || 0,
        inactivation: Number(r.inactivation) || 0,
      })
    } catch {
      // Not a row: dropped, as a hand-edited file's stray entry is.
    }
  }
  return rows
}

/**
 * The rows as the value's channels, on a built cable: each named region resolved against the
 * model's own names, a total spread over the named regions' membrane area, densities in S/cm².
 * A region the model has none of, a total with no membrane to spread over, and unlabelled cable
 * that region-placed channels skip are each said in `notes`.
 */
export function resolveChannels(
  rows: readonly ChannelRow[],
  cable: {
    readonly regionNames: readonly string[]
    readonly region: ArrayLike<number>
    /** µm² per compartment. */
    readonly area: ArrayLike<number>
  },
  notes: string[],
  /** How to get a soma under the card's soma mode, a sentence without its full stop. */
  addSoma: string,
): CellModelValue['channels'] {
  // Membrane per region: a name the model has but no compartment carries — a fragment the build
  // dropped, a soma whose node was painted over — is as missing as one it never had.
  const regionArea = regionAreas(cable)
  // A set of regions' membrane, each region once however often a row names it; none is everywhere.
  const areaOf = (codes: readonly number[]) =>
    codes.length === 0
      ? regionArea.reduce((a, b) => a + b, 0)
      : [...new Set(codes)].reduce((sum, code) => sum + (regionArea[code] ?? 0), 0)
  const missing = new Set<string>()
  const unknown = new Set<string>()
  const channels: CellModelValue['channels'][number][] = []
  for (const row of rows) {
    // A channel this build does not have — a hand-edited file, a newer one — is said here, at the
    // model, rather than thrown later by Simulate.
    if (!findChannel(row.channel)) {
      unknown.add(row.channel)
      continue
    }
    const named = row.regions.filter((name) => {
      const known = isNameableRegion(name) && regionArea[cable.regionNames.indexOf(name)]! > 0
      if (!known) missing.add(name)
      return known
    })
    // A row whose every region is missing sits nowhere — not everywhere, which `[]` would mean.
    if (row.regions.length > 0 && named.length === 0) continue
    const codes = named.map((name) => cable.regionNames.indexOf(name))
    let density = row.value / 1000
    if (row.mode === 'total') {
      const area = areaOf(codes)
      if (!(area > 0)) continue
      // nS over µm²: 1e-9 S / 1e-8 cm².
      density = (row.value * 0.1) / area
    }
    const { activation, inactivation } = row
    channels.push({
      id: row.channel,
      regions: named,
      density,
      shift: { activation, inactivation },
    })
  }
  if (unknown.size > 0) {
    notes.push(
      `${plural(unknown.size, 'channel')} ${agree(unknown.size, 'is', 'are')} not in this build's ` +
        `library and ${agree(unknown.size, 'was', 'were')} left out: ${[...unknown].join(', ')}.`,
    )
  }
  if (missing.size > 0) {
    // The soma's remedy is its own: there is no soma to label, only one to add.
    const remedy = missing.has('soma')
      ? `${addSoma}, label or paint the other regions, or place the channels everywhere.`
      : 'Label the skeleton with Split Axon/Dendrite, paint the regions, or place them everywhere.'
    notes.push(
      `This model has no ${[...missing].join(' or ')} cable, so channels placed there sit nowhere. ${remedy}`,
    )
  }
  // Unlabelled cable gets only what is placed everywhere; say how much of the membrane that is.
  if (rows.some((row) => row.regions.length > 0)) {
    const unlabelled = areaOf([cable.regionNames.indexOf(UNLABELLED_REGION)])
    const total = areaOf([])
    if (unlabelled > 0 && total > 0) {
      notes.push(
        `${formatNumber(Math.round((100 * unlabelled) / total))}% of the membrane is unlabelled, ` +
          `so the ${plural(rows.filter((r) => r.regions.length > 0).length, 'channel')} placed by ` +
          'region skip it.',
      )
    }
  }
  return channels
}
