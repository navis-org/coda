/**
 * What the layout bubble can change, and how it reaches ELK.
 *
 * Six controls, deliberately. ELK exposes several hundred options and layered alone has a few
 * dozen; the ones here are the ones whose effect is visible on a connectome pipeline at a
 * glance. Everything else keeps ELK's own default, which is what a default is for.
 *
 * Kept apart from the React that draws it so the mapping can be asserted headlessly — a wrong
 * option *key* is silently ignored by ELK rather than rejected, so "does this string reach the
 * algorithm" is a real question and `engine.test.ts` answers it against the real thing.
 */

/** ELK's own option record: string keys, string values, all of them. */
export type ElkOptions = Record<string, string>

export const LAYOUT_ALGORITHMS = ['layered', 'force', 'mrtree', 'radial'] as const
export type LayoutAlgorithm = (typeof LAYOUT_ALGORITHMS)[number]

export const LAYOUT_DIRECTIONS = ['RIGHT', 'DOWN', 'LEFT', 'UP'] as const
export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number]

export const LAYOUT_ALIGNMENTS = ['BRANDES_KOEPF', 'LINEAR_SEGMENTS', 'SIMPLE'] as const
export type LayoutAlignment = (typeof LAYOUT_ALIGNMENTS)[number]

export interface LayoutOptions {
  algorithm: LayoutAlgorithm
  direction: LayoutDirection
  /** Gap between neighbours within a layer, in flow units. */
  nodeSpacing: number
  /** Gap between one layer and the next. */
  layerSpacing: number
  /**
   * How layered decides a node's position *along* a layer.
   *
   * This is the control that was going to be "edge routing", and the swap is not cosmetic:
   * only ELK's node positions are kept — React Flow draws its own bezier wires from the
   * sockets — so `elk.edgeRouting` would be a control whose stated effect never appears on
   * screen. Alignment changes how cards line up across layers, which is visible.
   */
  alignment: LayoutAlignment
  /** Lay disconnected pieces out separately and pack them, rather than in one shared field. */
  packComponents: boolean
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  algorithm: 'layered',
  // Every graph in the app already flows left to right, and the sockets are fixed that way:
  // inputs west, outputs east. A default of DOWN would fight the node cards themselves.
  direction: 'RIGHT',
  nodeSpacing: 48,
  layerSpacing: 96,
  alignment: 'BRANDES_KOEPF',
  packComponents: true,
}

/** Bounds for the two spacing sliders. Also what `coerceLayoutOptions` clamps to. */
export const SPACING_RANGE = { min: 16, max: 240 } as const

/**
 * Layout options as ELK wants them, for the *root* graph.
 *
 * The split between this and `ELK_NODE_OPTIONS` is not tidiness: ELK reads algorithm,
 * direction and spacing off the parent of the nodes being arranged, while `portConstraints`
 * is a property *of a node*. Setting the latter on the root applies it to the root and to
 * nothing that matters, and the symptom is a layout that ignores every port — which looks
 * like a plausible layout, just a worse one.
 */
export function elkOptionsFor(options: LayoutOptions): ElkOptions {
  if (options.algorithm !== 'layered') {
    return {
      'elk.algorithm': options.algorithm,
      'elk.direction': options.direction,
      // The other three algorithms have no layers, so the layer slider has nowhere of its own
      // to go. Folding it into the one spacing they do read keeps it from silently doing
      // nothing the moment somebody switches algorithm.
      'elk.spacing.nodeNode': String(Math.max(options.nodeSpacing, options.layerSpacing)),
      'elk.separateConnectedComponents': String(options.packComponents),
      'elk.spacing.componentComponent': String(Math.round(options.nodeSpacing * 1.5)),
    }
  }
  return {
    'elk.algorithm': 'layered',
    'elk.direction': options.direction,
    'elk.spacing.nodeNode': String(options.nodeSpacing),
    'elk.separateConnectedComponents': String(options.packComponents),
    'elk.spacing.componentComponent': String(Math.round(options.nodeSpacing * 1.5)),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(options.layerSpacing),
    'elk.layered.nodePlacement.strategy': options.alignment,
  }
}

/**
 * Per-node options. Not a preference, and not in the bubble — but they do depend on direction,
 * and the reason is measured rather than reasoned.
 *
 * A Coda card draws its inputs on the left and its outputs on the right, always. Telling ELK
 * that (`FIXED_ORDER`, plus a side and an index per socket) is what makes a left-to-right
 * layout arrive straight into the sockets instead of guessing at them.
 *
 * **Under a vertical direction the same truth is actively harmful.** ELK reserves routing space
 * for a wire that has to leave the right-hand edge and come back into the left-hand edge of the
 * node *below*, so a four-node chain laid out `DOWN` comes out as a diagonal staircase rather
 * than a column. Measured on exactly that chain: x-spread **756** under `FIXED_ORDER` or
 * `FIXED_SIDE`, and **39** under `FREE` — the same 648 of vertical travel either way.
 *
 * So vertical directions let ELK place the ports. Nothing is lost by it: ELK's port coordinates
 * are discarded regardless, React Flow draws each wire from the real socket, and a bezier
 * leaving a card's right edge and entering the next one's left edge reads perfectly well when
 * the two are stacked. What would be lost by *not* doing it is the column somebody asked for
 * when they pressed the down arrow.
 */
export function elkNodeOptions(direction: LayoutDirection): ElkOptions {
  const horizontal = direction === 'RIGHT' || direction === 'LEFT'
  return {
    'elk.portConstraints': horizontal ? 'FIXED_ORDER' : 'FREE',
    'elk.spacing.portPort': '12',
  }
}

/**
 * Read a stored record back into options, falling back per field.
 *
 * Per field rather than all-or-nothing: a build that adds a seventh control must not throw away
 * the six someone has already set, and a value from an older build that no longer exists in the
 * union has to degrade to the default rather than reaching ELK as a string it will ignore.
 */
export function coerceLayoutOptions(raw: unknown): LayoutOptions {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT_OPTIONS
  const held = raw as Record<string, unknown>
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback
  const spacing = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(SPACING_RANGE.max, Math.max(SPACING_RANGE.min, Math.round(value)))
      : fallback

  return {
    algorithm: oneOf(held.algorithm, LAYOUT_ALGORITHMS, DEFAULT_LAYOUT_OPTIONS.algorithm),
    direction: oneOf(held.direction, LAYOUT_DIRECTIONS, DEFAULT_LAYOUT_OPTIONS.direction),
    nodeSpacing: spacing(held.nodeSpacing, DEFAULT_LAYOUT_OPTIONS.nodeSpacing),
    layerSpacing: spacing(held.layerSpacing, DEFAULT_LAYOUT_OPTIONS.layerSpacing),
    alignment: oneOf(held.alignment, LAYOUT_ALIGNMENTS, DEFAULT_LAYOUT_OPTIONS.alignment),
    packComponents: held.packComponents !== false,
  }
}
