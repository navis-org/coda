/**
 * Which node's chart is on screen, and how to get at it.
 *
 * The Download node can write an upstream chart as SVG or PNG, and that is only possible by
 * asking the *viewer* rather than the wire. A viewer is a tap — `out.scatter` passes its table
 * on, never its picture — so nothing arriving on a Download node's input could be an image.
 *
 * Reading the DOM would not do either, and this is the reason the registry exists at all: the
 * heatmap and the bar chart render a real `<svg>`, but the scatter plot draws to a canvas and
 * the network to WebGL, and both **synthesise** an SVG on demand (`scatterDraw`, `networkToSvg`
 * from sigma's post-reducer display data). Their picture has no element to query. The viewer's
 * own accessor is the only route, and this is where they hand it over.
 *
 * The node id travels by **context rather than by prop**, which is what keeps this to two touch
 * points instead of sixteen: `ValuePreview` is the single place that dispatches to a viewer and
 * already knows the node, and `ViewerActions` is the single place every viewer converges on with
 * its export source in hand. Threading a `nodeId` through all eight viewers would say the same
 * thing eight times and be wrong the first time somebody adds a ninth.
 */

import { createContext } from 'react'

import type { ExportSource } from './ViewerActions'

/**
 * The node whose value the surrounding viewer is drawing.
 *
 * Undefined outside a `ValuePreview` — a legend or a thumbnail rendered on its own belongs to no
 * node, and registering it would put a chart under an id that does not name it.
 */
export const ExportNodeContext = createContext<string | undefined>(undefined)

const sources = new Map<string, ExportSource>()

/**
 * Publish a viewer's export source under its node id.
 *
 * Last registration wins, and that is the useful way round: one node can be drawn in the card,
 * the inspector and the overlay at once, and the overlay — mounted last and largest — is the one
 * whose picture anybody asking for a PNG means.
 *
 * Returns an unregister that only clears the entry while it is still its own. Without that
 * check, a card unmounting after the overlay opened would remove the overlay's registration.
 */
export function registerExportSource(nodeId: string, source: ExportSource): () => void {
  sources.set(nodeId, source)
  return () => {
    if (sources.get(nodeId) === source) sources.delete(nodeId)
  }
}

/** The export source for a node's *rendered* viewer, or undefined when nothing is drawing it. */
export function exportSourceFor(nodeId: string | undefined): ExportSource | undefined {
  return nodeId ? sources.get(nodeId) : undefined
}

/** Test seam. */
export function resetExportSources(): void {
  sources.clear()
}
