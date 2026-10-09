/**
 * Which of a neuron's partners are lit on its arbour, and the partner list that lights them —
 * shared by every card that draws one neuron's synapses: Neuron Topology on a 3D stage, the Neuron
 * Dendrogram on a flat one.
 *
 * Lifted out of `TopologyViewer` whole rather than rewritten, because each memo here carries a
 * lesson that was paid for once — the two clouds and which one is measured, the hoisted partner
 * column, the gating that keeps a page turn from allocating fifteen thousand rows for a list
 * nobody has open. A second card writing its own would have to learn them again.
 *
 * The site cloud and connectivity come from `useNeuronTopology`, which both cards call with the
 * same key, so they share one fetch per neuron.
 */

import { useCallback, useMemo } from 'react'

import type { DatasetAnnotations } from '../../core/values'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { parseLabelFilter } from '../../nodes/lib/matrixShape'
import type { PartnerGrouping } from '../../nodes/lib/profileStats'
import { partnerTypes } from '../../nodes/lib/profileStats'
import { namesPartners } from '../../nodes/lib/topologyOps'
import { CHART_INK, cycleColor } from '../../style/colors'
import type { Mode } from '../../style/colors'
import { PARTNER_ROWS } from './PartnerList'
import type { NeuronTopologyData } from './useNeuronTopology'
import {
  HIGHLIGHT_COLUMN,
  HIGHLIGHT_OTHER,
  highlightColumn,
  partnerLabel,
  partnerLabelColumn,
} from './synapseHighlight'
import { hasSynapseLinks, useSynapseLinks } from './useSynapseLinks'

/**
 * Whether the synapse rows name partners: `fetchable` where the link cloud would (neuPrint names
 * partners only there), `unnamed` where the source cannot name them at all.
 */
export type PartnerNaming = 'named' | 'fetchable' | 'unnamed'

export interface PartnerHighlightInput {
  data: NeuronTopologyData | undefined
  sourceId: string | undefined
  datasetId: string | undefined
  neuronId: string | undefined
  annotations: DatasetAnnotations | undefined
  /** The lit partners. Pass a stable array (`useStable`) — every memo here is keyed on it. */
  partners: readonly string[]
  onPartners: (partners: string[]) => void
  grouping: PartnerGrouping
  direction: string
  partnerQuery: string
  /** Whether the partner list is on screen; nothing builds the list's rows while it is not. */
  listing: boolean
  /**
   * Whether the card needs every synapse to name its partner even with nothing lit — the Neuron
   * Dendrogram's Distal tab, which rolls the synapses beyond a point up by partner type. On neuPrint
   * that is the second query; elsewhere the site cloud names partners already and this costs nothing.
   */
  needsPartners?: boolean
  mode: Mode
}

