/**
 * The split gallery's tiles share one mesh's positions, normals and triangles (`SplitTiles.tsx`).
 * three's renderer frees the GPU buffer of every attribute a disposed geometry still holds, so a
 * tile recoloured — its geometry rebuilt and the old one disposed — must not take the shared ones
 * with it, or every other tile draws nothing from the next frame on. jsdom has no WebGL: what is
 * pinned is what the renderer's dispose handler would be handed.
 */

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { disposeOwn } from './SplitTiles'

describe('a tile’s geometry, disposed', () => {
  it('hands the renderer only its own colours, never the shared buffers', () => {
    const position = new THREE.BufferAttribute(new Float32Array(9), 3)
    const normal = new THREE.BufferAttribute(new Float32Array(9), 3)
    const index = new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1)
    const colour = new THREE.BufferAttribute(new Float32Array(9), 3)
    const tile = new THREE.BufferGeometry()
    tile.setAttribute('position', position)
    tile.setAttribute('normal', normal)
    tile.setIndex(index)
    tile.setAttribute('color', colour)
    // What `WebGLGeometries.onGeometryDispose` reads off the geometry, at the moment it runs.
    let freed: unknown[] = []
    tile.addEventListener('dispose', () => {
      freed = [...Object.values(tile.attributes), tile.index].filter(Boolean)
    })
    disposeOwn(tile)
    expect(freed).toEqual([colour])
  })
})
