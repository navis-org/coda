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
import type { CompositeRef, EnumOption, ParamDef } from '../../core/node'
import { ALL_SHAPES } from '../../ui/encoding'

/**
 * `default` assigns no colour at all and lets the renderer decide. Only offered where that
 * means something — neuroglancer hash-colours each segment, which is genuinely useful and is
 * also the shortest link. In-app viewers have no such notion, so they do not enable it.
 */
export type ColorMode =
  | 'default'
  | 'constant'
  | 'categorical'
  | 'sequential'
  | 'literal'
  /** One colour per distinct value, derived from the value. See `ui/segmentColor.ts`. */
  | 'hash'
  /**
   * One colour per connected component of a network. Nodes only, and network-only — see
   * `allowComponent`.
   *
   * A mode rather than a column, because the component is not *in* the data: it is derived
   * from the link set, and a column picker can only offer what the schema already has.
   */
  | 'component'
  /**
   * A link takes the colour of the node at one of its ends. Links only — see `allowEndpoints`.
   *
   * The other network mode that no column can express, and this one is not even a derived
   * column: what it resolves to is the *node* encoding's answer for a different table's row.
   */
  | 'sourceNode'
  | 'targetNode'

/**
 * Which categorical palette an encoding cycles through.
 *
 * Names only — the hex values live in `ui/colors.ts`, because this half stays headless so
 * `src/nodes` can declare params without pulling in the palette. Same split as
 * `CONSTANT_COLOR_OPTIONS`, which names slots and knows no colours either.
 */
export type PaletteName = 'coda' | 'okabeIto' | 'tableau10' | 'paired' | 'tab20'

/**
 * The palettes, with their size in the label.
 *
 * The size *is* the reason to switch — it is how many categories get a colour of their own
 * before the ramp comes round again — so it belongs in the words somebody reads while choosing,
 * not in a help string underneath.
 */
export const PALETTE_OPTIONS: Array<{ value: PaletteName; label: string }> = [
  { value: 'coda', label: 'Coda (8)' },
  { value: 'okabeIto', label: 'Okabe–Ito (8, CVD-safe)' },
  { value: 'tableau10', label: 'Tableau (10)' },
  { value: 'paired', label: 'Paired (12)' },
  { value: 'tab20', label: 'tab20 (20)' },
]

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
  /*
   * The two ends, outside the validated ramp on purpose.
   *
   * Neither is a *series* colour and neither is offered as one — they never come out of a
   * categorical encoding, only out of somebody choosing them. What they are for is a figure:
   * black ink on the light background a paper wants, white on a dark one. Both are therefore
   * fixed rather than theme-flipped, because "black" that turns white when the editor's theme
   * changes is not the thing that was asked for.
   */
  { value: 'black', label: 'black' },
  { value: 'white', label: 'white' },
]

/**
 * Modes that map no column, so the column picker has nothing to offer.
 *
 * The three network modes are here for a different reason from `constant` and `default`: they
 * do map data, just not a *column* of the table being encoded. A component is derived from the
 * link set and a link's endpoint colour comes from the node table, so in both cases a picker
 * over this table's columns has nothing to say.
 */
