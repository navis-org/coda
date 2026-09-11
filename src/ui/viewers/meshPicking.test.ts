/**
 * The mesh pick tree, headless — three-mesh-bvh needs no GL context, so the one property that
 * would fail silently is checkable here: the shared index array comes out untouched.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { buildPickTree, pickRaycast } from './meshPicking'

/** A sphere laid out the way a `MeshesValue` item is: its own `Float32Array` and `Uint32Array`. */
function neuronLike(): { mesh: THREE.Mesh; indices: Uint32Array } {
  const sphere = new THREE.SphereGeometry(1000, 24, 16)
  const positions = new Float32Array(sphere.getAttribute('position').array)
  const indices = Uint32Array.from(sphere.index!.array)
  const geometry = new THREE.BufferGeometry()
  // Wrapped, not copied — which is what `MeshItem` does, and why reordering would reach the value.
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.raycast = pickRaycast
  return { mesh, indices }
}

/** A ray from the camera's side, off-centre so the hit is not a degenerate pole triangle. */
function cast(mesh: THREE.Mesh): THREE.Intersection[] {
  const ray = new THREE.Raycaster(new THREE.Vector3(130, 70, 5000), new THREE.Vector3(0, 0, -1))
  return ray.intersectObject(mesh)
}

describe('buildPickTree', () => {
  it('leaves the index array it was handed exactly as it was', () => {
    /*
     * The default build reorders the index in place. Here that array is the `MeshesValue`'s own,
     * so a reorder would draw the same surface and hand every other reader of the value its
     * triangles in a different order — nothing on screen to say so.
     */
    const { mesh, indices } = neuronLike()
    const before = indices.slice()
    buildPickTree(mesh.geometry)
    expect(mesh.geometry.boundsTree).toBeDefined()
    expect(mesh.geometry.index!.array).toBe(indices)
    expect(indices).toEqual(before)
  })

  it('finds the same face three’s own raycast does', () => {
    const { mesh } = neuronLike()
    const brute = cast(mesh)
    buildPickTree(mesh.geometry)
    const fast = cast(mesh)
    expect(brute.length).toBeGreaterThan(0)
    // `faceIndex` has to come back in the geometry's own numbering, not the tree's — the
    // indirect layout keeps a separate order, and a face in that order names a different triangle.
    expect(fast[0]!.faceIndex).toBe(brute[0]!.faceIndex)
    expect(fast[0]!.distance).toBeCloseTo(brute[0]!.distance, 6)
  })

  it('still picks before a tree exists, so a click during the build is slow rather than lost', () => {
    const { mesh } = neuronLike()
    expect(mesh.geometry.boundsTree).toBeUndefined()
    expect(cast(mesh).length).toBeGreaterThan(0)
  })

  it('builds once', () => {
    const { mesh } = neuronLike()
    buildPickTree(mesh.geometry)
    const first = mesh.geometry.boundsTree
    buildPickTree(mesh.geometry)
    expect(mesh.geometry.boundsTree).toBe(first)
  })
})
