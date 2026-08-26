/**
 * The canvas lock, at the store: what a locked graph refuses, and what it deliberately does not.
 *
 * These guards are a **backstop** — every surface that can reach one of them is disabled on
 * screen, and `ui/panels/lock.test.tsx` is what pins that half. What is worth pinning *here* is
 * the line itself, because it is a judgement rather than a mechanism and nothing in a type check
 * can see it: a locked canvas freezes the viewport, the cards' geometry and the graph's
 * structure, and leaves everything else alone. A guard that crept onto `setParam` would make
 * Lock a read-only mode, which is a different feature; one missing from `undo` would let ⌘Z
 * delete a node on a frozen canvas.
 *
 * The lock is session state, so nothing here touches storage: it is off on every fresh store and
 * no load path turns it on.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { emptyPlan } from '../assistant/planShape'
import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  useGraphStore.setState({ locked: false })
  useGraphStore.getState().newGraph()
  useGraphStore.getState().loadGraph(twoNodes())
})

const store = () => useGraphStore.getState()
const graph = () => useGraphStore.getState().graph

/** A viewer fed by a table: one wire, two nodes, and a param on each to edit. */
function twoNodes() {
  const table = requireNodeDef('core.tableFromUrl')
  const viewer = requireNodeDef('out.table')
  let g = addNode(emptyGraph('two nodes'), {
    id: 'src',
    type: table.type,
    position: { x: 0, y: 0 },
    params: defaultParams(table),
  })
  g = addNode(g, {
    id: 'view',
    type: viewer.type,
    position: { x: 300, y: 0 },
    params: defaultParams(viewer),
  })
  return {
    ...g,
    edges: [
      { id: 'e1', source: 'src', sourceHandle: 'table', target: 'view', targetHandle: 'table' },
    ],
  }
}