const DATALESS_MODES = new Set<string>([
  'constant',
  'default',
  'component',
  'sourceNode',
  'targetNode',
])

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
   * schema is `neuronId` — a categorical encoding over one-value-per-row, folded into eight
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
   * Offer the `hash` mode: one colour per distinct value, computed from the value.
   *
   * Opt-in, and the reason is not that it might be wrong — it is that it might be *redundant*.
   * The Neuroglancer node already offers `default`, which sends no colours and lets
   * neuroglancer hash them; since Coda's hash is neuroglancer's, adding this there would put
   * two spellings of one behaviour in one dropdown.
   *
   * Everywhere else the question is whether the mark has identity worth encoding. A neuron
   * does. A bar in a chart, an axis, a trend line do not — a hash over categories is eight
   * arbitrary hues where the validated palette is eight chosen ones, and the palette wins
   * whenever the colour carries meaning rather than identity.
   */
  allowHash?: boolean
  /**
   * Offer the `component` mode: a colour per connected component of the network.
   *
   * Network nodes only — nothing else being encoded in this app *has* components — and opt-in
   * for the reason `allowHash` is: a mode that lands on one grey blob for every table in the
   * app is a control that teaches people not to trust the picker.
   *
   * What it is for is the first question anybody asks of an unfamiliar graph: is this one
   * thing, or several? A drawing answers that badly — a force layout can put two components in
   * one blob and split one across the canvas — and a colour answers it exactly.
   */
  allowComponent?: boolean
  /**
   * Offer `sourceNode` / `targetNode`: a link takes the colour of the node at one of its ends.
   *
   * Links only. What it buys is a picture of *flow*: with nodes coloured by type, colouring
   * links by their source shows where each type's output goes at a glance, which is the reading
   * a categorical encoding over the `source` column cannot give — that one would rank the
   * palette by link count and land on colours that disagree with the nodes an inch away.
   *
   * Note it deliberately produces **no legend**. The node colour's key already names every
   * colour on screen, and a second strip repeating the same eight swatches under the word
   * "links" is the stutter `NetworkLegend` exists to avoid.
   */
  allowEndpoints?: boolean
  /**
   * Offer a palette dropdown for the categorical modes.
   *
   * Opt-in because it is a control worth having only where a *lot* of categories turn up on
   * one screen — a connectome's cell types — and where the marks are individual enough that
   * cycling is readable. A chart with three series does not need somebody to choose between
   * five palettes to hold three colours.
   */
  palettes?: boolean
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
  /**
   * Add the two params an *interactive* legend writes: which keys are hidden, and which have
   * been given a colour of their own.
   *
   * Opt-in rather than automatic, because they are only meaningful where a viewer actually
   * draws an interactive strip — a node carrying params nothing can write is a node with two
   * controls that never move. Both are `advanced`, so they reach the inspector (where the
   * count and its `clear` are the way back out) and not the card.
   */
  legend?: boolean
  /**
   * Give this encoding an opacity, rendered as part of the colour row rather than beside it.
   *
   * A colour and how much of it comes through are one decision, and the panel now says so:
   * `role: 'extra'` puts the slider in the colour's own row. It is a channel-wide setting, not
   * a per-key one — a native colour input has no alpha channel to expose, and per-key alpha
   * would leave a categorical scene with no overrides unable to be translucent at all.
   *
   * Only offered where the mark *has* an opacity worth setting: a surface. Lines and points
   * would need transparent materials and a sorting story that neither has.
   */
  alpha?: { default: number; help?: string }
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
      ...(options.allowHash
        ? {
            help:
              'A colour each hashes the chosen column — neuroglancer’s own hash, so a neuron ' +
              'keeps the colour it has in a neuroglancer view. By category uses the eight ' +
              'validated palette slots and folds the rest into grey, which is the better ' +
              'choice when the colour stands for a group rather than for an individual.',
          }
        : {}),
      options: [
        ...(options.allowDefault
          ? [{ value: 'default', label: options.allowDefault.label }]
          : []),
        { value: 'constant', label: 'single colour' },
        // Second, because where it is offered it is usually the answer: it is the only mode
        // that can tell a hundred neurons apart.
        ...(options.allowHash ? [{ value: 'hash', label: 'a colour each' }] : []),
        ...(options.modes ?? ['categorical', 'sequential']).map((mode) =>
          mode === 'categorical'
            ? { value: 'categorical', label: 'by category' }
            : { value: 'sequential', label: 'by value' },
        ),
        // After the column-driven modes, because it is one of those in spirit — a category
        // per node — over a column the data does not carry.
        ...(options.allowComponent
          ? [{ value: 'component', label: 'by connected component' }]
          : []),
        ...(options.allowEndpoints
          ? [
              { value: 'sourceNode', label: 'by upstream node' },
              { value: 'targetNode', label: 'by downstream node' },
            ]
          : []),
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
    ...(options.palettes
      ? ([
          {
            ...base,
            presentational: true,
            /*
             * A facet of the colour row, not a row of its own: which palette and which column
             * are one decision called "colour", and the panel now says so.
             */
            composite: facet('extra', { facet: 'palette' }),
            id: `${prefix}Palette`,
            kind: 'enum',
            label: `${label} palette`,
            default: 'coda',
            options: [...PALETTE_OPTIONS],
            help:
              'Which colours a category encoding cycles through. The number is how many ' +
              'categories get a colour of their own before it comes round again — pick a ' +
              'bigger one when the legend says colours repeat. Okabe–Ito is the set to use ' +
              'when the figure has to survive colour-blindness; only Coda is tuned for both ' +
              'the light and the dark background, so the pale members of Paired and tab20 are ' +
              'weak on a light one.',
            /*
             * Only where a palette is what is being cycled. `constant` and `literal` name their
             * own colours, `sequential` is a ramp rather than a set, `hash` derives a colour per
             * value from the value itself, and a link taking its endpoint's colour is reading
             * the *node* channel's palette rather than one of its own.
             */
            visibleIf: (params) => {
              const current = String(params[modeId] ?? defaultMode)
              return current === 'categorical' || current === 'component'
            },
          },
        ] satisfies ParamDef[])
      : []),
    ...(options.alpha
      ? ([
          {
            ...base,
            presentational: true,
            advanced: options.advanced === true,
            composite: facet('extra', { facet: 'opacity' }),
            id: `${prefix}Opacity`,
            kind: 'number',
            label: `${label} opacity`,
            default: options.alpha.default,
            min: 0.02,
            max: 1,
            step: 0.02,
            slider: true,
            ...(options.alpha.help ? { help: options.alpha.help } : {}),
          },
        ] satisfies ParamDef[])
      : []),
    ...(options.legend
      ? ([
          {
            ...base,
            /*
             * Presentational, and that is the whole distinction the Network Viewer's filters
             * record from the other side. Hiding a key changes what is *drawn* and nothing
             * else — the node still emits the same selection — so it must not join the
             * provenance key and must not stale anything downstream. A filter that changed the
             * output would have to be the opposite, and say so on its tab.
             */
            presentational: true,
            advanced: true,
            id: `${prefix}Hidden`,
            kind: 'ids',
            label: `${label} — hidden`,
            noun: 'keys',
            default: [],
            help: 'Legend keys hidden from the scene. Set by the eye toggle on the legend.',
            /*
             * Shown only once it holds something, which is not the usual reason for a
             * `visibleIf`.
             *
             * These two are written by the legend and read by nobody else, so at rest they are
             * an empty row and an empty text box in every panel — controls that look like
             * something to fill in and are not. When one *is* set they become worth seeing, and
             * the `clear` beside the count is a second way out from a state the legend can also
             * undo. Safe under invariant 4 either way: both are presentational, so neither was
             * ever in the provenance key for the hiding rule to change.
             */
            visibleIf: (params) =>
              Array.isArray(params[`${prefix}Hidden`]) &&
              (params[`${prefix}Hidden`] as unknown[]).length > 0,
          },
          {
            ...base,
            presentational: true,
            advanced: true,
            id: `${prefix}ColorOverrides`,
            kind: 'string',
            label: `${label} — overrides`,
            default: '',
            help: 'Per-key colours chosen from the legend swatches, as JSON. Empty means the palette decides.',
            visibleIf: (params) => String(params[`${prefix}ColorOverrides`] ?? '') !== '',
          },
        ] satisfies ParamDef[])
      : []),
  ]
}

