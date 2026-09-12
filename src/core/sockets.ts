/**
 * What a socket can hold, and which of two sockets answers a wire better.
 *
 * `isAssignable` is the kind relation and stays the floor — nothing here ever admits a pair it
 * refuses. What this module adds is the half `CodaType` cannot say: a port declared `T.any()`
 * because its real answer is *skeletons, meshes or points* is not a port that takes anything,
 * and until `PortDef.kinds` existed every surface that asked "what could this feed?" treated it
 * as one. Dropping a `Linkage` wire on empty canvas offered `Mirror Neurons` first, then three
 * more `… Neurons` nodes, with `Cut Tree` and `Dendrogram` — the only two nodes in the registry
 * that take a linkage — sixth and seventh.
 *
 * Its own module rather than a pair of functions in `ports.ts` (which is about *expanding* port
 * groups) or in `node.ts` (which is already the definitions file) because the readers are the
 * argument: the card's socket dimming, the palette's filter, the palette's *order*, the socket
 * fill, the inspector chip, the node browser signature and the node guide all ask one of these
 * two questions, and `theme.css` already records what six independent spellings of one socket
 * table cost.
 *
 * **`socketAccepts` refuses, and that was a second decision.** `PortDef.kinds` shipped as a
 * declaration and not a constraint on `producedBy`'s precedent — narrow what is *offered*, and
 * let a wire somebody draws anyway be reported by the node's own `validate`. It came back within
 * the round as a bug, and rightly: once a socket **draws** as Geometries, a violet ring you can
 * drop on a `Dataset` port is a promise the picture makes and the behaviour breaks. The
 * precedent does not stretch this far either — `producedBy` and `exclusiveGroup` are not *kind*
 * facts, where refusing a kind mismatch with a reason is `checkConnection`'s whole job. Before
 * `kinds` existed the socket drew grey `Any` and taking anything was honest.
 *
 * An unresolved socket is still never a refusal: a bare `any` on either end passes, so a
 * half-built graph wires up exactly as it did.
 */

import type { CodaType, Kind } from './types'
import { T, isAssignable, kindSetLabel, typeLabel } from './types'

/**
 * Anything with a socket's two declarations. `PortDef` satisfies it structurally, and so does
 * the descriptor a link drag carries — which is why this takes a shape rather than a `PortDef`:
 * the palette compares a candidate port against *the end of a wire in flight*, which is not a
 * port of any node yet.
 */
export interface Socket {
  type: CodaType
  kinds?: readonly Kind[]
}

/**
 * The kinds this socket can hold, or **undefined for "not known"** — which is a bare `any`, and
 * is never a refusal.
 *
 * The distinction is the same one `isGeometryKind` and every predicate like it draws between an
 * unresolved upstream socket and a wrong one, and it has to survive here: a wire dragged out of
 * a `Download` passes through undeclared, and the palette must go on offering everything for it.
 */
function socketKinds(socket: Socket): readonly Kind[] | undefined {
  if (socket.kinds?.length) return socket.kinds
  return socket.type.kind === 'any' ? undefined : [socket.type.kind]
}

/**
 * Whether a wire leaving `from` may land on `to`.
 *
 * `isAssignable` first, so every widening it allows — `neurons` into a `table`, `number` into a
 * `string` — is allowed here too. A declared set then refines the one case assignability had to
 * wave through, which is `any` on either end; that is why a set has to list its kinds **as they
 * arrive** rather than as the node consumes them, and why `ITERABLE_KINDS` names `neurons`
 * beside `table` instead of relying on the subtype relation to cover it.
 *
 * The guard is the load-bearing half and the intersection is symmetric, which is worth saying
 * because the first version asked it twice, once per side, as though the two directions
 * differed. They do not: with neither side declaring, `isAssignable` is the whole answer, and
 * with either side declaring, the question is whether the two sets meet.
 */
export function socketAccepts(from: Socket, to: Socket): boolean {
  if (!isAssignable(from.type, to.type)) return false
  if (!from.kinds?.length && !to.kinds?.length) return true
  const ours = socketKinds(from)
  const theirs = socketKinds(to)
  return (
    ours === undefined || theirs === undefined || ours.some((kind) => theirs.includes(kind))
  )
}

