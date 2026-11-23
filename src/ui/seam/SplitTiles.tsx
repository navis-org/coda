/**
 * The split gallery's tiles: each candidate as a small 3D view of the neuron, coloured by the two
 * parts the split would make (`docs/split-gallery-plan.md`, phase 3). Clicking a tile — a click,
 * not the end of a drag — enlarges it.
 *
 * **One canvas, a view per tile** (drei's `View`, tracking each tile's element). Browsers cap live
 * WebGL contexts (Chrome at 16) and a Neuroglancer card already holds one, so six canvases of
 * their own would risk the oldest context being lost. Every tile draws the **same** geometry —
 * positions, triangles and normals shared — with its own vertex colours.
 *
 * Until the mesh has arrived a tile draws the neuron's level-2 chunk points, which are already
 * here and carry the split exactly; the mesh replaces them when it lands. A mesh vertex takes the
 * side of its nearest chunk (`splitColours.ts`).
 */

import { PerspectiveCamera, TrackballControls, View } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { createRef, useEffect, useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import * as THREE from 'three'

import { boundsCenter, boundsOf, boundsSize } from '../../core/values'
import type { Triple } from '../../data/precomputed/volume'
import type { SplitCandidate } from '../../packs/seam/splitGallery'
import type { ExactVertices, SideColours } from '../../packs/seam/splitColours'
import { colourOfSide, sideColours } from '../../packs/seam/splitColours'
import { chartSurface, CHART_INK, cycleColor } from '../../style/colors'
import { hexToLinearRgb } from '../../style/encoding'
import { computeNormals } from '../viewers/drawLimits'
import { CLICK_SLOP } from '../viewers/tooltipPoint'
import type { SplitMesh } from './splitSession'

/** The part a split keeps and the part it takes off, named for the caption and the legend. */
export const KEPT_HEX = cycleColor(0, 'dark')
export const TAKEN_HEX = cycleColor(1, 'dark')
const KEPT = hexToLinearRgb(KEPT_HEX)
const TAKEN = hexToLinearRgb(TAKEN_HEX)
const NEITHER = hexToLinearRgb(CHART_INK.dark.muted)

/** The surface the tiles' colours were checked against (`colors.ts`), and their caption ink. */
const SURFACE = chartSurface('dark')
const CAPTION_INK = CHART_INK.dark.secondary

export interface SplitTilesProps {
  readonly candidates: readonly SplitCandidate[]
  readonly chunks: readonly string[]
  readonly positions: ReadonlyMap<string, Triple>
  readonly mesh: SplitMesh | undefined
  /** Vertices placed exactly at the cuts, once read (`splitExact`). */
  readonly exact: ExactVertices | undefined
  readonly pointNm: Triple
  /** The enlarged tile, or undefined for all of them. */
  readonly selected: number | undefined
  readonly onSelect: (index: number) => void
  /** Each tile's caption. */
  readonly caption: (candidate: SplitCandidate, index: number) => ReactNode
}

export function SplitTiles(props: SplitTilesProps) {
  const { candidates, selected, onSelect, caption } = props
  const container = useRef<HTMLDivElement>(null)
  // One ref per tile, kept as tiles arrive, so each `View` goes on tracking the element it has.
  const refs = useRef<Array<RefObject<HTMLDivElement | null>>>([])
  while (refs.current.length < candidates.length) refs.current.push(createRef<HTMLDivElement>())
  const tiles = refs.current
  const framing = useMemo(() => frameOf(props.positions), [props.positions])
  const base = useBaseGeometry(props.mesh)
  const press = useRef<{ x: number; y: number } | undefined>(undefined)

  return (
    <div
      ref={container}
      className="split-tiles"
      data-enlarged={selected === undefined ? undefined : ''}
    >
      {candidates.map((candidate, i) => (
        <div
          key={i}
          ref={tiles[i]}
          className="split-tiles__tile"
          style={{ background: SURFACE }}
          data-selected={selected === i ? '' : undefined}
          onPointerDown={(event) => {
            press.current = { x: event.clientX, y: event.clientY }
          }}
          onPointerUp={(event) => {
            const at = press.current
            press.current = undefined
            if (!at || selected === i) return
            if (Math.hypot(event.clientX - at.x, event.clientY - at.y) <= CLICK_SLOP)
              onSelect(i)
          }}
        >
          <div className="split-tiles__caption" style={{ color: CAPTION_INK }}>
            {caption(candidate, i)}
          </div>
        </div>
      ))}
      <Canvas
        className="split-tiles__canvas"
        eventSource={container as RefObject<HTMLElement>}
        frameloop="demand"
        // No tone curve: the two parts' colours are the palette's, as the legend shows them.
        flat
      >
        {candidates.map((candidate, i) => (
          <View key={i} track={tiles[i] as RefObject<HTMLElement>}>
            <TileScene
              candidate={candidate}
              base={base}
              mesh={props.mesh}
              exact={props.exact}
              chunks={props.chunks}
              positions={props.positions}
              pointNm={props.pointNm}
              framing={framing}
              element={tiles[i]!}
            />
          </View>
        ))}
      </Canvas>
    </div>
  )
}

interface Framing {
  readonly centre: Triple
  readonly size: number
}

/** The neuron's extent, from its chunk points. */
function frameOf(positions: ReadonlyMap<string, Triple>): Framing {
  if (positions.size === 0) return { centre: [0, 0, 0], size: 1 }
  const bounds = boundsOf([new Float32Array([...positions.values()].flat())])
  return { centre: boundsCenter(bounds), size: boundsSize(bounds) }
}

/** The mesh's positions, triangles and normals, made once and shared by every tile. */
function useBaseGeometry(mesh: SplitMesh | undefined) {
  const base = useMemo(() => {
    if (!mesh) return undefined
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    // `computeNormals`, not three's: the same normals, measured 6.6× faster (`drawLimits.ts`).
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(computeNormals(mesh.positions, mesh.indices), 3),
    )
    geometry.computeBoundingSphere()
    return geometry
  }, [mesh])
  useEffect(() => () => base?.dispose(), [base])
  return base
}

