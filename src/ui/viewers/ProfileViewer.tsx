/**
 * The Profile widget: one neuron at a time, in tiles.
 *
 * Reads as a dashboard rather than a form, which is the point — it is where you land after
 * Explore has told you *which* neuron, to find out *what* it is. Everything about the layout
 * follows from two constraints:
 *
 *  - **A tile renders only when its data exists.** Datasets disagree about almost everything:
 *    hemibrain has no transmitter probabilities, MANC has no `superclass`, a table that has
 *    been through Select may have nothing but a bodyId. So a tile that cannot say anything is
 *    absent rather than full of dashes, and nothing here names a column that must be present.
 *  - **Browsing is free.** The pager writes a presentational param and the fetches are the
 *    widget's own, so paging never marks the node stale. Pinning is the deliberate act, and
 *    it is the only thing here that touches the graph's provenance.
 *
 * The 3D tile differs between card and overlay on purpose: the card draws the cached coarse
 * silhouette (free, and usually already fetched by Explore), while the overlay mounts a live
 * neuroglancer frame. A canvas can hold a dozen profile cards, and each neuroglancer frame is
 * a full WebGL application that starts fetching EM the moment it mounts — paying that a dozen
 * times over for a preview is not a trade worth making. The card says so, with a control that
 * opens the real thing.
 */

import { useMemo } from 'react'

import type { CellValue, TableValue } from '../../core/values'
import { getRow } from '../../core/values'
import {
  connectivitySummary,
  hemisphereSplit,
  partnerTypes,
  regionRows,
  topPartners,
  transmitterReading,
} from '../../nodes/lib/profileStats'
import type { PartnerTypeRow, RegionRow } from '../../nodes/lib/profileStats'
import { CHART_INK, currentMode, seriesColor } from '../colors'
import { chipKey, chipSlots, rowFields } from '../explore/rowFields'
import { NeuronThumbnail } from '../explore/NeuronThumbnail'
import { tableToCsvParts } from '../export'
import { formatCell, formatCompact, formatNumber } from '../format'
import { NeuroglancerProfileFrame } from './NeuroglancerProfileFrame'
import { Bars, Facts, Loadable, Tile } from './Tiles'
import { useNeuronProfile } from './useNeuronProfile'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

