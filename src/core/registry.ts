/**
 * Node registry. Node packs register themselves at import time; the editor reads the
 * registry to build the add-node palette and to resolve types when loading a file.
 */

import { MISSING_TYPE, missingNodeDef } from './missing'
import type { NodeCategory, NodeDefinition, ParamValues } from './node'
import { findParam, withDefaults } from './node'
import { nodeTypeProblem, packIdProblem, packOf, typeKey } from './nodeType'
import { allInputPorts, allOutputPorts, isPortGroup } from './ports'

const definitions = new Map<string, NodeDefinition>()

/** Former type ids, each to the live type that now answers for it — see `NodeDefinition.formerTypes`. */
const formerTypes = new Map<string, string>()

/**
 * A node pack: a directory under `src/packs/` whose nodes are registered together, under its id.
 *
 * Only the nodes are here. What else a pack brings is found where each surface already looks for
 * it, by file — `glyphs.ts`, `seeAlso.ts` and `help/*.md` in the pack's directory (see
 * `src/packs/index.ts`) — because two of those surfaces are drawn by a static page that must not
 * import a single node definition.
 */
export interface PackDefinition {
  /**
   * The prefix its node types carry — `zapbench` for `zapbench:traces` — unless it keeps built-in
   * ids, and the name every switch, shortcut and `requires` uses for it.
   */
  id: string
  /** What the pack is called where somebody switches it on or off. */
  label: string
  /** One line saying what the pack adds, beside that switch. */
  description: string
  /**
   * Whether the pack starts switched on for somebody who has never touched its switch. Absent
   * means on. A pack most readers do not need says `false`, and a shortcut (`packs/shortcuts.ts`)
   * is how the readers who do need it get it switched on.
   */
  defaultOn?: boolean
  /**
   * The packs this one needs switched on — Cortex building on CAVE, and so on Connectome, CAVE's
   * parent. Following the switches'
   * rule (`ui/packSwitches.ts`): a required pack is on whenever anything needing it is, switching
   * this one on switches them on, and switching one off while this needs it is refused.
   */
  requires?: readonly string[]
  /**
   * The pack this one is part of — neuPrint within Connectome. **Not a requirement, the opposite
   * direction**: switching the parent off takes every child with it (each child's own switch is
   * remembered for when the parent comes back), where switching off a *required* pack is refused.
   * A child is offered only while it and its parent are both on, nests under it in the Plugins
   * dialog, and a shortcut naming a child switches the parent on too. One level only.
   */
  parent?: string
  /**
   * Its nodes keep the built-in ids they had before they moved into the pack
   * (`neuron.connectivity`, not `connectome:connectivity`). A declared exception to the
   * `pack:name` grammar, for nodes that existed first: renaming Connectome's twelve would have
   * touched some four hundred references for no change in behaviour. The cost is that the id no
   * longer says which pack a node is from, so that is asked of the registry (`packOfType`), and a
   * placeholder for one cannot name its pack. A new pack's nodes never take this.
   */
  keepsBuiltInIds?: true
  /**
   * The node whose drawing stands for the pack in the Plugins dialog. Absent means the first of
   * `nodes`. A node type rather than a drawing of its own, for the reason the wizard's `glyph` is:
   * a pack is its nodes, and one of them already says what the pack is about.
   */
  glyph?: string
  nodes: readonly NodeDefinition[]
}

const packs = new Map<string, PackDefinition>()

/** Every registered pack node's pack, by type — the only answer for a pack that keeps built-in ids. */
const packByType = new Map<string, string>()

/**
 * The pack a registered node type belongs to, or undefined for a built-in node. Asked of the
 * registry rather than read off the id (`packOf`), because a pack keeping built-in ids has none.
 */
export function packOfType(type: string): string | undefined {
  return packByType.get(type)
}

/** A registered pack by id, or undefined. */
export function getPack(id: string): PackDefinition | undefined {
  return packs.get(id)
}

