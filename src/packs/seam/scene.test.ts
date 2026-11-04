/**
 * The annotation layer. Three things it has to get right, each silent when it does not: the
 * coordinates are the source's own, every annotation has a distinct id, and the shader reads the
 * colour property — without it neuroglancer draws the whole clustering in one colour.
 */

import { describe, expect, it } from 'vitest'

import { clusterColor } from '../../style/encoding'
import { MAX_ANNOTATIONS, clusterLayer, writeDrawnPositions } from './scene'

const neuron = (id: string, labels: number[]) => ({
  neuronId: id,
  positions: Float32Array.from(labels.flatMap((_, i) => [i * 10, i * 20, i * 30])),
  labels: Int32Array.from(labels),
})

describe('clusterLayer', () => {
  it('draws one point per sample, at the positions it was given', () => {
    const { layer, dropped, drawn } = clusterLayer([neuron('a', [1, 2])], 'clusters')
    const annotations = layer.annotations as Record<string, unknown>[]
    expect(dropped).toBe(0)
    expect(drawn).toBe(2)
    expect(annotations[1]!.point).toEqual([10, 20, 30])
  })

  it('gives every annotation its own id', () => {
    const { layer } = clusterLayer([neuron('a', [1, 1]), neuron('b', [1, 1])], 'clusters')
    const ids = (layer.annotations as { id: string }[]).map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reads the colour property in its shader', () => {
    const { layer } = clusterLayer([neuron('a', [1])], 'clusters')
    expect(layer.shader).toContain('prop_color()')
    expect(layer.annotationProperties).toEqual([
      { id: 'color', type: 'rgb', default: '#ffffff' },
    ])
  })

  it('states nanometres rather than leaving the viewer to guess', () => {
    const { layer } = clusterLayer([neuron('a', [1])], 'clusters')
    const source = layer.source as { transform: { outputDimensions: Record<string, unknown> } }
    expect(source.transform.outputDimensions.x).toEqual([1e-9, 'm'])
  })

  /** The tail is dropped and counted, never the layer: a partial picture beats a frozen tab. */
  it('drops the tail past the cap and says how much', () => {
    const labels = new Array(MAX_ANNOTATIONS + 50).fill(1)
    const { layer, dropped, drawn } = clusterLayer([neuron('a', labels)], 'clusters')
    expect(drawn).toBe(MAX_ANNOTATIONS)
    expect(dropped).toBe(50)
    expect((layer.annotations as unknown[]).length).toBe(MAX_ANNOTATIONS)
  })

  /**
   * The colours are `src/style/encoding.ts`' `clusterColor`, so the layer and the 3D View agree
   * by sharing one function rather than by two palettes happening to line up.
   */
  it('colours a point the way the 3D View colours the same cluster', () => {
    const { layer } = clusterLayer([neuron('a', [1, 0])], 'clusters')
    const props = (layer.annotations as { props: string[] }[]).map((a) => a.props[0])
    expect(props).toEqual([clusterColor(1, 'dark'), clusterColor(0, 'dark')])
  })
})

describe('writeDrawnPositions', () => {
  /**
   * The gather that puts the answer back where neuroglancer needs it. Interleaved xyz read
   * through an index array is the silent off-by-one class, and it is the one piece of the node's
   * output assembly a test can reach without a GPU.
   */
  it('gathers the drawn nodes’ own coordinates, into the slice it is given', () => {
    const positions = Float32Array.from([0, 0, 0, 10, 11, 12, 20, 21, 22])
    const whole = new Float32Array(4 * 3)
    // A `subarray` writes through, which is what lets the caller size one buffer for every
    // neuron and hand each its own window.
    writeDrawnPositions(positions, Int32Array.from([2, 0]), whole.subarray(2 * 3, 4 * 3))
    expect([...whole]).toEqual([0, 0, 0, 0, 0, 0, 20, 21, 22, 0, 0, 0])
  })

  /** Drawn with replacement, so one node can appear twice — and must, both times. */
  it('writes a repeated draw twice', () => {
    const positions = Float32Array.from([1, 2, 3, 4, 5, 6])
    const into = new Float32Array(2 * 3)
    writeDrawnPositions(positions, Int32Array.from([1, 1]), into)
    expect([...into]).toEqual([4, 5, 6, 4, 5, 6])
  })
})
