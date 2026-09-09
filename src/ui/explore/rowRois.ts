/**
 * Turning a page of per-(neuron, ROI) rows into one small stacked bar per neuron.
 *
 * Headless, so the folding is testable where the SVG is not — `rowPlots.ts`' arrangement.
 *
 * **Two rules decide whether these bars mean anything at all.**
 *
 * The first is nesting. `roiInfo` counts a synapse in `LO(R)` again in `OL(R)`, so only the
 * dataset's *primary* set may be summed — `NeuPrintSource` records this and the Profile widget
 * already obeys it. Without the filter a bar would report roughly twice the neuron's synapses and
 * the shares would be drawn from a total nobody could reproduce. An absent primary list is not an
 * empty one: it means discovery has not answered, and the honest answer then is to draw nothing
 * rather than a plausible wrong picture.
 *
 * The second is that **the regions have to be ranked across the page, not per row.** A bar whose
 * first segment is `ME(R)` on one row and `LO(L)` on the next is five colours that mean five
 * different things per line, which is worse than no bar. So one ranking is taken over every
 * neuron on screen, and each row's segments are drawn in that order — which is what makes the
 * column scannable, and it is the same reason `resolveColor` ranks categories by frequency
 * rather than per mark.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableValue } from '../../core/values'
import type { RegionRow } from '../../nodes/lib/profileStats'
import { partitionByMember, regionRows } from '../../nodes/lib/profileStats'
import { idColumn } from '../../nodes/lib/tableOps'
import { OTHER_LABEL, foldByRank } from '../colors'

/** One segment of a row's bar. */
export interface RegionShare {
  roi: string
  /** Share of this neuron's synapses in the ranked regions, 0 to 1. */
  share: number
  /** Synapses counted, for the caption. */
  count: number
  /** Rank in the page's ordering — the palette index, so a region is one colour down the list. */
  rank: number
}

/**
 * How many regions a bar draws before the rest become one "other" segment.
 *
 * Small, because the bar is 54 pixels wide: past five the segments are under ten pixels and stop
 * being separable. The tail is folded rather than dropped — a bar whose segments did not sum to
 * the neuron's synapses would be a proportion of nothing in particular. **Fold where the mark
 * folds**, which is `src/ui/colors.ts`' rule for exactly this shape.
 */
export const MAX_REGIONS = 5

/**
 * Fold a page of per-(neuron, ROI) rows into per-neuron bars, keyed by neuron id.
 *
 * Returns empty where the primary list has not arrived — see the header. `pre + post`, because a
 * region bar is about *where the neuron is*, and splitting it by polarity is the balance bar's
 * question one column over.
 */
export function regionShares(
  rows: TableValue | undefined,
  primaryRois: readonly string[] | undefined,
): Map<string, RegionShare[]> {
  // Not "no filter": an unfiltered sum double-counts, so nothing is the only honest picture.
  if (!rows || !primaryRois?.length) return new Map()

  /*
   * The fold is `profileStats`' — `partitionByMember` then `regionRows` per neuron.
   *
   * That module says why in so many words: the nested-ROI filter is "a decision made once above,
   * and a second implementation gets one of them wrong in a way that still produces a plausible
   * bar". Written out here it already had two of them — a `roi` cell of a non-string type, and
   * whether a zero total is dropped before or after folding — neither visible, which is the point.
   * What stays local is the part that is genuinely about *this* mark: one ranking across the page,
   * and the head/tail slice.
   */
  /*
   * `idColumn` and not a walk of our own: the per-cell rule is `core/ids.ts`' `idText`, and
   * invariant 8 names `src/ui` as the layer where a second spelling of it keeps appearing. Deduped
   * because the rows are one per (neuron, ROI) — an eightyfold repeat on a well-innervated page.
   *
   * `SubjectPartition` is positional — one entry per member, `undefined` where a member had no
   * rows — so the id list and the parts are read together.
   */
  const ids = [...new Set(rows.data[ID_COLUMN_NAME] ? idColumn(rows) : [])]
  const parts = partitionByMember(rows, ids)
  const perNeuron = new Map<string, RegionRow[]>()
  const total = new Map<string, number>()
  ids.forEach((id, at) => {
    const regions = regionRows(parts[at], { primaryRois })
    if (regions.length === 0) return
    perNeuron.set(id, regions)
    for (const region of regions)
      total.set(region.roi, (total.get(region.roi) ?? 0) + region.total)
  })

  /*
   * One ranking for the whole page, through `foldByRank` — which is `colors.ts`' own, so the tie
   * break is its deterministic `localeCompare` rather than whatever order the rows arrived in (a
   * colour that changed between two visits to the same page) and the residual carries the app's
   * `OTHER_LABEL` rather than a second spelling of it.
   */
  const ranking = foldByRank(total, Number.MAX_SAFE_INTEGER)

  const byNeuron = new Map<string, RegionShare[]>()
  for (const [id, regions] of perNeuron) {
    const sum = regions.reduce((a, r) => a + r.total, 0)
    if (sum <= 0) continue
    const ordered = [...regions].sort((a, b) => ranking.slotOf(a.roi) - ranking.slotOf(b.roi))
    const shares: RegionShare[] = ordered.slice(0, MAX_REGIONS).map((region) => ({
      roi: region.roi,
      count: region.total,
      share: region.total / sum,
      rank: ranking.slotOf(region.roi),
    }))
    const rest = ordered.slice(MAX_REGIONS).reduce((a, r) => a + r.total, 0)
    if (rest > 0) {
      // One segment for the tail, at the palette's own fold position.
      shares.push({ roi: OTHER_LABEL, count: rest, share: rest / sum, rank: MAX_REGIONS })
    }
    byNeuron.set(id, shares)
  }

  return byNeuron
}

/** One ring segment, as a dash pattern on a circle. */
export interface DonutArc {
  roi: string
  rank: number
  /** Arc length along the circle. */
  length: number
  /** Where the arc starts, as a negative dash offset. */
  offset: number
}

/**
 * Lay the shares out around a ring.
 *
 * **Dash offsets on one circle rather than `A` path arcs**, which is not a style choice: a segment
 * covering the whole ring is a 360° arc whose start and end points coincide, and SVG draws that as
 * *nothing*. A neuron entirely within one region is an ordinary case here — it is most fragments —
 * so the shape that renders it has to be the one that cannot degenerate.
 *
 * Offsets accumulate rather than being computed per segment, so rounding cannot open a hairline
 * gap between two arcs that are meant to touch.
 */
export function donutArcs(shares: readonly RegionShare[], circumference: number): DonutArc[] {
  const arcs: DonutArc[] = []
  let used = 0
  for (const share of shares) {
    const length = share.share * circumference
    // Only what the ring needs: the caption is built from the shares themselves.
    arcs.push({ roi: share.roi, rank: share.rank, length, offset: -used })
    used += length
  }
  return arcs
}
