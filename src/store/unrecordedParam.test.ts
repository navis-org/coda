/**
 * A param declared `unrecorded` is written with no undo step: the Neuroglancer card saving where it
 * is looking, many times a gesture, must not be what Ctrl+Z rewinds through first. Pinned at the
 * store because that is where the flag is honoured, so no writer can forget it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

const store = () => useGraphStore.getState()
const params = () => store().graph.nodes.find((n) => n.id === 'ng')!.params

beforeEach(() => {
  clearStorage()
  store().newGraph()
  const def = requireNodeDef('out.neuroglancer')
  store().loadGraph(
    addNode(emptyGraph('one card'), {
      id: 'ng',
      type: def.type,
      position: { x: 0, y: 0 },
      params: defaultParams(def),
    }),
  )
})

describe('an unrecorded param', () => {
  it('is saved in the document but is not an undo step', () => {
    const before = store().past.length
    store().setParam('ng', 'view', '{"dataset":"x","view":{}}')
    expect(params()['view']).toBe('{"dataset":"x","view":{}}')
    expect(store().past).toHaveLength(before)
  })

  it('is left alone by undo and redo, which step only the edits around it', () => {
    store().setParam('ng', 'selectionEdits', ['+1'])
    store().undo()
    store().setParam('ng', 'view', '{"dataset":"x","view":{"position":[1,2,3]}}')
    store().redo()
    expect(params()['selectionEdits']).toEqual(['+1'])
    expect(params()['view']).toBe('{"dataset":"x","view":{"position":[1,2,3]}}')
    store().undo()
    expect(params()['view']).toBe('{"dataset":"x","view":{"position":[1,2,3]}}')
  })

  it('survives undoing a drag that was under way when it was written', () => {
    const at = (x: number) => [{ id: 'ng', position: { x, y: 0 } }]
    store().moveNodes(at(10), false)
    store().setParam('ng', 'view', '{"dataset":"x","view":{"position":[4,5,6]}}')
    store().moveNodes(at(20), true)
    store().undo()
    const node = store().graph.nodes.find((n) => n.id === 'ng')!
    expect(node.position).toEqual({ x: 0, y: 0 })
    expect(params()['view']).toBe('{"dataset":"x","view":{"position":[4,5,6]}}')
  })

  it('leaves every other param recorded as before', () => {
    const before = store().past.length
    store().setParam('ng', 'selectionEdits', ['+1'])
    expect(store().past).toHaveLength(before + 1)
  })
})

/**
 * Unrecorded is about undo, not about running: a presentational one (the camera) changes no result
 * and schedules nothing, while one that is data (`seam:proofreadMerges`'s merge record, which `Merges` and
 * `Current` read) re-runs like any edit, or the card would show a result from before the write.
 */
describe('an unrecorded param that is data', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules a run where a presentational one does not', () => {
    const def = requireNodeDef('seam:proofreadMerges')
    store().loadGraph(
      addNode(store().graph, {
        id: 'review',
        type: def.type,
        position: { x: 0, y: 300 },
        params: defaultParams(def),
      }),
    )
    vi.useFakeTimers()
    vi.clearAllTimers()
    store().setParam('ng', 'view', '{"dataset":"x","view":{}}')
    const camera = vi.getTimerCount()
    vi.clearAllTimers()
    store().setParam('review', 'merges', '[]')
    expect(vi.getTimerCount()).toBe(camera + 1)
    expect(store().past.length).toBe(0)
  })
})