/** Every registered pack, in registration order — for the surface that switches them. */
export function registeredPacks(): PackDefinition[] {
  return [...packs.values()]
}

/**
 * Every live type by its `typeKey` — the id with its punctuation folded, which is what the node
 * guide's anchors are made of. Former ids stay out, so a rename keeps its anchor.
 */
const keys = new Map<string, string>()

/**
 * A pack's node, typed exactly as `registerNode` would type it and left for `registerPack` to
 * register — so the manifest decides when, and with what checks, rather than import order.
 */
export function packNode<P extends ParamValues>(def: NodeDefinition<P>): NodeDefinition {
  return def as unknown as NodeDefinition
}

/**
 * Register a pack's nodes. Every one must belong to the pack — carry its prefix, or be declared by
 * a pack that keeps built-in ids — and a pack registers once, after the packs it requires.
 *
 * The ownership check is `register`'s own, so a pack cannot register another's type and nothing
 * outside a pack can register one of its types — the line the pack switches
 * (`ui/packSwitches.ts`) draw.
 */
export function registerPack(pack: PackDefinition): void {
  if (packs.has(pack.id)) throw new Error(`Duplicate pack "${pack.id}"`)
  // Stored in every reader's switches and named in every placeholder's message, so checked here.
  const problem = packIdProblem(pack.id)
  if (problem) throw new Error(`"${pack.id}" is not a pack id: ${problem}.`)
  for (const id of pack.requires ?? []) {
    if (!packs.has(id)) {
      throw new Error(`Pack "${pack.id}" requires "${id}", which must be registered before it.`)
    }
  }
  if (pack.parent !== undefined) {
    const parent = packs.get(pack.parent)
    if (!parent) {
      throw new Error(
        `Pack "${pack.id}" is part of "${pack.parent}", which must be registered before it.`,
      )
    }
    if (parent.parent !== undefined) {
      throw new Error(
        `Pack "${pack.id}" is part of "${pack.parent}", itself part of a pack: one level only.`,
      )
    }
  }
  packs.set(pack.id, pack)
  for (const def of pack.nodes) register(def, pack.id)
}

export function registerNode<P extends ParamValues>(def: NodeDefinition<P>): NodeDefinition<P> {
  return register(def, undefined)
}

