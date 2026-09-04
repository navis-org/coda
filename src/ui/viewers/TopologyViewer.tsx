/**
 * The Neuron Topology widget: the arbour as the surface, the numbers over it.
 *
 * This is the **Stage** layout, picked over columns and rows after all three were mocked up at
 * the four widths the node has to survive. The reasoning, and the one thing it costs:
 *
 * - **The 3D view is the whole surface**, not a pane in it. A morphology card whose picture is
 *   40% of its area is a card you expand every time; a Table beside it is a Table node away.
 * - **The data rail floats over the stage and folds away.** So the same component is a readable
 *   dashboard cell at 360px and a full inspection surface at 1100px, with no breakpoint — the
 *   rail is the thing that gets dropped, and dropping it leaves the useful half.
 * - The cost is that the rail *covers* part of the picture. That is why `--topo-rail-space`
 *   exists: the stage's own controls are constrained to the width the rail leaves, so the layer
 *   and colour controls can never end up underneath it. Found by looking at the mock in a dock.
 *
 * ## What is free and what is not
 *
 * Everything on the Morphology tab is measured here, from the skeleton, on every render that
 * changes it — `topologyOps` is tree walks and a hemibrain neuron is single-digit milliseconds.
 * Nothing on this card triggers a graph run.
 *
 * The two exceptions are worth knowing because they are the node's only real costs. The
 * **geometry** comes from `useNeuronTopology`, which fetches per neuron viewed and shares the
 * session geometry cache with the node's own Run. The **split** comes from `useCompartments`,
 * which is opt-in: it stays idle until somebody colours by compartment or opens that tab, because
 * it is the one thing here behind a ~10 MB download.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { idText } from '../../core/ids'
import type { DatasetAnnotations, DatasetEdges, TableValue } from '../../core/values'
import { column, findColumn, tableSchema } from '../../core/types'
import { getColumn, getRow, makeTable } from '../../core/values'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { parseLabelFilter } from '../../nodes/lib/matrixShape'
import { partnerTypes } from '../../nodes/lib/profileStats'
import {
  CODE_AXON,
  CODE_DENDRITE,
  CODE_LINKER,
  morphometrics,
  sitesFrom,
  strahlerOrders,
} from '../../nodes/lib/topologyOps'
import { CHART_INK, currentMode, cycleColor, seriesColor, sequentialColor } from '../colors'
import { formatMeasure, formatNumber, plural } from '../format'
import { LazyViewer3D } from './LazyViewers'
import { Bars, Facts, Tile } from './Tiles'
import { useCompartments } from './useCompartments'
import { useStable } from './useStable'
import { hasNeuronMeshes, useNeuronMesh } from './useNeuronMesh'
import { useNeuronTopology } from './useNeuronTopology'
import {
  HIGHLIGHT_COLUMN,
  HIGHLIGHT_OTHER,
  highlightColumn,
  partnerLabel,
} from './synapseHighlight'
import { hasSynapseLinks, useSynapseLinks } from './useSynapseLinks'

export interface TopologyViewerProps {
  neurons: TableValue | undefined
  sourceId: string | undefined
  datasetId: string | undefined
  annotations?: DatasetAnnotations
  edges?: DatasetEdges
  page: number
  onPage: (page: number) => void
  pinned: readonly string[]
  onPin: (ids: string[]) => void
  colorBy: string
  onColorBy: (value: string) => void
  showMesh: boolean
  showSkeleton: boolean
  showSynapses: boolean
  onLayer: (id: LayerParam, on: boolean) => void
  partners: readonly string[]
  onPartners: (partners: string[]) => void
  direction: string
  onDirection: (value: string) => void
  /** The partner filter box's contents. Presentational, so it survives expanding the card. */
  partnerQuery: string
  onPartnerQuery: (value: string) => void
  tab: string
  onTab: (value: string) => void
  railOpen: boolean
  onRailOpen: (open: boolean) => void
  /** The node's `split` param — data, so flipping it marks the graph stale. */
  split: boolean
  onSplit: (on: boolean) => void
  /** navis's two tuning knobs, written by the Compartments tab. See `SplitParam`. */
  flowThresh: number
  splitVal: number
  onSplitParam: (id: SplitParam, value: number) => void
  pointSize: number
  skeletonWidth: number
  skeletonOpacity: number
  dimOpacity: number
  meshOpacity: number
  onVisual: (id: VisualParam, value: number) => void
  /** The flat skeleton colour, as a hex. Written by the Visuals tab's picker. */
  skeletonColor: string
  onSkeletonColor: (hex: string) => void
  compact?: boolean
}

const TABS = [
  { id: 'partners', label: 'Partners' },
  { id: 'morphology', label: 'Morphology' },
  { id: 'compartments', label: 'Compartments' },
  { id: 'visuals', label: 'Visuals' },
] as const

