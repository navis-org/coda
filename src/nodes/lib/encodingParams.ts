/**
 * Param factories for data-driven visual encodings.
 *
 * Declared once and reused by every viewer that supports encoding, so "colour by a column"
 * means the same thing, has the same param ids, and behaves the same everywhere. The
 * resolution half lives in `ui/encoding.ts`; this half stays headless so `src/nodes` can
 * declare params without pulling in the palette.
 *
 * These are `presentational` by default: an encoding changes how a result is drawn, never
 * what the node returns, so restyling must not invalidate the pipeline. The one exception is
 * a node whose *output is the styled artefact* — see `ColorParamOptions.presentational`.
 */

import type { AttributePart, DType } from '../../core/types'
import { NUMERIC_DTYPES } from '../../core/types'
import type { CompositeRef, ParamDef } from '../../core/node'

/**
 * `default` assigns no colour at all and lets the renderer decide. Only offered where that
 * means something — neuroglancer hash-colours each segment, which is genuinely useful and is
 * also the shortest link. In-app viewers have no such notion, so they do not enable it.
 */
export type ColorMode = 'default' | 'constant' | 'categorical' | 'sequential' | 'literal'

/** The eight validated categorical slots, by name, so a constant colour stays in-palette. */
export const CONSTANT_COLOR_OPTIONS = [
  { value: '0', label: 'blue' },
  { value: '1', label: 'orange' },
  { value: '2', label: 'aqua' },
  { value: '3', label: 'yellow' },
  { value: '4', label: 'magenta' },
  { value: '5', label: 'green' },
  { value: '6', label: 'violet' },
  { value: '7', label: 'red' },
  { value: 'muted', label: 'grey' },
]

/** Modes that map no column, so the column picker has nothing to offer. */
const DATALESS_MODES = new Set<string>(['constant', 'default'])

export interface ColorParamOptions {
  /** Param id prefix, e.g. "node" -> nodeColorMode / nodeColorBy / nodeColor. */
  prefix: string
  /** Input port supplying the attribute schema. */
  from: string
  part?: AttributePart
  /** Shown in the UI, e.g. "Node colour". */
  label: string
  defaultMode?: ColorMode
  /** Slot index or "muted". */
  defaultColor?: string
  /**
   * Column the picker starts on. Empty means "first compatible column", which on a neuron
   * schema is `bodyId` — a categorical encoding over one-value-per-row, folded into eight
   * slots plus grey. That reads as category structure where there is none, so a viewer whose
   * schema has a real label column should name it.
   */
  defaultColumn?: string
  advanced?: boolean
  /** Tab of a grouped styling panel these land in. See `NodeDefinition.paramGroups`. */
  group?: string
  /**
   * Row label inside a grouped panel, where the tab heading already says which half of the
   * network this is — "Node colour" reads as a stutter under a tab called Node.
   */
  rowLabel?: string
  /**
   * Whether restyling leaves the node's output alone. True for every in-app viewer, and
   * false for the one whose output *is* the styled artefact: the Neuroglancer node bakes the
   * colours into the URL it emits, so marking them presentational would leave a link showing
   * colours nobody chose. See the `presentational` contract in `core/node.ts`.
   */
  presentational?: boolean
  /**
   * Offer the `default` mode, labelled by the caller: what happens instead of a Coda colour
   * is renderer-specific, so only the caller can name it.
   */
  allowDefault?: { label: string }
  /**
   * Offer the `literal` mode: the chosen column already holds colours.
   *
   * Opt-in for the reason `allowDefault` is, though the reasoning runs the other way. That one
   * is offered by a single node and would be *wrong* elsewhere; this one is simply useless
   * where nothing upstream produces colours, and a mode that lands on grey for every table in
   * the app is a control that teaches people not to trust the picker.
   *
   * What it is *for*: a producer that has already decided the colours and needs them honoured
   * rather than re-derived. `out.dendrogram` is the first — its `Selected` carries the hue each
   * leaf was drawn in, and `categorical` on the cluster number cannot reproduce it, because
   * `resolveColor` ranks categories by frequency where a dendrogram numbers them left to right.
   */
  allowLiteral?: boolean
  /**
   * Which data-driven modes to offer; defaults to both.
   *
   * Exists because a mode can be wrong for a *mark* rather than for a node. `sequential` on a
   * thin line is the case: the receding end of the blue ramp measures 1.46:1 against the dark
   * surface, and clamping it to clear 3:1 pushes adjacent steps to ΔL 0.047 against a 0.06
   * floor — so the ramp cannot carry both visibility and step separation at that width. See
   * the network viewer's notes in CLAUDE.md.
   */
  modes?: Array<'categorical' | 'sequential'>
}

/**
 * `<prefix>ColorMode`, `<prefix>ColorBy`, `<prefix>Color`.
 *
 * The column picker is hidden in constant mode and the constant swatch is hidden otherwise,
 * so the node body only ever shows the two controls that currently matter.
 */
