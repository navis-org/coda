/**
 * 3D morphology viewer, on three.js via react-three-fiber.
 *
 * Geometry is built into flat typed arrays once per input value, not per frame: a hundred
 * skeletons is ~40k segments, and rebuilding that on a colour change would stutter. Colour
 * lives in a per-vertex buffer so an encoding change only rewrites the colour attribute.
 *
 * Picking raycasts the skeleton lines and maps the hit vertex back to its neuron through a
 * segment→item lookup, which is why the geometry builder keeps that array around.
 */

import { Canvas, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

import type { MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import { boundsCenter, boundsSize } from '../../core/values'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { chartSurface, currentMode } from '../colors'
import { describeLegend, hexToRgbFloat, resolveColor } from '../encoding'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

export interface Viewer3DProps {
  skeletons?: SkeletonsValue | undefined
  meshes?: MeshesValue | undefined
  points?: PointsValue | undefined
  skeletonColor: ColorSpec
  meshColor: ColorSpec
  pointColor: ColorSpec
  skeletonWidth: number
  meshOpacity: number
  pointSize: number
  background: 'theme' | 'dark' | 'light'
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

const DIMMED: [number, number, number] = [0.42, 0.42, 0.4]

export function Viewer3D(props: Viewer3DProps) {
  const {
    skeletons,
    meshes,
    points,
    skeletonColor,
    background,
    selection,
    compact = false,
    baseName,
    onExpand,
    onError,
  } = props

  const mode = currentMode()
  // Every branch goes through `chartSurface`: the explicit ones name a mode rather than a
  // hex, or "dark" here and the dark theme could drift apart with nothing to catch it.
  const surface = chartSurface(background === 'theme' ? mode : background)

  const skeletonColors = useMemo(
    () => resolveColor(skeletons?.attributes, skeletonColor, mode),
    [skeletons, skeletonColor, mode],
  )

  const bounds = skeletons?.bounds ?? meshes?.bounds ?? points?.bounds
  const exportSource: ExportSource = useMemo(() => {
    const attributes = skeletons?.attributes ?? meshes?.attributes ?? points?.attributes
    return attributes ? { csv: () => tableToCsvParts(attributes) } : {}
  }, [skeletons, meshes, points])

  if (!skeletons && !meshes && !points) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Connect skeletons, meshes or points to see a scene.</div>
      </div>
    )
  }

  const center = bounds ? boundsCenter(bounds) : ([0, 0, 0] as [number, number, number])
  const size = bounds ? boundsSize(bounds) : 1

  return (
    <div className="viewer">
      <div className="viewer3d-canvas nowheel">
        <Canvas
          frameloop="demand"
          camera={{
            position: [center[0], center[1], center[2] + size * 1.9],
            fov: 45,
            far: size * 40,
          }}
          onCreated={({ gl }) => gl.setClearColor(surface)}
        >
          <ambientLight intensity={0.85} />
          <directionalLight position={[1, 1, 1]} intensity={0.6} />
          <SceneContents {...props} skeletonColors={skeletonColors} />
          <OrbitControls target={center} makeDefault enableDamping={false} />
          <FrameOnChange center={center} size={size} />
        </Canvas>
      </div>

      {skeletonColors.legend?.kind === 'categorical' && !compact && (
        <div className="legend">
          {skeletonColors.legend.entries.map((entry) => (
            <span key={entry.label} className="legend__item">
              <span className="legend__swatch" style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {skeletons ? `${skeletons.items.length} skeletons` : ''}
          {meshes ? `${skeletons ? ' · ' : ''}${meshes.items.length} meshes` : ''}
          {points
            ? `${skeletons || meshes ? ' · ' : ''}${points.attributes.length} points`
            : ''}
          {selection.length > 0 && ` · ${selection.length} selected`}
        </span>
        {/*
          * Two ways a mesh set can be coarser than what the source holds, and they need
          * different words. A multi-resolution source *picked a level*, so the useful number is
          * which of how many; a source with none *simplified what it fetched*, where naming a
          * level would report "0 of 0" while most of the triangles have gone. Both admit the
          * trade and both name the control that changes it.
          */}
        {meshes?.detail && !compact && (
          <span
            className="viewer__note"
            title={
              (meshes.detail.decimated
                ? `This source publishes one level of detail, so meshes are simplified on ` +
                  `arrival to fit the triangle budget — ` +
                  `${meshes.detail.triangles.toLocaleString()} triangles here.`
                : `Meshes drawn at level ${meshes.detail.lod} of ${meshes.detail.levels - 1} ` +
                  `(0 is finest), ${meshes.detail.triangles.toLocaleString()} triangles.`) +
              ` Raise Detail on the Meshes node, or fetch fewer neurons, for a finer surface.`
            }
          >
            {meshes.detail.decimated
              ? 'meshes simplified'
              : `mesh LOD ${meshes.detail.lod}/${meshes.detail.levels - 1}`}
          </span>
        )}
        {skeletonColors.legend && !compact && (
          <span>{describeLegend(skeletonColors.legend)}</span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, '3d')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SceneContents({
  skeletons,
  meshes,
  points,
  meshColor,
  pointColor,
  skeletonWidth,
  meshOpacity,
  pointSize,
  selection,
  onSelectionChange,
  skeletonColors,
}: Viewer3DProps & { skeletonColors: ReturnType<typeof resolveColor> }) {
  const mode = currentMode()
  const selected = useMemo(() => new Set(selection), [selection])

  const meshColors = useMemo(
    () => resolveColor(meshes?.attributes, meshColor, mode),
    [meshes, meshColor, mode],
  )
  const pointColors = useMemo(
    () => resolveColor(points?.attributes, pointColor, mode),
    [points, pointColor, mode],
  )

  return (
    <>
      {skeletons && (
        <SkeletonLines
          skeletons={skeletons}
          colorAt={skeletonColors.at}
          selected={selected}
          width={skeletonWidth}
          onSelectionChange={onSelectionChange}
          selection={selection}
        />
      )}
      {meshes?.items.map((item, index) => (
        <MeshItem
          key={`${item.id}-${index}`}
          positions={item.positions}
          indices={item.indices}
          color={meshColors.at(index)}
          opacity={meshOpacity}
          dimmed={selected.size > 0 && !selected.has(item.id)}
        />
      ))}
      {points && <PointCloud points={points} colorAt={pointColors.at} size={pointSize} />}
    </>
  )
}

/**
 * Every skeleton in one LineSegments.
 *
 * A draw call per neuron would be 100+ calls a frame for no benefit — the whole collection
 * shares a material, and selection is expressed through the colour buffer rather than
 * through separate objects.
 */
function SkeletonLines({
  skeletons,
  colorAt,
  selected,
  width,
  selection,
  onSelectionChange,
}: {
  skeletons: SkeletonsValue
  colorAt: (index: number) => string
  selected: Set<string>
  width: number
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
}) {
  const invalidate = useThree((state) => state.invalidate)

  /** Geometry is rebuilt only when the skeletons themselves change. */
  const built = useMemo(() => {
    let segments = 0
    for (const item of skeletons.items) {
      for (let i = 0; i < item.parents.length; i++) if (item.parents[i]! >= 0) segments++
    }

    const positions = new Float32Array(segments * 6)
    const segmentItem = new Int32Array(segments)
    let cursor = 0
    let segmentIndex = 0

    skeletons.items.forEach((item, itemIndex) => {
      for (let i = 0; i < item.parents.length; i++) {
        const parent = item.parents[i]!
        if (parent < 0) continue
        positions[cursor++] = item.positions[i * 3]!
        positions[cursor++] = item.positions[i * 3 + 1]!
        positions[cursor++] = item.positions[i * 3 + 2]!
        positions[cursor++] = item.positions[parent * 3]!
        positions[cursor++] = item.positions[parent * 3 + 1]!
        positions[cursor++] = item.positions[parent * 3 + 2]!
        segmentItem[segmentIndex++] = itemIndex
      }
    })

    return { positions, segmentItem, segments }
  }, [skeletons])

  /** Colour is a separate memo, so restyling does not rebuild positions. */
  const colors = useMemo(() => {
    const buffer = new Float32Array(built.segments * 6)
    const dimming = selected.size > 0
    for (let s = 0; s < built.segments; s++) {
      const itemIndex = built.segmentItem[s]!
      const neuronId = skeletons.items[itemIndex]?.id ?? ''
      const rgb = dimming && !selected.has(neuronId) ? DIMMED : hexToRgbFloat(colorAt(itemIndex))
      for (let v = 0; v < 2; v++) {
        buffer[s * 6 + v * 3] = rgb[0]
        buffer[s * 6 + v * 3 + 1] = rgb[1]
        buffer[s * 6 + v * 3 + 2] = rgb[2]
      }
    }
    return buffer
  }, [built, colorAt, selected, skeletons])

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeBoundingSphere()
    return g
  }, [built, colors])

  useEffect(() => {
    invalidate()
    return () => geometry.dispose()
  }, [geometry, invalidate])

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!onSelectionChange) return
    const vertexIndex = event.index
    if (vertexIndex === undefined) return
    const segment = Math.floor(vertexIndex / 2)
    const itemIndex = built.segmentItem[segment]
    if (itemIndex === undefined) return
    const neuronId = skeletons.items[itemIndex]?.id ?? ''
    if (!neuronId) return
    event.stopPropagation()
    onSelectionChange(
      selection.includes(neuronId)
        ? selection.filter((id) => id !== neuronId)
        : [...selection, neuronId],
    )
  }

  return (
    <lineSegments geometry={geometry} onClick={onClick}>
      <lineBasicMaterial vertexColors linewidth={width} />
    </lineSegments>
  )
}

function MeshItem({
  positions,
  indices,
  color,
  opacity,
  dimmed,
}: {
  positions: Float32Array
  indices: Uint32Array
  color: string
  opacity: number
  dimmed: boolean
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    g.computeVertexNormals()
    return g
  }, [positions, indices])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={dimmed ? '#6a6a66' : color}
        transparent
        opacity={dimmed ? opacity * 0.4 : opacity}
        depthWrite={false}
        side={THREE.DoubleSide}
        roughness={0.9}
      />
    </mesh>
  )
}

function PointCloud({
  points,
  colorAt,
  size,
}: {
  points: PointsValue
  colorAt: (index: number) => string
  size: number
}) {
  const geometry = useMemo(() => {
    const count = points.attributes.length
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const rgb = hexToRgbFloat(colorAt(i))
      colors[i * 3] = rgb[0]
      colors[i * 3 + 1] = rgb[1]
      colors[i * 3 + 2] = rgb[2]
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(points.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeBoundingSphere()
    return g
  }, [points, colorAt])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <points geometry={geometry}>
      <pointsMaterial vertexColors size={size} sizeAttenuation />
    </points>
  )
}

/**
 * Re-frame when the scene's extent changes.
 *
 * Without this, switching from one neuron to a whole cell type leaves the camera framed on
 * the old bounding box, and the new scene is off-screen with no obvious way back.
 */
function FrameOnChange({ center, size }: { center: [number, number, number]; size: number }) {
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    camera.position.set(center[0], center[1], center[2] + size * 1.9)
    camera.near = Math.max(0.1, size / 1000)
    camera.far = size * 40
    camera.updateProjectionMatrix()
    camera.lookAt(center[0], center[1], center[2])
    invalidate()
  }, [camera, center, size, invalidate])

  return null
}
