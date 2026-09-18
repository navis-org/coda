/**
 * The `Warn above` control, in one place.
 *
 * Six nodes carry it — three morphology fetches, both NBLASTs and Neuroglancer — and until the
 * guard rails became warnings they at least differed in their defaults (500, 25, 100, 100, 100,
 * 500), each picked at a different time for a different reason. Converging them on one
 * threshold converged everything else too, leaving six copies of a block whose only real
 * variation is a floor and a sentence. That is the moment to factor: the alternative is that
 * the next edit to "Nothing is capped" is six edits, and a seventh node copies whichever
 * of the six it happens to land beside.
 *
 * The shared half is the part that carries the policy — `Warn above` as the label, the
 * threshold as its own maximum, `advanced` because nobody sets it on the way past — and the
 * per-node half is `counting`, which names what the threshold is over and cannot be shared.
 *
 * Follows `encodingParams.ts`'s `colorParams`, which is the same shape of thing for the same
 * reason.
 */

import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import type { ParamDef } from '../../core/node'

export interface WarnAboveOptions {
  /** The threshold, which is also the control's maximum: `MAX_NEURONS`, `SEGMENTS_WARN`. */
  threshold: number
  /** Smallest sensible value. 1 for a fetch; 2 for a comparison, which needs two sides. */
  min: number
  /**
   * What is being counted, as a clause completing "Show a warning before …".
   *
   * The per-node half of one sentence: the shared half says a warning is all that happens, and
   * `core/limits.ts` records why that has to survive being copied. Kept a clause rather than a
   * sentence so every one of the six reads the same way.
   */
  counting: string
}

export function warnAboveParam(options: WarnAboveOptions): ParamDef {
  return {
    id: 'limit',
    kind: 'int',
    label: 'Warn above',
    help: `Show a warning before ${options.counting}. Nothing is capped.`,
    default: options.threshold,
    min: options.min,
    max: options.threshold,
    step: 10,
    advanced: true,
  }
}

/**
 * The warning the `Warn above` control actually produces, for a node that counts each side
 * of a comparison separately.
 *
 * Here beside the control rather than in each node, for `warnAboveParam`'s reason: four
 * comparison nodes — both NBLASTs, syNBLAST and Distance between — carried the same closure with
 * the same `unit`, the same `control` and a `cost` differing by one verb, so the next edit to how
 * this reads was four edits and the fourth would be the one somebody missed. What stays with the
 * caller is `cost`, which is the only part that is about the node.
 *
 * **The fourth was missed on the way in**, which is the argument holding still: syNBLAST kept its
 * own `warnOverThreshold` for a round and had already drifted — one message off
 * `Math.max(rows, cols)` reading `neurons`, where the other three name the side that is large.
 *
 * Silent at or below the limit, so a caller passes every count rather than guarding first — the
 * guard and the threshold in one condition is what `SILENT` records going wrong.
 */
export function warnSideCount(
  ctx: Warner,
  side: string,
  count: number,
  limit: number,
  cost: string,
): void {
  if (count <= limit) return
  warnOverThreshold(ctx, {
    count,
    threshold: limit,
    unit: `neurons on ${side}`,
    control: "this node's Warn above",
    cost,
  })
}

/**
 * The `Label by` picker the four comparison nodes carry.
 *
 * **Not `displayLabels.ts`' `labelParams`**, which is the other builder of a control with this
 * name and is a different control: that one mints a `matchColumn`/`labelColumn` *pair* reading an
 * Annotations port, where this is one optional picker on the Query port. Named here so the next
 * node copies whichever it means rather than whichever it lands beside.
 *
 * `warnAboveParam`'s argument at a second control: the four were byte-identical apart from
 * `help`, so the shared half — that it is an optional column picker on the Query port, defaulting
 * to empty — is stated once and each node supplies the sentence that is its own. `optional` is
 * the load-bearing flag: `resolveColumn`'s rule 3 hands a *required* picker whose stored default
 * the schema lacks the first compatible column, which here would name every row after whatever
 * happens to come first.
 */
export function labelColumnParam(help: string): ParamDef {
  return {
    id: 'labelColumn',
    kind: 'column',
    label: 'Label by',
    from: 'query',
    default: '',
    optional: true,
    help,
  }
}
