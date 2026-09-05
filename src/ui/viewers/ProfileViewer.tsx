/**
 * The Profile widget: one subject at a time, in tiles.
 *
 * Reads as a dashboard rather than a form, which is the point — it is where you land after
 * Explore has told you *which* neuron, to find out *what* it is. Everything about the layout
 * follows from two constraints:
 *
 *  - **A tile renders only when its data exists.** Datasets disagree about almost everything:
 *    hemibrain has no transmitter probabilities, MANC has no `superclass`, a table that has
 *    been through Select may have nothing but a neuronId. So a tile that cannot say anything is
 *    absent rather than full of dashes, and nothing here names a column that must be present.
 *  - **Browsing is free.** The pager writes a presentational param and the fetches are the
 *    widget's own, so paging never marks the node stale. Pinning is the deliberate act, and
 *    it is the only thing here that touches the graph's provenance.
 *
 * **A subject is a neuron or a group of them, and there is only one code path.** With `groupBy`
 * set the pager pages cell types instead of cells, and every number becomes an `Aggregate` —
 * mean, spread, and how many members contributed. A single neuron is a subject of one, whose
 * mean is its value and whose spread is unknown, so the tiles need no second branch to draw it:
 * `stat()` is the single place that decides whether a `±` appears — and it is used only where a
 * value has a line to itself, never in a list row beside a bar, where the spread is a whisker on
 * the track instead. The arithmetic is
 * `profileStats`' subject layer, which runs the single-neuron roll-ups per member and folds
 * them — the grouped answer *is* the ungrouped one, so the two cannot disagree.
 *
 * The 3D tile differs between card and overlay on purpose: the card draws the cached coarse
 * silhouette (free, and usually already fetched by Explore), while the overlay mounts a live
 * neuroglancer frame. A canvas can hold a dozen profile cards, and each neuroglancer frame is
 * a full WebGL application that starts fetching EM the moment it mounts — paying that a dozen
 * times over for a preview is not a trade worth making. The card says so, with a control that
 * opens the real thing.
 */

import { useMemo } from 'react'

import type { DatasetAnnotations, DatasetEdges, CellValue, TableValue } from '../../core/values'
import type { NeuronId } from '../../core/ids'
import { columnNames } from '../../core/types'
import { getRow } from '../../core/values'
import {
  partitionByMember,
  profileSubjects,
  subjectConnectivity,
  subjectConsensus,
  subjectNumeric,
  subjectPartnerTypes,
  subjectRegions,
  subjectTopPartners,
  subjectTransmitter,
} from '../../nodes/lib/profileStats'
import type {
  Aggregate,
  SubjectPartnerRow,
  SubjectRegionRow,
  SubjectTypeRow,
} from '../../nodes/lib/profileStats'
import { CHART_INK, currentMode, seriesColor } from '../colors'
import { chipKey, chipSlots, rowFields } from '../explore/rowFields'
import { NeuronThumbnail } from '../explore/NeuronThumbnail'
import { tableToCsvParts } from '../export'
import { formatCell, formatCompact, formatNumber, plural } from '../format'
import { NeuroglancerProfileFrame } from './NeuroglancerProfileFrame'
import { Bars, Facts, Loadable, Tile } from './Tiles'
import { useNeuronProfile } from './useNeuronProfile'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

