/**
 * The colours compartments are drawn in, wherever Coda draws them apart.
 *
 * navis's convention — a warm axon, a cool dendrite — because anybody who has looked at a split
 * neuron before reads it without a legend. Fixed rather than ranked: ranked colours would put the
 * *commonest* compartment in slot 0, so the axon would change colour between two neurons. One
 * table for Topology's computed split, the Cortex gallery's published labels and the 3D View's
 * compartment mode alike, so none of them disagrees about which colour means axon. What a code
 * *means* is `compartmentKey`'s, headless; this file only says what each meaning is drawn in.
 */

import type { CompartmentKey, SkeletonsValue } from '../core/values'
import {
  CODE_AXON,
  CODE_DENDRITE,
  CODE_LINKER,
  compartmentKey,
  splitName,
} from '../core/values'
import type { ColorSpec } from '../nodes/lib/encodingParams'
import type { Mode } from '../style/colors'
import { CHART_INK, cycleColor } from '../style/colors'
import type { ResolvedColor } from '../style/encoding'
import { literalColor } from '../style/encoding'

/** The keys the compartment colours can draw, in the order a legend lists them. */
const KEYS = ['axon', 'dendrite', 'linker', 'soma', 'unlabelled'] as const
type Key = CompartmentKey | 'unlabelled'

/**
 * Every compartment's ink: dendrite and axon the first two categorical slots, the linker `muted`,
 * the soma the primary ink, and `secondary` for a node nobody labelled.
 */
export function compartmentInks(mode: Mode): Record<Key, string> {
  const ink = CHART_INK[mode]
  return {
    dendrite: cycleColor(0, mode),
    axon: cycleColor(1, mode),
    linker: ink.muted,
    soma: ink.primary,
    unlabelled: ink.secondary,
  }
}

/**
 * A synapse's two sides as inks, for a drawing that also shows compartments: the palette's next two
 * slots after `compartmentInks`' axon and dendrite (slots 0 and 1), because a tick drawn in the
 * axon's colour would read as axon. Keyed by the word the key prints, `pre` being an output.
 */
export function polarityInks(mode: Mode): { output: string; input: string } {
  return { output: cycleColor(2, mode), input: cycleColor(3, mode) }
}

/**
 * A computed split's codes as their inks — the table for every surface drawing `split` by code
 * (Topology's card, Split Axon/Dendrite's editor). An unassigned node has no entry: each surface
 * says what that looks like.
 */
export function splitInks(mode: Mode): Readonly<Record<number, string>> {
  const ink = compartmentInks(mode)
  return Object.fromEntries(
    [CODE_DENDRITE, CODE_AXON, CODE_LINKER].map((code) => [code, ink[splitName(code)!]]),
  )
}

/** The 3D View's skeleton channel under `compartment`: a colour per node, and its key. */
export type CompartmentShading = ResolvedColor & {
  /** How many skeletons drew a computed split, and how many the source's own labels. */
  readonly drawn: { readonly split: number; readonly source: number }
}

/**
 * Colour every skeleton node by its compartment.
 *
 * **A computed split wins over the source's labels** where an arbour carries both, because wiring
 * Split Axon/Dendrite in front of the viewer is a deliberate act; `drawn` counts which was used so
 * the caption can say, the legend having no title to put it in. A node with no label, and every
 * node of an unlabelled arbour, takes the `unlabelled` ink — under this mode a neuron has no colour
 * of its own to fall back to.
 *
 * The key recolours — an override is keyed by the label, as on every other channel — and has no
 * `labelAt`, a key here being a set of *nodes* where the channel hides whole neurons.
 */
export function compartmentShading(
  skeletons: SkeletonsValue | undefined,
  spec: ColorSpec,
  mode: Mode,
): CompartmentShading {
  const base = compartmentInks(mode)
  const color = {} as Record<Key, string>
  for (const key of KEYS) color[key] = literalColor(spec.overrides?.[key]) ?? base[key]

  const items = (skeletons?.items ?? []).map((item) => ({
    labels: item.split ?? item.compartments,
    computed: item.split !== undefined,
  }))

  const present = new Set<Key>()
  for (const { labels, computed } of items) {
    if (!labels) present.add('unlabelled')
    else for (const code of labels) present.add(compartmentKey(code, computed) ?? 'unlabelled')
  }
  const entries = KEYS.filter((key) => present.has(key)).map((key) => ({
    label: key,
    color: color[key],
  }))

  return {
    at: () => color.unlabelled,
    legend:
      entries.length > 0
        ? { kind: 'categorical', column: 'compartment', entries, truncated: false }
        : undefined,
    nodeAt: (itemIndex, nodeIndex) => {
      const item = items[itemIndex]
      const code = item?.labels?.[nodeIndex]
      const key = code === undefined ? undefined : compartmentKey(code, item!.computed)
      return key && color[key]
    },
    drawn: {
      split: items.filter((item) => item.computed).length,
      source: items.filter((item) => !item.computed && item.labels).length,
    },
  }
}
