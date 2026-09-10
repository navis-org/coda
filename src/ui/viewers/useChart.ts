/**
 * What an SVG chart opens with: its measured box, the one mark under the pointer, the `<svg>` the
 * SVG and PNG exports clone, the ink for the current theme, and the CSV/SVG export source.
 *
 * Bar, Histogram, Pie and Distribution each wrote these eleven lines out identically. What differs
 * between them — how wide and tall the plot is, where the legend goes — stays in each.
 */

import { useMemo, useRef, useState } from 'react'

import type { TableValue } from '../../core/values'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { tableToCsvParts } from '../export'
import type { ExportSource } from './ViewerActions'
import { useElementSize } from './useElementSize'

export function useChart<Hover>(table: TableValue) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)
  const exportSource: ExportSource = useMemo(
    () => ({ csv: () => tableToCsvParts(table), svg: () => svgRef.current }),
    [table],
  )
  return { ref, size, hover, setHover, svgRef, mode, ink, surface, exportSource }
}