/** The one registration, for a built-in node (`pack` undefined) or a pack's. */
function register<P extends ParamValues>(
  def: NodeDefinition<P>,
  pack: string | undefined,
): NodeDefinition<P> {
  if (definitions.has(def.type)) {
    throw new Error(`Duplicate node type "${def.type}"`)
  }
  // The id is in every saved file, so its spelling is checked where it is declared — see
  // `core/nodeType.ts` for the grammar and why a pack's types carry a prefix.
  const problem = nodeTypeProblem(def.type)
  if (problem) throw new Error(`"${def.type}" is not a node type id: ${problem}.`)
  const owner =
    packOf(def.type) ?? (pack && packs.get(pack)?.keepsBuiltInIds ? pack : undefined)
  if (owner !== pack) {
    throw new Error(
      owner
        ? `"${def.type}" belongs to the ${owner} pack, and registers through \`registerPack\` with it.`
        : `"${def.type}" is a built-in type, and the ${pack} pack cannot register it.`,
    )
  }
  /*
   * Two ids the registry tells apart can still be one key to everything that folds punctuation:
   * `neuron:findNeurons` beside `neuron.findNeurons`, or a pack `dataset-catmaid:fafb` beside
   * `dataset.catmaid.fafb`, share a node-guide anchor. The rule is on the key itself, so it holds
   * whichever side registers first and whatever a pack is called.
   */
  const key = typeKey(def.type)
  const clash = keys.get(key)
  if (clash) {
    throw new Error(
      `"${def.type}" and "${clash}" fold to the same key "${key}", and would collide.`,
    )
  }
  if (def.type === MISSING_TYPE) {
    throw new Error(
      `"${MISSING_TYPE}" is the placeholder for a node this build does not have, and is not registered.`,
    )
  }
  checkFormerTypes(def as unknown as NodeDefinition)
  /*
   * The `loop: 'begin'` / `loopPlan` pairing, enforced rather than documented.
   *
   * Without it a node declaring one half fails *silently and asymmetrically*: the scheduler
   * falls through to running it once, while `loopsIn` still derives a region for it and the
   * canvas still draws a frame captioned "for each" around nodes that will run exactly once. A
   * loop node that quietly is not one, with the canvas asserting that it is. Thrown at
   * registration for the duplicate-type reason — this is a fact about the node pack, so it
   * should fail the moment the pack is imported rather than the first time somebody runs.
   */
  if ((def.loop === 'begin') !== (def.loopPlan !== undefined)) {
    throw new Error(
      `"${def.type}" declares ${def.loop === 'begin' ? "`loop: 'begin'` without `loopPlan`" : "`loopPlan` without `loop: 'begin'`"}. ` +
        'A loop needs both: the flag is what derives its region, the plan is what says how many passes to make.',
    )
  }
  /*
   * A companion is placed under its host's *height* on add, before anything has measured the
   * host — so the host has to say how tall it expects to be. Without this it would silently fall
   * back to a guess, and the failure is the one that forced the field: a credit card drawn over
   * the card it credits. See `NodeDefinition.cardHeight`.
   */
  if (def.companion && def.cardHeight === undefined && !def.defaultSize) {
    throw new Error(
      `"${def.type}" declares a companion but no \`cardHeight\` or \`defaultSize\`: its companion ` +
        'is placed under the host before the host is drawn, so the host must say how tall it is.',
    )
  }
  checkPortGroups(def as unknown as NodeDefinition)
  checkFormerParamIds(def as unknown as NodeDefinition)
  checkPortKinds(def as unknown as NodeDefinition)
  checkStringDrawing(def as unknown as NodeDefinition)
  freezeDeep(def)
  definitions.set(def.type, def as unknown as NodeDefinition)
  keys.set(key, def.type)
  if (pack) packByType.set(def.type, pack)
  for (const former of def.formerTypes ?? []) formerTypes.set(former, def.type)
  referenceTypes = undefined
  loopTypes = undefined
  return def
}

/**
 * A rename is one-to-one or it is ambiguous, so the ambiguous cases are refused here: a former id
 * that is some type's live id (a stored node would then mean whichever registered first), one
 * already claimed by another type, and a live id that some earlier type claimed as its former
 * one. Former ids are *not* held to the grammar — they are what files already say.
 */
function checkFormerTypes(def: NodeDefinition): void {
  const claimed = formerTypes.get(def.type)
  if (claimed) {
    throw new Error(
      `"${def.type}" is a former id of "${claimed}", and cannot be registered again.`,
    )
  }
  for (const former of def.formerTypes ?? []) {
    const other = formerTypes.get(former)
    if (other) {
      throw new Error(
        `"${def.type}" cannot claim the former id "${former}": "${other}" already does.`,
      )
    }
    if (!former || former === def.type || former === MISSING_TYPE || definitions.has(former)) {
      throw new Error(`"${def.type}" cannot claim the former id "${former}": it is not free.`)
    }
  }
}

/**
 * Freeze a definition and everything plain inside it — ports, params, options, types.
 *
 * A definition is read by identity everywhere after this: `ports.ts` memoises on it,
 * `typesWithReferenceInputs` and `typesWithLoops` derive from it once, and every check above ran
 * against it exactly as it stood. A definition changed afterwards would keep all of those
 * answers while no longer meaning them, so a change is refused outright — loudly, at the line
 * that tried, rather than as a stale memo somewhere else. With node packs it is also the line
 * between *adding* to Coda and quietly changing what a built-in node computes.
 *
 * Only arrays and plain objects are walked. Functions are left alone, as is anything with a
 * prototype of its own (a `Map`, a class instance), since freezing those
 * would not stop them changing and would say it had.
 */