export function colorParams(options: ColorParamOptions): ParamDef[] {
  const { prefix, from, part, label, defaultMode = 'constant', defaultColor = '0' } = options
  const modeId = `${prefix}ColorMode`
  const base = {
    presentational: options.presentational !== false,
    ...(options.advanced ? { advanced: true } : {}),
    ...(options.group ? { group: options.group } : {}),
  }
  // The mode, the column and the swatch are one property called "colour"; a panel that can
  // say so renders them as one row. The two `value` members are `visibleIf`-exclusive, which
  // is what lets a single slot hold whichever of them currently applies.
  const facet = (role: CompositeRef['role'], extra?: Partial<CompositeRef>): CompositeRef => ({
    key: `${prefix}Color`,
    role,
    label: options.rowLabel ?? label,
    ...extra,
  })

  return [
    {
      ...base,
      composite: facet('primary'),
      id: modeId,
      kind: 'enum',
      label,
      default: defaultMode,
      options: [
        ...(options.allowDefault
          ? [{ value: 'default', label: options.allowDefault.label }]
          : []),
        { value: 'constant', label: 'single colour' },
        ...(options.modes ?? ['categorical', 'sequential']).map((mode) =>
          mode === 'categorical'
            ? { value: 'categorical', label: 'by category' }
            : { value: 'sequential', label: 'by value' },
        ),
        // Last: it is the specialist of the four, and only ever means anything when something
        // upstream has put colours in a column.
        ...(options.allowLiteral ? [{ value: 'literal', label: 'colours in a column' }] : []),
      ],
    },
    {
      ...base,
      composite: facet('value'),
      id: `${prefix}ColorBy`,
      kind: 'column',
      label: `${label} column`,
      from,
      ...(part ? { part } : {}),
      default: options.defaultColumn ?? '',
      visibleIf: (params) => !DATALESS_MODES.has(String(params[modeId] ?? defaultMode)),
    },
    {
      ...base,
      composite: facet('value'),
      id: `${prefix}Color`,
      kind: 'enum',
      label: `${label} value`,
      default: defaultColor,
      options: CONSTANT_COLOR_OPTIONS,
      visibleIf: (params) => (params[modeId] ?? defaultMode) === 'constant',
    },
  ]
}

export interface SizeParamOptions {
  prefix: string
  from: string
  part?: AttributePart
  label: string
  defaultMin: number
  defaultMax: number
  /** Restrict the picker; defaults to numeric columns. */
  dtypes?: DType[]
  advanced?: boolean
  /** Tab of a grouped styling panel these land in. See `NodeDefinition.paramGroups`. */
  group?: string
  /** Row label inside a grouped panel; defaults to `label`. */
  rowLabel?: string
}

/**
 * `<prefix>SizeBy`, `<prefix>SizeMin`, `<prefix>SizeMax`.
 *
 * No column selected means a constant size of `min`, which is the sensible degenerate case
 * and avoids a separate on/off switch.
 */
export function sizeParams(options: SizeParamOptions): ParamDef[] {
  const { prefix, from, part, label, defaultMin, defaultMax } = options
  const base = {
    presentational: true as const,
    ...(options.advanced ? { advanced: true } : {}),
    ...(options.group ? { group: options.group } : {}),
  }
  // Unlike colour there is no mapping enum: an empty column *is* the constant case, which is
  // why the column picker is the row's primary control and the range hangs off it.
  const facet = (role: CompositeRef['role'], extra?: Partial<CompositeRef>): CompositeRef => ({
    key: `${prefix}Size`,
    role,
    label: options.rowLabel ?? label,
    ...extra,
  })

  return [
    {
      ...base,
      composite: facet('primary'),
      id: `${prefix}SizeBy`,
      kind: 'column',
      label,
      from,
      ...(part ? { part } : {}),
      dtypes: options.dtypes ?? NUMERIC_DTYPES,
      default: '',
      optional: true,
    },
    {
      ...base,
      composite: facet('extra', { facet: 'min' }),
      id: `${prefix}SizeMin`,
      kind: 'number',
      label: `${label} min`,
      default: defaultMin,
      min: 0.1,
      step: 0.5,
      advanced: true,
    },
    {
      ...base,
      composite: facet('extra', { facet: 'max' }),
      id: `${prefix}SizeMax`,
      kind: 'number',
      label: `${label} max`,
      default: defaultMax,
      min: 0.1,
      step: 0.5,
      advanced: true,
    },
  ]
}

/** Read an encoding's params back off a node, for the viewer to consume. */
export interface ColorSpec {
  mode: ColorMode
  column: string | undefined
  constant: string
}

export interface SizeSpec {
  column: string | undefined
  min: number
  max: number
}

export function readColorSpec(
  prefix: string,
  params: Record<string, unknown>,
  resolveColumn: (paramId: string) => string | undefined,
): ColorSpec {
  const mode = String(params[`${prefix}ColorMode`] ?? 'constant') as ColorMode
  return {
    mode,
    column: DATALESS_MODES.has(mode) ? undefined : resolveColumn(`${prefix}ColorBy`),
    constant: String(params[`${prefix}Color`] ?? '0'),
  }
}

export function readSizeSpec(
  prefix: string,
  params: Record<string, unknown>,
  resolveColumn: (paramId: string) => string | undefined,
  fallback: { min: number; max: number },
): SizeSpec {
  const min = Number(params[`${prefix}SizeMin`])
  const max = Number(params[`${prefix}SizeMax`])
  return {
    column: resolveColumn(`${prefix}SizeBy`),
    min: Number.isFinite(min) ? min : fallback.min,
    max: Number.isFinite(max) ? max : fallback.max,
  }
}
