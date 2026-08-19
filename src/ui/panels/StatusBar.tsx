import { useGraphStore, useStaleCount } from '../../store/graphStore'
import { formatDuration, plural } from '../format'

export function StatusBar() {
  const nodeCount = useGraphStore((s) => s.graph.nodes.length)
  const edgeCount = useGraphStore((s) => s.graph.edges.length)
  const selection = useGraphStore((s) => s.selection.length)
  const lastRun = useGraphStore((s) => s.lastRun)
  const busy = useGraphStore((s) => s.busy)
  const staleCount = useStaleCount()

  return (
    <div className="statusbar">
      <span>
        {plural(nodeCount, 'node')} · {plural(edgeCount, 'link')}
        {selection > 0 && ` · ${selection} selected`}
      </span>

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

      <div className="shortcut-hints">
        <span>Space commands</span>
        <span>drag pan</span>
        <span>⇧drag select</span>
        <span>⇧R run</span>
        <span>M mute</span>
        <span>⌘Z undo</span>
      </div>
    </div>
  )
}