function freezeDeep(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  const proto = Object.getPrototypeOf(value) as unknown
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return
  Object.freeze(value)
  for (const child of Object.values(value)) freezeDeep(child)
}

freezeDeep(missingNodeDef)

/**
 * Structural checks on a definition's port groups, thrown at registration.
 *
 * For the reason the `loop`/`loopPlan` pairing above is checked here: every one of these fails
 * *silently* at runtime and produces a node that looks wired. A `repeat` naming a param that
 * does not exist resolves to the group's `min` forever, so the count field the author added is
 * simply inert. A default outside `[min, max]` means a fresh node opens at a different arity
 * than the number shown in its own param field. And two ports that collide at some arity give
 * one card two sockets with one id, where `inbound` keeps whichever edge it saw first and the
 * other silently carries nothing.
 *
 * Expanded at `max` rather than at the default, because a collision that only appears at arity
 * five is still a collision, and it would otherwise ship and be found by a user.
 */
function checkPortGroups(def: NodeDefinition): void {
  for (const side of ['inputs', 'outputs'] as const) {
    const slots = def[side]
    if (!slots) continue
    for (const slot of slots) {
      if (!isPortGroup(slot)) continue
      const where = `"${def.type}" port group "${slot.repeat}" (${side})`
      if (slot.ports.length === 0) throw new Error(`${where} repeats no ports.`)
      const param = findParam(def, slot.repeat)
      if (!param) {
        throw new Error(
          `${where} names no param. The repeat count must be a real \`int\` param, or it is not saved, not undoable and not in the provenance key.`,
        )
      }
      if (param.kind !== 'int') {
        throw new Error(
          `${where} names a "${param.kind}" param; the repeat count must be \`int\`.`,
        )
      }
      /*
       * Both of these silently break invariant 4. `normalizeParams` drops presentational params
       * and params hidden by `visibleIf` from the provenance key — correctly, for colour scales
       * and switched-off branches. A *repeat* count excluded from that key means changing a
       * node's arity does not re-key it: the scheduler finds the cached entry fresh and serves a
       * result that is missing the outputs the new ports were added for, with nothing stale on
       * the canvas to say so. The port set is the one thing a param can change that the cache
       * cannot see any other way.
       */
      if (param.presentational) {
        throw new Error(
          `${where} names a presentational param. A repeat count changes what \`evaluate\` returns — it is excluded from the provenance key, so a changed arity would serve a stale result (invariant 4).`,
        )
      }
      if (param.visibleIf) {
        throw new Error(
          `${where} names a param with \`visibleIf\`. A hidden param is excluded from the provenance key, so hiding the count would freeze the arity a cached result was computed at (invariant 4).`,
        )
      }
      /*
       * The range lives on the param and nowhere else, so the inspector's spinner and the
       * expansion in `core/ports.ts` cannot disagree about how far a group goes. Undeclared, the
       * spinner would run to infinity while `allInputPorts` expanded to one.
       */
      if (typeof param.min !== 'number' || typeof param.max !== 'number') {
        throw new Error(
          `${where} names a param with no \`min\`/\`max\`; that pair is the group's arity.`,
        )
      }
      if (param.min < 1) {
        throw new Error(`${where} has min ${param.min}; a group repeats at least once.`)
      }
      if (param.max < param.min) {
        throw new Error(`${where} has max ${param.max} below min ${param.min}.`)
      }
      if (param.default < param.min || param.default > param.max) {
        throw new Error(
          `${where} has default ${param.default} outside [${param.min}, ${param.max}], so a fresh node would not open at the arity its own field reports.`,
        )
      }
      /*
       * `formerIds` is positional, so on a group repeating a *tuple* "the id at index 2" names
       * two ports and the array cannot say which — a silent half-migration where one socket of
       * the pair keeps its stored edges and the other drops them. And an entry past `max` names
       * an index that never expands, so the edge it was written for is dropped anyway while the
       * declaration reads as if it were covered.
       */
      if (slot.formerIds) {
        if (slot.ports.length > 1) {
          throw new Error(
            `${where} declares \`formerIds\` on a group repeating ${slot.ports.length} ports. A former id is positional, so it cannot say which port of a tuple it renames.`,
          )
        }
        if (slot.formerIds.length > param.max) {
          throw new Error(
            `${where} declares ${slot.formerIds.length} \`formerIds\` for a group whose max is ${param.max}; the surplus name indices that never expand.`,
          )
        }
      }
    }
    const seen = new Set<string>()
    for (const port of side === 'inputs' ? allInputPorts(def) : allOutputPorts(def)) {
      if (seen.has(port.id)) {
        throw new Error(
          `"${def.type}" has two ${side} called "${port.id}" at some arity. Port ids must be unique when every group is expanded at its max.`,
        )
      }
      seen.add(port.id)
    }
  }
}