/**
 * The column a synapse's partner is named in, and the reason highlighting is conditional.
 *
 * `CANONICAL_SCHEMAS.synapses` carries `partnerId` and `partnerType`, and the mock and the CAVE
 * and CATMAID backends emit them. **neuPrint deliberately does not** — `neuprint/schema.ts`
 * overrides the canonical schema to drop both, because a neuron holds one `SynapseSet` per
 * partner and the bare walk therefore returns a T-bar once per partner it drives. So the
 * highlight lights up on some sources and not others, and the card has to say which rather than
 * looking broken.
 */
const PARTNER_COLUMN = 'partnerType'

/**
 * How many partner rows are drawn at once.
 *
 * A cap on the *drawing*, not on the search — everything is still reachable by typing. Fifty is
 * about three screens of the rail, and past it the list stops being scannable long before the DOM
 * stops coping.
 */
const PARTNER_ROWS = 50

/**
 * The empty selection, hoisted.
 *
 * `Viewer3D` memoises `new Set(selection)` on the array's identity, and that set is a dependency
 * of the skeleton colour buffer — so a literal `[]` here rebuilt ~17,000 segment colours and
 * re-uploaded the line geometry on every render. Nothing selects a neuron on this card, so one
 * frozen empty array is the whole fix.
 */
const NO_SELECTION: string[] = []

/** The presentational numbers the Visuals tab writes. */
type VisualParam =
  'pointSize' | 'skeletonWidth' | 'skeletonOpacity' | 'dimOpacity' | 'meshOpacity'

/**
 * The layers the stage's toolbar switches.
 *
 * `showMesh` is not like the other two, and the difference is what the layer button costs.
 * Skeleton and synapses are already in hand — `useNeuronTopology` fetched both to measure the
 * neuron — so those toggles only decide what is drawn. A mesh is fetched *because* the layer is
 * on (`useNeuronMesh`), which is why paging with it on is a download per neuron and paging with
 * it off is none.
 */
type LayerParam = 'showMesh' | 'showSkeleton' | 'showSynapses'

/**
 * The two numbers the Compartments tab writes, and the one place on this card where a slider is
 * not presentational.
 *
 * Both are navis's own knobs. Which of the two you want is decided by *how* the split looks
 * wrong: `flowThresh` moves where the neuron is cut, `splitVal` decides which of the resulting
 * pieces is called axon. With the split checkbox off they are hidden params, so moving them
 * re-runs the live split and marks nothing stale; with it on they enter the provenance key.
 */
type SplitParam = 'flowThresh' | 'splitVal'

/**
 * The compartment palette, and why it is not `seriesColor`.
 *
 * navis's own convention — a warm axon, a cool dendrite — because anybody who has looked at a
 * split neuron before reads it without a legend. Ranked colours would put the *commonest*
 * compartment in slot 0, so the axon would change colour between two neurons; here the meaning is
 * fixed and the legend names it anyway.
 */
function compartmentColors(mode: ReturnType<typeof currentMode>): Record<number, string> {
  return {
    [CODE_DENDRITE]: cycleColor(0, mode),
    [CODE_AXON]: cycleColor(1, mode),
    [CODE_LINKER]: CHART_INK[mode].muted,
  }
}

/** A `ColorSpec` that is just one colour. Spelled once; the interface requires every field. */
function constantColor(constant: string): ColorSpec {
  return { mode: 'constant', column: undefined, constant }
}

/**
 * Strahler order as a **sequential** ramp, and the reason it is not `seriesColor`.
 *
 * Strahler order is ordinal — 1 is a terminal twig, the maximum is the primary neurite — so a
 * categorical palette is the wrong kind of scale twice over. It says nothing about magnitude:
 * orders 2 and 3 get unrelated hues, and nothing in the picture tells you which way the numbers
 * run. Worse, `seriesColor` folds everything past its eighth slot onto the achromatic residual
 * — that is `foldByRank`'s rule and it is right for categories — so on any neuron with more
 * than eight orders the *highest* ones all came out the same grey. That is the trunk: the part
 * the encoding is most often turned on to find, drawn in the colour that means "not one of the
 * eight".
 *
 * `sequentialColor` flips with the theme, so a twig recedes into the surface on both, and the
 * trunk takes the saturated end. The bar chart on the Morphology tab calls this too, which is
 * what lets it serve as the key — there is no legend on the stage for this channel, and two
 * spellings of the ramp would have made the bars a key to a picture they disagreed with.
 */
function strahlerColor(order: number, maxOrder: number, mode: ReturnType<typeof currentMode>) {
  // A neuron with one order is unbranched; anything is "the whole of it", so take the strong end
  // rather than dividing by zero and colouring it as the bottom of a scale it does not have.
  const t = maxOrder > 1 ? (order - 1) / (maxOrder - 1) : 1
  return sequentialColor(t, mode)
}

const COMPARTMENT_NAMES: Record<number, string> = {
  [CODE_DENDRITE]: 'Dendrite',
  [CODE_AXON]: 'Axon',
  [CODE_LINKER]: 'Linker',
}

