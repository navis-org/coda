/**
 * Where a graph builder puts its cards when there is no layout pass to ask.
 *
 * Not ELK, which computes its own spacing and needs every card's real height — which only the
 * canvas has. This is for the builders that must lay a graph out synchronously and headless: the
 * Workflow Wizard (and the starters, which are its output), the assistant's applier, which runs
 * before the graph is committed, and the node guide's demo builder. Two numbers: `cardWidth` for
 * how wide a card is and `CARD_GAP` for what goes between two.
 *
 * ## The rules, and which failure each is for
 *
 * **A card's column is its depth in the dataflow** — the longest path to it over the wires given.
 * A reference wire is not a dependency (`PortDef.reference`, and `topoSort`'s reason), so it is
 * left out; otherwise an annotation chain reading its datastack from the dataset it feeds is a
 * two-edge loop and one end of it lands a column late. A cycle is tolerated rather than trusted:
 * the assistant places a plan before anything has checked it for cycles, and a cyclic one has to
 * be refused by the checker, not hang here.
 *
 * **Every end of the chain shares the last column.** A card nothing reads is a viewer in every
 * graph a builder makes, and a viewer's *height* is its content — an unrun Table card is short and
 * a run one is 387px, so a viewer placed in a column above or below an ordinary card overlaps it
 * the moment the graph runs. Measured in a browser, twice, on the wizard's viewers and on Linkage.
 *
 * **Everything else is pulled right to the column before the nearest card that reads it.** Longest
 * path alone left-aligns: an arm with nothing in front of it starts at column 0 while its sibling
 * carrying a six-card annotation chain starts at column 4, so two datasets meeting at a mapper sat
 * four columns apart; and a source feeding only a deep card sat at the far left, a wire's length
 * from what it feeds. Pulled right, bands align at the card they meet at and every source sits
 * beside its consumer.
 *
 * **A column is as wide as the widest card in it** — through `cardWidth`, which reads the
 * definition, so a 520px Explore or a 620px ROI viewer takes its own room rather than a column
 * sized for a 232px card.
 *
 * **A row is the caller's, where it has one.** Rows are in `ROW_HEIGHT`s and may be fractional; a
 * card with none is stacked under whatever its column holds. Cards given the *same* column and row
 * sit side by side rather than on top of each other — which is how several viewers off one port
 * share a column, stepped by their own widths.
 */

import type { Wire } from '../core/graph'
import { isReferencePort } from '../core/graph'
import { cardWidth } from './elkGraph'
import type { XY } from './place'

/** Clear space between one card's right edge and the next column, for every builder. */
export const CARD_GAP = 90

/** How far apart two rows of cards are. A row hint is in these. */
const ROW_HEIGHT = 190

/** Where the first card of a placed graph lands on an empty canvas. */
export const GRID_ORIGIN: XY = { x: 60, y: 80 }

/** A card to place. */
interface ColumnCard {
  id: string
  type: string
  /** Its row, in `ROW_HEIGHT`s. Absent: stacked under what its column already holds. */
  row?: number
}

interface Placed extends ColumnCard {
  width: number
}

/**
 * Positions for the cards, in columns by dataflow depth. See the module note for every rule.
 *
 * A wire whose ends are not both among the cards is ignored, which is what lets the assistant
 * place a plan's new cards by their depth *within the plan*: a card appended to a five-deep chain
 * belongs beside that chain's end, not five columns further out.
 */
export function placeInColumns(
  given: readonly ColumnCard[],
  wires: readonly Wire[],
  origin: XY = GRID_ORIGIN,
): Map<string, XY> {
  const cards: Placed[] = given.map((card) => ({ ...card, width: cardWidth(card.type) }))
  const ids = new Set(cards.map((card) => card.id))
  const types = new Map(cards.map((card) => [card.id, card.type]))
  const feeders = new Map<string, string[]>()
  const readers = new Map<string, string[]>()
  for (const [from, , to, toPort] of wires) {
    if (from === to || !ids.has(from) || !ids.has(to)) continue
    if (isReferencePort(types.get(to), toPort)) continue
    feeders.set(to, [...(feeders.get(to) ?? []), from])
    readers.set(from, [...(readers.get(from) ?? []), to])
  }

  // Longest path in. The `visiting` guard is what makes a cyclic plan terminate: the back edge
  // simply does not count, and the checker downstream refuses the plan.
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let best = 0
    for (const feeder of feeders.get(id) ?? []) best = Math.max(best, depthOf(feeder) + 1)
    visiting.delete(id)
    depth.set(id, best)
    return best
  }
  for (const card of cards) depthOf(card.id)

  // A reader that is not strictly deeper is across a cycle's back edge, and constrains nothing.
  const forward = (id: string) =>
    (readers.get(id) ?? []).filter((reader) => depth.get(reader)! > depth.get(id)!)

  const last = Math.max(0, ...depth.values())
  const column = new Map<string, number>()
  // Deepest first, so every reader's column is settled before its feeder asks for it.
  const order = [...cards].sort((a, b) => depth.get(b.id)! - depth.get(a.id)!)
  for (const card of order) {
    const ahead = forward(card.id)
    const fed = (feeders.get(card.id) ?? []).length > 0
    if (ahead.length === 0) {
      // An end of the chain goes to the last column; a card with no wires at all stays put.
      column.set(card.id, fed ? last : depth.get(card.id)!)
      continue
    }
    const nearest = Math.min(...ahead.map((reader) => column.get(reader)!))
    column.set(card.id, Math.max(depth.get(card.id)!, nearest - 1))
  }

  // Grouped by column, then by row. Only columns something landed in are drawn, so a depth
  // nothing ended up at costs no canvas.
  const slots = new Map<number, Map<number, Placed[]>>()
  for (const card of cards) {
    const index = column.get(card.id)!
    const rows = slots.get(index) ?? new Map<number, Placed[]>()
    slots.set(index, rows)
    const row = card.row ?? (rows.size === 0 ? 0 : Math.floor(Math.max(...rows.keys())) + 1)
    rows.set(row, [...(rows.get(row) ?? []), card])
  }

  const out = new Map<string, XY>()
  let x = origin.x
  for (const index of [...slots.keys()].sort((a, b) => a - b)) {
    let widest = 0
    for (const [row, slot] of slots.get(index)!) {
      // Side by side within a slot, each stepped by its own width.
      let dx = 0
      for (const card of slot) {
        out.set(card.id, { x: x + dx, y: origin.y + row * ROW_HEIGHT })
        dx += card.width + CARD_GAP
      }
      widest = Math.max(widest, dx - CARD_GAP)
    }
    x += widest + CARD_GAP
  }
  return out
}
