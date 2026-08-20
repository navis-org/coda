/**
 * The ⤓ control and its format menu.
 *
 * Shared by the viewers' caption bar (`ViewerActions`) and a node card's foot
 * (`ResultDownload`), which offer overlapping formats for the same value and would otherwise be
 * two menus free to disagree about what a row looks like and when one appears at all. Same call
 * as `LegendKeys`, extracted from `NetworkLegend` for the same reason.
 *
 * It knows nothing about formats beyond their names: what a format is called, what it writes and
 * whether it is available are all the caller's, because the two callers answer them differently
 * — one asks a live viewer for its picture, the other asks `planExport` about a value.
 *
 * Generic in the format id so a caller with a union keeps it: `FORMAT_LABEL[format]` on a
 * `Record<Format, string>` has to be indexed by `Format`, not by `string`.
 */

import { useCallback, useRef, useState } from 'react'

import { errorMessage } from '../core/errors'
import { useDismissOnOutside } from './useDismiss'

export interface DownloadButtonProps<F extends string> {
  /** In menu order. Nothing is rendered at all when this is empty. */
  formats: readonly F[]
  /** Menu row text, e.g. `CSV data`. */
  label: (format: F) => string
  /** What the single-format button prints beside the arrow, e.g. `CSV`. */
  short: (format: F) => string
  /**
   * Writes the file(s). Awaited, so the button stays disabled for as long as it takes — PNG
   * rasterises through an `Image`, which is not instant on a large chart.
   */
  onPick: (format: F) => Promise<void> | void
  /** Drop the word beside the arrow, for an in-node preview. */
  compact?: boolean
  onError?: (message: string) => void
}

export function DownloadButton<F extends string>({
  formats,
  label,
  short,
  onPick,
  compact = false,
  onError,
}: DownloadButtonProps<F>) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissOnOutside(containerRef, close, { enabled: open })

  const run = async (format: F) => {
    setOpen(false)
    setBusy(true)
    try {
      await onPick(format)
    } catch (error) {
      onError?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const only = formats.length === 1 ? formats[0] : undefined
  if (formats.length === 0) return null

  return (
    <div className="download-button" ref={containerRef}>
      {only !== undefined && (
        // One format needs no menu: a single-item list is a second click for nothing.
        <button
          type="button"
          className="viewer-actions__btn nodrag"
          title={`Download ${label(only)}`}
          aria-label={`Download ${label(only)}`}
          disabled={busy}
          onClick={() => void run(only)}
        >
          ⤓{!compact && <span>{short(only)}</span>}
        </button>
      )}

      {only === undefined && (
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
                  {label(format)}
                  <span>.{format}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