/**
 * `ParamBase.formerId` checked at registration, for `checkPortGroups`' reason: both ways of
 * getting it wrong fail silently *on somebody else's saved file*, which is the one place nobody
 * is looking.
 *
 * A `formerId` that is also a live param id would have `storedParams` move a value out from under
 * the param that legitimately owns it — and the loser depends on declaration order, so the same
 * document loads differently after an unrelated reshuffle. Two params claiming one `formerId` is
 * the same failure with the winner picked the same arbitrary way.
 */
function checkFormerParamIds(def: NodeDefinition): void {
  const params = def.params ?? []
  if (!params.some((param) => param.formerId !== undefined)) return
  const live = new Set(params.map((param) => param.id))
  const claimed = new Set<string>()
  for (const param of params) {
    const former = param.formerId
    if (former === undefined) continue
    if (live.has(former)) {
      throw new Error(
        `"${def.type}" param "${param.id}" claims \`formerId\` "${former}", which is a param it still declares. A rename moves a stored value, so this would take it from the param that owns it.`,
      )
    }
    if (claimed.has(former)) {
      throw new Error(
        `"${def.type}" has two params claiming \`formerId\` "${former}"; only one can inherit the stored value, and which one would depend on declaration order.`,
      )
    }
    claimed.add(former)
  }
}

/**
 * A text param's drawing flags that the widget cannot honour together, thrown at registration.
 *
 * `ParamField` picks one widget per string param, and a textarea takes neither a list nor chips.
 * So `multiline` beside `suggestions` or `chips` used to lose the other flag in silence: the list
 * never appeared, or the chips drew as one text box, and nothing said why. (`supplied` is not in
 * this: it is a *state*, not a drawing, and wins over every flag while a wire answers.)
 */
function checkStringDrawing(def: NodeDefinition): void {
  for (const param of def.params ?? []) {
    if (param.kind !== 'string' || !param.multiline) continue
    const clash = param.chips ? 'chips' : param.suggestions ? 'suggestions' : undefined
    if (clash) {
      throw new Error(
        `"${def.type}" param "${param.id}" declares \`multiline\` with \`${clash}\`. A textarea draws neither, so the second would be ignored.`,
      )
    }
  }
}

/**
 * `PortDef.kinds` is only a statement about an `any`, thrown at registration.
 *
 * Three of the four failures are silent, and two of those are silent in the *passing* direction.
 * A set beside a concrete type is a second statement that can disagree with the first — and it is
 * the set the palette and the socket dimming would read, so `type: T.skeletons(), kinds:
 * ['meshes']` would draw and filter as meshes while `isAssignable` went on answering for
 * skeletons. An empty set reads as "holds nothing" to `socketKinds` and as "not declared" to
 * every `?.length` guard beside it, which is two answers to the one question the field exists to
 * settle. And `any` inside the set is the field cancelling itself: `socketAccepts` would then
 * admit every kind again, so the port would filter exactly as it did before anybody declared
 * anything. The fourth — a repeated kind — diverges from nothing, every reader being an
 * `includes`; it is here because a set is always a shared `as const`, so a repeat in one is a
 * copy-paste slip rather than a preference, and this is the cheapest place to say so.
 *
 * Over `allInputPorts`/`allOutputPorts` rather than a hand-rolled walk of the slots, which is
 * what `checkPortGroups` above already does with the same imports: expanding at `max` is the
 * "every port this node could ever have" reading, and a second slot-flattening idiom is a second
 * place a future `PortSlot` shape has to be taught about.
 */
