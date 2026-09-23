/**
 * Recipes: a set of nodes somebody uses together, saved so it can be put back in one gesture.
 *
 * **A recipe is a clipboard fragment that remembers its edges.** The fragment half is
 * `core/clipboard.ts`' and is not reimplemented: `fragmentBody` decides what a selection takes,
 * `deserializeGraph` reads it back (so a recipe saved months ago gets the renames, the
 * `absentMeans` and the unknown-type drops a file gets), and `insertFragment` re-identifies it.
 * What a fragment deliberately throws away is every wire with one end outside the selection —
 * right for a paste, which must not steal an input, and useless for the setup this exists for:
 * the FlyWire annotation chain is six cards whose whole purpose is two reference wires *from* a
 * dataset and one wire back *into* its `annotations` port. Saved as a fragment it comes back as
 * six cards attached to nothing.
 *
 * So the crossing wires are recorded as **slots**, and a slot is **one outside node**, not one
 * wire. That chain's three wires all touch the same dataset, and listing them as three things to
 * bind would ask for one dataset three times — and allow binding them to three different ones,
 * which nothing downstream would flag. Grouped, the chain has one slot, "FlyWire", and a slot's
 * wires may run in both directions.
 *
 * **Attaching is all-or-nothing per slot.** A half-attached chain — references wired, the output
 * refused because the dataset's `annotations` port was already taken — reads the datastack and
 * feeds nothing, under cards that all look configured. Either every wire of the slot fits the
 * node, or none is made and the reason is handed back.
 *
 * **What a recipe attaches to is the caller's to say, and only ever one node.** The rule chosen
 * for the canvas is *the selection, never a search*: two datasets on one canvas are exactly where
 * "the compatible one" is a guess, and CLAUDE.md records two automatic matchers that picked a
 * plausible wrong candidate with nothing to say so. Given that node, the first slot that fits it
 * takes it, slots with a wire *into* the recipe ahead of the rest — a selection is usually what
 * the recipe should read from, and a slot that only *feeds* a node would otherwise attach a
 * recipe's output to whatever input on the selected dataset happened to take a table.
 *
 * Headless, so `recipes.test.ts` reads it with no DOM. Storage is the store's, and the surfaces
 * are the UI's; what crosses to them is a `Recipe` and the text `recipeText` writes.
 */

import type { Point } from './clipboard'
import { fragmentBody, insertFragment } from './clipboard'
import type { CodaGraph, GraphNode } from './graph'
import {
  addEdge,
  deserializeGraph,
  edgeInto,
  nodeLabel,
  nodePorts,
  nodesById,
  resolvePort,
} from './graph'
import { createGroup } from './groups'
import { checkConnection, inferGraph } from './inference'
import { defaultParams } from './node'
import { getNodeDef } from './registry'
import type { Socket } from './sockets'
import { dragReaches } from './sockets'

/**
 * What a recipe file says it is. Required on read, unlike `FRAGMENT_MARKER`: without it the text
 * carries no slots, and a fragment is already something ⌘V can place.
 */
export const RECIPE_MARKER = 'coda.recipe'

/** What an unnamed recipe is called — the one spelling of the fallback. */
const UNNAMED = 'Untitled recipe'

/** One wire that crossed the selection's edge when the recipe was saved. */
export interface SlotWire {
  /** `in` ran from the outside node into the recipe; `out` from the recipe to it. */
  dir: 'in' | 'out'
  /** The inside end: a fragment-local node id, and the port on it. */
  node: string
  port: string
  /**
   * The port on the outside node the wire used. A preference, not a requirement — the node a
   * recipe is attached to need not be the type it was saved against, so a miss falls back to the
   * first port of the bound node that fits (see `wireOne`).
   */
  outer: string
}

/** One outside node the recipe was wired to, and every wire that touched it. */
export interface RecipeSlot {
  /** What the surfaces call it — the outside node's title when it was saved. */
  label: string
  wires: SlotWire[]
}

