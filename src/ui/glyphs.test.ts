/**
 * The drawing table, checked headlessly — no React, because none of what can go wrong here
 * needs a DOM.
 *
 * Two failure modes are silent and both arrived with the table. A mistyped key still compiles,
 * still lints, and simply hands that node the category fallback, which looks like a node
 * nobody drew rather than like a bug. And the two renderers can now disagree about an
 * attribute name, which shows up as `nodes.html` drawing a glyph at the wrong weight while the
 * app draws it correctly — a difference nobody sees without opening both.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { allNodeDefs } from '../core/registry'
import { DATASET_FAMILIES, familyForNodeType } from '../nodes/lib/datasetFamilies'
import {
  CATEGORY_GLYPHS,
  DATASET_GLYPHS,
  GLYPH_STROKE_WIDTH,
  NODE_GLYPHS,
  glyphMarkup,
  glyphShapes,
  specimenShapes,
} from './glyphs'

const registered = new Set(allNodeDefs().map((def) => def.type))

describe('the glyph table', () => {
  it('keys every entry on a node type that exists', () => {
    // The silent one: `core.filterTabel` draws a plain table and says nothing.
    const unknown = Object.keys(NODE_GLYPHS).filter((type) => !registered.has(type))
    expect(unknown).toEqual([])
  })

  it('draws something for every registered node', () => {
    for (const def of allNodeDefs()) {
      const shapes = glyphShapes(def.type, def.category, familyForNodeType(def.type)?.glyph)
      expect(shapes.length, def.type).toBeGreaterThan(0)
    }
  })

  it('gives every dataset family a silhouette with shapes in it', () => {
    // The type system already guarantees a *key* — `DatasetFamily.glyph` is a `DatasetGlyph`
    // and the table is total over it — so the only thing left to assert is that it drew.
    for (const family of DATASET_FAMILIES) {
      expect(DATASET_GLYPHS[family.glyph].length, family.key).toBeGreaterThan(0)
    }
  })

  it('keeps the category fallback complete, so adding a node needs no drawing', () => {
    /*
     * Deliberately not an exhaustive list of which nodes fall through: `glyphs.ts` and
     * `docs/canvas.md` both promise that adding a node without a drawing is free, and a test
     * that fails when somebody does exactly that would make the promise false. What has to hold
     * is that the fallback covers every category a node can declare.
     */
    for (const category of new Set(allNodeDefs().map((def) => def.category))) {
      expect(CATEGORY_GLYPHS[category].length, category).toBeGreaterThan(0)
    }
    // And that the generic Dataset node is still the one type using it on purpose.
    expect(NODE_GLYPHS['neuron.dataset']).toBeUndefined()
    expect(glyphShapes('neuron.dataset', 'dataset', undefined)).toBe(CATEGORY_GLYPHS.dataset)
  })
})

describe('specimenShapes', () => {
  it('puts back exactly the stroke weight the scale takes away', () => {
    // Off by any amount and every dataset tile draws at a different weight from every other
    // node, which reads as a rendering fault rather than as an arithmetic one.
    const [group] = specimenShapes('fly_cns')
    const scale = Number(/scale\(([\d.]+)\)/.exec(group![1].transform ?? '')![1])
    expect(Number(group![1].strokeWidth) * scale).toBeCloseTo(GLYPH_STROKE_WIDTH, 2)
  })

  it('adds a mark to a silhouette without replacing it', () => {
    /*
     * FIB-19's crop edge. Resolved through the family rather than against a transcribed
     * `fly_optic`, so re-drawing that silhouette moves this tile with it — the failure the
     * separate `DATASET_MARKS` table exists to make unspellable.
     */
    const family = familyForNodeType('dataset.fib19')!
    const shapes = glyphShapes('dataset.fib19', 'dataset', family.glyph)
    const children = shapes[0]![2] ?? []
    expect(children.length).toBe(DATASET_GLYPHS[family.glyph].length + 1)
  })
})

describe('glyphMarkup', () => {
  it('writes attributes in SVG spelling, not React’s', () => {
    expect(glyphMarkup(NODE_GLYPHS['out.heatmap']!)).toContain('fill-opacity=')
    expect(glyphMarkup(NODE_GLYPHS['out.heatmap']!)).not.toContain('fillOpacity')
  })

  it('nests the scaling group rather than flattening it', () => {
    const markup = glyphMarkup(specimenShapes('mouse_brain'))
    expect(markup.startsWith('<g ')).toBe(true)
    expect(markup.endsWith('</g>')).toBe(true)
    expect(markup).toContain('stroke-width=')
  })

  it('emits well-formed markup for every registered node', () => {
    for (const def of allNodeDefs()) {
      const markup = glyphMarkup(
        glyphShapes(def.type, def.category, familyForNodeType(def.type)?.glyph),
      )
      // Tags opened and closed in step: the string renderer's one way to produce garbage.
      const opened = markup.match(/<\w+/g) ?? []
      const closed = markup.match(/(?:\/>|<\/\w+>)/g) ?? []
      expect(opened.length, def.type).toBe(closed.length)
    }
  })
})
