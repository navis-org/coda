/**
 * Building an SVG document by hand — the shared half of `networkToSvg`, `scatterToSvg` and
 * `heatmapToSvg`.
 *
 * Three viewers synthesise their export rather than handing over a live element, because their
 * picture is a canvas or a WebGL surface and there is no DOM to clone. They had a verbatim copy
 * of `element`, `textNode`, `round` and `SVG_NS` each, which is the second-consumer trigger this
 * codebase extracts on (`useStable`, `LegendKeys`, `Tiles`, `raster`) reached for the third time.
 *
 * **`svgRoot` exists so the namespace rule cannot be forgotten.** `serializeSvg` writes the
 * declaration; a builder that also sets `xmlns` as a plain attribute produces it twice, which is
 * a fatal XML error rather than something a reader recovers from — and that shipped, in all
 * three builders, unnoticed for the life of the feature. Comments saying "do not set xmlns" are
 * what it was fixed with first; a root builder that has no parameter for it is what stops the
 * fourth viewer reintroducing it. `svgBuilders.test.ts` is the other half.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** Two decimal places: enough for a hairline, and it keeps a 900,000-cell path readable. */
export const round = (value: number): number => Math.round(value * 100) / 100

export function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, typeof value === 'number' ? String(round(value)) : value)
  }
  return node
}

/**
 * A `<text>` node, optionally haloed.
 *
 * The halo is a stroke drawn under the fill rather than a backing rect: labels sit on top of the
 * marks they annotate, and a rect per label would occlude the very geometry being labelled.
 */
export function textNode(
  content: string,
  attributes: Record<string, string | number>,
  outline?: string,
): SVGTextElement {
  const node = element('text', attributes)
  if (outline) {
    node.setAttribute('stroke', outline)
    node.setAttribute('stroke-width', '3')
    node.setAttribute('paint-order', 'stroke')
    node.setAttribute('stroke-linejoin', 'round')
  }
  node.textContent = content
  return node
}

export interface SvgRootOptions {
  /** Width of the picture, in CSS pixels. */
  width: number
  /** Height of the picture, excluding any legend strip below it. */
  height: number
  /** Extra height appended below the picture for a legend or colour bar. */
  strip?: number
  background: string
  title?: string
}

/**
 * The root `<svg>`, with its `<title>` and background already in place.
 *
 * Note what it does **not** take: `xmlns`, which `serializeSvg` owns, and `font`, which it also
 * owns — the builders used to inline a `<style>` of their own beside the serializer's, and the
 * serializer's resolves to nothing because a synthesised element is detached. Two owners for one
 * declaration is the shape of the bug this module exists to close.
 */
export function svgRoot(options: SvgRootOptions): SVGSVGElement {
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))
  const total = height + Math.max(0, Math.round(options.strip ?? 0))

  const svg = element('svg', {
    width,
    height: total,
    viewBox: `0 0 ${width} ${total}`,
    role: 'img',
  })

  if (options.title) {
    const title = document.createElementNS(SVG_NS, 'title')
    title.textContent = options.title
    svg.append(title)
  }
  svg.append(element('rect', { x: 0, y: 0, width, height: total, fill: options.background }))
  return svg
}