export interface Recipe {
  /**
   * Also the title of the frame `recipeFrom` puts in the fragment, copied there once at save time
   * so ⌘V of the file arrives framed too. A rename has to write both.
   */
  name: string
  /** The fragment, positions absolute as saved; `insertFragment` decides where it lands. */
  graph: CodaGraph
  slots: RecipeSlot[]
}

export interface RecipeOptions {
  name: string
  /**
   * Nodes whose params go back to their declared defaults, for a setup whose values were this
   * graph's rather than the recipe's — an id list, a file name. Everything else is kept verbatim,
   * which is the default because the configuration is usually why the set was worth saving.
   */
  reset?: readonly string[]
}

/**
 * The chosen nodes as a recipe, or undefined when none of them are there.
 *
 * **Framed** at save time, titled with the recipe's name, so what arrives is visibly one thing and
 * ⇧⌘G takes it apart — and so it arrives framed by *either* way in, the frame being part of the
 * fragment that ⌘V places too. Not when the selection carries frames of its own (groups do not
 * nest, and wrapping would pull its cards out of them), nor around a single card, where a frame
 * hides nothing.
 *
 * Slots come out in the order their outside nodes sit in the graph, and each slot's wires in edge
 * order, so saving the same selection twice writes the same document.
 */
export function recipeFrom(
  graph: CodaGraph,
  nodeIds: readonly string[],
  { name, reset = [] }: RecipeOptions,
): Recipe | undefined {
  const body = fragmentBody(graph, nodeIds)
  if (!body) return undefined
  const title = name.trim() || UNNAMED
  const inside = new Set(body.nodes.map((n) => n.id))
  const resetIds = new Set(reset)
  const nodes = body.nodes.map((node) => {
    const def = resetIds.has(node.id) ? getNodeDef(node.type) : undefined
    return def ? { ...node, params: defaultParams(def) } : node
  })
  let fragment: CodaGraph = { ...body, nodes }
  if (nodes.length > 1 && !body.groups?.length) {
    fragment = createGroup(
      fragment,
      nodes.map((n) => n.id),
      { title },
    )
  }

  return { name: title, graph: fragment, slots: recipeSlots(graph, inside) }
}

/**
 * The slots cutting these cards out of `graph` would record — `recipeFrom`'s half that the Save as
 * Recipe dialog shows before anything is saved, apart so the dialog does not build a fragment to
 * read them.
 */
export function recipeSlots(graph: CodaGraph, nodeIds: Iterable<string>): RecipeSlot[] {
  const inside = new Set(nodeIds)
  const wiresByOuter = new Map<string, SlotWire[]>()
  for (const e of graph.edges) {
    const fromInside = inside.has(e.source)
    if (fromInside === inside.has(e.target)) continue
    const outer = fromInside ? e.target : e.source
    const wire: SlotWire = fromInside
      ? { dir: 'out', node: e.source, port: e.sourceHandle, outer: e.targetHandle }
      : { dir: 'in', node: e.target, port: e.targetHandle, outer: e.sourceHandle }
    const list = wiresByOuter.get(outer)
    if (list) list.push(wire)
    else wiresByOuter.set(outer, [wire])
  }
  return graph.nodes
    .filter((n) => wiresByOuter.has(n.id))
    .map((n): RecipeSlot => ({ label: nodeLabel(n), wires: wiresByOuter.get(n.id)! }))
}

/**
 * The kinds of wire a recipe can be attached by: the sockets of the inside ports its slot wires
 * land on — `reads` where a wire runs *into* the recipe, `feeds` where one runs out of it.
 *
 * **Declared sockets, not inferred ones**: this is recorded when a recipe is saved and read by a
 * palette that has not loaded the recipe, and nothing is inferred on a fragment without its
 * inputs. That makes it a filter rather than a promise — a declared `any` passes anything, which
 * is `socketAccepts`' rule — and the attach itself is still `checkConnection`'s.
 */
