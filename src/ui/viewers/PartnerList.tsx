/**
 * The partner list a single-neuron card lights synapses from, and the line under it — shared by
 * Neuron Topology and the Neuron Dendrogram. `usePartnerHighlight` computes what it shows.
 */

import type { partnerTypes } from '../../nodes/lib/profileStats'
import { formatNumber, plural } from '../format'
import { partnerLabel } from './synapseHighlight'

/**
 * How many partner rows are drawn at once.
 *
 * A cap on the *drawing*, not on the search — everything is still reachable by typing. Fifty is
 * about three screens of the rail, and past it the list stops being scannable long before the DOM
 * stops coping.
 */
export const PARTNER_ROWS = 50

/**
 * What the line under the partner list says.
 *
 * A function with five early returns rather than the nested ternary this was, which had to be
 * read backwards through four negations to find its default case — and which could not be tested
 * without mounting the 3D stage.
 */
export interface PartnerNote {
  canHighlight: boolean
  linksState: 'idle' | 'loading' | 'ready' | 'error'
  selected: readonly string[]
  lit: number | undefined
  filtered: boolean
  matched: number
  total: number
  neuronCount: number
}

export function partnerNote(n: PartnerNote): string {
  if (!n.canHighlight) {
    /*
     * Narrowed, because this used to be said about CAVE — whose synapse rows carry a partner
     * *id* and no type. The card looked for one column, found nothing, and reported it as a fact
     * about the dataset. Today it is true of CATMAID alone, whose synapse schema declines
     * `partnerId` on purpose: naming the far end of a connector is a second POST per connector
     * set, which a cloud drawn in 3D does not need.
     */
    return (
      'This dataset’s synapses carry no partner on the far side of the cleft, so picking one ' +
      'cannot light it up on the arbour.'
    )
  }
  if (n.linksState === 'loading') {
    return (
      'Finding where these partners connect… on neuPrint that is a second query, and on a big ' +
      'cell it returns tens of thousands of connections.'
    )
  }
  if (n.linksState === 'error')
    return 'Could not load partner-resolved synapses for this neuron.'
  if (n.selected.length > 0) {
    // `plural` rather than a `?? 's'`: `lit` reaches five figures on a dense cell, and it carries
    // the thousands separator this was printing without.
    return (
      `${plural(n.lit ?? 0, 'synapse')} lit — ${n.selected.join(', ')}. Every other synapse ` +
      'stays grey, so you can see where these sit among the rest.'
    )
  }
  // With a filter up, the unfiltered totals describe a list nobody is looking at.
  if (n.filtered) return `${n.matched} of ${n.total} partner types match.`
  return (
    `${n.neuronCount} partner neurons across ${n.total} types. Type to filter; a plain word ` +
    'matches anywhere, /^LC is a pattern, !Tm excludes.'
  )
}

export interface PartnerListProps {
  /** Already filtered and capped — see `PARTNER_ROWS`. */
  rows: ReturnType<typeof partnerTypes>
  /**
   * Everything the line under the list says, as one value.
   *
   * Eight of these were separate props, and each was spelled four times over — in the prop type,
   * in the destructure, in the object literal that put them straight back together, and at the
   * call site. `partnerNote` already takes exactly this shape and is where every one of them is
   * documented; passing it whole means a ninth thing to say costs one field rather than four
   * edits, and nothing in this component reads any of them individually.
   */
  note: PartnerNote
  onToggle: (name: string) => void
  /** The colour this partner is drawn in on the arbour, or undefined when it is not lit. */
  colorFor: (name: string) => string | undefined
  loading: boolean
  /** Why the typed pattern will not compile. The list is left whole and this is said. */
  filterError?: string
}

export function PartnerList({
  rows,
  note,
  onToggle,
  colorFor,
  loading,
  filterError,
}: PartnerListProps) {
  if (rows.length === 0) {
    return (
      <p className="topo__pending">
        {loading
          ? 'Loading partners…'
          : note.total === 0
            ? 'No partners in this direction.'
            : 'No partner matches that filter.'}
      </p>
    )
  }
  const max = Math.max(...rows.map((r) => r.synapses), 1)
  return (
    <>
      <ul className="topo__partners">
        {rows.map((row) => {
          const name = partnerLabel(row.type)
          const color = colorFor(name)
          return (
            <li key={name}>
              <button
                type="button"
                className="topo__partner"
                data-on={color ? true : undefined}
                // Both, because the name alone is an id once the list is ungrouped and the type
                // is the half a reader recognises.
                title={row.partnerType ? `${row.partnerType} · ${name}` : name}
                onClick={() => onToggle(name)}
              >
                <i style={{ background: color ?? 'transparent' }} />
                <span className="topo__partner-name">
                  {name}
                  {row.partnerType && <em className="topo__partner-sub">{row.partnerType}</em>}
                </span>
                <span className="topo__partner-track">
                  <span
                    style={{
                      width: `${(row.synapses / max) * 100}%`,
                      // The bar takes the *same* colour as the dots on the arbour, from the same
                      // map. A swatch that disagreed with the picture would be worse than none.
                      background: color ?? 'var(--text-muted)',
                    }}
                  />
                </span>
                <span className="topo__partner-weight">{formatNumber(row.synapses)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {/*
       * What the list is *not* showing, said rather than implied. A cap that quietly hid the
       * partner somebody was looking for is the failure this whole control exists to fix, so a
       * truncated list has to admit it — the rule `+N more` and `colours repeat` already follow.
       */}
      {note.matched > rows.length && (
        <p className="topo__note topo__note--block">
          Showing the {rows.length} strongest of {note.matched} matches. Narrow the filter to
          reach the rest.
        </p>
      )}
      {filterError && (
        <p className="topo__note topo__note--block topo__note--warn">
          {filterError} — showing every partner.
        </p>
      )}
      <p className="topo__note topo__note--block">{partnerNote(note)}</p>
    </>
  )
}
