/**
 * Socket appearance: which colour family and which shape a type gets.
 *
 * Six chromatic families and one achromatic. `theme.css` carries the measurement and the
 * argument for why six is past the validated all-pairs gate and shipped anyway; read it before
 * adding a seventh. The short version: the floor is met on every pair that can share a card,
 * and colour is never the only channel — shape and an always-visible label are the other two.
 *
 * Colour names the **material**; shape separates the members within one material.
 *
 *   filled circle  Neurons  (a table guaranteed to have neuronId)   table   blue
 *   hollow ring    Table    (same material, different shape)         table   blue
 *   diamond        Matrix                                            matrix  orange
 *   hex            Network                                           matrix  orange
 *   square         Layout                                            matrix  orange
 *   ring           Linkage  (a clustering *of* a matrix)             matrix  orange
 *   square         Dataset                                           dataset green
 *   filled circle  Skeletons                                         geometry violet
 *   hex            Meshes                                            geometry violet
 *   small dot      Points                                            geometry violet
 *   hollow ring    Geometries (a port taking any of the three)       geometry violet
 *   diamond        Transform (a mapping applied to geometry)         transform teal
 *   hollow ring    Layers   (neuroglancer's own layer stack)         layers  magenta
 *   small dot      Number / String / Boolean                         scalar  gray
 *
 * A shape repeats **across** materials and never within one, which is the rule that keeps the
 * two channels independent: a diamond means Matrix or Transform and the hue says which, where
 * two orange diamonds would mean nothing at all.
 *
 * ## Geometries, and why it cost no colour
 *
 * The last row is not a `CodaType`. It is what `portStyle` draws for a socket declared
 * `T.any()` with a `PortDef.kinds` that names only geometry — `Mirror Neurons`, `Transform
 * Neurons`, `Stack Neurons`, `Split Neurons` — which before it were four violet-in-spirit ports
 * drawn in the grey that means *anything at all*, beside a Warp in teal and a Skeletons in
 * violet on the same card.
 *
 * It needed **no new hue and no new CSS**, which is the whole reason it was affordable: the
 * `theme.css` note records that six chromatic families are already past the validated all-pairs
 * gate and that nothing here may spend a seventh, and `ring` was the one shape the geometry
 * family had not used. So this is the shape channel doing exactly what the rule above says —
 * `ring` already means Table, Linkage and Layers, and the hue says which.
 *
 * A **subset** draws as the whole: `Split Neurons` declines points and still draws Geometries,
 * because the alternative is a fifth silhouette for a set that differs by one member. What the
 * socket declines it still declines — `socketAccepts` reads the declared list, not this label.
 */

import { getNodeDef } from '../core/registry'
import type { Socket } from '../core/sockets'
import { resolvedSocket } from '../core/sockets'
import type { CodaType, Kind } from '../core/types'
import { backendForNodeType } from '../nodes/lib/datasetFamilies'

export type SocketFamily =
  'table' | 'matrix' | 'dataset' | 'geometry' | 'transform' | 'layers' | 'scalar' | 'any'
export type SocketShape = 'circle' | 'ring' | 'diamond' | 'square' | 'dot' | 'hex'

export interface SocketStyle {
  family: SocketFamily
  shape: SocketShape
}

/**
 * The table itself, keyed on the tag alone.
 *
 * **There is deliberately no `socketStyle(type)` beside it any more.** Migrating six surfaces
 * off the function that ignores `PortDef.kinds` — and finding two of them a round later, drawing
 * grey where the card next to them drew violet — was the whole cost of this feature; leaving the
 * old spelling exported keeps that footgun loaded for the seventh, and picking it compiles and
 * paints a plausible ring. `portStyle` is the entry point, and it is the only one.
 *
 * Keyed on the tag rather than the type because `sharedFamily` asks it of a bare `Kind` — a
 * member of a declared set has no `CodaType` around it, and synthesising `{ kind } as CodaType`
 * would be a cast repeated for every kind in every set.
 */