export function recipeSockets(recipe: Recipe): { reads: Socket[]; feeds: Socket[] } {
  const byId = nodesById(recipe.graph)
  const reads: Socket[] = []
  const feeds: Socket[] = []
  for (const wire of recipe.slots.flatMap((slot) => slot.wires)) {
    const inside = byId.get(wire.node)
    const reading = wire.dir === 'in'
    const port =
      inside && nodePorts(inside, reading ? 'input' : 'output').find((p) => p.id === wire.port)
    if (!port) continue
    const socket: Socket = { type: port.type, ...(port.kinds ? { kinds: port.kinds } : {}) }
    ;(reading ? reads : feeds).push(socket)
  }
  return { reads, feeds }
}

/**
 * Whether a wire dragged out of `drag` could attach this recipe: from an output, through a port
 * the recipe reads; from an input, through one it feeds. `dragReaches` is the direction's rule.
 */
export function recipeTakesWire(
  sockets: { reads: readonly Socket[]; feeds: readonly Socket[] },
  drag: Socket & { from: 'source' | 'target' },
): boolean {
  return (drag.from === 'source' ? sockets.reads : sockets.feeds).some((port) =>
    dragReaches(drag, port),
  )
}

/**
 * What a recipe attaches to when nobody names a node: the selection, when it is exactly one card.
 * The palette's hint and the store's insert both ask this, so the node the hint names is the node
 * the recipe attaches to.
 */
export function selectionAttach(selection: readonly string[]): string | undefined {
  return selection.length === 1 ? selection[0] : undefined
}

/**
 * The recipe as a file: the fragment body with the marker and the slots beside it.
 *
 * One document rather than a fragment wrapped in an envelope, so the text is also a fragment —
 * `readFragment` ignores the fields it does not know, and a recipe file pasted with ⌘V places its
 * cards, framed and unattached, rather than being refused.
 */
export function recipeText(recipe: Recipe): string {
  return JSON.stringify(
    {
      coda: RECIPE_MARKER,
      recipe: { name: recipe.name, slots: recipe.slots },
      ...recipe.graph,
    },
    null,
    2,
  )
}

/**
 * Text read as a recipe, or undefined when it is not one.
 *
 * The graph goes through `deserializeGraph`, and a slot wire is then held to what survived it by
 * the same `resolvePort` an edge is, so a port renamed since the save is followed and a node this
 * build dropped takes its wires with it. A wire that cannot be placed is dropped with a warning;
 * a slot left with no wires is not a slot.
 *
 * The text is parsed twice — once here for the recipe's own fields, which `deserializeGraph`
 * does not keep, and once there. A recipe is read when a surface opens, not per keystroke, and
 * the alternative is a second reader for the graph half.
 */
export function readRecipe(text: string): { recipe: Recipe; warnings: string[] } | undefined {
  const raw = recipeDocument(text)
  if (!raw) return undefined
  let read
  try {
    read = deserializeGraph(text)
  } catch {
    return undefined
  }
  if (read.graph.nodes.length === 0) return undefined

  const { graph, warnings } = read
  const alive = nodesById(graph)
  const slots: RecipeSlot[] = []
  const rawSlots = Array.isArray(raw.recipe.slots) ? raw.recipe.slots : []
  for (const [index, s] of rawSlots.entries()) {
    if (!isRecord(s) || !Array.isArray(s.wires)) continue
    const label = typeof s.label === 'string' && s.label.trim() ? s.label : `Input ${index + 1}`
    const wires: SlotWire[] = []
    for (const w of s.wires) {
      const wire = validWire(w, alive)
      if (typeof wire === 'string') warnings.push(`Recipe slot "${label}": ${wire}`)
      else wires.push(wire)
    }
    if (wires.length) slots.push({ label, wires })
  }
  const name = typeof raw.recipe.name === 'string' ? raw.recipe.name.trim() : ''
  return { recipe: { name: name || UNNAMED, graph, slots }, warnings }
}