function checkPortKinds(def: NodeDefinition): void {
  for (const side of ['inputs', 'outputs'] as const) {
    for (const port of side === 'inputs' ? allInputPorts(def) : allOutputPorts(def)) {
      const where = `"${def.type}" port "${port.id}" (${side})`
      // One rule, so one throw: both fields say something about an `any` and neither has anything
      // to add to a concrete type, which already says what the port holds.
      if ((port.kinds || port.anyKind) && port.type.kind !== 'any') {
        throw new Error(
          `${where} declares \`${port.kinds ? 'kinds' : 'anyKind'}\` beside type "${port.type.kind}". Both spell something about a union \`CodaType\` cannot, so they belong only on \`T.any()\`; a concrete type already says what the port holds.`,
        )
      }
      if (port.anyKind && port.kinds) {
        throw new Error(
          `${where} declares both \`anyKind\` and \`kinds\`, which is the port saying it takes everything and that it takes four things.`,
        )
      }
      if (!port.kinds) continue
      if (port.kinds.length === 0) {
        throw new Error(
          `${where} declares an empty \`kinds\`. Omit the field instead: absent means "not known", which is what an undeclared \`any\` is.`,
        )
      }
      if (port.kinds.includes('any')) {
        throw new Error(
          `${where} lists "any" in \`kinds\`, which cancels the declaration — every kind is admitted again. Omit the field instead.`,
        )
      }
      if (new Set(port.kinds).size !== port.kinds.length) {
        throw new Error(`${where} repeats a kind in \`kinds\`.`)
      }
    }
  }
}

/** Memo for `typesWithReferenceInputs`, dropped whenever the registry gains a type. */
let referenceTypes: Set<string> | undefined

/**
 * The node types that declare a `reference` input.
 *
 * So the graph walks can answer "could this graph contain a reference edge at all?" without
 * touching a single edge. Exactly one type does today, so on every other graph the reference
 * machinery in `topoSort` and `wouldCreateCycle` short-circuits to nothing — and those run twice
 * per keystroke and once per pointer move of a link drag respectively.
 *
 * Memoised because the registry is fixed after module load, and **cleared by `registerNode`**
 * rather than assumed fixed: a test registers types long after this file is imported, and a memo
 * that outlived one of those would answer about a registry that no longer exists.
 */
export function typesWithReferenceInputs(): Set<string> {
  referenceTypes ??= new Set(
    [...definitions.values()]
      .filter((def) => allInputPorts(def).some((port) => port.reference === true))
      .map((def) => def.type),
  )
  return referenceTypes
}

/** Memo for `typesWithLoops`, dropped whenever the registry gains a type. */
let loopTypes: Set<string> | undefined

/**
 * The node types that begin or end a loop — see `NodeDefinition.loop`.
 *
 * `typesWithReferenceInputs`' twin, and for the same measured reason: the scheduler asks "could
 * this graph contain a loop at all?" once per run and the canvas asks it once per edge memo, and
 * on the overwhelming majority of graphs the answer is no. A `Set` lookup per node beats deriving
 * a region, and the loop machinery below it then allocates nothing.
 *
 * Cleared by `registerNode` rather than assumed fixed, because tests register types long after
 * this module is imported — the bug `typesWithReferenceInputs` already had to be pinned against.
 */
export function typesWithLoops(): Set<string> {
  loopTypes ??= new Set(
    [...definitions.values()].filter((def) => def.loop !== undefined).map((def) => def.type),
  )
  return loopTypes
}

