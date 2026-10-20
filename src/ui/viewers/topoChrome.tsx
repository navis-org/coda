/**
 * The chrome the single-neuron cards share: the identity bar over the stage, the rail's tab strip,
 * and the partner panel. Neuron Topology and the Neuron Dendrogram draw exactly these, and a fix to
 * an accessible name or a pager clamp has to reach both — which two copies of the JSX made a fix
 * that landed once. The `topo__*` classes are Topology's, which the dendrogram card borrows whole.
 */

import type { PartnerGrouping } from '../../nodes/lib/profileStats'
import type { PartnerListProps } from './PartnerList'
import { PartnerList } from './PartnerList'

/** What a neuron is called on a viewer's bar: its type, else its instance, else its id. */
export function neuronLabel(
  row: Readonly<Record<string, unknown>> | undefined,
  id: string | null | undefined,
): string {
  return String(row?.['type'] ?? row?.['instance'] ?? id ?? '—')
}

/**
 * A neuron's name, then its id muted beside it — the id left out where the name already is the id
 * (a neuron with no type), rather than written twice.
 */
export function TopoName({ name, neuronId }: { name: string; neuronId: string | null }) {
  return (
    <>
      <span className="topo__name" title={name}>
        {name}
      </span>
      {neuronId && neuronId !== name && <code className="topo__id">{neuronId}</code>}
    </>
  )
}

/** Pager, the neuron's name and id, and the Pin and Data toggles. */
export function TopoBar({
  index,
  total,
  onPage,
  name,
  neuronId,
  pinned,
  onPin,
  railOpen,
  onRailOpen,
}: {
  index: number
  total: number
  onPage: (page: number) => void
  name: string
  neuronId: string | null
  pinned: readonly string[]
  onPin: (ids: string[]) => void
  railOpen: boolean
  onRailOpen: (open: boolean) => void
}) {
  const isPinned = neuronId !== null && pinned.includes(neuronId)
  return (
    <div className="topo__bar">
      <button
        type="button"
        className="topo__page"
        aria-label="Previous neuron"
        disabled={index <= 0}
        onClick={() => onPage(index - 1)}
      >
        ‹
      </button>
      <span className="topo__count">
        {index + 1} / {total}
      </span>
      <button
        type="button"
        className="topo__page"
        aria-label="Next neuron"
        disabled={index >= total - 1}
        onClick={() => onPage(index + 1)}
      >
        ›
      </button>
      <TopoName name={name} neuronId={neuronId} />
      <span className="topo__spacer" />
      <button
        type="button"
        className="topo__pin"
        aria-pressed={isPinned}
        title="Emit this neuron from the Current port"
        onClick={() => onPin(isPinned ? [] : neuronId ? [neuronId] : [])}
      >
        {isPinned ? 'Pinned' : 'Pin'}
      </button>
      <button
        type="button"
        className="topo__pin"
        aria-pressed={railOpen}
        title={railOpen ? 'Hide the data rail' : 'Show the data rail'}
        onClick={() => onRailOpen(!railOpen)}
      >
        Data
      </button>
    </div>
  )
}

/** The rail's tab strip, with the close button at its end where there is something to close. */
export function RailTabs<Id extends string>({
  tabs,
  tab,
  onTab,
  onClose,
}: {
  tabs: ReadonlyArray<{ readonly id: Id; readonly label: string }>
  tab: Id
  onTab: (id: Id) => void
  onClose?: () => void
}) {
  return (
    <nav className="topo__tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
      {onClose && (
        <>
          <span className="topo__spacer" />
          <button
            type="button"
            className="topo__close"
            aria-label="Hide the data rail"
            onClick={onClose}
          >
            ×
          </button>
        </>
      )}
    </nav>
  )
}

/** The Partners tab: which side, a filter, the grouping, and the list that lights them. */
export function PartnerPanel({
  direction,
  onDirection,
  query,
  onQuery,
  grouping,
  onGrouping,
  list,
}: {
  direction: string
  onDirection: (direction: 'inputs' | 'outputs') => void
  query: string
  onQuery: (query: string) => void
  grouping: PartnerGrouping
  onGrouping: (grouping: PartnerGrouping) => void
  list: PartnerListProps
}) {
  return (
    <div className="topo__panel">
      <div className="topo__seg">
        <button
          type="button"
          aria-pressed={direction === 'inputs'}
          onClick={() => onDirection('inputs')}
        >
          Inputs
        </button>
        <button
          type="button"
          aria-pressed={direction === 'outputs'}
          onClick={() => onDirection('outputs')}
        >
          Outputs
        </button>
        <input
          className="topo__search"
          type="search"
          value={query}
          placeholder="Filter partners…"
          aria-label="Filter partners"
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      {/*
       * A select and not two checkboxes, for the reason `PartnerGrouping` records: "split the
       * untyped" and "don't group" have a fourth state between them that means nothing. Its own
       * row rather than beside the direction toggle — the rail is 216px at its narrowest and that
       * row already carries a segmented control and a search box.
       */}
      <div className="topo__seg topo__seg--group">
        <select
          className="topo__select"
          aria-label="Group partners by"
          value={grouping}
          onChange={(e) => onGrouping(e.target.value as PartnerGrouping)}
        >
          <option value="type">Group: cell type</option>
          <option value="typed">Group: cell type, untyped apart</option>
          <option value="neuron">Group: none, one row per neuron</option>
        </select>
      </div>
      <PartnerList {...list} />
    </div>
  )
}
