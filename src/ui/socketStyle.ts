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
 *   diamond        Transform (a mapping applied to geometry)         transform teal
 *   hollow ring    Layers   (neuroglancer's own layer stack)         layers  magenta
 *   small dot      Number / String / Boolean                         scalar  gray
 *
 * A shape repeats **across** materials and never within one, which is the rule that keeps the
 * two channels independent: a diamond means Matrix or Transform and the hue says which, where
 * two orange diamonds would mean nothing at all.
 */

import { getNodeDef } from '../core/registry'
import type { CodaType } from '../core/types'
import { backendForNodeType } from '../nodes/lib/datasetFamilies'

export type SocketFamily =
  'table' | 'matrix' | 'dataset' | 'geometry' | 'transform' | 'layers' | 'scalar' | 'any'
export type SocketShape = 'circle' | 'ring' | 'diamond' | 'square' | 'dot' | 'hex'

export interface SocketStyle {
  family: SocketFamily
  shape: SocketShape
}

export function socketStyle(type: CodaType | undefined): SocketStyle {
  switch (type?.kind) {
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
  return familyColorVar(socketStyle(type).family)
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
 */
export function wireStyle(
  type: CodaType | undefined,
  muted = false,
): { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity?: number } {
  return {
    stroke: typeColorVar(type),
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
 * Stroke only. The width and the dashes stay in `editor.css`, because they say *in flight*
 * rather than what is flowing, and a dropped wire must not inherit them.
 */
export function draggedWireStyle(type: CodaType | undefined): { stroke: string } {
  return { stroke: typeColorVar(type) }
}
