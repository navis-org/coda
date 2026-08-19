/**
 * The download / expand controls that sit in every viewer's caption bar.
 *
 * Formats are declared by the viewer, not assumed here: a table offers CSV, a chart offers
 * CSV plus SVG and PNG. When only one format is available the button downloads directly
 * instead of opening a one-item menu.
 */

import { useCallback, useRef, useState } from 'react'

import { downloadCsv, downloadPng, downloadSvg } from '../export'
import { useDismissOnOutside } from '../useDismiss'
import { errorMessage } from '../../core/errors'

export interface ExportSource {
  /** Called lazily — a large CSV is only built when the user actually asks for it. */
  csv?: () => string[]
  /** Live chart element, for vector and raster export. */
  svg?: () => SVGSVGElement | null
}

export interface ViewerActionsProps {
  /** Filename stem, without extension. */
  baseName: string
  source: ExportSource
  /** Provided when the viewer can be enlarged; omitted when it already is. */
  onExpand?: () => void
  /** Hide labels and shrink hit areas for the in-node preview. */
  compact?: boolean
  onError?: (message: string) => void
}

type Format = 'csv' | 'svg' | 'png'

const FORMAT_LABEL: Record<Format, string> = {
  csv: 'CSV data',
  svg: 'SVG vector',
  png: 'PNG image',
}

export function ViewerActions({
  baseName,
  source,
  onExpand,
  compact = false,
  onError,
}: ViewerActionsProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const formats: Format[] = []
  if (source.csv) formats.push('csv')
  if (source.svg) formats.push('svg', 'png')

  const close = useCallback(() => setOpen(false), [])
  useDismissOnOutside(containerRef, close, { enabled: open })

  const run = async (format: Format) => {
    setOpen(false)
    try {
      if (format === 'csv') {
        const parts = source.csv?.()
        if (!parts) throw new Error('Nothing to export')
        downloadCsv(parts, `${baseName}.csv`)
        return
      }
      const svg = source.svg?.()
      if (!svg) throw new Error('Chart is not rendered yet')
      if (format === 'svg') {
        downloadSvg(svg, `${baseName}.svg`)
        return
      }
      setBusy(true)
      await downloadPng(svg, `${baseName}.png`)
    } catch (error) {
      onError?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="viewer-actions" ref={containerRef}>
      {formats.length === 1 && formats[0] && (
        <button
          type="button"
          className="viewer-actions__btn nodrag"
          title={`Download ${FORMAT_LABEL[formats[0]]}`}
          aria-label={`Download ${FORMAT_LABEL[formats[0]]}`}
          disabled={busy}
          onClick={() => void run(formats[0]!)}
        >
          ⤓{!compact && <span>CSV</span>}
        </button>
      )}

      {formats.length > 1 && (
        <>
          <button
            type="button"
            className="viewer-actions__btn nodrag"
            title="Download…"
            aria-label="Download"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen((v) => !v)}
          >
            ⤓{!compact && <span>Download</span>}
          </button>
          {open && (
            <div className="viewer-actions__menu" role="menu">
              {formats.map((format) => (
                <button
                  key={format}
                  type="button"
                  className="viewer-actions__item"
                  role="menuitem"
                  onClick={() => void run(format)}
                >
                  {FORMAT_LABEL[format]}
                  <span>.{format}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {onExpand && (
        <button
          type="button"
          className="viewer-actions__btn nodrag"
          title="Expand (double-click the preview)"
          aria-label="Expand viewer"
          onClick={onExpand}
        >
          ⤢
        </button>
      )}
    </div>
  )
}