function styleForKind(kind: Kind | undefined): SocketStyle {
  switch (kind) {
    case 'neurons':
      return { family: 'table', shape: 'circle' }
    case 'table':
      return { family: 'table', shape: 'ring' }
    case 'matrix':
      return { family: 'matrix', shape: 'diamond' }
    // Network, Layout and Linkage share the matrix hue: all three are *about* a matrix, and
    // shape separates them. That is the one place the many-to-one mapping is still load-bearing
    // — every other family is now one material with one colour.
    case 'network':
      return { family: 'matrix', shape: 'hex' }
    case 'dataset':
      return { family: 'dataset', shape: 'square' }
    /*
     * Geometry is its own hue, and used not to be — it shared the dataset green, which meant a
     * Skeletons output, a Dataset input, a Warp and an Extra-layers port were four different
     * kinds of thing wearing one colour. It reads as a chain that keeps changing its mind. The
     * split cost the all-pairs gate; `theme.css` carries what was measured and why it was still
     * the right trade.
     */
    case 'skeletons':
      return { family: 'geometry', shape: 'circle' }
    case 'meshes':
      return { family: 'geometry', shape: 'hex' }
    case 'points':
      return { family: 'geometry', shape: 'dot' }
    // A layout is about a network, so it takes the network's hue; square separates it from the
    // diamond and hex already spoken for.
    case 'layout':
      return { family: 'matrix', shape: 'square' }
    // A linkage is a clustering *of* a matrix, so it takes the matrix hue and the one shape that
    // family has left. `ring` is also the table family's, which is the shape channel repeating
    // across materials as it is meant to.
    case 'linkage':
      return { family: 'matrix', shape: 'ring' }
    /*
     * A Warp is applied *to* geometry and is not geometry, which is exactly why it stopped
     * wearing geometry's colour: on a Mirror card the two sockets are the thing and the
     * operation, and they were the same green. Teal, and the diamond it already had — a shape
     * the matrix family also uses, which is the channel working as intended.
     */
    case 'transform':
      return { family: 'transform', shape: 'diamond' }
    /*
     * Layers used to take the dataset hue on the argument that both carry *a place to read from*
     * rather than data. True, and it made `out.neuroglancer` — Dataset, Neurons, Extra layers —
     * a card with two identical green sockets meaning different things. Its own hue now; the
     * ring is unchanged.
     */
    case 'layers':
      return { family: 'layers', shape: 'ring' }
    case 'number':
    case 'string':
    case 'boolean':
      return { family: 'scalar', shape: 'dot' }
    default:
      return { family: 'any', shape: 'ring' }
  }
}

/**
 * The card's standing rule — *what it carries, falling back to what it accepts* — with the
 * declared kind set as the fallback.
 *
 * `resolved` is what inference says is on the port; the declaration answers when it says
 * nothing, and **`any` counts as nothing**. That three-way decision is `resolvedSocket`'s,
 * shared with `socketLabel`, because it is one rule and the core/UI boundary is the only reason
 * this is two functions. Every surface that draws a port goes through this one: the socket, the
 * inspector chip, the browser thumbnail, the node guide's pips, the help figures.
 *
 * **The family is derived from the set rather than named**, and that is the half worth keeping.
 * Written as `if the set has a name, draw geometry/ring` it was right for the only named set
 * there is and silently wrong for the next one — `kindSetLabel` gaining a "Collections" entry
 * would have drawn `For Each`'s table ports as violet geometry rings, which is a failure in the
 * passing direction. Asking each member kind for its own family and taking it only when they
 * agree answers `GEOMETRY_KINDS` violet, answers `ITERABLE_KINDS` with the honest grey, and
 * needs no second table to be kept in step with the first.
 *
 * `ring` is the shape because it is the one the geometry family had not spent — see the header.
 * A set whose members disagree never reaches it.
 */
export function portStyle(socket: Socket | undefined, resolved?: CodaType): SocketStyle {
  const held = resolvedSocket(socket, resolved)
  const family = sharedFamily(held.kinds)
  return family ? { family, shape: 'ring' } : styleForKind(held.type.kind)
}

/**
 * The one family every kind in a set belongs to, or undefined where they disagree.
 *
 * The whole of `portStyle`'s decision about a declared set, and asked *first* rather than behind
 * a check that the set has a name. That order is the difference between the members-agree rule
 * being the rule and being a formality: gated on the name, it only ever ran on sets
 * `kindSetLabel` had already admitted — every one of them geometry — so the disagreeing branch
 * was unreachable through the public function and had to be exported to be tested at all.
 */
function sharedFamily(kinds: readonly Kind[] | undefined): SocketFamily | undefined {
  if (!kinds?.length) return undefined
  const first = styleForKind(kinds[0]).family
  return kinds.every((kind) => styleForKind(kind).family === first) ? first : undefined
}