/** Sides as the caption names them: `a` is whichever part is larger — the one kept. */
function keptSides(candidate: SplitCandidate): SideColours {
  return candidate.sizes.a >= candidate.sizes.b
    ? { a: KEPT, b: TAKEN, none: NEITHER }
    : { a: TAKEN, b: KEPT, none: NEITHER }
}

function TileScene({
  candidate,
  base,
  mesh,
  exact,
  chunks,
  positions,
  pointNm,
  framing,
  element,
}: {
  candidate: SplitCandidate
  base: THREE.BufferGeometry | undefined
  /** For its vertices' nearest chunks, which index its own chunk list, not the session's. */
  mesh: SplitMesh | undefined
  exact: ExactVertices | undefined
  chunks: readonly string[]
  positions: ReadonlyMap<string, Triple>
  pointNm: Triple
  framing: Framing
  element: RefObject<HTMLDivElement | null>
}) {
  const colours = useMemo(() => keptSides(candidate), [candidate])
  // This tile's mesh: the shared attributes, its own colours.
  const geometry = useMemo(() => {
    if (!base || !mesh) return undefined
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', base.getAttribute('position'))
    geometry.setAttribute('normal', base.getAttribute('normal'))
    geometry.setIndex(base.getIndex())
    geometry.boundingSphere = base.boundingSphere
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(
        sideColours(mesh.nearest, mesh.chunks, candidate, colours, exact),
        3,
      ),
    )
    return geometry
  }, [base, mesh, exact, candidate, colours])
  // Until then, the chunk points, coloured by the chunk's own side.
  const points = useMemo(() => {
    if (geometry) return undefined
    const xyz: number[] = []
    const rgb: number[] = []
    for (const chunk of chunks) {
      const at = positions.get(chunk)
      if (!at) continue
      xyz.push(...at)
      rgb.push(...colourOfSide(candidate.chunkSides.get(chunk), colours))
    }
    const cloud = new THREE.BufferGeometry()
    cloud.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3))
    cloud.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3))
    return cloud
  }, [geometry, chunks, positions, candidate, colours])
  useEffect(() => () => geometry?.dispose(), [geometry])
  useEffect(() => () => points?.dispose(), [points])
  /*
   * The controls move the camera in `update()`, which runs only when a frame is drawn — and under
   * the `demand` frameloop a press or a move draws nothing, so the view never turned. A frame is
   * asked for on a press, a wheel turn, and a move **with a button held**: a hover changes nothing,
   * and one frame draws every tile. The controls' own `change` keeps it going while they move.
   */
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    const tile = element.current
    if (!tile) return
    const wake = () => invalidate()
    const drag = (event: PointerEvent) => {
      if (event.buttons !== 0) invalidate()
    }
    tile.addEventListener('pointerdown', wake)
    tile.addEventListener('wheel', wake, { passive: true })
    tile.addEventListener('pointermove', drag)
    return () => {
      tile.removeEventListener('pointerdown', wake)
      tile.removeEventListener('wheel', wake)
      tile.removeEventListener('pointermove', drag)
    }
  }, [element, invalidate])

  const { centre, size } = framing
  return (
    <>
      {/* Looking along +z with y down: neuroglancer's xy view, so the shape reads the same. */}
      <PerspectiveCamera
        makeDefault
        position={[centre[0], centre[1], centre[2] - size * 1.8]}
        up={[0, -1, 0]}
        fov={35}
        near={size / 1000}
        far={size * 10}
        onUpdate={(camera) => camera.lookAt(centre[0], centre[1], centre[2])}
      />
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[centre[0], centre[1] - size, centre[2] - size]}
        intensity={1.6}
      />
      {geometry ? (
        <mesh geometry={geometry}>
          <meshLambertMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      ) : points ? (
        <points geometry={points}>
          <pointsMaterial vertexColors size={4} sizeAttenuation={false} />
        </points>
      ) : null}
      {/* The point the key was pressed over. */}
      <mesh position={[pointNm[0], pointNm[1], pointNm[2]]}>
        <sphereGeometry args={[size * 0.006, 16, 12]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      {/*
       * `keys` blanked as `Viewer3D` does: three-stdlib binds A/S/D on the window, and D is Coda's
       * Dashboard key. `domElement` the tile's own, so a drag turns this view and no other.
       */}
      {element.current && (
        <TrackballControls
          domElement={element.current}
          target={[centre[0], centre[1], centre[2]]}
          staticMoving
          rotateSpeed={3}
          zoomSpeed={2.4}
          panSpeed={0.8}
          keys={['', '', '']}
        />
      )}
    </>
  )
}
