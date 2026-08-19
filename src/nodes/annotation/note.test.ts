/**
 * The Text note, from the engine's side.
 *
 * Everything here is about what a note is *not*: not evaluated, not stale, not blocked, not
 * counted, not deferred. That is the whole contract of `annotation: true`, and none of it fails a
 * type check when it breaks — the symptom is a toolbar permanently reporting stale nodes and a
 * Run that never clears them, which reads as a scheduler bug rather than as a comment card.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addNode, deserializeGraph, emptyGraph, serializeGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { isAnnotation, listableNodeDefs, requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import '../index'

beforeAll(async () => {
  await registerSource(new MockSource({ latencyMs: 0 })).listDatasets()
})

function scheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

function note(id: string, text = 'Hello'): GraphNode {
  const def = requireNodeDef('note.text')
  return {
    id,
    type: 'note.text',
    position: { x: 0, y: 0 },
    params: { ...defaultParams(def), text },
  }
}

function dataset(id: string): GraphNode {
  const def = requireNodeDef('dataset.mock.opticlobe')
  return {
    id,
    type: 'dataset.mock.opticlobe',
    position: { x: 0, y: 0 },
    params: defaultParams(def),
  }
}

describe('the Text note definition', () => {
  it('is an annotation with no ports, and is offered in the add surfaces', () => {
    const def = requireNodeDef('note.text')
    expect(def.annotation).toBe(true)
    expect(def.inputs ?? []).toEqual([])
    expect(def.outputs ?? []).toEqual([])
    expect(isAnnotation('note.text')).toBe(true)
    // Registered *and* listable: a note is a thing people add on purpose, unlike a superseded
    // type that stays registered only so old files keep loading.
    expect(listableNodeDefs().map((d) => d.type)).toContain('note.text')
  })

  it('infers cleanly on its own, with nothing wired to it', () => {
    const inference = inferGraph(addNode(emptyGraph(), note('n1')))
    expect(inference.ok).toBe(true)
    expect(inference.nodes.n1?.issues ?? []).toEqual([])
  })
})

describe('a note in a run', () => {
  it('is neither executed nor deferred, and gets no state at all', async () => {
    let graph = addNode(emptyGraph(), dataset('ds'))
    graph = addNode(graph, note('n1'))
    const sched = scheduler()

    sched.refreshStates(graph)
    // The dataset node is real work waiting to happen; the note is not work.
    expect(sched.info('ds').state).toBe('stale')
    expect(sched.info('n1').state).toBe('idle')

    const summary = await sched.run(graph, { mode: 'full' })
    expect(summary.executed).toEqual(['ds'])
    expect(summary.deferred).toEqual([])
    expect(summary.failed).toEqual([])
    expect(sched.info('n1').state).toBe('idle')
  })

  it('stays out of the way when its text changes', async () => {
    let graph = addNode(emptyGraph(), dataset('ds'))
    graph = addNode(graph, note('n1', 'first'))
    const sched = scheduler()
    await sched.run(graph, { mode: 'full' })
    expect(sched.info('ds').state).toBe('ok')

    // Editing prose must not invalidate anything: the note is not in any provenance key, so the
    // dataset node's cached result is still current.
    const edited = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'n1' ? note('n1', 'second') : n)),
    }
    sched.refreshStates(edited)
    expect(sched.info('ds').state).toBe('ok')
    expect(sched.info('n1').state).toBe('idle')
  })

  it('returns the same idle object every time, so selectors do not loop', () => {
    const sched = scheduler()
    sched.refreshStates(addNode(emptyGraph(), note('n1')))
    // Invariant 7: the store is read through useSyncExternalStore, which compares by identity.
    expect(sched.info('n1')).toBe(sched.info('n1'))
  })
})

describe('a note in a file', () => {
  it('survives a save/load round trip with its text and its size', () => {
    const original = addNode(emptyGraph('With a note'), {
      ...note('n1', '# Heading\n\nBody with a [link](https://example.org).'),
      size: { width: 420, height: 180 },
    })
    const { graph, warnings } = deserializeGraph(serializeGraph(original))
    expect(warnings).toEqual([])
    expect(graph.nodes).toEqual(original.nodes)
  })
})
