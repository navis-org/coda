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

/**
 * How a wire is drawn between two sockets.
 *
 * - `curved`     — React Flow's bezier, for every wire. What the editor has always drawn.
 * - `orthogonal` — right-angled steps throughout: ELK's bend points where it computed some, and
 *                  a plain step path everywhere else.
 *
 * Not a layout option in ELK's sense. `elk.edgeRouting` is deliberately never set, because
 * layered computes orthogonal bend points regardless and the two settings that would change them
 * (`POLYLINE`, `SPLINES`) move the *nodes* as well — a different arrangement rather than a
 * different drawing of one. This chooses what the canvas does with a route ELK already returned.
 *
 * **A third mode was built and removed, and the reason is the important part.** `routed` kept the
 * bezier everywhere *except* on wires ELK had actually bent. It read well on paper and failed in
 * the hand: ELK produces bend points only as a by-product of laying a graph out, so on a canvas
 * nobody had arranged there were no routes at all and the mode was byte-identical to `curved` —
 * a button that did nothing until you pressed a *different* button first. There is no fixing that
 * within ELK: `elk.fixed` honours given positions and returns **zero** routes, and every
 * interactive layered strategy moves the cards anyway. Routing wires around cards that are
 * already placed is an obstacle-routing problem ELK does not solve.
 *
 * `orthogonal` has no such hole, because it steps *every* wire — the ones ELK bent follow the
 * channel it reserved, and the rest take an ordinary step path. So the control always does
 * something visible, whether or not anything has been arranged, which is the property the third
 * mode could not have.
 *
 * That is also the honest reading of the measurement: across the five bundled examples only 10 of
 * 32 edges come back with bend points at all, so a mode keyed *solely* to those was always going
 * to look like it had half worked.
 */
export const EDGE_ROUTINGS = ['curved', 'orthogonal'] as const
export type EdgeRouting = (typeof EDGE_ROUTINGS)[number]

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
   * This is where "edge routing" was going to live and no longer needs to: `EdgeRouting` is a
   * separate control on the rail, and it sets no ELK option at all. Alignment changes how cards
   * line up across layers, which is the thing this slot is actually good for.
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
 *
 * **`pinned` upgrades `FIXED_ORDER` to `FIXED_POS`, and that is what makes a route usable.** ELK
 * spreads a node's sockets by its own `spacing.portPort` rule — a three-output card came out at
 * y 40/80/120 — while a Coda card pairs input *i* and output *i* into one `.port-row`, so
 * opposite sockets share a height. ELK has no constraint that can say so, which means its route
 * endpoints and the sockets React Flow draws from are structurally different numbers. Handing it
 * the measured offsets instead settles it at the layout end rather than by splicing real
 * endpoints onto a computed middle in the renderer.
 *
 * Measured on a four-card graph with a 3-in/3-out node: `FIXED_POS` honoured every offset
 * exactly, still bent the two edges that had to clear a card, and left the node placement
 * unchanged in x and *tidier* in y (row spread 0 against 9.5). Vertical directions stay `FREE`
 * regardless — pinning sockets east and west is the staircase above, and the paragraph before
 * this one is the measurement that says so.
 */
export function elkNodeOptions(direction: LayoutDirection, pinned = false): ElkOptions {
  const horizontal = direction === 'RIGHT' || direction === 'LEFT'
  return {
    'elk.portConstraints': horizontal ? (pinned ? 'FIXED_POS' : 'FIXED_ORDER') : 'FREE',
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
