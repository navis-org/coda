/**
 * Ordering within a layer, by repeated barycentre sweeps.
 *
 * The middle step of every layered drawing: once each node has a layer, decide the order *within*
 * each one so that the connections between layers cross as little as possible. Shared because two
 * viewers do it — `flowChartLayout.ts` over boxes and routing corridors, `sankeyLayout.ts` over
 * flow nodes — and an ordering rule written twice is an ordering rule that drifts. The two
 * pictures are laid out by different code in every other respect and would still be expected to
 * put the same graph in the same order.
 *
 * **Forwards then backwards, four times**, which is the classic schedule and is where the returns
 * stop at the sizes these viewers draw; `networkLayout.ts`' own version settled on the same number
 * independently. Ties break on the slot index, so the arrangement is deterministic given the node
 * order — what invariant 4 requires of anything that reaches a drawing.
 *
 * **Weighted**, and a caller that has no weight passes 1 rather than 0. At 0 an edge exerts no
 * pull at all and lets its endpoints drift to opposite ends of their layers, which is the
 * opposite of what an unmeasured connection should do: it is still a connection.
 */

/** Neighbours of each slot on one side, as `[slot, pull]`. Indexed by slot. */
export type Neighbours = ReadonlyArray<ReadonlyArray<readonly [number, number]>>

export interface BarycentreInput {
  /**
   * Slot indices per layer, in their arrival order.
   *
   * **Mutated in place** into the final order, which is what both callers want: the arrays are
   * already the thing the placement step walks, and returning a copy would leave two orderings
   * for a reader to keep in step.
   */
  buckets: ReadonlyMap<number, number[]>
  /** Layer keys, ascending. Handed in rather than derived, so one sort decides both. */
  layers: readonly number[]
  /** Neighbours in the previous layer. */
  up: Neighbours
  /** Neighbours in the next layer. */
  down: Neighbours
  /** Total slots, i.e. the length `up` and `down` are indexed by. */
  count: number
}

/**
 * Forward-and-back sweeps. Four is the classic schedule and where the returns stop at the sizes
 * these viewers draw; a constant rather than an option, because no caller has wanted another
 * number and an option nobody passes is a number with two homes.
 */
const PASSES = 4

export function barycentreOrder(input: BarycentreInput): void {
  const { buckets, layers, up, down, count } = input

  /*
   * Rank within a layer, as a local rather than a field on the caller's node type.
   *
   * It is scratch state that only this function maintains, and holding it on the node made it a
   * second copy of an ordering the buckets already carry — two representations of one thing, kept
   * in step by a hand-written re-sort.
   */
  const rank = new Float64Array(count)
  for (const layer of layers) buckets.get(layer)!.forEach((slot, i) => (rank[slot] = i))

  const sweep = (order: readonly number[], side: Neighbours) => {
    for (const layer of order) {
      const members = buckets.get(layer)!
      const scored = members.map((slot) => {
        const near = side[slot] ?? []
        if (near.length === 0) return { slot, score: rank[slot]! }
        let sum = 0
        let total = 0
        for (const [other, pull] of near) {
          sum += rank[other]! * pull
          total += pull
        }
        return { slot, score: total === 0 ? rank[slot]! : sum / total }
      })
      scored.sort((a, b) => a.score - b.score || a.slot - b.slot)
      // Written straight back rather than re-sorted: `members` has to end up in `scored`'s
      // permutation, and sorting it by the rank just assigned reproduces exactly that.
      for (let i = 0; i < scored.length; i++) {
        const slot = scored[i]!.slot
        rank[slot] = i
        members[i] = slot
      }
    }
  }

  const backwards = [...layers].reverse()
  for (let pass = 0; pass < PASSES; pass++) {
    sweep(layers, up)
    sweep(backwards, down)
  }
}