describe('a locked canvas', () => {
  beforeEach(() => {
    useGraphStore.setState({ locked: true })
  })

  it('refuses to move or resize a card', () => {
    store().moveNodes([{ id: 'src', position: { x: 999, y: 999 } }], true)
    store().resizeNodes([{ id: 'view', size: { width: 800, height: 600 } }], true)
    expect(graph().nodes.find((n) => n.id === 'src')?.position).toEqual({ x: 0, y: 0 })
    expect(graph().nodes.find((n) => n.id === 'view')?.size).toBeUndefined()
  })

  it('refuses an arrange, so auto-layout cannot move a frozen graph either', () => {
    store().arrangeNodes(new Map([['src', { x: 500, y: 500 }]]))
    expect(graph().nodes.find((n) => n.id === 'src')?.position).toEqual({ x: 0, y: 0 })
  })

  it('adds nothing, and says so with an id nobody can wire to', () => {
    const before = graph().nodes.length
    expect(store().addNode('out.table', { x: 10, y: 10 })).toBe('')
    expect(graph().nodes.length).toBe(before)
  })

  it('refuses to wire, rewire, delete or duplicate', () => {
    const edges = graph().edges.length
    const nodes = graph().nodes.length
    expect(
      store().connect({
        source: 'src',
        sourceHandle: 'table',
        target: 'view',
        targetHandle: 'table',
      }),
    ).toBe(false)
    expect(
      store().reconnect('e1', {
        source: 'src',
        sourceHandle: 'table',
        target: 'view',
        targetHandle: 'table',
      }),
    ).toBe(false)
    store().setSelection(['src'])
    store().duplicateSelection()
    store().deleteNodes(['view'])
    store().deleteEdges(['e1'])
    expect(graph().nodes.length).toBe(nodes)
    expect(graph().edges.length).toBe(edges)
  })

  it('refuses an assistant plan, and answers with a reason rather than in silence', () => {
    const result = store().applyAssistantPlan({
      ...emptyPlan(),
      summary: 'add a table',
      add: [{ ref: 'a', type: 'out.table', params: {} }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/locked/i)
  })

  /*
   * Undo is a graph edit like any other, and the reason it is here rather than left alone: with
   * add and delete refused, a ⌘Z that still ran would be the one way to restructure a frozen
   * graph — and the node it removed would come back from nowhere.
   */
  it('refuses undo and redo, leaving the history where it was', () => {
    useGraphStore.setState({ locked: false })
    store().setParam('src', 'url', 'https://example.org/a.csv')
    const depth = store().past.length
    expect(depth).toBeGreaterThan(0)
    useGraphStore.setState({ locked: true })
    store().undo()
    expect(store().past.length).toBe(depth)
    expect(graph().nodes.find((n) => n.id === 'src')?.params.url).toBe(
      'https://example.org/a.csv',
    )
  })

  it('still edits params, renames, mutes and collapses — the lock is about the canvas', () => {
    store().setParam('src', 'url', 'https://example.org/b.csv')
    store().renameNode('view', 'Results')
    store().toggleDisabled(['view'])
    store().toggleCollapsed(['view'])
    const view = graph().nodes.find((n) => n.id === 'view')
    expect(graph().nodes.find((n) => n.id === 'src')?.params.url).toBe(
      'https://example.org/b.csv',
    )
    expect(view?.title).toBe('Results')
    expect(view?.disabled).toBe(true)
    expect(view?.collapsed).toBe(true)
  })

  it('still selects, which is what the inspector and every viewer are reached through', () => {
    store().setSelection(['view'])
    expect(store().selection).toEqual(['view'])
  })

  it('still opens another graph — a document load is not a canvas gesture', () => {
    store().loadGraph(emptyGraph('another'))
    expect(graph().meta?.name).toBe('another')
    expect(store().locked).toBe(true)
  })
})

/**
 * The list that keeps the guards honest.
 *
 * The lock is enforced as one `if (frozen()) return` per action, which is readable and local but
 * **fail-open**: nothing makes the author of the next structural action — align, group, paste —
 * think about it, and a missing guard is silent. So the partition is written down, and a store
 * action that is neither classified nor deliberately live fails this test until somebody decides
 * which it is. That decision is the whole feature; the list is just where it is recorded.
 */
describe('every store action is on one side of the lock', () => {
  /** Moves a card, restructures the graph, or moves the viewport: refused while locked. */
  const FROZEN = [
    'arrangeNodes',
    'addNode',
    'spliceNode',
    'moveNodes',
    'resizeNodes',
    'duplicateSelection',
    'deleteNodes',
    'deleteEdges',
    'connect',
    'reconnect',
    'applyAssistantPlan',
    'undo',
    'redo',
  ]

  /** Not the canvas — a param, a preference, a panel, a run, a document, or a read. */
  const LIVE = [
    'requestPalette',
    'requestNodeBrowser',
    'requestShare',
    'requestShortcuts',
    'requestFitView',
    'setAutoRun',
    'setAutoLayout',
    'toggleLocked',
    'setLayoutOptions',
    'toggleEdgeRouting',
    'setTheme',
    'togglePanel',
    'openEdgePanel',
    'closeEdgePanel',
    'attachEdgeSet',
    'openStartPage',
    'closeStartPage',
    'setStartPageDismissed',
    'expandNode',
    'openHelp',
    'setGraph',
    'setGraphName',
    'setGraphGist',
    'newGraph',
    'loadGraph',
    'loadExample',
    'loadStarter',
    'refreshLibrary',
    'saveToLibrary',
    'openFromLibrary',
    'renameInLibrary',
    'deleteFromLibrary',
    'setParam',
    'renameNode',
    'toggleDisabled',
    'toggleCollapsed',
    'toggleParamRows',
    'canConnect',
    'setSelection',
    'runAll',
    'runNode',
    'cancelRun',
    'invalidateNode',
    'clearNodeCache',
    'clearResults',
    'needsRun',
    'nodeInfo',
    'nodeInputs',
    'nodeOutput',
    'nodeFetchedAt',
    'nodeWarning',
    'setNotice',
  ]

  it('is classified, so a new one cannot slip past the lock unnoticed', () => {
    const state = useGraphStore.getState() as unknown as Record<string, unknown>
    const actions = Object.keys(state).filter((key) => typeof state[key] === 'function')
    const classified = new Set([...FROZEN, ...LIVE])
    const unclassified = actions.filter((name) => !classified.has(name))
    // If this fails: decide whether the new action edits the canvas. If it does, guard it with
    // `frozen()` and add it to FROZEN — with a case above proving it refuses. If it does not,
    // add it to LIVE.
    expect(unclassified).toEqual([])
    // And the other way, so a renamed or deleted action does not leave a stale name behind.
    expect([...classified].filter((name) => !actions.includes(name))).toEqual([])
  })
})

describe('the lock itself', () => {
  it('is off on a fresh store and toggles both ways', () => {
    expect(store().locked).toBe(false)
    store().toggleLocked()
    expect(store().locked).toBe(true)
    store().toggleLocked()
    expect(store().locked).toBe(false)
  })

  it('is not written into the document, so a saved or shared graph carries no lock', () => {
    useGraphStore.setState({ locked: true })
    expect(JSON.stringify(graph())).not.toMatch(/locked/)
  })
})