/**
 * How well `socket` answers a wire from `other`; **lower is better**, and only meaningful once
 * `socketAccepts` has said yes.
 *
 * The mirror image of `wizard/demo.ts`' `tierOf`, which ranks the *source* end of the same
 * question and was put there by two wrong demos. The tiers:
 *
 *   0  the kind itself — `Cut Tree` for a Linkage
 *   1  a widening `isAssignable` allows — a `table` port taking a `neurons` wire
 *   2  a named union — a geometry port taking a Skeletons wire
 *   3  a bare `any` — `Download`, `Collect`: real answers, and the last ones to reach for
 *
 * A named union sits *below* a widening rather than beside it because the two say different
 * things: a `table` port asked to take neurons is a node built for that wire, where an `any`
 * port is a node built for a family the wire happens to belong to. Both are correct; the first
 * is what somebody dropping a wire meant.
 */
export function socketTier(socket: Socket, other: Socket): number {
  if (socket.type.kind !== 'any') {
    const theirs = socketKinds(other)
    return theirs?.includes(socket.type.kind) ? 0 : 1
  }
  return socket.kinds?.length ? 2 : 3
}

/**
 * What a socket is called when nothing is wired to it: the type's own name, unless a declared
 * set has a name of its own.
 *
 * The card's standing rule — *what it carries, falling back to what it accepts* — for the name,
 * where `ui/socketStyle.ts`' `portStyle` is the same rule for the drawing; both go through
 * `resolvedSocket`. A wired socket reads as the concrete kind flowing through it and only an
 * empty one names the family.
 *
 * `resolvedSocket` below carries the three-way decision, `any`-counts-as-unresolved included.
 *
 * Every surface that prints an unwired port goes through this — `CodaNodeView`'s tooltip, the
 * inspector chip, the node browser signature, the node guide, the assistant catalogue — because
 * the alternative is the six-spellings failure `theme.css` describes: five of them saying
 * "Geometries" and one still saying "Any" looks like nothing at all.
 */
export function socketLabel(socket: Socket | undefined, resolved?: CodaType): string {
  const held = resolvedSocket(socket, resolved)
  return kindSetLabel(held.kinds) ?? typeLabel(held.type)
}

/**
 * What a socket holds, before anything decides whether to draw it or name it: the concrete type
 * flowing through it, or else the declaration — its kind set and the type it is written as.
 *
 * **The one place "an inferred `any` is not an answer" lives.** `inferOutputs` on a passthrough
 * hands back the input type, and `outputTypesFor` seeds the map with the declared `port.type`
 * before asking it — so an unwired passthrough publishes a perfectly *truthy* `T.any()`, and any
 * reader that took the inferred type and stopped there threw away the only declaration that knew
 * anything. Four did, and two of them were reported together as one bug: `Mirror Neurons`'
 * output drew as a violet **Geometries** ring, the wire leaving it drew grey and dimmed nothing,
 * and it could be dropped straight onto a `Dataset` socket.
 *
 * It briefly existed twice — as this, and as a `socketFace` returning the same three-way answer
 * with an optional `type` — which is the drift it was extracted to prevent, so the two are one
 * function. `type` is total because the only way to reach an absent one is to pass nothing at
 * all, and `Any` is the honest answer to that.
 *
 * The name and the drawing are then each one question asked of the result: `socketLabel` here,
 * `portStyle` in `ui/socketStyle.ts`, where the boundary rule keeps it. **It hands back the
 * kinds, not the set's name** — a name is what one of them wants, the other wants the *family*,
 * and handing over a name made the second reach past this to `socket.kinds` and gate on the
 * first's answer.
 */
export function resolvedSocket(socket: Socket | undefined, resolved?: CodaType): Socket {
  if (resolved && resolved.kind !== 'any') return { type: resolved }
  return {
    type: socket?.type ?? T.any(),
    ...(socket?.kinds?.length ? { kinds: socket.kinds } : {}),
  }
}

/**
 * Whether this socket can *originate* a kind, rather than pass one on.
 *
 * A passthrough declares `T.any()` on its output and `PortDef.kinds` beside it says what it will
 * hand on — not that it can make one from nothing. So a backwards drag from a `Skeletons` socket
 * must not offer `Mirror Neurons`: it would answer the question with a node that needs the same
 * question asked again behind it.
 *
 * Here rather than as a `port.type.kind !== 'any'` at each site because it was three of those in
 * two files — the palette's backwards filter and both of `wizard/demo.ts`' producer searches —
 * each with its own paragraph making the identical argument, and it is the rule most likely to
 * want refining later (a Mirror *can* originate geometry, given geometry).
 */
export function socketOriginates(socket: Socket): boolean {
  return socket.type.kind !== 'any'
}