export interface ProfileViewerProps {
  /** The incoming neuron table. Paged through, one subject at a time. */
  neurons: TableValue | undefined
  sourceId: string | undefined
  /** The wired annotation chain, so a partner's type is the one the ports carry. */
  annotations?: DatasetAnnotations
  /** A user-supplied edge set, when one answers this dataset's connectivity. */
  edges?: DatasetEdges
  datasetId: string | undefined
  /**
   * Column whose value defines a subject. Empty profiles one neuron per row.
   *
   * Resolved through `ctx.column`, so an unset picker is genuinely unset here — see the node's
   * `optional` note.
   */
  groupBy?: string | undefined
  /** Subject index shown. Clamped here, never trusted. */
  page: number
  onPage: (page: number) => void
  /** Neuron ids on the node's `selection` param — what the Current port emits. */
  pinned: readonly string[]
  onPin: (ids: string[]) => void
  minWeight: number
  topN: number
  /** Fields to show as chips. Empty means "decide for me", as in Explore. */
  chips?: readonly string[]
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/**
 * The separator that keeps a chip list's memo key unambiguous.
 *
 * Joined with nothing, `['ab','c']` and `['a','bc']` are the same key and one column set is
 * served the other's row spec. A named constant rather than an inline escape because the escape
 * was written as a raw U+0001 once already, which is invisible in an editor and reads as `''`.
 */
const SEPARATOR = '\u0001'

/** Thumbnail size on the card. Big enough to read a neuron's silhouette, not a viewer. */
const SILHOUETTE_SIZE = 104

export function ProfileViewer({
  neurons,
  sourceId,
  annotations,
  edges,
  datasetId,
  groupBy,
  page,
  onPage,
  pinned,
  onPin,
  minWeight,
  topN,
  chips = [],
  compact = false,
  baseName,
  onExpand,
  onError,
}: ProfileViewerProps) {
  /*
   * The one derivation the whole widget hangs off. Memoised on the table and the grouping
   * column alone — the two things that can change what a subject *is* — so paging, a threshold
   * and a palette change all leave it alone, and `members` keeps its identity for every roll-up
   * below that depends on it.
   */
  const subjects = useMemo(() => profileSubjects(neurons, groupBy), [neurons, groupBy])
  const total = subjects.length
  /*
   * Clamped on read rather than corrected in the store. A search upstream that shrinks the
   * table would otherwise leave the node parked on a subject that no longer exists, showing an
   * empty profile with nothing to blame — the same lesson Explore's pager learned. Changing the
   * grouping column moves the same way, which is why nothing writes a corrected page back.
   */
  const index = total > 0 ? Math.min(Math.max(0, Math.floor(page)), total - 1) : 0
  const subject = subjects[index]
  // Read off the subject, never re-derived from `groupBy`: `profileSubjects` also falls back to
  // one neuron per row when the picker names a column the schema does not have, and a second
  // guess here would label those rows as groups of one.
  const grouped = subject?.grouped ?? false

  const members: readonly NeuronId[] = subject?.members ?? EMPTY_MEMBERS

  const profile = useNeuronProfile(sourceId, datasetId, members, annotations, edges)
  const data = profile.status === 'ready' ? profile.data : undefined
  const deferred = profile.status === 'deferred'

  /*
   * The subject's own rows — and **not** while its fetch is deferred.
   *
   * This is the half of the gate the fetch does not cover, and it is the expensive half. A
   * deferred subject has tens of thousands of members by definition; materialising a record per
   * row and running `subjectConsensus` over every schema column is rows × columns of work, which
   * on a `Group by: status` mis-click is millions of string conversions per press of ›, while the
   * banner says nothing has been loaded. The tiles that read these are the ones the banner has
   * already stood down, so the honest answer is that a subject nobody asked for computes nothing.
   */
  const rows = useMemo(
    // On `deferred`, not on `profile.status`: the gate reads one bit, and keying the whole local
    // pass on the fetch's lifecycle re-ran it on every `loading → ready` for data that never
    // moved.
    () =>
      neurons && subject && !deferred ? subject.rows.map((row) => getRow(neurons, row)) : [],
    [neurons, subject, deferred],
  )

  /*
   * Every roll-up is memoised on the values it reads, never on object identity: `data` is
   * stable across renders but `minWeight` and `topN` arrive fresh from the node's params on
   * each one, and a hub neuron is twelve thousand rows to walk — a hub *type* is that times its
   * members. Same discipline `useStable` enforces in the network viewer.
   */
  /*
   * The three partitions, held here because this is the memo that knows their lifetime.
   *
   * Six roll-ups read them and `selectRows` copies every column, so computing one per roll-up
   * re-copied a whole direction of connectivity three times over. Keyed on `data` and `members`
   * — the two things that change what a partition *is* — so a threshold or a palette tick leaves
   * them alone, and a subject with no data costs an empty array whatever its member count.
   */
  const inputParts = useMemo(() => partitionByMember(data?.inputs, members), [data, members])
  const outputParts = useMemo(() => partitionByMember(data?.outputs, members), [data, members])
  const regionParts = useMemo(() => partitionByMember(data?.regions, members), [data, members])

  const inputTypes = useMemo(
    () => subjectPartnerTypes(inputParts, { minWeight, topN }),
    [inputParts, minWeight, topN],
  )
  const outputTypes = useMemo(
    () => subjectPartnerTypes(outputParts, { minWeight, topN }),
    [outputParts, minWeight, topN],
  )
  const inputPartners = useMemo(
    () => subjectTopPartners(inputParts, { minWeight, topN }),
    [inputParts, minWeight, topN],
  )
  const outputPartners = useMemo(
    () => subjectTopPartners(outputParts, { minWeight, topN }),
    [outputParts, minWeight, topN],
  )
  const inputSummary = useMemo(
    () => subjectConnectivity(inputParts, { minWeight }),
    [inputParts, minWeight],
  )
  const outputSummary = useMemo(
    () => subjectConnectivity(outputParts, { minWeight }),
    [outputParts, minWeight],
  )
  const regions = useMemo(
    () => subjectRegions(regionParts, { primaryRois: data?.primaryRois }),
    [regionParts, data],
  )
  // Sides are computed over *every* region rather than the ones the list shows, so raising
  // `Rows per list` cannot change the hemisphere balance.
  const shownRegions = useMemo(() => regions.rows.slice(0, topN), [regions, topN])

  const fields = useMemo(
    () => rowFields(neurons?.schema, chips),
    // Joined rather than kept as an array: `ctx.columns` mints a fresh one every render, so
    // an identity-keyed memo would rebuild the row spec on every unrelated tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [neurons?.schema, chips.join(SEPARATOR)],
  )

  const transmitter = useMemo(() => subjectTransmitter(rows), [rows])

  /*
   * The subject's own rows, read as one row.
   *
   * A group has no single row, so `facts` prints what its members agree on and how many answers
   * they give where they do not. `chipRow` is the stricter half: a chip is a scanning aid, so a
   * field the group disagrees about is left out rather than drawn as "30 values" — the count is
   * still there in the attributes tile, where there is room to read it.
   */
  const { factRow, chipRow, attributes } = useMemo(
    () => subjectRows(neurons, rows, grouped),
    [neurons, rows, grouped],
  )

  const isPinned = members.length > 0 && samePins(pinned, members)
  const exportSource: ExportSource = {
    csv: () => (neurons ? tableToCsvParts(neurons) : []),
  }

  if (!neurons) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Connect a table of neurons to profile them.</div>
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">No neurons in the incoming table.</div>
      </div>
    )
  }

  const name = grouped ? (subject?.label ?? '—') : primaryName(factRow, fields.primary)
  /** What the pager steps through: cells, or groups of them. */
  const unit = grouped ? 'group' : 'neuron'
  const neuronId = members[0] ?? null

  return (
    <div className="viewer profile nodrag">
      <div className="profile__pager">
        <button
          type="button"
          className="profile__page-btn"
          aria-label={`Previous ${unit}`}
          title={`Previous ${unit}`}
          disabled={index <= 0}
          onClick={() => onPage(index - 1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="profile__page-btn"
          aria-label={`Next ${unit}`}
          title={`Next ${unit}`}
          disabled={index >= total - 1}
          onClick={() => onPage(index + 1)}
        >
          ›
        </button>
        <span className="profile__position">
          {formatNumber(index + 1)} / {formatNumber(total)}
        </span>
        <span className="profile__name" title={name}>
          {name}
        </span>
        {/* The id for a cell, the size for a group: in both cases the thing the header does not
            already say. A group's id list is what the pin writes, not something to read. */}
        {grouped ? (
          <span className="profile__id">{plural(members.length, 'neuron')}</span>
        ) : (
          neuronId !== null && <span className="profile__id">{neuronId}</span>
        )}
        <span className="profile__spacer" />
        {members.length > 0 && (
          <button
            type="button"
            className="profile__pin"
            data-pinned={isPinned || undefined}
            aria-pressed={isPinned}
            title={
              isPinned
                ? 'Unpin. The Current port stops emitting these neurons, so downstream goes stale.'
                : grouped
                  ? `Pin ${plural(members.length, 'neuron')} to the Current port. Unlike paging, this marks the graph stale.`
                  : 'Pin this neuron to the Current port. Unlike paging, this marks the graph stale.'
            }
            onClick={() => onPin(togglePin(pinned, members))}
          >
            {isPinned ? 'Pinned' : 'Pin'}
          </button>
        )}
        <ViewerActions
          baseName={baseName ?? 'profile'}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>

      {/*
       * One offer, beside the pager, rather than a button in each of six tiles. Above
       * `MAX_AUTO_MEMBERS` nothing is fetched until this is pressed — see the hook, and note
       * that it is a deferral rather than a refusal: the answer is well defined at any size,
       * what is not reasonable is asking for it between two presses of ›.
       */}
      {deferred && (
        <div className="profile__deferred">
          <span>
            {name} has {plural(profile.members, 'neuron')}. Loading connectivity for all of them
            is a large query.
          </span>
          <button type="button" className="tile__link" onClick={profile.load}>
            Load anyway
          </button>
        </div>
      )}

      <div className="tiles nowheel">
        <Tile label="Identity">
          <Facts
            rows={[
              // `Facts` drops an absent value, so this is the whole of "only when grouped".
              ['neurons', grouped ? formatNumber(members.length) : undefined],
              ['type', factRow?.['type']],
              ['instance', factRow?.['instance']],
              ['status', factRow?.['status'] ?? factRow?.['statusLabel']],
              ['dataset', datasetId ?? null],
            ]}
          />
          <Chips row={chipRow} fields={fields.chips} />
        </Tile>

        <Tile label={compact ? 'Shape' : '3D'} {...(compact ? {} : { span: 2 as const })}>
          {compact ? (
            <div className="profile__shape">
              <NeuronThumbnail
                sourceId={sourceId}
                datasetId={datasetId}
                // The first member stands for a group here, and the facts beside it are the
                // whole group's — a silhouette is a shape, and the tile does not claim it is
                // the average of anything.
                neuronId={neuronId ?? ''}
                size={SILHOUETTE_SIZE}
              />
              <div className="profile__shape-facts">
                <Facts rows={attributes} />
                {onExpand && (
                  <button type="button" className="tile__link" onClick={onExpand}>
                    Open 3D ⤢
                  </button>
                )}
              </div>
            </div>
          ) : (
            <NeuroglancerProfileFrame
              sourceId={sourceId}
              datasetId={datasetId}
              // Every member, so a cell type is drawn as a cell type. Text: a wide root id does
              // not survive a double, and these become neuroglancer segments. Invariant 8.
              neuronIds={members}
              onError={onError}
            />
          )}
        </Tile>

        <Tile label="Connectivity" qualifier={threshold(minWeight)}>
          <Loadable state={profile.status}>
            <SplitMeter
              parts={[
                {
                  label: 'in',
                  value: inputSummary.synapses.mean,
                  color: seriesColor(0, currentMode()),
                },
                {
                  label: 'out',
                  value: outputSummary.synapses.mean,
                  color: seriesColor(1, currentMode()),
                },
              ]}
            />
            {/*
             * One row per direction when grouped, two when not.
             *
             * `26.5 ± 37.5 in · 35 ± 49.5 out` is three times the ungrouped string, and a fact's
             * value is one nowrap line with an ellipsis — so on a tile column it silently
             * truncated, losing the "out" half of the headline number. Splitting is what makes
             * each line fit; the compact form stays where it still does.
             */}
            <Facts
              rows={
                grouped
                  ? [
                      ['synapses in', stat(inputSummary.synapses)],
                      ['synapses out', stat(outputSummary.synapses)],
                      ['partners in', stat(inputSummary.partners)],
                      ['partners out', stat(outputSummary.partners)],
                    ]
                  : [
                      [
                        'synapses',
                        `${stat(inputSummary.synapses)} in · ${stat(outputSummary.synapses)} out`,
                      ],
                      [
                        'partners',
                        `${stat(inputSummary.partners)} in · ${stat(outputSummary.partners)} out`,
                      ],
                    ]
              }
            />
            {grouped && (
              <p className="tile__note">Mean ± sd across {plural(members.length, 'neuron')}.</p>
            )}
          </Loadable>
        </Tile>

        {(transmitter.calls.length > 0 || transmitter.probabilities.length > 0) && (
          <Tile label="Transmitter">
            {transmitter.calls.length > 0 && (
              <Facts
                rows={
                  grouped
                    ? // Every call the group makes, not the commonest one: a type that is 28
                      // cholinergic and 2 GABAergic is interesting exactly where a single
                      // "acetylcholine" would round it away.
                      [
                        ...transmitter.calls.map(
                          (call) =>
                            [
                              call.label,
                              `${formatNumber(call.count)} / ${formatNumber(transmitter.n)}`,
                            ] as [string, CellValue],
                        ),
                        [
                          'confidence',
                          transmitter.confidence ? stat(transmitter.confidence) : null,
                        ],
                      ]
                    : [
                        ['call', transmitter.calls[0]?.label ?? null],
                        // Restored rather than new: the ungrouped card showed this before the
                        // subject layer arrived, and it went missing when the tile moved onto
                        // `subjectTransmitter`.
                        [
                          'confidence',
                          transmitter.confidence ? stat(transmitter.confidence) : null,
                        ],
                      ]
                }
              />
            )}
            {transmitter.probabilities.length > 0 && (
              <Bars
                rows={transmitter.probabilities.map((p) => ({
                  key: p.label,
                  title: p.column,
                  // Probabilities are already 0..1, so they scale against a fixed 1 rather
                  // than against the strongest — otherwise a 0.4/0.3 split would draw as a
                  // full bar beside a three-quarter one and read as near-certainty.
                  fraction: Math.max(0, Math.min(1, p.value)),
                  value: p.value.toFixed(2),
                }))}
                color={seriesColor(6, currentMode())}
              />
            )}
          </Tile>
        )}

        <Tile label="Top input types" qualifier={threshold(minWeight)}>
          <Loadable state={profile.status} empty={inputTypes.length === 0}>
            <TypeBars
              rows={inputTypes}
              color={seriesColor(0, currentMode())}
              grouped={grouped}
            />
            <SpreadNote grouped={grouped} />
          </Loadable>
        </Tile>

        <Tile label="Top output types" qualifier={threshold(minWeight)}>
          <Loadable state={profile.status} empty={outputTypes.length === 0}>
            <TypeBars
              rows={outputTypes}
              color={seriesColor(1, currentMode())}
              grouped={grouped}
            />
            <SpreadNote grouped={grouped} />
          </Loadable>
        </Tile>

        {!compact && (
          <>
            <Tile label="Top input partners" qualifier={threshold(minWeight)}>
              <Loadable state={profile.status} empty={inputPartners.length === 0}>
                <PartnerList rows={inputPartners} total={inputSummary.partners.total} />
              </Loadable>
            </Tile>
            <Tile label="Top output partners" qualifier={threshold(minWeight)}>
              <Loadable state={profile.status} empty={outputPartners.length === 0}>
                <PartnerList rows={outputPartners} total={outputSummary.partners.total} />
              </Loadable>
            </Tile>
          </>
        )}

        <Tile label="Regions" qualifier="post · pre" wide>
          <Loadable state={profile.status} empty={shownRegions.length === 0}>
            <RegionBars rows={shownRegions} />
            {grouped && <p className="tile__note">Mean per neuron; hover for the spread.</p>}
            {/*
             * Said out loud when it applies. `roiInfo` nests, so without the dataset's
             * primary list these bars include a region and its parent and the total is
             * roughly double. Reporting that is the difference between a caveat and a lie.
             */}
            {data && !data.primaryRois && (
              <p className="tile__note">
                Includes nested regions — this dataset&rsquo;s primary region list has not
                loaded, so the totals may double-count.
              </p>
            )}
            {data?.primaryRois && regions.total > 0 && (
              <SplitMeter
                parts={[
                  {
                    label: 'L',
                    value: regions.left.mean,
                    color: seriesColor(2, currentMode()),
                  },
                  {
                    label: 'R',
                    value: regions.right.mean,
                    color: seriesColor(3, currentMode()),
                  },
                  {
                    label: 'center',
                    value: regions.center.mean,
                    color: CHART_INK[currentMode()].muted,
                  },
                ]}
              />
            )}
          </Loadable>
        </Tile>

        <Tile label={`All ${neurons.schema.columns.length} attributes`} wide collapsible>
          <Facts
            rows={neurons.schema.columns.map((col) => [col.name, factRow?.[col.name] ?? null])}
          />
        </Tile>
      </div>

      {profile.status === 'error' && <div className="profile__error">{profile.message}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * The classification chips.
 *
 * Same `rowFields` machinery Explore's list uses, so a field is the same hue in both places
 * and neither has its own idea of which fields matter. The colour is a scanning aid and never
 * the identity — every chip carries its value as text, and the two-letter side fields carry an
 * inline key besides.
 */
function Chips({
  row,
  fields,
}: {
  row: Record<string, CellValue> | undefined
  fields: readonly string[]
}) {
  const slots = chipSlots(fields)
  const chips = fields
    .map((name) => ({ name, value: row?.[name], slot: slots.get(name), key: chipKey(name) }))
    .filter((chip) => chip.value !== null && chip.value !== undefined && chip.value !== '')

  if (chips.length === 0) return null
  return (
    <div className="profile__chips">
      {chips.map((chip) => (
        <span key={chip.name} className="explore-chip" data-slot={chip.slot} title={chip.name}>
          {chip.key && <span className="explore-chip__key">{chip.key}</span>}
          {formatCell(chip.value as CellValue, chip.name)}
        </span>
      ))}
    </div>
  )
}

/**
 * Partner types as bars.
 *
 * Scaled against the strongest row rather than against the total, so the second and third
 * entries stay readable — a neuron whose top partner takes 39% would otherwise draw every
 * other bar as a sliver. The percentage is printed, so the scale is never the only thing
 * saying how big a share is.
 *
 * Scaled on the **mean**, which is what the row prints. Scaling on the total instead would draw
 * one picture for a subject of one and a differently-ordered one for a group, since the two
 * orders only agree while every subject has the same number of members.
 */
function TypeBars({
  rows,
  color,
  grouped,
}: {
  rows: SubjectTypeRow[]
  color: string
  grouped: boolean
}) {
  const max = Math.max(...rows.map((r) => r.synapses.mean), 1)
  return (
    <Bars
      color={color}
      rows={rows.map((row) => {
        const made = contributors(row.synapses)
        return {
          key: row.type ?? 'untyped',
          title: `${row.type ?? 'untyped'} — ${stat(row.synapses)} synapses across ${stat(
            row.partners,
          )} partners${made ? ` — ${made}` : ''}`,
          fraction: row.synapses.mean / max,
          ...(spreadOf(row.synapses, max) ?? {}),
          // The *mean* alone, in both modes — the spread is the whisker and the tooltip. Printed
          // here it doubled the width of a column the track has to share a row with.
          value: mean(row.synapses),
          // Grouped, the partner count is a *mean* — `39% · 1.5` — so it is wider than the count
          // it replaces at exactly the moment the value column is already wider. It is in the
          // tooltip, which is where the figures live for this list now.
          detail: grouped
            ? percent(row.synapseShare)
            : `${percent(row.synapseShare)} · ${mean(row.partners)}`,
        }
      })}
    />
  )
}

/**
 * What the whisker is, said once per list that draws one.
 *
 * An encoding nobody names is an encoding nobody reads. It is one line rather than a legend
 * because there is exactly one non-obvious mark on these bars.
 */
function SpreadNote({ grouped }: { grouped: boolean }) {
  if (!grouped) return null
  // Short enough for one line in a tile column: a two-line caption under a three-row list is
  // more chrome than list.
  return <p className="tile__note">Bar: mean. Line: ±1 sd.</p>
}

function RegionBars({ rows }: { rows: SubjectRegionRow[] }) {
  const max = Math.max(...rows.map((r) => r.total), 1)
  const mode = currentMode()
  return (
    <div className="tile__bars">
      {rows.map((row) => (
        <div
          key={row.roi}
          className="tile__bar"
          title={`${row.roi} — ${stat(row.post)} post, ${stat(row.pre)} pre`}
        >
          <span className="tile__bar-key">{row.roi}</span>
          {/* Two segments in one track, so a region's balance of inputs to outputs reads
              without a second chart. */}
          <span className="tile__bar-track">
            <span
              className="tile__bar-fill"
              style={{
                width: `${(row.post.mean / max) * 100}%`,
                background: seriesColor(0, mode),
              }}
            />
            <span
              className="tile__bar-fill"
              style={{
                width: `${(row.pre.mean / max) * 100}%`,
                background: seriesColor(1, mode),
              }}
            />
          </span>
          <span className="tile__bar-value">
            {mean(row.post)}
            <span className="tile__bar-detail">{mean(row.pre)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function PartnerList({ rows, total }: { rows: readonly SubjectPartnerRow[]; total: number }) {
  return (
    <div className="profile__partners">
      {rows.map((row) => (
        <div key={row.neuronId} className="profile__partner">
          <span className="profile__partner-name" title={String(row.neuronId)}>
            {row.neuronId}
            {row.type && <span className="profile__partner-type">{row.type}</span>}
          </span>
          <span className="profile__partner-weight" title={contributors(row.weight)}>
            {mean(row.weight)}
          </span>
          <span className="profile__partner-share">{percent(row.share)}</span>
        </div>
      ))}
      {total > rows.length && (
        <p className="tile__note">
          Showing the strongest {formatNumber(rows.length)} of {formatNumber(total)} partners.
        </p>
      )}
    </div>
  )
}

/**
 * A proportion bar.
 *
 * Segments are separated by a real gap in the surface colour, which is the secondary encoding
 * the palette's validation requires wherever two categorical fills touch.
 */
function SplitMeter({
  parts,
}: {
  parts: Array<{ label: string; value: number; color: string }>
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  if (total <= 0) return null
  const shown = parts.filter((part) => part.value > 0)
  return (
    <div className="profile__split">
      <div className="profile__split-track">
        {shown.map((part) => (
          <span
            key={part.label}
            style={{ flexGrow: part.value, background: part.color }}
            title={`${part.label} — ${formatCompact(part.value)} (${percent(part.value / total)})`}
          />
        ))}
      </div>
      <div className="profile__split-key">
        {shown.map((part) => (
          <span key={part.label}>
            <i style={{ background: part.color }} aria-hidden="true" />
            {part.label} {percent(part.value / total)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable across renders, so an empty subject does not void every roll-up's memo. */
const EMPTY_MEMBERS: readonly NeuronId[] = []

/** The row attributes the Shape tile reports beside the silhouette. */
const ATTRIBUTE_FACTS = ['size', 'pre', 'post'] as const

/**
 * One measurement, with its spread where the subject has more than one member.
 *
 * The only place that decides whether a `±` appears, which is what lets every tile above draw a
 * cell and a cell type with the same call. A subject of one prints its value and nothing else —
 * "12 ± —" would be noise on the mode that is still the common one.
 */
/**
 * The number a list row prints: the mean, and never the spread.
 *
 * A row's value column sits beside the track in one `auto` grid column, so every character here
 * is taken from the bar. `stat` is what the *tiles* use, where a fact has a line to itself.
 */
function mean(agg: Aggregate): string {
  return formatCompact(agg.n <= 1 ? agg.total : agg.mean)
}

/**
 * ±1 sd around a mean, as fractions of the axis the bar is drawn on.
 *
 * `undefined` for a subject of one, which has no spread to draw, and for a measured zero spread,
 * where a whisker would be a mark with no width. Clamped at zero because these are counts: on a
 * real cell type the sd routinely exceeds the mean, and the lower arm would otherwise run off the
 * end of the track drawing a negative synapse count.
 */
function spreadOf(
  agg: Aggregate,
  max: number,
): { spread: { lo: number; hi: number } } | undefined {
  if (agg.sd === null || agg.sd === 0) return undefined
  return {
    spread: {
      lo: Math.max(0, (agg.mean - agg.sd) / max),
      hi: Math.min(1, (agg.mean + agg.sd) / max),
    },
  }
}

function stat(agg: Aggregate): string {
  // `sd` is null exactly when `n <= 1`; `aggregateOf` is the only thing that mints one. A lone
  // value is a *count*, so it keeps its thousands separator.
  if (agg.sd === null) return formatNumber(agg.total)
  // Both halves compact, deliberately: `formatNumber` prints a standard deviation to three
  // decimals — `26.5 ± 37.477` — which is precision the measurement does not have.
  return `${formatCompact(agg.mean)} ± ${formatCompact(agg.sd)}`
}

/**
 * How many members a mean was actually made of, for a tooltip.
 *
 * Empty for a subject of one, and empty where every member contributed — the number is worth
 * saying exactly when it differs from the denominator, because a mean of 4 across thirty cells
 * where two connect is a different fact from one where all thirty do, and the mean alone cannot
 * tell them apart.
 */
function contributors(agg: Aggregate): string | undefined {
  if (agg.n <= 1 || agg.present === agg.n) return undefined
  return `in ${formatNumber(agg.present)} of ${plural(agg.n, 'neuron')}`
}

/**
 * The subject's rows, read as one row twice over.
 *
 * `factRow` prints what a group agrees on and counts the answers where it does not; `chipRow`
 * leaves a disagreement out entirely. Two rows rather than one because the two surfaces want
 * different things from the same fact: the attributes tile has room to say "30 values", and a
 * chip strip that said it thirty times over would stop being a scanning aid.
 */
function subjectRows(
  neurons: TableValue | undefined,
  rows: ReadonlyArray<Record<string, CellValue>>,
  grouped: boolean,
): {
  factRow: Record<string, CellValue> | undefined
  chipRow: Record<string, CellValue> | undefined
  /** The numeric attributes the Shape tile reports, averaged where the subject is a group. */
  attributes: Array<[string, CellValue | undefined]>
} {
  if (!grouped) {
    return {
      factRow: rows[0],
      chipRow: rows[0],
      attributes: ATTRIBUTE_FACTS.map((name) => [name, rows[0]?.[name]]),
    }
  }

  const names = columnNames(neurons?.schema)
  const agreed = subjectConsensus(rows, names)
  // Averaged rather than reported as "30 values": these are quantities, and a mean of them is the
  // useful answer. `subjectNumeric` records why its denominator is the members that publish a
  // value rather than the whole subject.
  const means = subjectNumeric(rows, ATTRIBUTE_FACTS)
  const factRow: Record<string, CellValue> = {}
  const chipRow: Record<string, CellValue> = {}
  for (const name of names) {
    const answer = agreed.get(name) ?? { value: null, distinct: 0 }
    factRow[name] =
      answer.distinct <= 1 ? answer.value : `${formatNumber(answer.distinct)} values`
    chipRow[name] = answer.distinct === 1 ? answer.value : null
  }
  return {
    factRow,
    chipRow,
    attributes: ATTRIBUTE_FACTS.map((name) => {
      const agg = means.get(name)
      return [name, agg ? stat(agg) : null]
    }),
  }
}

function togglePin(pinned: readonly string[], members: readonly NeuronId[]): string[] {
  /*
   * A pin replaces rather than accumulates. `Current` is "the neurons I am looking at" — one
   * cell, or one cell type — and a pin that quietly built up a list would make the port's
   * meaning drift as you browsed. Unpinning what is already pinned clears it.
   *
   * The group is resolved to its member ids **here**, which is the whole reason `groupBy` can
   * be presentational: what reaches the node's `selection` param is a list of neurons either
   * way, so `evaluate` never learns that grouping exists.
   */
  return samePins(pinned, members) ? [] : [...members]
}

/**
 * Whether what is pinned is exactly this subject.
 *
 * As a set, not as a sequence: `selection` comes back off a stored graph in whatever order it
 * was written, and a group whose members arrive re-ordered is still the same group. Comparing
 * sequences left the Pin control unlit on a reloaded graph, with a second press then clearing a
 * pin that looked as though it had never been set.
 */
function samePins(pinned: readonly string[], members: readonly NeuronId[]): boolean {
  if (pinned.length !== members.length) return false
  const set = new Set(pinned)
  return members.every((id) => set.has(id))
}

function primaryName(
  row: Record<string, CellValue> | undefined,
  primary: string | undefined,
): string {
  const value = primary ? row?.[primary] : undefined
  if (value !== null && value !== undefined && value !== '') return String(value)
  const id = row?.['neuronId']
  return id === null || id === undefined ? 'Neuron' : String(id)
}

function percent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  // Sub-1% shares are common on a hub neuron, and rounding them all to "0%" makes a ranked
  // list look broken. One decimal below 10%, none above.
  if (fraction < 0.1) return `${(fraction * 100).toFixed(1)}%`
  return `${Math.round(fraction * 100)}%`
}

function threshold(minWeight: number): string | undefined {
  // Only said when it is doing something. "1+ syn" on every heading is noise; "5+ syn" is the
  // reason a count differs from what the Connectivity node reports.
  return minWeight > 1 ? `${minWeight}+ syn` : undefined
}
