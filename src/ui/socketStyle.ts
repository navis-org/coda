/**
 * Socket appearance: which colour family and which shape a type gets.
 *
 * Colour cannot carry type identity on its own here — see `colors.ts`, only three
 * chromatic families clear the all-pairs CVD gate, and Coda has more than three types.
 * So the mapping is deliberately many-to-one on colour and distinguished by SHAPE, with
 * the socket's text label always visible beside it as the third channel.
 *
 *   filled circle  Neurons  (a table guaranteed to have neuronId)
 *   hollow ring    Table    (same family, different shape)
 *   diamond        Matrix
 *   square         Dataset
 *   small dot      Number / String / Boolean — recessive, achromatic
 *   diamond        Transform (geometry hue — a mapping applied to geometry)
 */

import type { CodaType } from '../core/types'

export type SocketFamily = 'table' | 'matrix' | 'dataset' | 'geometry' | 'scalar' | 'any'
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
    case 'network':
      // Shares the matrix hue: both are connectivity, and a fourth chromatic family would
      // fail the all-pairs colourblind gate (see colors.ts). Shape carries the difference.
      return { family: 'matrix', shape: 'hex' }
    case 'dataset':
      return { family: 'dataset', shape: 'square' }
    // 3D geometry shares the dataset hue for the same reason; shapes separate them.
    case 'skeletons':
      return { family: 'geometry', shape: 'circle' }
    case 'meshes':
      return { family: 'geometry', shape: 'hex' }
    case 'points':
      return { family: 'geometry', shape: 'dot' }
    // A layout is about a network, so it takes the network's hue; square separates it from the
    // diamond and hex already spoken for. Adding a fifth chromatic family would fail the
    // all-pairs colourblind gate — see colors.ts.
    case 'layout':
      return { family: 'matrix', shape: 'square' }
    // A linkage is a clustering *of* a matrix, so it takes the matrix hue and the one shape
    // that family has left. `ring` is also the table family's, which is the existing trade
    // rather than a new one — geometry and table both draw a circle, and hue plus the always
    // visible label carry the difference. A sixth chromatic family would fail the all-pairs
    // colourblind gate; see colors.ts.
    case 'linkage':
      return { family: 'matrix', shape: 'ring' }
    /*
     * A transform is a thing you apply *to* geometry, so it takes geometry's hue — and diamond
     * is the shape that family has left. Diamond is also the matrix family's, which is the
     * existing many-to-one trade rather than a new one (see `linkage` above): hue plus the
     * always-visible label carry the difference. A seventh chromatic family would fail the
     * all-pairs colourblind gate; see colors.ts.
     */
    case 'transform':
      return { family: 'geometry', shape: 'diamond' }
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
    case 'geometry':
      return 'var(--socket-dataset)'
    default:
      return 'var(--socket-scalar)'
  }
}

export function typeColorVar(type: CodaType | undefined): string {
  return familyColorVar(socketStyle(type).family)
}
