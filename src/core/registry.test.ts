/**
 * What `registerNode` refuses about a definition as a whole: an id outside the type grammar, the
 * placeholder's reserved id, and a change made after registration.
 *
 * The structural checks on ports and params each live with their subject (`ports.test.ts`,
 * `sockets.test.ts`, `companions.test.ts`).
 */

import { describe, expect, it } from 'vitest'

import { MISSING_TYPE } from './missing'
import type { NodeDefinition } from './node'
import { nodeTypeProblem, packOf, typeStem } from './nodeType'
import { packOfType, registerNode, registerPack } from './registry'
import type { PackDefinition } from './registry'
import { T } from './types'

function def(type: string): NodeDefinition {
  return {
    type,
    label: 'Test',
    category: 'utility',
    cost: 'cheap',
    outputs: [{ id: 'out', type: T.number() }],
    params: [{ id: 'n', label: 'N', kind: 'int', default: 1 }],
    evaluate: () => ({ out: { kind: 'number', value: 1 } }),
  }
}

function pack(id: string, nodes: NodeDefinition[]): PackDefinition {
  return { id, label: id, description: '', nodes }
}

describe('the type grammar', () => {
  it('takes a dotted built-in id, and a pack-prefixed one with or without dots of its own', () => {
    expect(nodeTypeProblem('core.filterTable')).toBeUndefined()
    expect(nodeTypeProblem('dataset.catmaid.l1')).toBeUndefined()
    expect(nodeTypeProblem('zapbench:traces')).toBeUndefined()
    expect(nodeTypeProblem('light:reader.tiff')).toBeUndefined()
    expect(nodeTypeProblem('light-sheet:reader')).toBeUndefined()
  })

  it('refuses an undotted built-in id, a bad pack id and an empty name', () => {
    expect(nodeTypeProblem('filter')).toMatch(/dotted/)
    expect(nodeTypeProblem('Core.filter')).toMatch(/dotted/)
    expect(nodeTypeProblem('Light:reader.tiff')).toMatch(/pack id/)
    expect(nodeTypeProblem(':reader.tiff')).toMatch(/pack id/)
    // A hyphen only between runs: `a-` and `a--b` would fold onto other ids' keys.
    expect(nodeTypeProblem('light-:reader')).toMatch(/pack id/)
    expect(nodeTypeProblem('light--sheet:reader')).toMatch(/pack id/)
    expect(nodeTypeProblem('light:')).toMatch(/a name/)
    expect(nodeTypeProblem('light:Reader')).toMatch(/a name/)
  })

  it('reads a type down to its stem, for a readable node id', () => {
    expect(typeStem('core.filterTable')).toBe('filterTable')
    expect(typeStem('zapbench:traces')).toBe('traces')
  })

  it('names the pack a type belongs to, and none for a built-in one', () => {
    expect(packOf('light:reader.tiff')).toBe('light')
    expect(packOf('core.filterTable')).toBeUndefined()
    expect(packOf(':reader.tiff')).toBeUndefined()
  })
})

describe('registerNode', () => {
  it('refuses an id outside the grammar when the module is imported, not when a file is saved', () => {
    expect(() => registerNode(def('ungrouped'))).toThrow(/"ungrouped" is not a node type id/)
  })

  it('refuses the placeholder id', () => {
    expect(() => registerNode(def(MISSING_TYPE))).toThrow(/placeholder/)
  })

  it('freezes a definition, down to its ports, params and their types', () => {
    const registered = registerNode(def('test.frozen'))
    expect(() => {
      ;(registered as { evaluate: unknown }).evaluate = () => ({})
    }).toThrow(TypeError)
    expect(() => {
      ;(registered.params as unknown[]).push({ id: 'x', label: 'X', kind: 'bool' })
    }).toThrow(TypeError)
    expect(Object.isFrozen(registered.outputs![0])).toBe(true)
    expect(Object.isFrozen((registered.outputs![0] as { type: object }).type)).toBe(true)
  })
})

describe('registerPack', () => {
  it("registers a pack's nodes, and a pack's type nowhere else", () => {
    registerPack(pack('testpack', [def('testpack:thing')]))
    expect(() => registerNode(def('testpack:other'))).toThrow(
      /registers through `registerPack`/,
    )
  })

  it('refuses a built-in type inside a pack, and a pack registered twice', () => {
    expect(() => registerPack(pack('rogue', [def('test.builtIn')]))).toThrow(
      /built-in type, and the rogue pack cannot register it/,
    )
    expect(() => registerPack(pack('testpack', []))).toThrow(/Duplicate pack/)
    expect(() => registerPack(pack('Bad_Pack', []))).toThrow(/not a pack id/)
  })

  it('refuses two live types that fold to one key, in whichever order they arrive', () => {
    // Each pair shares a node-guide anchor; the second is the one a family check let through.
    registerNode(def('famous.thing'))
    expect(() => registerPack(pack('famous', [def('famous:thing')]))).toThrow(
      /fold to the same key "famous-thing"/,
    )
    registerPack(pack('dataset-x', [def('dataset-x:fafb')]))
    expect(() => registerNode(def('dataset.x.fafb'))).toThrow(/fold to the same key/)
  })
})

describe('a pack keeping built-in ids, and one needing another', () => {
  it('lets a pack that says so own built-in ids, and names it as their owner', () => {
    registerPack({ ...pack('adopter', [def('adopted.thing')]), keepsBuiltInIds: true })
    expect(packOfType('adopted.thing')).toBe('adopter')
    expect(packOfType('core.nothingHere')).toBeUndefined()
  })

  it('refuses a pack registered before a pack it requires', () => {
    expect(() => registerPack({ ...pack('early', []), requires: ['late'] })).toThrow(
      /requires "late", which must be registered before it/,
    )
  })
})

describe('formerTypes', () => {
  it('refuses a former id that is live, claimed twice, or re-registered as live', () => {
    registerNode({ ...def('test.renamed'), formerTypes: ['test.oldName'] })
    expect(() => registerNode({ ...def('test.again'), formerTypes: ['test.oldName'] })).toThrow(
      /"test.renamed" already does/,
    )
    expect(() =>
      registerNode({ ...def('test.greedy'), formerTypes: ['test.renamed'] }),
    ).toThrow(/not free/)
    expect(() => registerNode(def('test.oldName'))).toThrow(/former id of "test.renamed"/)
  })
})