/**
 * A type's definition, or undefined when this build has no such type.
 *
 * Answers for the placeholder too (`core/missing.ts`), which is deliberately **not** in
 * `definitions`: every lookup finds it, and nothing that lists the registry ever meets it.
 */
export function getNodeDef(type: string): NodeDefinition | undefined {
  return definitions.get(type) ?? (type === MISSING_TYPE ? missingNodeDef : undefined)
}

/**
 * The live type a stored type id answers to: itself if registered, else the type that claims it
 * as a former id (`NodeDefinition.formerTypes`), else undefined. For the readers of *stored* ids —
 * the loader, a `demo://` link, a Zoo digest — and nothing else; every lookup after load uses the
 * live id.
 */
export function currentType(type: string): string | undefined {
  return definitions.has(type) ? type : formerTypes.get(type)
}

/** `currentType`, keeping the stored id where nothing answers — for a reader that shows it anyway. */
export function liveType(stored: string): string {
  return currentType(stored) ?? stored
}

/**
 * The definition for a type id somebody *wrote* — a plan's `add`, an MCP lookup — rather than one a
 * file stored: a former id answers as its successor (`liveType`), and the placeholder answers
 * nothing, not being a node anybody can name.
 */
export function authoredNodeDef(type: string): NodeDefinition | undefined {
  const def = getNodeDef(liveType(type))
  return def?.type === MISSING_TYPE ? undefined : def
}

/** Throwing variant for code paths where a missing type is a bug, not user input. */
export function requireNodeDef(type: string): NodeDefinition {
  const def = getNodeDef(type)
  if (!def) throw new Error(`Unknown node type "${type}"`)
  return def
}

/**
 * Does this type annotate the canvas rather than compute on it? See `NodeDefinition.annotation`.
 *
 * A helper rather than `getNodeDef(t)?.annotation === true` spelled out at each call site,
 * because the answer decides whether a node is evaluated at all — the scheduler, the store's
 * "needs run" and the canvas all have to agree on it, and three copies of an optional-chained
 * comparison is how they stop agreeing. An unregistered type is not an annotation: it is an
 * error the caller already handles.
 */
export function isAnnotation(type: string): boolean {
  return definitions.get(type)?.annotation === true
}

export function allNodeDefs(): NodeDefinition[] {
  return [...definitions.values()]
}

/**
 * Everything a user may add, i.e. minus superseded types.
 *
 * `allNodeDefs` stays complete because lookups and deserialisation need it; this is the list the
 * add-node surfaces show. Separating the two is what lets a retired node keep loading old files
 * without also being offered for new work.
 *
 * `offered` narrows it further for a surface that honours switched-off packs (`core/packs.ts`'
 * `offeredType`). A predicate on the *type* rather than a list of packs, so the registry need not
 * know where the switches are kept.
 */
export function listableNodeDefs(offered?: (type: string) => boolean): NodeDefinition[] {
  return allNodeDefs().filter((d) => !d.hidden && (!offered || offered(d.type)))
}

export function nodeDefsByCategory(offered?: (type: string) => boolean): Array<{
  category: NodeCategory
  defs: NodeDefinition[]
}> {
  const order: NodeCategory[] = [
    'dataset',
    'query',
    'transform',
    'analysis',
    'visualisation',
    'utility',
  ]
  const listable = listableNodeDefs(offered)
  return order
    .map((category) => ({
      category,
      defs: listable
        .filter((d) => d.category === category)
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .filter((group) => group.defs.length > 0)
}

/**
 * A node's params as its code reads them (`withDefaults`), for a surface holding the node rather
 * than a context. One spelling, because the UI kept writing `def ? withDefaults(def, node.params)
 * : node.params` — and a caller that did not is how the loop card read `NaN` for a batch size.
 */
export function filledParams(node: { type: string; params: ParamValues }): ParamValues {
  const def = getNodeDef(node.type)
  return def ? withDefaults(def, node.params) : node.params
}
