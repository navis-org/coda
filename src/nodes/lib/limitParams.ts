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

import { ID_COLUMN_NAME } from '../../core/ids'
import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import type { ParamDef } from '../../core/node'
import type { Value } from '../../core/values'
import { isTableValue } from '../../core/values'
import { idColumn } from './tableOps'

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

/**
 * Where every neuron-count control starts warning, so one number governs all of them.
 *
 * It governs more than the Skeletons and Meshes nodes — the Connectome pack's synapse nodes too, and
 * nothing can reach the NBLAST nodes that these did not fetch, so their threshold is this one. Restating the literal there
 * made "parity with the Skeletons node" a comment rather than a fact.
 *
 * It used to be a **refusal** at 500 — and 25 for meshes, and 100 for synapses, each picked
 * before the thing that governs the cost existed. It is now the point at which the node says
 * what it is about to do and then does it (see `core/limits.ts`), which is why the same number
 * can be both the default and the maximum of the control: past ten thousand neurons every
 * backend in the tree is into tens of minutes, and that is worth a sentence on the card
 * whatever anybody set.
 */
export const MAX_NEURONS = 10000

/**
 * Read neuron ids off the incoming table, saying so when the set is a large one.
 *
 * `cost` names what actually gets expensive, because it differs per node and the number is
 * otherwise unexplainable. Two earlier versions of this message were wrong in ways worth
 * keeping in view: the first blamed "this viewer", which has no cap of its own and is not what
 * was refusing, and the second refused at all — a fetch of four thousand skeletons is a long
 * wait, not an impossibility, and the node's job is to say which.
 *
 * An empty input still throws. That is not a guard rail: there is nothing to fetch, so there
 * is no result to warn about.
 */
// Shared by the Skeletons and Meshes nodes, `out.topology` and the Connectome pack's synapse nodes,
// which fetch for the same reason and would otherwise each carry a copy of the ceiling, the message
// and the empty-input rule.
export function neuronIdsFrom(
  ctx: Warner,
  value: Value | undefined,
  limit: number,
  cost: string,
): string[] {
  if (!isTableValue(value)) throw new Error('Neurons input is not a table')
  const ids = idColumn(value, ID_COLUMN_NAME)
  if (ids.length === 0) throw new Error('No neuronIds in the incoming neuron table')
  if (ids.length > limit) {
    warnOverThreshold(ctx, {
      count: ids.length,
      threshold: limit,
      unit: 'neurons',
      control: "this node's Warn above",
      cost,
    })
  }
  return ids
}
