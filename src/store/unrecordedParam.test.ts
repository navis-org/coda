/**
 * A param declared `unrecorded` is written with no undo step: the Neuroglancer card saving where it
 * is looking, many times a gesture, must not be what Ctrl+Z rewinds through first. Pinned at the
 * store because that is where the flag is honoured, so no writer can forget it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

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

  it('leaves every other param recorded as before', () => {
    const before = store().past.length
    store().setParam('ng', 'selectionEdits', ['+1'])
    expect(store().past).toHaveLength(before + 1)
  })
})