export function usePartnerHighlight(input: PartnerHighlightInput) {
  const {
    data,
    sourceId,
    datasetId,
    neuronId,
    annotations,
    partners,
    onPartners,
    grouping,
    direction,
    partnerQuery,
    listing,
    needsPartners = false,
    mode,
  } = input

  /*
   * Two clouds, and which one is which matters more than it looks.
   *
   * `data.synapses` is the *site* cloud — one row per synapse, de-duplicated — and it is what
   * every measurement reads: the morphometrics, and the flow centrality behind the split. The
   * link cloud below repeats a presynaptic site once per partner it drives (6.8x on male-CNS body
   * 10003), which is exactly right for saying *where a partner connects* and exactly wrong for
   * counting anything.
   *
   * neuPrint needs the second query because it drops the partner columns; every other source
   * carries them on the site cloud already, so `linksWanted` stays false there and no second
   * fetch happens at all.
   */
  const sitesNamePartners = !!data?.synapses && namesPartners(data.synapses.attributes.schema)
  const linksWanted =
    (partners.length > 0 || needsPartners) &&
    !sitesNamePartners &&
    hasSynapseLinks(sourceId, datasetId)
  const links = useSynapseLinks(sourceId, datasetId, neuronId, linksWanted, annotations)

  /**
   * The cloud the card draws: the link cloud where one was needed, else the site cloud. A card
   * that measures (Topology's morphometrics) reads `data.synapses` itself, never this.
   */
  const cloud = links.status === 'ready' ? links.points : data?.synapses

  /**
   * A label per cloud row, in the partner list's vocabulary.
   *
   * `partnerLabelColumn` is headless and tested as such; the join it makes is `partnerTypesById`,
   * shared with the Neuron Dendrogram's Partners port.
   *
   * Gated on something being lit, the same gating as `partnerRows` on the list being open, and
   * keyed on *whether* anything is lit rather than on what, the column being the same for any
   * selection. The join walks both connectivity tables and allocates one entry per cloud row — on
   * body 10003 that is a 57,034-element array over a 30,000-row table — and the only consumer is
   * `highlighted`, which returns early with nothing selected. `canHighlight` deliberately does
   * *not* read this: it is a question about the schema and must not cost an array to answer.
   */
  const anyLit = partners.length > 0
  const partnerColumn = useMemo(
    () =>
      cloud && anyLit
        ? partnerLabelColumn(cloud.attributes, [data?.inputs, data?.outputs], grouping)
        : undefined,
    [cloud, data, grouping, anyLit],
  )
  /*
   * Asked of the *source*, not only of the cloud in hand. On neuPrint the site cloud never names
   * a partner, so a check on the value alone would report "this dataset cannot" on exactly the
   * dataset where the second query can - and the list would say so before anyone had clicked the
   * thing that would fetch it.
   */
  const cloudNames = cloud !== undefined && namesPartners(cloud.attributes.schema)
  const canHighlight = cloudNames || hasSynapseLinks(sourceId, datasetId)
  /*
   * The same question asked of one row rather than of the list: whether the cloud in hand names
   * the partner, or the link cloud would — `fetchable` says it *can* be asked for, not that it has
   * been (`needsPartners` is what asks) — or nothing here can. Here beside `canHighlight` so the
   * two cannot disagree about a source.
   */
  const partnerNaming: PartnerNaming = cloudNames
    ? 'named'
    : canHighlight && links.status !== 'error'
      ? 'fetchable'
      : 'unnamed'

  /*
   * **Every** partner, not the top forty.
   *
   * The cap used to be applied here, which made the list a leaderboard rather than an index: a
   * partner outside the top forty could not be reached at all, and on body 10003 that is 14,983
   * of them. `topN` absent keeps the whole sorted list; the cap now belongs to what is *drawn*,
   * after the filter has had its say, so searching can reach anything.
   */
  const partnerRows = useMemo(() => {
    /*
     * Gated on the tab, `sites` and `orders`' rule. This walks the whole connectivity table
     * building a bucket and a `Set` per type — on body 10003's outgoing table that is ~30,000
     * rows and 14,983 partner ids — and its only readers are `partnerNeuronCount` and
     * `shownPartners`, both of which feed `PartnerList` alone. So with the rail folded away or
     * another tab up it was allocating all of that per page turn to be thrown away. Lighting a
     * partner does *not* need it: the highlight reads `partnerColumn` off the cloud.
     */
    if (!listing) return []
    const table = direction === 'inputs' ? data?.inputs : data?.outputs
    return partnerTypes(table, { minWeight: 1, grouping })
  }, [data, direction, listing, grouping])

  /*
   * Summed off the rolled-up types rather than by building the per-neuron list. Each partner
   * neuron belongs to exactly one type bucket, so the sum is the count — and `topPartners` over
   * fifteen thousand partners would allocate that array to read `.length` off it.
   */
  const partnerNeuronCount = useMemo(
    () => partnerRows.reduce((sum, row) => sum + row.partners, 0),
    [partnerRows],
  )

  const partnerFilter = useMemo(() => parseLabelFilter(partnerQuery), [partnerQuery])

  /**
   * The rows the list draws: the filter's matches, capped, with anything lit kept visible.
   *
   * A selected partner survives a filter that excludes it, because it is the only control that
   * can *un*-select it — a search that hid the thing you had just lit would leave the picture
   * with no way back except clearing the box.
   */
  const shownPartners = useMemo(() => {
    const test = partnerFilter.filter
    const selected = new Set(partners)
    /*
     * The filter reads the cell type too, which a row carries only once it is keyed by an id. Typing
     * `Tm3` with one row per neuron would otherwise match nothing at all — every label is
     * eighteen digits — and the reader has no way to know the type is still there.
     */
    const matched = test
      ? partnerRows.filter((row) => {
          // Once per row, not twice: ungrouped this runs over ~15,000 rows per keystroke.
          const label = partnerLabel(row.type)
          return (
            selected.has(label) ||
            test.test(label) ||
            (row.partnerType !== undefined && test.test(row.partnerType))
          )
        })
      : partnerRows
    return { rows: matched.slice(0, PARTNER_ROWS), matched: matched.length }
  }, [partnerRows, partnerFilter, partners])

  /**
   * The cloud with a column of *our* vocabulary written onto it, and the count that is lit.
   *
   * This replaces overriding a colour for every value the partner column happened to hold. That
   * version keyed nulls as `''` where `resolveColor` keys them `'—'`, so every synapse whose
   * partner has no cell type missed its override and kept a bright palette colour — 13,621 of
   * male-cns body 10003's 57,034 rows, lit on every render and identical whatever was selected,
   * against the 38 the partner actually picked has. See `synapseHighlight.ts`, which is where
   * that rule now lives with tests on it.
   */
  const highlighted = useMemo(() => {
    if (!cloud || !partnerColumn || partners.length === 0) return undefined
    const { values, lit } = highlightColumn(cloud.attributes, partnerColumn, {
      partners,
      direction,
    })
    const schema = tableSchema(
      ...cloud.attributes.schema.columns,
      column(HIGHLIGHT_COLUMN, 'str'),
    )
    const attributes = makeTable(schema, {
      ...cloud.attributes.data,
      [HIGHLIGHT_COLUMN]: values,
    })
    // `values` rides along so the emphasis predicate reads the labels that were actually
    // written, rather than recomputing the match and risking a second answer.
    return { points: { ...cloud, attributes }, lit, values }
  }, [cloud, partnerColumn, partners, direction])

  /**
   * The colour every lit partner is drawn in — **one map, two readers**.
   *
   * The rail's swatch and the 3D dot have to be the same colour or the highlight says nothing,
   * and `resolveColor` ranks categories by frequency, so the slot a partner would get on its own
   * is not the slot it has in this list. Pinning them through `ColorSpec.overrides` is the
   * mechanism the encoding layer provides for exactly that.
   *
   * The map is now small and closed — one entry per selected partner plus `other` — because the
   * column it keys is one this component wrote. Nothing here depends on how the *data's* values
   * are spelled, which is the property that was missing.
   */
  const partnerOverrides = useMemo(() => {
    if (!highlighted) return undefined
    const overrides: Record<string, string> = { [HIGHLIGHT_OTHER]: CHART_INK[mode].muted }
    partners.forEach((name, i) => {
      overrides[name] = cycleColor(i, mode)
    })
    return overrides
  }, [highlighted, partners, mode])

  /** A selected partner's colour, for the rail's swatch. Same map, same order. */
  const colorForPartner = useCallback(
    (name: string): string | undefined => {
      const at = partners.indexOf(name)
      return at < 0 ? undefined : cycleColor(at, mode)
    },
    [partners, mode],
  )

  const togglePartner = useCallback(
    (name: string) => {
      const next = partners.includes(name)
        ? partners.filter((p) => p !== name)
        : [...partners, name]
      onPartners(next)
    },
    [partners, onPartners],
  )

  return {
    cloud,
    links,
    canHighlight,
    partnerNaming,
    partnerRows,
    partnerNeuronCount,
    partnerFilter,
    shownPartners,
    highlighted,
    partnerOverrides,
    colorForPartner,
    togglePartner,
  }
}