export interface ProfileViewerProps {
  /** The incoming neuron table. Paged through, one row at a time. */
  neurons: TableValue | undefined
  sourceId: string | undefined
  datasetId: string | undefined
  /** Row index shown. Clamped here, never trusted. */
  page: number
  onPage: (page: number) => void
  /** Body ids on the node's `selection` param — what the Current port emits. */
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

/** Thumbnail size on the card. Big enough to read a neuron's silhouette, not a viewer. */
const SILHOUETTE_SIZE = 104

export function ProfileViewer({
  neurons,
  sourceId,
  datasetId,
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
  const total = neurons?.length ?? 0
  /*
   * Clamped on read rather than corrected in the store. A search upstream that shrinks the
   * table would otherwise leave the node parked on a row that no longer exists, showing an
   * empty profile with nothing to blame — the same lesson Explore's pager learned.
   */
  const index = total > 0 ? Math.min(Math.max(0, Math.floor(page)), total - 1) : 0
  const row = useMemo(
    () => (neurons && total > 0 ? getRow(neurons, index) : undefined),
    [neurons, index, total],
  )
  const bodyId = row ? Number(row['bodyId']) : undefined
  const hasBodyId = bodyId !== undefined && Number.isFinite(bodyId)

  const profile = useNeuronProfile(sourceId, datasetId, hasBodyId ? bodyId : undefined)
  const data = profile.status === 'ready' ? profile.data : undefined

  /*
   * Every roll-up is memoised on the values it reads, never on object identity: `data` is
   * stable across renders but `minWeight` and `topN` arrive fresh from the node's params on
   * each one, and a hub neuron is twelve thousand rows to walk. Same discipline `useStable`
   * enforces in the network viewer, and for the same reason.
   */
  const inputTypes = useMemo(
    () => partnerTypes(data?.inputs, { minWeight, topN }),
    [data, minWeight, topN],
  )
  const outputTypes = useMemo(
    () => partnerTypes(data?.outputs, { minWeight, topN }),
    [data, minWeight, topN],
  )
  const inputPartners = useMemo(
    () => topPartners(data?.inputs, { minWeight, topN }),
    [data, minWeight, topN],
  )
  const outputPartners = useMemo(
    () => topPartners(data?.outputs, { minWeight, topN }),
    [data, minWeight, topN],
  )
  const inputSummary = useMemo(
    () => connectivitySummary(data?.inputs, { minWeight }),
    [data, minWeight],
  )
  const outputSummary = useMemo(
    () => connectivitySummary(data?.outputs, { minWeight }),
    [data, minWeight],
  )
  const allRegions = useMemo(
    () => regionRows(data?.regions, { primaryRois: data?.primaryRois }),
    [data],
  )
  const regions = useMemo(() => allRegions.slice(0, topN), [allRegions, topN])
  const sides = useMemo(() => hemisphereSplit(allRegions), [allRegions])

  const fields = useMemo(
    () => rowFields(neurons?.schema, chips),
    // Joined rather than kept as an array: `ctx.columns` mints a fresh one every render, so
    // an identity-keyed memo would rebuild the row spec on every unrelated tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [neurons?.schema, chips.join('\u0001')],
  )

  const transmitter = useMemo(() => (row ? transmitterReading(row) : undefined), [row])

  const isPinned = hasBodyId && pinned.includes(String(bodyId))
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

  const name = primaryName(row, fields.primary)

  return (
    <div className="viewer profile nodrag">
      <div className="profile__pager">
        <button
          type="button"
          className="profile__page-btn"
          aria-label="Previous neuron"
          title="Previous neuron"
          disabled={index <= 0}
          onClick={() => onPage(index - 1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="profile__page-btn"
          aria-label="Next neuron"
          title="Next neuron"
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
        {hasBodyId && <span className="profile__id">{bodyId}</span>}
        <span className="profile__spacer" />
        {hasBodyId && (
          <button
            type="button"
            className="profile__pin"
            data-pinned={isPinned || undefined}
            aria-pressed={isPinned}
            title={
              isPinned
                ? 'Unpin. The Current port stops emitting this neuron, so downstream goes stale.'
                : 'Pin this neuron to the Current port. Unlike paging, this marks the graph stale.'
            }
            onClick={() => onPin(togglePin(pinned, String(bodyId)))}
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

      <div className="tiles nowheel">
        <Tile label="Identity">
          <Facts
            rows={[
              ['type', row?.['type']],
              ['instance', row?.['instance']],
              ['status', row?.['status'] ?? row?.['statusLabel']],
              ['dataset', datasetId ?? null],
            ]}
          />
          <Chips row={row} fields={fields.chips} />
        </Tile>

        <Tile label={compact ? 'Shape' : '3D'} {...(compact ? {} : { span: 2 as const })}>
          {compact ? (
            <div className="profile__shape">
              <NeuronThumbnail
                sourceId={sourceId}
                datasetId={datasetId}
                bodyId={hasBodyId ? bodyId : 0}
                size={SILHOUETTE_SIZE}
              />
              <div className="profile__shape-facts">
                <Facts
                  rows={[
                    ['size', row?.['size']],
                    ['pre', row?.['pre']],
                    ['post', row?.['post']],
                  ]}
                />
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
              bodyId={hasBodyId ? bodyId : undefined}
              onError={onError}
            />
          )}
        </Tile>

        <Tile label="Connectivity" qualifier={threshold(minWeight)}>
          <Loadable state={profile.status}>
            <SplitMeter
              parts={[
                { label: 'in', value: inputSummary.synapses, color: seriesColor(0, currentMode()) },
                {
                  label: 'out',
                  value: outputSummary.synapses,
                  color: seriesColor(1, currentMode()),
                },
              ]}
            />
            <Facts
              rows={[
                [
                  'synapses',
                  `${formatNumber(inputSummary.synapses)} in · ${formatNumber(outputSummary.synapses)} out`,
                ],
                [
                  'partners',
                  `${formatNumber(inputSummary.partners)} in · ${formatNumber(outputSummary.partners)} out`,
                ],
              ]}
            />
          </Loadable>
        </Tile>

        {transmitter && (transmitter.call || transmitter.probabilities.length > 0) && (
          <Tile label="Transmitter">
            {transmitter.call && (
              <Facts
                rows={[
                  ['call', transmitter.call],
                  [
                    'confidence',
                    transmitter.confidence === undefined
                      ? null
                      : transmitter.confidence.toFixed(2),
                  ],
                ]}
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
            <TypeBars rows={inputTypes} color={seriesColor(0, currentMode())} />
          </Loadable>
        </Tile>

        <Tile label="Top output types" qualifier={threshold(minWeight)}>
          <Loadable state={profile.status} empty={outputTypes.length === 0}>
            <TypeBars rows={outputTypes} color={seriesColor(1, currentMode())} />
          </Loadable>
        </Tile>

        {!compact && (
          <>
            <Tile label="Top input partners" qualifier={threshold(minWeight)}>
              <Loadable state={profile.status} empty={inputPartners.length === 0}>
                <PartnerList rows={inputPartners} total={inputSummary.partners} />
              </Loadable>
            </Tile>
            <Tile label="Top output partners" qualifier={threshold(minWeight)}>
              <Loadable state={profile.status} empty={outputPartners.length === 0}>
                <PartnerList rows={outputPartners} total={outputSummary.partners} />
              </Loadable>
            </Tile>
          </>
        )}

        <Tile label="Regions" qualifier="post · pre" wide>
          <Loadable state={profile.status} empty={regions.length === 0}>
            <RegionBars rows={regions} />
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
            {data?.primaryRois && sides.total > 0 && (
              <>
                <SplitMeter
                  parts={[
                    { label: 'L', value: sides.left, color: seriesColor(2, currentMode()) },
                    { label: 'R', value: sides.right, color: seriesColor(3, currentMode()) },
                    { label: 'center', value: sides.center, color: CHART_INK[currentMode()].muted },
                  ]}
                />
              </>
            )}
          </Loadable>
        </Tile>

        <Tile label={`All ${neurons.schema.columns.length} attributes`} wide collapsible>
          <Facts rows={neurons.schema.columns.map((col) => [col.name, row?.[col.name] ?? null])} />
        </Tile>
      </div>

      {profile.status === 'error' && (
        <div className="profile__error">{profileErrorMessage(profile)}</div>
      )}
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
          {formatCell(chip.value as CellValue)}
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
 */
function TypeBars({ rows, color }: { rows: PartnerTypeRow[]; color: string }) {
  const max = Math.max(...rows.map((r) => r.synapses), 1)
  return (
    <Bars
      color={color}
      rows={rows.map((row) => ({
        key: row.type ?? 'untyped',
        title: `${row.type ?? 'untyped'} — ${formatNumber(row.synapses)} synapses across ${formatNumber(row.partners)} partners`,
        fraction: row.synapses / max,
        value: formatCompact(row.synapses),
        detail: `${percent(row.synapseShare)} · ${formatNumber(row.partners)}`,
      }))}
    />
  )
}

function RegionBars({ rows }: { rows: RegionRow[] }) {
  const max = Math.max(...rows.map((r) => r.total), 1)
  const mode = currentMode()
  return (
    <div className="tile__bars">
      {rows.map((row) => (
        <div
          key={row.roi}
          className="tile__bar"
          title={`${row.roi} — ${formatNumber(row.post)} post, ${formatNumber(row.pre)} pre`}
        >
          <span className="tile__bar-key">{row.roi}</span>
          {/* Two segments in one track, so a region's balance of inputs to outputs reads
              without a second chart. */}
          <span className="tile__bar-track">
            <span
              className="tile__bar-fill"
              style={{ width: `${(row.post / max) * 100}%`, background: seriesColor(0, mode) }}
            />
            <span
              className="tile__bar-fill"
              style={{ width: `${(row.pre / max) * 100}%`, background: seriesColor(1, mode) }}
            />
          </span>
          <span className="tile__bar-value">
            {formatCompact(row.post)}
            <span className="tile__bar-detail">{formatCompact(row.pre)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function PartnerList({
  rows,
  total,
}: {
  rows: Array<{ bodyId: number; type: string | null; weight: number; share: number }>
  total: number
}) {
  return (
    <div className="profile__partners">
      {rows.map((row) => (
        <div key={row.bodyId} className="profile__partner">
          <span className="profile__partner-name" title={String(row.bodyId)}>
            {row.bodyId}
            {row.type && <span className="profile__partner-type">{row.type}</span>}
          </span>
          <span className="profile__partner-weight">{formatNumber(row.weight)}</span>
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
            title={`${part.label} — ${formatNumber(part.value)} (${percent(part.value / total)})`}
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

function togglePin(pinned: readonly string[], id: string): string[] {
  /*
   * A pin replaces rather than accumulates. `Current` is singular by intent — "the neuron I
   * am looking at" — and a pin that quietly built up a list would make the port's meaning
   * drift as you browsed. Unpinning the one that is pinned clears it.
   */
  return pinned.length === 1 && pinned[0] === id ? [] : [id]
}

function primaryName(
  row: Record<string, CellValue> | undefined,
  primary: string | undefined,
): string {
  const value = primary ? row?.[primary] : undefined
  if (value !== null && value !== undefined && value !== '') return String(value)
  const id = row?.['bodyId']
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

function profileErrorMessage(state: { status: 'error'; message: string }): string {
  return state.message
}