/**
 * Read a `<prefix>ColorOverrides` or `<prefix>ShapeOverrides` param into a map.
 *
 * One reader for both channels, because it is one encoding: a JSON object of legend key to
 * chosen value. It was `readColorOverrides` while colour was the only channel that had
 * overrides; a second copy spelled `readShapeOverrides` is how the two would acquire different
 * tolerances for the same malformed string.
 *
 * Tolerant on purpose: the value is a string in a saved file, and a hand-edited or truncated
 * one is not a reason for a viewer to throw mid-render. Anything unreadable means "no
 * overrides", which is the state every graph written before this existed is already in.
 *
 * It does **not** check that the values mean anything. That check belongs where the value is
 * used — `resolveColor` has `literalColor` and `resolveShape` has `isMarkerShape`, each with a
 * rule for a cell that is not one — and doing it in both places is how the two acquire
 * different rules.
 */
export function readOverrides(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, cell] of Object.entries(parsed)) {
      if (typeof cell === 'string') out[key] = cell
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The other half of `readOverrides`, so the encoding is written where it is read.
 *
 * It was a bare `JSON.stringify` in the 3D viewer's click handler — the decode half in
 * `src/nodes/lib` and the encode half in a React component, which is the split invariant 3
 * exists to object to. The next viewer that offers recolouring gets the same spelling by
 * calling this rather than by remembering what the reader expects.
 *
 * An empty map writes the **empty string**, not `{}`: that is what the param's declared default
 * is, what `visibleIf` tests for, and what `readColorSpec` treats as "no overrides".
 */
export function writeOverrides(overrides: Readonly<Record<string, string>>): string {
  return Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : ''
}

/**
 * The legend keys hidden for one channel, off a node's params.
 *
 * The sibling of `readColorSpec`, and it exists for the same reason: `colorParams({ legend })`
 * *generates* `<prefix>Hidden`, so the name is the factory's to know and not a viewer's to spell
 * out per channel. It was four literal reads in `ValuePreview` — one per socket — against a
 * param id built by string concatenation in the component that writes it back, with nothing to
 * catch the two drifting apart. A hidden list that no one reads is an eye toggle that silently
 * does nothing.
 *
 * Tolerant in the same way and for the same reason: the value is whatever a saved file holds,
 * and a graph written before the legend existed has no key for it at all.
 */
export function readHiddenKeys(prefix: string, params: Record<string, unknown>): string[] {
  const value = params[`${prefix}Hidden`]
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

/** The two things a shape channel can be told to do. Sequential has no meaning for a shape. */
export type ShapeMode = 'constant' | 'categorical'

export interface ShapeParamOptions {
  /** Param id prefix, e.g. "node" -> nodeShapeMode / nodeShapeBy / nodeShape. */
  prefix: string
  from: string
  part?: AttributePart
  label: string
  defaultMode?: ShapeMode
  defaultShape?: string
  defaultColumn?: string
  advanced?: boolean
  group?: string
  rowLabel?: string
  presentational?: boolean
  /** Whether to generate the `<prefix>ShapeOverrides` companion the legend writes into. */
  legend?: boolean
}

export interface ShapeSpec {
  mode: ShapeMode
  column: string | undefined
  /** The shape every mark takes in `constant` mode, and the fallback everywhere else. */
  constant: string
  /** Per-key shapes chosen from the legend. Keyed by legend label, `Other` included. */
  overrides?: Readonly<Record<string, string>>
}

/**
 * The shapes a picker offers, in assignment order.
 *
 * Derived from `ALL_SHAPES` rather than transcribed. It was written out here on the grounds
 * that `src/nodes` must not reach into `src/ui` — which is not a rule this repo holds:
 * `eslint.config.js` scopes that boundary to `src/core`, `src/data`, `src/assistant`,
 * `src/layout` and `src/pyodide`, and `output/neuroglancer.ts` and `output/dendrogram.ts`
 * already import from `src/ui/encoding`. So the copy bought nothing and cost a hand-maintained
 * second list plus a test to keep the two in step.
 *
 * The reverse import is type-only and erases, so this adds no runtime cycle.
 */
export const SHAPE_OPTIONS: EnumOption[] = ALL_SHAPES.map((value) => ({
  value,
  label: value,
}))

/**
 * The shape channel's params: `<prefix>ShapeMode`, `<prefix>ShapeBy`, `<prefix>Shape`.
 *
 * Deliberately the same shape as `colorParams`, down to the composite facets, because the two
 * are the same idea over a different visual variable and a panel that renders one should render
 * the other without learning anything new. What it does *not* have is a palette: there is one
 * set of six marks and no second ordering of them worth offering.
 */
export function shapeParams(options: ShapeParamOptions): ParamDef[] {
  const { prefix, from, part, label, defaultMode = 'constant', defaultShape = 'circle' } = options
  const modeId = `${prefix}ShapeMode`
  const base = {
    presentational: options.presentational !== false,
    ...(options.advanced ? { advanced: true } : {}),
    ...(options.group ? { group: options.group } : {}),
  }
  const facet = (role: CompositeRef['role'], extra?: Partial<CompositeRef>): CompositeRef => ({
    key: `${prefix}Shape`,
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
      help:
        'Shape is a coarser channel than colour: six marks, and everything past the sixth ' +
        'commonest value folds into a dash rather than reusing one. Pointing shape and ' +
        'colour at the same column is the usual reason to set it — two channels saying one ' +
        'thing is what makes a picture readable without colour.',
      options: [
        { value: 'constant', label: 'single shape' },
        { value: 'categorical', label: 'by category' },
      ],
    },
    {
      ...base,
      composite: facet('value'),
      id: `${prefix}ShapeBy`,
      kind: 'column',
      label: `${label} column`,
      from,
      ...(part ? { part } : {}),
      default: options.defaultColumn ?? '',
      visibleIf: (params) => String(params[modeId] ?? defaultMode) === 'categorical',
    },
    {
      ...base,
      composite: facet('value'),
      id: `${prefix}Shape`,
      kind: 'enum',
      label: `${label} mark`,
      default: defaultShape,
      options: [...SHAPE_OPTIONS],
      visibleIf: (params) => String(params[modeId] ?? defaultMode) !== 'categorical',
    },
    ...(options.legend
      ? ([
          {
            ...base,
            presentational: true,
            advanced: true,
            id: `${prefix}ShapeOverrides`,
            kind: 'string',
            label: `${label} — overrides`,
            default: '',
            help: 'Per-key shapes chosen from the legend marks, as JSON. Empty means the ranking decides.',
            visibleIf: (params) => String(params[`${prefix}ShapeOverrides`] ?? '') !== '',
          },
        ] satisfies ParamDef[])
      : []),
  ]
}

/** Read a `<prefix>Shape*` group off a node's params. The sibling of `readColorSpec`. */
export function readShapeSpec(
  prefix: string,
  params: Record<string, unknown>,
  column: (id: string) => string | undefined,
): ShapeSpec {
  const overrides = readOverrides(params[`${prefix}ShapeOverrides`])
  return {
    mode:
      String(params[`${prefix}ShapeMode`] ?? 'constant') === 'categorical'
        ? 'categorical'
        : 'constant',
    // Resolved once and assigned unconditionally, as `readColorSpec` does: the resolver is not
    // free, and a conditional spread here called it twice to decide whether to call it.
    column: column(`${prefix}ShapeBy`),
    constant: String(params[`${prefix}Shape`] ?? 'circle'),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  }
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
  /**
   * Per-legend-key colours, chosen by hand, overriding the palette slot.
   *
   * Only categorical encodings have keys, so this is only consulted there. Note it is part of
   * the *spec* rather than something a viewer applies afterwards: the legend and the marks
   * have to agree, and one place decides.
   */
  overrides?: Readonly<Record<string, string>>
  /**
   * Which palette a categorical encoding cycles through. Undefined means `coda`.
   *
   * Part of the spec rather than a viewer argument for the reason `overrides` is: the legend
   * and the marks it keys have to agree, and one place decides.
   */
  palette?: PaletteName
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
  const overrides = readOverrides(params[`${prefix}ColorOverrides`])
  return {
    mode,
    column: DATALESS_MODES.has(mode) ? undefined : resolveColumn(`${prefix}ColorBy`),
    constant: String(params[`${prefix}Color`] ?? '0'),
    // Tolerant like the rest of this reader: a graph saved before the dropdown existed has no
    // key at all, and `paletteColors` reads a missing or unknown name as `coda`.
    ...(params[`${prefix}Palette`]
      ? { palette: String(params[`${prefix}Palette`]) as PaletteName }
      : {}),
    // Omitted when empty rather than carried as `{}`, because these specs are memoised *by
    // value* (`useStable`) and an always-present empty object is one more thing to serialise
    // on every render of every viewer that never had an override.
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
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