/** CSS custom property for a family, for inline swatches outside the socket itself. */
export function familyColorVar(family: SocketFamily): string {
  switch (family) {
    case 'table':
      return 'var(--socket-table)'
    case 'matrix':
      return 'var(--socket-matrix)'
    case 'dataset':
      return 'var(--socket-dataset)'
    case 'geometry':
      return 'var(--socket-geometry)'
    case 'transform':
      return 'var(--socket-transform)'
    case 'layers':
      return 'var(--socket-layers)'
    default:
      return 'var(--socket-scalar)'
  }
}

export function typeColorVar(type: CodaType | undefined): string {
  return familyColorVar(styleForKind(type?.kind).family)
}

/** How thick a wire is drawn. One number: three surfaces had a copy of it. */
export const WIRE_WIDTH = 1.8

/**
 * The stroke a wire wears: the colour of the data flowing through it, as in Blender.
 *
 * `muted` is a node producing nothing — dashed and dimmed, so a chain that has been switched off
 * reads as switched off rather than as ordinary. Shared by the canvas, the merged wires a folded
 * group draws and the panel it opens, which each had the pair written out and only two of which
 * remembered the muting.
 *
 * A `Socket` rather than a `CodaType`, matching `draggedWireStyle`, and for the half of the same
 * report that the drag fix did not reach: the wire *in flight* off an unwired `Mirror Neurons`
 * drew violet and turned **grey the instant it landed**, because a landed wire was coloured from
 * `inference.nodes[x].outputs[handle]` alone and a passthrough's is a truthy `T.any()`. Its three
 * callers now go through `outputSocket`.
 */
export function wireStyle(
  socket: Socket | undefined,
  muted = false,
): { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity?: number } {
  return {
    stroke: familyColorVar(portStyle(socket).family).valueOf(),
    strokeWidth: WIRE_WIDTH,
    ...(muted ? { strokeDasharray: '4 3', opacity: 0.5 } : {}),
  }
}

/**
 * The tint a node wears: its backend's, or its category's, or nothing.
 *
 * Three surfaces draw a node as a coloured box — the add-node thumbnail, the Zoo card's minimap,
 * and the node header itself (in CSS, via `[data-category]`). The first two resolved the ladder
 * by hand, character for character, including the fallback-inside-`var()` trick that lets a
 * backend nobody has styled yet fall through to the generic dataset token. A fourth backend
 * arriving and reaching one of them but not the other is a wrong signal rather than a missing
 * one, which is the failure `datasetFamilies.ts` already documents for the card tint.
 *
 * `fallback` is what an **unregistered** type gets, and it is a parameter because the honest
 * answer differs by surface: a thumbnail is only ever built from a real definition, while a Zoo
 * card is drawn from a layout digest that may name a node this build no longer has — and there,
 * drawing it as visibly unknown is the point.
 *
 * Not in `colors.ts`, which has no imports at all and is the palette itself. This file already
 * owns "which token does this thing wear" and already resolves two other ladders.
 */
export function nodeTintVar(type: string, fallback = 'var(--border)'): string {
  const backend = backendForNodeType(type)
  if (backend) return `var(--cat-dataset-${backend.id}, var(--cat-dataset))`
  const def = getNodeDef(type)
  return def ? `var(--cat-${def.category})` : fallback
}

/**
 * The stroke an in-flight wire wears while it is being dragged.
 *
 * It used to be `--accent` in CSS, so every new wire was blue until the moment it landed and
 * then became its type's colour — the one gesture where knowing the type early is worth most,
 * since what you are looking for is the socket that will take it. The colour is the *origin*
 * port's, both directions: dragged from an output that is the wire's final colour exactly, and
 * dragged backwards from an input it is the colour of what that port accepts, the final wire
 * being its source's and unknowable until the drop.
 *
 * A `Socket` rather than a type, which is what makes the second half of that sentence true on
 * the ports it was least true on: dragged backwards out of `Mirror Neurons` the wire was grey,
 * because the port it left declares `any` — now it leaves violet, and the sockets it is hunting
 * for are the violet ones.
 *
 * Stroke only. The width and the dashes stay in `editor.css`, because they say *in flight*
 * rather than what is flowing, and a dropped wire must not inherit them.
 */
export function draggedWireStyle(socket: Socket | undefined): { stroke: string } {
  return { stroke: familyColorVar(portStyle(socket).family) }
}