export function TopologyViewer(props: TopologyViewerProps) {
  const {
    neurons,
    sourceId,
    datasetId,
    annotations,
    edges,
    page,
    onPage,
    pinned,
    onPin,
    colorBy,
    onColorBy,
    showMesh,
    showSkeleton,
    showSynapses,
    onLayer,
    onPartners,
    direction,
    onDirection,
    partnerQuery,
    onPartnerQuery,
    tab,
    onTab,
    railOpen,
    onRailOpen,
    split,
    onSplit,
    flowThresh,
    splitVal,
    onSplitParam,
    pointSize,
    skeletonWidth,
    skeletonOpacity,
    dimOpacity,
    meshOpacity,
    onVisual,
    skeletonColor,
    onSkeletonColor,
    compact = false,
  } = props

  /*
   * Stabilised, and this is the difference between the highlight memo hitting and never hitting.
   * `ValuePreview` builds this with `idList(node.params.partners)`, which is a `map` — a fresh
   * array on every store tick and on every frame of a slider drag. Every memo keyed on it then
   * missed, so dragging the point-size slider rebuilt the 57k-row label column, re-resolved the
   * colour channel over it and re-uploaded both point buffers to the GPU. `useStable` is what
   * `Viewer3D` already uses for its own array-valued props.
   */
  const partners = useStable(props.partners)

  const total = neurons?.length ?? 0
  // Clamped on read, never corrected in the store: a search upstream that shrinks the table would
  // otherwise park the node on a row that no longer exists. Profile's pager learned this.
  const index = total > 0 ? Math.min(Math.max(0, Math.floor(page)), total - 1) : 0
  const row = useMemo(
    () => (neurons && total > 0 ? getRow(neurons, index) : undefined),
    [neurons, index, total],
  )
  // Through `idText`, never `Number` — invariant 8, and this is the fetch key.
  const neuronId = row ? idText(row['neuronId']) : null

  const loaded = useNeuronTopology(
    sourceId,
    datasetId,
    neuronId ?? undefined,
    annotations,
    edges,
  )
  const data = loaded.status === 'ready' ? loaded.data : undefined
  const skeleton = data?.skeletons?.items[0]
  /*
   * Opt-in, and this is the whole gate: the split runs only when its answer is on screen. Colour
   * by compartment, or the Compartments tab. Nothing else in this component can start a download.
   */
  const wantsSplit = colorBy === 'compartment' || tab === 'compartments'

  const sites = useMemo(
    // Gated on `wantsSplit`: the only consumer is `useCompartments`, which returns immediately
    // when disabled — so without this a page turn built one object per synapse row, up to 57,000
    // of them, purely to be discarded.
    () => (wantsSplit ? sitesFrom(data?.synapses) : undefined),
    [data, wantsSplit],
  )

  const metrics = useMemo(() => (skeleton ? morphometrics(skeleton) : undefined), [skeleton])
  /** The longest bar, so the Strahler rows are scaled against each other. */
  const strahlerPeak = Math.max(...(metrics?.cableByStrahler ?? [0]), 1)
  /*
   * The top of the ramp — read off the field rather than from `cableByStrahler.length - 1`, which
   * is the same number only because that array is allocated by order with slot 0 unused. It has
   * to be normalised per neuron: paging from an optic-lobe cell to a descending neuron moves it
   * from about 4 to about 12.
   */
  const maxOrder = Math.max(1, metrics?.maxStrahler ?? 1)
  /*
   * Per node, and separate from `metrics` on purpose: `Morphometrics` holds per-neuron
   * aggregates, and an Int32Array per node hung off it would be the largest thing on an object
   * whose other consumer is a table row. Only the colour channel wants this, so only the colour
   * channel pays for it — and it is memoised on the skeleton, so re-colouring never recomputes.
   */
  /*
   * Gated on the mode that reads it, the same gate `sites` carries above. `strahlerOrders` walks
   * the whole tree and allocates a child list per node — 17,000 arrays on a traced cell — and
   * `nodeColor` consults it only under `colorBy === 'strahler'`, so every page turn in the other
   * two modes was paying for an array nothing read.
   */
  const orders = useMemo(
    () => (skeleton && colorBy === 'strahler' ? strahlerOrders(skeleton) : undefined),
    [skeleton, colorBy],
  )

  /*
   * Gated on the layer, not merely hidden by it: this is the one thing on the card whose cost is
   * paid per neuron *viewed*. See `useNeuronMesh`.
   */
  const mesh = useNeuronMesh(
    sourceId,
    datasetId,
    neuronId ?? undefined,
    showMesh,
    annotations,
    edges,
  )
  // Called plainly rather than memoised, `hasSynapseLinks`' arrangement two hooks down: it is a
  // property lookup, and memoising it would freeze an answer a source can still learn.
  const meshAvailable = hasNeuronMeshes(sourceId, datasetId)

  const compartments = useCompartments(skeleton, sites, flowThresh, splitVal, wantsSplit)
  const labels = compartments.status === 'ready' ? compartments.data : undefined

  const mode = currentMode()
  const palette = useMemo(() => compartmentColors(mode), [mode])

  /**
   * The per-node colour channel — the one thing `ColorSpec` cannot express, since it resolves
   * against an attribute table with a row per *neuron*.
   *
   * Returning undefined falls back to the ordinary encoding, which is what makes an un-split or
   * partly-split arbour draw normally rather than in a colour that means "no answer" and looks
   * like one.
   */
  const nodeColor = useCallback(
    (_item: number, node: number): string | undefined => {
      if (colorBy === 'compartment') {
        const code = labels?.labels[node]
        return code === undefined ? undefined : palette[code]
      }
      if (colorBy === 'strahler') {
        const order = orders?.[node]
        return order === undefined ? undefined : strahlerColor(order, maxOrder, mode)
      }
      return undefined
    },
    // `maxOrder` is in here because the Strahler ramp is normalised *per neuron*: left out, a
    // cell paged to would be drawn against the previous cell's scale, which is a plausible
    // picture in the wrong colours rather than anything that looks broken.
    [colorBy, labels, palette, orders, mode, maxOrder],
  )

  /**
   * Which partner names this dataset can actually place on the arbour.
   *
   * Read off the fetched cloud rather than assumed from the source id: what matters is whether
   * *these* points carry a partner column, which is a fact about the value in hand.
   */
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
  const sitesHavePartners = useMemo(() => {
    const attributes = data?.synapses?.attributes
    return attributes ? findColumn(attributes.schema, PARTNER_COLUMN) !== undefined : false
  }, [data])
  const linksWanted =
    partners.length > 0 && !sitesHavePartners && hasSynapseLinks(sourceId, datasetId)
  const links = useSynapseLinks(
    sourceId,
    datasetId,
    neuronId ?? undefined,
    linksWanted,
    annotations,
  )

  /** The cloud the *scene* draws. Never the one anything measures. */
  const cloud = links.status === 'ready' ? links.points : data?.synapses

  const partnerColumn = useMemo(() => {
    const attributes = cloud?.attributes
    /*
     * Asked of the *schema* first. `getColumn` throws on a name it does not hold, which is right
     * for a caller that has already established the column exists and fatal for one asking
     * whether it does — and the sources that drop `partnerType` are the main ones, so reaching
     * for it optimistically took the whole card down on every neuPrint dataset.
     */
    if (!attributes || !findColumn(attributes.schema, PARTNER_COLUMN)) return undefined
    return getColumn(attributes, PARTNER_COLUMN)
  }, [cloud])
  /*
   * Asked of the *source*, not only of the cloud in hand. On neuPrint the site cloud never names
   * a partner, so a check on the value alone would report "this dataset cannot" on exactly the
   * dataset where the second query can - and the list would say so before anyone had clicked the
   * thing that would fetch it.
   */
  const canHighlight = partnerColumn !== undefined || hasSynapseLinks(sourceId, datasetId)

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
    if (!railOpen || tab !== 'partners') return []
    const table = direction === 'inputs' ? data?.inputs : data?.outputs
    return partnerTypes(table, { minWeight: 1 })
  }, [data, direction, railOpen, tab])

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
    const matched = test
      ? partnerRows.filter(
          (row) => selected.has(partnerLabel(row.type)) || test.test(partnerLabel(row.type)),
        )
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

  /*
   * Colour the cloud by partner while any are lit, and by polarity otherwise. `overrides` carries
   * the whole map, so the constant is never reached for a value the column actually holds.
   */
  /** What the scene actually gets: the labelled copy while anything is lit, else the cloud. */
  const scenePoints = highlighted?.points ?? cloud

  /*
   * Which rows the scene draws large and opaque. Read off the labels already computed rather than
   * re-deriving the match, so the dots that grow are exactly the dots the count counted.
   */
  const emphasis = useMemo(() => {
    const values = highlighted?.values
    if (!values) return undefined
    return (row: number) => values[row] !== HIGHLIGHT_OTHER
  }, [highlighted])

  const pointColor: ColorSpec = useMemo(
    () =>
      partnerOverrides
        ? {
            mode: 'categorical',
            column: HIGHLIGHT_COLUMN,
            constant: CHART_INK[mode].muted,
            overrides: partnerOverrides,
          }
        : { mode: 'categorical', column: 'polarity', constant: seriesColor(2, mode) },
    [partnerOverrides, mode],
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

  if (!neurons) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Connect a table of neurons to measure them.</div>
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

  const isPinned = neuronId !== null && pinned.includes(neuronId)
  const name = String(row?.['type'] ?? row?.['instance'] ?? neuronId ?? '—')

  return (
    <div className="viewer topo nodrag" data-rail={railOpen ? 'open' : 'closed'}>
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
        <span className="topo__name" title={name}>
          {name}
        </span>
        {neuronId && <code className="topo__id">{neuronId}</code>}
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

      <div className="topo__stage">
        <div className="topo__scene">
          {data?.skeletons && data.skeletons.items.length > 0 ? (
            <LazyViewer3D
              skeletons={data.skeletons}
              {...(showMesh && mesh.status === 'ready' ? { meshes: mesh.mesh } : {})}
              {...(showSynapses && scenePoints ? { points: scenePoints } : {})}
              skeletonColor={constantColor(skeletonColor)}
              meshColor={constantColor(skeletonColor)}
              // Pre and post are the two values, so a categorical channel on `polarity` is the
              // encoding rather than a constant — the same two colours the ROI and 3D cards use.
              pointColor={pointColor}
              volumeColor={constantColor(CHART_INK[mode].muted)}
              skeletonNodeColor={nodeColor}
              skeletonWidth={skeletonWidth}
              skeletonOpacity={skeletonOpacity}
              skeletonWidthMode="uniform"
              skeletonRadiusWidth={3}
              skeletonWorldWidth={1}
              lightIntensity={1}
              meshOpacity={meshOpacity}
              pointSize={pointSize}
              // Screen pixels, not nanometres — see the param's own note. Without this the dots
              // are a hundredth of a pixel on one neuron and legible on the next.
              pointSizeAttenuation={false}
              pointEmphasis={emphasis}
              pointDimOpacity={dimOpacity}
              volumeOpacity={0.12}
              background="theme"
              selection={NO_SELECTION}
              selectByClick={false}
              ambientOcclusion={0}
              hidden={{ skeleton: [], mesh: [], point: [], volume: [] }}
              shown={{
                skeletons: showSkeleton,
                meshes: showMesh && mesh.status === 'ready',
                points: showSynapses,
                volumes: false,
              }}
              compact={compact}
            />
          ) : (
            <div className="viewer__empty">
              {loaded.status === 'loading'
                ? 'Loading geometry…'
                : loaded.status === 'error'
                  ? loaded.message
                  : 'No skeleton for this neuron.'}
            </div>
          )}
        </div>

        {/* Constrained to what the rail leaves — see `--topo-rail-space`. */}
        <div className="topo__tools">
          <div className="topo__group">
            <button
              type="button"
              // `&& meshAvailable`, so a stored `showMesh: true` on a dataset that has no meshes
              // does not report a layer as on while nothing is drawn.
              aria-pressed={showMesh && meshAvailable}
              /*
               * Disabled rather than absent where the dataset has none: a button that is simply
               * not there reads as a build without the feature, where a greyed one with a reason
               * says which of the two it is. `meshAvailable` is asked of the source rather than
               * of a fetch, so it answers before anything is downloaded.
               */
              disabled={!meshAvailable}
              title={
                meshAvailable
                  ? 'A translucent shell around the skeleton. Fetched per neuron while it is on.'
                  : 'This dataset publishes no neuron meshes'
              }
              onClick={() => onLayer('showMesh', !showMesh)}
            >
              Mesh
            </button>
            <button
              type="button"
              aria-pressed={showSkeleton}
              onClick={() => onLayer('showSkeleton', !showSkeleton)}
            >
              Skeleton
            </button>
            <button
              type="button"
              aria-pressed={showSynapses}
              onClick={() => onLayer('showSynapses', !showSynapses)}
            >
              Synapses
            </button>
          </div>
          <select
            className="topo__select"
            aria-label="Colour skeleton by"
            value={colorBy}
            onChange={(e) => onColorBy(e.target.value)}
          >
            <option value="compartment">Colour: compartment</option>
            <option value="strahler">Colour: Strahler</option>
            <option value="flat">Colour: flat</option>
          </select>
          {showMesh && mesh.status === 'loading' && <span className="topo__note">mesh…</span>}
          {showMesh && mesh.status === 'error' && (
            // Said, not swallowed: a mesh that failed leaves a picture that looks exactly like a
            // mesh that is switched off.
            <span className="topo__note topo__note--warn">mesh unavailable</span>
          )}
          {colorBy === 'compartment' && compartments.status === 'loading' && (
            <span className="topo__note">splitting…</span>
          )}
        </div>

        {colorBy === 'compartment' && labels?.status === 'ok' && (
          <div className="topo__legend">
            {[CODE_DENDRITE, CODE_AXON, CODE_LINKER].map((code) => (
              <span key={code} className="topo__key">
                <i style={{ background: palette[code] }} />
                {COMPARTMENT_NAMES[code]}
              </span>
            ))}
          </div>
        )}

        {railOpen && (
          <aside className="topo__rail">
            <nav className="topo__tabs" role="tablist">
              {TABS.map((t) => (
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
              <span className="topo__spacer" />
              <button
                type="button"
                className="topo__close"
                aria-label="Hide the data rail"
                onClick={() => onRailOpen(false)}
              >
                ×
              </button>
            </nav>

            {tab === 'partners' && (
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
                    value={partnerQuery}
                    placeholder="Filter partners…"
                    aria-label="Filter partners"
                    onChange={(e) => onPartnerQuery(e.target.value)}
                  />
                </div>
                <PartnerList
                  rows={shownPartners.rows}
                  note={{
                    canHighlight,
                    linksState: links.status,
                    selected: partners,
                    lit: highlighted?.lit,
                    filtered: Boolean(partnerFilter.filter),
                    matched: shownPartners.matched,
                    total: partnerRows.length,
                    neuronCount: partnerNeuronCount,
                  }}
                  onToggle={togglePartner}
                  colorFor={colorForPartner}
                  loading={loaded.status === 'loading'}
                  {...(partnerFilter.error ? { filterError: partnerFilter.error } : {})}
                />
              </div>
            )}

            {tab === 'morphology' && (
              <div className="topo__panel">
                {metrics ? (
                  <div className="tiles">
                    <Tile label="Cable">
                      <Facts
                        rows={[
                          // `formatMeasure`, not a hand-built suffix: it promotes µm to mm, so a
                          // 4 mm CATMAID cable prints "4.003 mm" instead of "4,003.103 µm" — the
                          // thousands-separator failure that function exists to remove.
                          ['Total', formatMeasure(metrics.cableLength, 'µm')],
                          ['Longest path', formatMeasure(metrics.longestNeurite, 'µm')],
                          [
                            'Mean radius',
                            metrics.meanRadius === null
                              ? 'not published'
                              : formatMeasure(metrics.meanRadius, 'µm'),
                          ],
                        ]}
                      />
                    </Tile>
                    <Tile label="Topology">
                      <Facts
                        rows={[
                          ['Nodes', formatNumber(metrics.nodes)],
                          ['Branch points', formatNumber(metrics.branchPoints)],
                          ['End points', formatNumber(metrics.endPoints)],
                          ['Segments', formatNumber(metrics.segments)],
                          ['Max Strahler', String(metrics.maxStrahler)],
                          [
                            'Mean tortuosity',
                            metrics.meanTortuosity === null
                              ? '—'
                              : metrics.meanTortuosity.toFixed(2),
                          ],
                          ...(metrics.fragments > 1
                            ? ([['Fragments', String(metrics.fragments)]] as [string, string][])
                            : []),
                        ]}
                      />
                    </Tile>
                    <Tile label="Cable by Strahler order" qualifier="µm" wide>
                      <Bars
                        rows={metrics.cableByStrahler.flatMap((cable, order) =>
                          // Index 0 is unused: no edge has Strahler order 0.
                          order === 0
                            ? []
                            : [
                                {
                                  key: `order ${order}`,
                                  fraction: cable / strahlerPeak,
                                  value: formatNumber(cable),
                                  color: strahlerColor(order, maxOrder, mode),
                                },
                              ],
                        )}
                        color={CHART_INK[mode].muted}
                      />
                    </Tile>
                  </div>
                ) : (
                  <p className="topo__pending">
                    {loaded.status === 'loading' ? 'Loading geometry…' : 'No skeleton.'}
                  </p>
                )}
              </div>
            )}

            {tab === 'visuals' && (
              <div className="topo__panel">
                {/* Grouped by what they act on — synapses, then skeleton, then mesh — which is
                    the same order the layer buttons sit in on the stage. */}
                <Slider
                  id="pointSize"
                  label="Synapse size"
                  value={pointSize}
                  min={1}
                  max={24}
                  step={1}
                  onChange={onVisual}
                  format={(v) => `${v} px`}
                />
                <Slider
                  id="dimOpacity"
                  label="Unlit synapses"
                  value={dimOpacity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={onVisual}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <ColorRow
                  label="Skeleton colour"
                  value={skeletonColor}
                  onChange={onSkeletonColor}
                />
                <Slider
                  id="skeletonWidth"
                  label="Line width"
                  value={skeletonWidth}
                  min={1}
                  max={10}
                  step={0.5}
                  onChange={onVisual}
                />
                <Slider
                  id="skeletonOpacity"
                  label="Skeleton opacity"
                  value={skeletonOpacity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={onVisual}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <Slider
                  id="meshOpacity"
                  label="Mesh opacity"
                  value={meshOpacity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={onVisual}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <p className="topo__note topo__note--block">
                  Presentational — nothing here re-runs the graph or marks it stale.{' '}
                  <b>Unlit synapses</b> is how visible every other partner’s synapses stay while
                  one partner is lit, so it does nothing until you light one. It goes a long way
                  at the bottom of its range and very little at the top — overlapping dots
                  stack, so on a dense cell a nominal 20% already covers the picture. The lit
                  ones are drawn half again as large, the rest a little smaller.{' '}
                  <b>Mesh opacity</b> needs the Mesh layer on, which is the one switch here that
                  costs a download per neuron.
                </p>
              </div>
            )}

            {tab === 'compartments' && (
              <div className="topo__panel">
                <CompartmentPanel
                  state={compartments}
                  palette={palette}
                  split={split}
                  onSplit={onSplit}
                  flowThresh={flowThresh}
                  splitVal={splitVal}
                  onSplitParam={onSplitParam}
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

/**
 * One presentational colour, as the OS picker with its hex beside it.
 *
 * `LegendKeys`' control, for its reason: the alternative is a popover offering the eight palette
 * slots, and somebody setting a neuron's colour by hand wants the one that is *not* in the
 * palette. The hex is printed because a swatch alone gives no way to write the value down.
 */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  return (
    <label className="topo__slider">
      <span className="topo__slider-label">{label}</span>
      <input
        className="topo__color"
        type="color"
        value={value}
        aria-label={`${label} colour`}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="topo__slider-value">{value}</span>
    </label>
  )
}

/**
 * One number, as a slider with its value beside it.
 *
 * A range input rather than a number field because every one of these is a *look at it and
 * decide* control — nobody knows they want a 7px synapse, or a linker threshold of 0.65 — and the
 * readout is there because a bare slider gives you no way to say what you ended up with.
 *
 * Generic over the param id so the Compartments tab can share it: written against `VisualParam`
 * it would have needed either a widened union covering two unrelated groups of controls, or a
 * second copy of the same twelve lines.
 *
 * **`defer` is the one thing here that is not styling.** A range input fires `onChange` on every
 * step of a drag, which is free for a colour or a point size and is not free for the split: each
 * distinct value is a separate crossing of the Python bridge, so dragging the linker threshold
 * from 0.9 to 0.5 queues eight splits of a seventeen-thousand-node arbour to display the last
 * one. Deferred, the track moves live off local state and the param is written once, when the
 * drag ends. The history already coalesces (`HISTORY_COALESCE_MS`), so this is about the worker
 * rather than about undo.
 */
function Slider<Id extends string>({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  defer = false,
  modifier,
}: {
  id: Id
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (id: Id, value: number) => void
  /** How the value reads. Defaults to the number, which is right for a pixel width. */
  format?: (value: number) => string
  /** Write the param when the drag ends rather than on every step. See above. */
  defer?: boolean
  /** A modifier on `topo__slider`, for a group whose labels need a wider column. */
  modifier?: string
}) {
  const [draft, setDraft] = useState(value)
  // Re-synced from the prop, so a value written anywhere else — the inspector, an undo, a
  // different neuron — moves the track rather than being masked by a stale draft.
  useEffect(() => setDraft(value), [value])

  const shown = defer ? draft : value
  const commit = () => {
    if (draft !== value) onChange(id, draft)
  }

  return (
    <label className={modifier ? `topo__slider ${modifier}` : 'topo__slider'}>
      <span className="topo__slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (defer) setDraft(next)
          else onChange(id, next)
        }}
        {...(defer
          ? // `blur` as well as the two gesture ends: a drag released outside the window, and a
            // keyboard user tabbing away, both leave a draft that would otherwise never land.
            { onPointerUp: commit, onKeyUp: commit, onBlur: commit }
          : {})}
      />
      <span className="topo__slider-value">{format ? format(shown) : shown}</span>
    </label>
  )
}

/**
 * What the line under the partner list says.
 *
 * A function with five early returns rather than the nested ternary this was, which had to be
 * read backwards through four negations to find its default case — and which could not be tested
 * without mounting the 3D stage.
 */
interface PartnerNote {
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
    return (
      'This dataset’s synapses do not name their partner, so picking one cannot light it up on ' +
      'the arbour.'
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

function PartnerList({
  rows,
  note,
  onToggle,
  colorFor,
  loading,
  filterError,
}: {
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
}) {
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
                onClick={() => onToggle(name)}
              >
                <i style={{ background: color ?? 'transparent' }} />
                <span className="topo__partner-name">{name}</span>
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

/** navis's defaults, so "put it back" is one click and the panel can say when it is not there. */
const SPLIT_DEFAULTS: Record<SplitParam, number> = { flowThresh: 0.9, splitVal: 1 }

function CompartmentPanel({
  state,
  palette,
  split,
  onSplit,
  flowThresh,
  splitVal,
  onSplitParam,
}: {
  state: ReturnType<typeof useCompartments>
  palette: Record<number, string>
  split: boolean
  onSplit: (on: boolean) => void
  flowThresh: number
  splitVal: number
  onSplitParam: (id: SplitParam, value: number) => void
}) {
  const tuned = flowThresh !== SPLIT_DEFAULTS.flowThresh || splitVal !== SPLIT_DEFAULTS.splitVal

  function resetSplit(): void {
    // Only what moved: writing both would put a redundant `splitVal` edit in the provenance key
    // of a graph whose author never touched it.
    if (flowThresh !== SPLIT_DEFAULTS.flowThresh)
      onSplitParam('flowThresh', SPLIT_DEFAULTS.flowThresh)
    if (splitVal !== SPLIT_DEFAULTS.splitVal) onSplitParam('splitVal', SPLIT_DEFAULTS.splitVal)
  }

  /*
   * Everything below the body renders whatever the split did, which is the point: a split that
   * came back "multiple roots" or plain wrong is exactly when somebody reaches for these, and an
   * early return on an error took both the knobs and the checkbox away at that moment. Same call
   * the checkbox's own comment records.
   */
  return (
    <>
      <CompartmentBody state={state} palette={palette} />
      <div className="topo__panel-foot">
        <Slider
          id="flowThresh"
          label="Linker threshold"
          value={flowThresh}
          min={0.1}
          max={1}
          step={0.05}
          onChange={onSplitParam}
          format={(v) => v.toFixed(2)}
          defer
          modifier="topo__slider--tune"
        />
        <Slider
          id="splitVal"
          label="Axon threshold"
          value={splitVal}
          min={0.1}
          max={3}
          step={0.05}
          onChange={onSplitParam}
          format={(v) => v.toFixed(2)}
          defer
          modifier="topo__slider--tune"
        />
        <p className="topo__note topo__note--block">
          navis’s two knobs, applied to this neuron as you move them. <b>Linker threshold</b>{' '}
          decides <i>where</i> the arbour is cut — lower it to widen the linker, which is what
          separates a poorly segregated cell into compartments at all. <b>Axon threshold</b>{' '}
          decides <i>which piece is which</i> — lower it to call more of the cell axon, raise it
          to call more of it dendrite.
          {tuned && (
            <>
              {' '}
              <button type="button" className="topo__reset" onClick={resetSplit}>
                Back to navis defaults
              </button>
            </>
          )}
        </p>
      </div>
      <div className="topo__panel-foot">
        <label className="topo__check">
          <input type="checkbox" checked={split} onChange={(e) => onSplit(e.target.checked)} />
          Add compartment columns to Morphometrics
        </label>
        <p className="topo__note topo__note--block">
          {split
            ? 'On — the split runs for every neuron on Run, and the graph is marked stale.'
            : 'The split above is for this neuron only. Ticking the box puts it in the port, which is data and marks the graph stale.'}
        </p>
      </div>
    </>
  )
}

/** Whatever the split has to show right now. A sibling component, not a closure after a return. */
function CompartmentBody({
  state,
  palette,
}: {
  state: ReturnType<typeof useCompartments>
  palette: Record<number, string>
}) {
  if (state.status === 'loading') return <p className="topo__pending">Splitting…</p>
  if (state.status === 'error') return <p className="topo__pending">{state.message}</p>
  if (state.status === 'idle') return <p className="topo__pending">No skeleton to split.</p>

  const { data } = state
  if (data.status !== 'ok') {
    return (
      <p className="topo__pending">
        {data.status === 'multiple roots'
          ? 'This reconstruction is in several pieces, so it cannot be split. Heal it first (Clean Skeletons ▸ Heal).'
          : 'This neuron has synapses of only one polarity, so there is no flow to split on.'}
      </p>
    )
  }
  return <CompartmentTable data={data} palette={palette} />
}

function CompartmentTable({
  data,
  palette,
}: {
  data: { labels: Int32Array; synapses: { pre: Uint32Array; post: Uint32Array } }
  palette: Record<number, string>
}) {
  /*
   * Memoised on the split. This walks one entry per skeleton node — seventeen thousand on a
   * traced cell — and sat in the component body, so it re-ran on every store tick and every
   * frame of a slider drag while this tab was open.
   */
  const counts = useMemo(() => {
    const out: Record<number, { nodes: number; pre: number; post: number }> = {
      [CODE_DENDRITE]: { nodes: 0, pre: 0, post: 0 },
      [CODE_AXON]: { nodes: 0, pre: 0, post: 0 },
      [CODE_LINKER]: { nodes: 0, pre: 0, post: 0 },
    }
    for (let i = 0; i < data.labels.length; i++) {
      const bucket = out[data.labels[i]!]
      if (!bucket) continue
      bucket.nodes++
      bucket.pre += data.synapses.pre[i] ?? 0
      bucket.post += data.synapses.post[i] ?? 0
    }
    return out
  }, [data])

  return (
    <>
      <table className="topo__table">
        <thead>
          <tr>
            <th>Compartment</th>
            <th>Nodes</th>
            <th>Pre</th>
            <th>Post</th>
          </tr>
        </thead>
        <tbody>
          {[CODE_DENDRITE, CODE_AXON, CODE_LINKER].map((code) => (
            <tr key={code}>
              <td>
                <i className="topo__swatch" style={{ background: palette[code] }} />
                {COMPARTMENT_NAMES[code]}
              </td>
              <td>{formatNumber(counts[code]!.nodes)}</td>
              <td>{formatNumber(counts[code]!.pre)}</td>
              <td>{formatNumber(counts[code]!.post)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
