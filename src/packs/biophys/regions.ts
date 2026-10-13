/**
 * A compartment model's regions: the names channels are placed on (`channelRows.ts`). They start as
 * the skeleton's own labels (`regionLabels`) and can be **painted** in the Compartment Model's
 * Regions tab, the Axon/Dendrite Split editor's gesture: everything distal of a point, or everything
 * else, becomes a named region (`RegionStroke`).
 *
 * Strokes are applied in order and a later one paints over an earlier one and over the skeleton's
 * labels, so every node ends in exactly one region and regions never overlap — an initiation zone
 * between two points is "distal of A → SIZ", then "distal of B → axon". Anchored by position, with
 * the root each was made against, as split corrections are (`paintSubtrees`), so a re-fetch that
 * renumbers nodes keeps them; one that lands nowhere is counted on the card.
 */

import type { SkeletonGeometry } from '../../core/values'
import { SWC_SOMA, compartmentKey, compartmentName } from '../../core/values'
import type { StoredStroke } from '../../nodes/lib/splitCorrections'
import { paintSubtrees, readStrokes } from '../../nodes/lib/splitCorrections'
import { agree, plural } from '../../style/format'
import { UNLABELLED_REGION, isNameableRegion } from './channelRows'

/** The param the Regions tab writes: one `RegionStroke` as JSON per entry, in order. */
export const REGIONS_PARAM = 'paintedRegions'

export interface RegionStroke extends StoredStroke {
  /** The region it paints: a new name, or one the model already has (`axon` restores it). */
  readonly region: string
  /** The root "distal" was measured from, nm: always stored, the editor drawing from one. */
  readonly root: readonly [number, number, number]
}

export function writeRegionStroke(stroke: RegionStroke): string {
  return JSON.stringify(stroke)
}

/**
 * The stored strokes, anything malformed dropped — a hand-edited file's stray entry included, and
 * one painting `unlabelled`, which no channel row can name.
 */
export function readRegionStrokes(raw: unknown): RegionStroke[] {
  return readStrokes(raw, (stroke, { region }) => {
    const name = typeof region === 'string' ? region.trim() : ''
    const { root } = stroke
    return root && isNameableRegion(name) ? { ...stroke, root, region: name } : undefined
  })
}

/** The card's and the Regions tab's one sentence for strokes that land on no node. */
export function staleStrokes(n: number): string {
  return (
    `${plural(n, 'painted stroke')} ${agree(n, 'lands', 'land')} on no node of this skeleton ` +
    `and ${agree(n, 'is', 'are')} not applied.`
  )
}

/** The region every soma is, whatever labelled it: index 1 of every model's names. */
export const SOMA_REGION = 1

/**
 * A region per node as an index into a names table of the model's own — `unlabelled` at 0, the
 * soma at 1, then each other region the skeleton has, by name. Named by `compartmentKey`, the one
 * reading of a label in either vocabulary: a computed split (`split`, the Axon/Dendrite Split's
 * axon, dendrite and linker) where there is one, else the source's SWC codes, basal and apical both
 * `dendrite`. So a channel placed on `axon` means the same wherever the labels came from. The soma
 * is the source's own label either way, a split having none; a code neither vocabulary has keeps
 * its SWC name.
 */
/**
 * Kept per skeleton: it depends on nothing else, and the Compartment Model, a `cheap` node, asks on
 * every edit — as does its Regions tab. Callers read it and never write it; `paintedRegions` copies
 * before painting.
 */
const LABELS = new WeakMap<SkeletonGeometry, { label: Int32Array; names: string[] }>()

export function regionLabels(skeleton: SkeletonGeometry): {
  label: Int32Array
  names: string[]
} {
  const hit = LABELS.get(skeleton)
  if (hit) return hit
  const labels = labelRegions(skeleton)
  LABELS.set(skeleton, labels)
  return labels
}

function labelRegions(skeleton: SkeletonGeometry): {
  label: Int32Array
  names: string[]
} {
  const names = [UNLABELLED_REGION, 'soma']
  const index = new Map<string, number>([['soma', SOMA_REGION]])
  const n = skeleton.parents.length
  const label = new Int32Array(n)
  const { compartments: codes, split } = skeleton
  for (let v = 0; v < n; v++) {
    const code = codes?.[v] ?? 0
    const name =
      code === SWC_SOMA
        ? 'soma'
        : split
          ? compartmentKey(split[v]!, true)
          : code > 0
            ? (compartmentKey(code, false) ?? compartmentName(code) ?? `swc ${code}`)
            : undefined
    if (!name) continue
    let i = index.get(name)
    if (i === undefined) {
      i = names.length
      index.set(name, i)
      names.push(name)
    }
    label[v] = i
  }
  return { label, names }
}

/**
 * A skeleton's regions with this neuron's strokes painted over them, in order: per node an index
 * into `names`, a stroke's new region added to the table where it first lands. `stale` counts
 * the strokes for this neuron that landed nowhere.
 */
export function paintedRegions(
  skeleton: SkeletonGeometry,
  strokes: readonly RegionStroke[],
  /** `regionLabels(skeleton)`, where the caller already has it; left as it is. */
  base = regionLabels(skeleton),
): { label: Int32Array; names: string[]; stale: number } {
  const mine = strokes.filter((s) => s.neuron === skeleton.id)
  if (mine.length === 0) return { ...base, stale: 0 }
  const names = [...base.names]
  const label = base.label.slice()
  let applied = 0
  for (const s of mine) {
    // A name joins the table only where its stroke lands, so a stale one names no empty region.
    const known = names.indexOf(s.region)
    const code = known >= 0 ? known : names.length
    const stroke = { at: s.at, scope: s.scope, root: s.root, code }
    if (paintSubtrees(skeleton, label, [stroke]) === 0) continue
    if (known < 0) names.push(s.region)
    applied++
  }
  return { label, names, stale: mine.length - applied }
}