/**
 * A recipe file under a new name, and the name as written (trimmed, the fallback filled in); or
 * undefined when the text is not a recipe.
 *
 * Retitles the frame too: `recipeFrom` copied the name into it, and a rename that left the old
 * title on the frame would insert a box called something the shelf no longer says. Every frame
 * carrying the old name is retitled, which includes a frame of the user's own that the recipe was
 * named after — the same box, by the same name, so the same rename.
 *
 * **Edits the stored text rather than a read recipe.** `readRecipe` heals what it reads, and a
 * card from a newer build is *dropped*; writing that back would make a rename in an older tab
 * delete the card for the build that knows it.
 */
export function renamedRecipeText(
  text: string,
  name: string,
): { text: string; name: string } | undefined {
  const raw = recipeDocument(text)
  if (!raw) return undefined
  const before = raw.recipe.name
  const after = name.trim() || UNNAMED
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((g: unknown) =>
        isRecord(g) && g.title === before ? { ...g, title: after } : g,
      )
    : raw.groups
  const doc = { ...raw, recipe: { ...raw.recipe, name: after }, groups }
  return { text: JSON.stringify(doc, null, 2), name: after }
}

/** A stored slot wire held to the nodes that survived the load, or why it could not be. */
function validWire(raw: unknown, alive: ReadonlyMap<string, GraphNode>): SlotWire | string {
  const { dir, node, port, outer } = isRecord(raw) ? raw : {}
  if (
    (dir !== 'in' && dir !== 'out') ||
    typeof node !== 'string' ||
    typeof port !== 'string' ||
    typeof outer !== 'string'
  ) {
    return 'dropped a malformed wire'
  }
  const inside = alive.get(node)
  if (!inside) return `dropped a wire at a node this build did not load (${node})`
  const healed = resolvePort(nodePorts(inside, dir === 'in' ? 'input' : 'output'), port)
  if (!healed) return `dropped a wire at ${inside.type} (${node}): no port "${port}"`
  return { dir, node, port: healed, outer }
}

