import { useGraphStore, useStaleCount } from '../../store/graphStore'
import { formatBytes, formatDuration, formatShare, plural } from '../format'
import { useMemoryReading } from '../memoryReadout'
import { STATUS_BAR_HINTS, shortcutHint } from '../shortcuts'
import { MemoryMeter } from './MemoryDialog'

/**
 * The memory readout, opening the Memory dialog.
 *
 * Its own component so the two-second clock re-renders this and not the status bar around it.
 * Chrome's measured figure with a meter coloured by the heap share where there is one; Coda's own
 * estimate, marked `≈` and with no meter, where the browser says nothing — a meter needs a limit,
 * and there is no honest one to draw.
 */
function MemoryReadout() {
  const reading = useMemoryReading()
  const requestMemory = useGraphStore((s) => s.requestMemory)
  if (!reading) return null
  const { heap } = reading
  const figure = heap ? formatBytes(heap.used) : `≈ ${formatBytes(reading.held)}`
  const title = heap
    ? `This tab is using ${formatBytes(heap.used)}; objects are at ${formatShare(heap.share)} ` +
      `of the browser's limit. Click for details.`
    : `Coda is holding about ${formatBytes(reading.held)}. This browser does not report its ` +
      `own memory use. Click for details.`
  return (
    <button
      type="button"
      className="memchip"
      data-level={heap?.level ?? 'ok'}
      title={title}
      onClick={requestMemory}
    >
      {heap && <MemoryMeter heap={heap} />}
      Memory {figure}
    </button>
  )
}

export function StatusBar() {
  const nodeCount = useGraphStore((s) => s.graph.nodes.length)
  const edgeCount = useGraphStore((s) => s.graph.edges.length)
  const selection = useGraphStore((s) => s.selection.length)
  const lastRun = useGraphStore((s) => s.lastRun)
  const busy = useGraphStore((s) => s.busy)
  const staleCount = useStaleCount()

  return (
    <div className="statusbar" data-tour="statusbar">
      <span>
        {plural(nodeCount, 'node')} · {plural(edgeCount, 'link')}
        {selection > 0 && ` · ${selection} selected`}
      </span>

      <MemoryReadout />

      {busy && <span>running…</span>}

      {!busy && lastRun && (
        <span>
          last run: {lastRun.executed.length} executed
          {lastRun.deferred.length > 0 && `, ${lastRun.deferred.length} deferred`}
          {lastRun.failed.length > 0 && `, ${lastRun.failed.length} failed`}
          {lastRun.cancelled && ', cancelled'} · {formatDuration(lastRun.durationMs)}
        </span>
      )}

      {!busy && staleCount === 0 && nodeCount > 0 && <span>up to date</span>}

      <div className="toolbar__spacer" />

      {/*
       * Six of the twenty-odd, chosen in `shortcuts.ts` rather than here — these strings used
       * to be typed out, and went on advertising `⌘Z` to Windows, which has no ⌘ key.
       */}
      <div className="shortcut-hints">
        {STATUS_BAR_HINTS.map((id) => (
          <span key={id}>{shortcutHint(id)}</span>
        ))}
      </div>
    </div>
  )
}
