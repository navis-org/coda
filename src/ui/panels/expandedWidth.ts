/**
 * How wide a node gets when it is expanded.
 *
 * The overlay fills the backdrop's height for everything, and for most of what opens in it the
 * width should follow: a scene, a heatmap, a network or a table *is* the content, and every
 * pixel of a 4K display is worth something. So the default here is `'full'`.
 *
 * The exceptions are the surfaces whose layout is bound by something other than the panel, and
 * they fail in two distinct ways past a certain width:
 *
 * - **A tile grid gains columns rather than size.** `.tiles` is
 *   `repeat(auto-fit, minmax(190px, 1fr))`, so Profile and Dataset Summary answer a wider panel
 *   with *more, narrower* tiles — twenty-six of them across a 5K screen, each a bar chart about
 *   as wide as its own axis labels. The cap is what keeps a tile the size of a thing you can
 *   read.
 * - **Prose and lists have a measure.** `.overlay .markdown` holds a blurb to 70ch and a
 *   neuron row is a thumbnail then a few chips; the rest of an uncapped panel is empty, which
 *   reads as content that failed to load rather than as generosity.
 *
 * Keyed by node type, because the two kinds of expanded surface — a `NODE_BODIES` body and a
 * `ValuePreview` viewer — have no registry in common, and `category: 'visualisation'` does not
 * separate them either (Profile is as much a visualisation as the 3D viewer).
 *
 * Getting an entry wrong is cosmetic and visible immediately, which is the one reason this is a
 * plain table and not something cleverer.
 */

/** A px cap, or the backdrop's full width. */
export type ExpandedWidth = number | 'full'

/**
 * The cap itself.
 *
 * 1500px was the overlay's blanket `max-width` before any of this was per-node, so it is a
 * number with some wear on it rather than a fresh guess: seven Profile tiles across, and a
 * dataset blurb's 70ch column in a panel that still looks deliberate around it.
 */
export const MEASURED_WIDTH = 1500

const EXPANDED_WIDTHS: Record<string, ExpandedWidth> = {
  // Tile grids.
  'out.profile': MEASURED_WIDTH,
  'out.datasetSummary': MEASURED_WIDTH,
  'net.metrics': MEASURED_WIDTH,
  // Prose, and a list of rows.
  'dataset.description': MEASURED_WIDTH,
  'cave.tableInfo': MEASURED_WIDTH,
  'core.uploadTable': MEASURED_WIDTH,
  'neuron.explore': MEASURED_WIDTH,
}

export function expandedWidth(nodeType: string): ExpandedWidth {
  return EXPANDED_WIDTHS[nodeType] ?? 'full'
}