/** The text parsed as a recipe document — the marker and a `recipe` field — or undefined. */
function recipeDocument(
  text: string,
): (Record<string, unknown> & { recipe: Record<string, unknown> }) | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.coda !== RECIPE_MARKER || !isRecord(raw.recipe)) return undefined
  return raw as Record<string, unknown> & { recipe: Record<string, unknown> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export interface InsertOptions {
  /** Where the recipe's top-left corner lands. Without one, `PASTE_OFFSET` from where it was. */
  at?: Point
  /** The one node to attach a slot to — the selection. See the header for which slot takes it. */
  attach?: string
  /**
   * The port on `attach` a dropped wire left, and which end of the wire that was. The slot with a
   * wire running that way is tried first, and that wire tries this port before the saved one — so
   * a recipe offered because it fits the dragged port is attached through it.
   */
  via?: Via
}

/** A dropped wire's end on the node a recipe attaches to. */
export interface Via {
  port: string
  from: 'source' | 'target'
}

export interface InsertResult {
  graph: CodaGraph
  /** The ids the recipe's nodes were given, in document order — what the caller selects. */
  nodeIds: string[]
  /** The slot `attach` was wired to, or undefined when none took it (or none was asked). */
  attached?: RecipeSlot
  /**
   * Why each slot that was tried refused `attach`, in words for the status bar. Empty when one
   * attached or none was asked.
   */
  refusals: string[]
}

/**
 * Merge a recipe into a graph, re-identified, attached to `attach` where a slot fits.
 *
 * One graph out, so the store's `commit` makes the whole insertion one undo step.
 */
export function insertRecipe(
  graph: CodaGraph,
  recipe: Recipe,
  { at, attach, via }: InsertOptions = {},
): InsertResult {
  const { graph: pasted, nodeIds, idMap } = insertFragment(graph, recipe.graph, at)
  // Looked up in the graph as it was, so it can never be one of the cards just placed.
  const target = attach === undefined ? undefined : graph.nodes.find((n) => n.id === attach)
  const refusals: string[] = []
  // Reads first unless a wire was dropped from an input, which is a question about what it feeds.
  const lead = via?.from === 'target' ? 'out' : 'in'
  if (target) {
    for (const slot of first(recipe.slots, (s) => s.wires.some((w) => w.dir === lead))) {
      const wired = attachSlot(pasted, slot, idMap, target, via)
      if (typeof wired !== 'string')
        return { graph: wired, nodeIds, attached: slot, refusals: [] }
      refusals.push(`${slot.label}: ${wired}`)
    }
  }
  return { graph: pasted, nodeIds, refusals }
}

/** `items` with the ones matching `lead` moved to the front, each half in its own order. */
function first<T>(items: readonly T[], lead: (item: T) => boolean): T[] {
  return [...items.filter(lead), ...items.filter((item) => !lead(item))]
}

/**
 * Every wire of one slot made against `target`, or the reason the first one could not be.
 *
 * Wires *into* the recipe go first, and each is checked against a fresh inference of the graph as
 * it stands — a passthrough's output type is its input's, so an outgoing wire only checks once the
 * incoming ones are in. The assistant's plan applier makes the same call for the same reason.
 */
function attachSlot(
  graph: CodaGraph,
  slot: RecipeSlot,
  idMap: ReadonlyMap<string, string>,
  target: GraphNode,
  via: Via | undefined,
): CodaGraph | string {
  let next = graph
  for (const wire of first(slot.wires, (w) => w.dir === 'in')) {
    const prefer = via && (via.from === 'source') === (wire.dir === 'in') ? via.port : undefined
    // Every slot wire names a card in the fragment — `recipeFrom` records only those, and
    // `readRecipe` drops the rest — and `insertFragment` maps every card.
    const wired = wireOne(next, wire, idMap.get(wire.node)!, target, prefer)
    if (typeof wired === 'string') return wired
    next = wired
  }
  return next
}

/**
 * One slot wire made on the first of `target`'s ports that takes it: the dropped wire's port
 * (`prefer`) first where there is one, then the saved port, then the rest.
 *
 * The saved port is matched by id and nothing more: the target may be another type from the one
 * the recipe was saved against, so `resolvePort`'s renames — one type's history — do not apply.
 * An input already wired is never taken, because `addEdge` would evict whatever feeds it, which
 * is an attach silently stealing an input.
 */
function wireOne(
  graph: CodaGraph,
  wire: SlotWire,
  inside: string,
  target: GraphNode,
  prefer: string | undefined,
): CodaGraph | string {
  const reads = wire.dir === 'in'
  const side = nodePorts(target, reads ? 'output' : 'input')
  const inference = inferGraph(graph)
  let reason: string | undefined
  const ordered = first(
    first(side, (p) => p.id === wire.outer),
    (p) => p.id === prefer,
  )
  for (const port of ordered) {
    if (!reads && edgeInto(graph, target.id, port.id)) {
      reason ??= `${port.label} is already wired`
      continue
    }
    const outer = { nodeId: target.id, portId: port.id }
    const inner = { nodeId: inside, portId: wire.port }
    const [from, to] = reads ? [outer, inner] : [inner, outer]
    const check = checkConnection(graph, inference, from, to)
    if (!check.ok) {
      reason ??= check.reason
      continue
    }
    return addEdge(graph, {
      source: from.nodeId,
      sourceHandle: from.portId,
      target: to.nodeId,
      targetHandle: to.portId,
    })
  }
  return reason ?? `no ${reads ? 'output' : 'input'} to wire`
}
