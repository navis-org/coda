/**
 * The node packs as a set: every directory registered, and every file a surface finds by glob
 * keeping to its own pack. Plus the rename that moving ZapBench into one cost, read back.
 *
 * The files are found by the same globs the surfaces use, so a pack that drops a file in the
 * right place is checked without anybody adding it here. The one exception is `wizard.ts`, whose
 * ownership is refused at load by `wizard/contribute.ts` — a wizard file is code a dialog runs, so
 * a mis-owned id should not survive to be offered — and tested in `contribute.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { deserializeGraph } from '../core/graph'
import { currentType, getNodeDef, packOfType } from '../core/registry'
import {
  CUSTOM_DATASET_NODES,
  DATASET_FAMILIES,
  DATASET_NODE_PREFIX,
} from '../nodes/lib/datasetFamilies'
import { demoGraph } from '../wizard/demo'
import { PACKS } from '.'
import { SHORTCUTS } from './shortcuts'

const MANIFESTS = import.meta.glob('./*/index.ts')
const GLYPHS = import.meta.glob('./*/glyphs.ts', { eager: true, import: 'default' }) as Record<
  string,
  Record<string, unknown>
>
const GROUPS = import.meta.glob('./*/seeAlso.ts', { eager: true, import: 'default' }) as Record<
  string,
  readonly (readonly string[])[]
>

const dirOf = (path: string) => path.split('/')[1]!

describe('the packs', () => {
  it('registers every pack directory, under its directory name', () => {
    const dirs = Object.keys(MANIFESTS).map(dirOf).sort()
    expect(PACKS.map((p) => p.id).sort()).toEqual(dirs)
  })

  it("owns each of a pack's nodes, whether its ids carry the pack's prefix or not", () => {
    for (const pack of PACKS) {
      for (const node of pack.nodes) expect(packOfType(node.type), node.type).toBe(pack.id)
    }
  })

  it('lets only Connectome and its parts keep built-in ids — a new pack never takes the exception', () => {
    expect(PACKS.filter((p) => p.keepsBuiltInIds).map((p) => p.id)).toEqual([
      'connectome',
      'neuprint',
      'cave',
      'catmaid',
    ])
  })

  it("gives each backend's pack its custom dataset node, read off the table", () => {
    expect(packOfType('dataset.neuprint')).toBe('neuprint')
    expect(packOfType('dataset.cave')).toBe('cave')
    expect(packOfType('dataset.catmaid')).toBe('catmaid')
    expect(packOfType('dataset.mock.opticlobe')).toBeUndefined()
  })

  /*
   * A family or custom node whose backend no pack lists would be offered in New, on the start page
   * and in the wizard while its node type does not exist — nothing else fails.
   */
  it('registers a node for every dataset family and every custom dataset node', () => {
    for (const family of DATASET_FAMILIES) {
      expect(getNodeDef(DATASET_NODE_PREFIX + family.key), family.key).toBeTruthy()
    }
    for (const custom of CUSTOM_DATASET_NODES) {
      expect(getNodeDef(custom.type), custom.type).toBeTruthy()
    }
  })

  it('draws each pack with one of its own nodes', () => {
    for (const pack of PACKS) {
      if (pack.glyph === undefined) continue
      expect(
        pack.nodes.map((n) => n.type),
        pack.id,
      ).toContain(pack.glyph)
    }
  })

  it("keeps each pack's drawings to its own registered nodes", () => {
    for (const [path, glyphs] of Object.entries(GLYPHS)) {
      for (const type of Object.keys(glyphs)) {
        // The registry's answer, which is also the check that the type is registered at all.
        expect(packOfType(type), `${path}: ${type}`).toBe(dirOf(path))
      }
    }
  })

  it("puts one of the pack's own nodes in every See also group it brings", () => {
    for (const [path, groups] of Object.entries(GROUPS)) {
      for (const group of groups) {
        expect(
          group.some((type) => packOfType(type) === dirOf(path)),
          `${path}: ${group.join(', ')}`,
        ).toBe(true)
      }
    }
  })
})

describe('the shortcuts', () => {
  it('name only registered packs, under an id a path can carry', () => {
    const packs = new Set(PACKS.map((p) => p.id))
    for (const { id, packs: named } of SHORTCUTS) {
      expect(id, id).toMatch(/^[a-z][a-z0-9-]*$/)
      for (const pack of named) expect(packs.has(pack), `${id}: ${pack}`).toBe(true)
    }
  })
})

describe('ZapBench, moved into a pack', () => {
  it('answers its old ids with its new ones', () => {
    expect(currentType('zapbench.traces')).toBe('zapbench:traces')
    expect(currentType('zapbench.neurons')).toBe('zapbench:neurons')
    expect(currentType('zapbench.neuronTraces')).toBe('zapbench:neuronTraces')
  })

  it('loads a file saved before the move as the moved nodes, wires and settings intact', () => {
    const { graph, warnings } = deserializeGraph(
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'zt',
            type: 'zapbench.traces',
            position: { x: 0, y: 0 },
            params: { cells: '5-9' },
          },
          { id: 'zn', type: 'zapbench.neurons', position: { x: 300, y: 0 }, params: {} },
        ],
        edges: [
          {
            id: 'e',
            source: 'zt',
            sourceHandle: 'traces',
            target: 'zn',
            targetHandle: 'cells',
          },
        ],
      }),
    )
    expect(warnings).toEqual([])
    expect(graph.nodes.map((n) => n.type)).toEqual(['zapbench:traces', 'zapbench:neurons'])
    expect(graph.nodes[0]!.params['cells']).toBe('5-9')
    expect(graph.edges).toHaveLength(1)
  })

  it('opens a demo link written before the move', () => {
    const graph = demoGraph('zapbench.traces')
    expect(graph?.nodes.map((n) => n.type)).toContain('zapbench:traces')
  })
})
