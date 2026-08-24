/**
 * Landmark Transform: reading somebody else's registration off a table.
 *
 * The arithmetic is three multiplications, so what is worth testing is the refusals and the
 * unit conversion — plus the one design decision that is the opposite of the obvious one, which
 * is that the six column pickers are *required* rather than optional. That is easy to "fix"
 * back, so it is pinned here with the reason.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import {
  MIN_LANDMARKS,
  checkLandmarkCount,
  landmarkTriple,
} from '../lib/transformOps'
import { scaleFor } from '../../data/transforms/landmarks'
import { makeTable } from '../../core/values'
import type { TableValue } from '../../core/values'
import '../index'

const COLUMNS = ['x', 'y', 'z', 'x2', 'y2', 'z2'] as const
const PICKED = {
  sourceX: 'x',
  sourceY: 'y',
  sourceZ: 'z',
  targetX: 'x2',
  targetY: 'y2',
  targetZ: 'z2',
}

/** Four landmarks, the floor for a 3-D spline, with the target side a fixed offset away. */
function landmarks(rows = 4, offset = 10): TableValue {
  const data: Record<string, number[]> = {}
  for (const name of COLUMNS) data[name] = []
  for (let i = 0; i < rows; i++) {
    data.x!.push(i)
    data.y!.push(i * 2)
    data.z!.push(i * 3)
    data.x2!.push(i + offset)
    data.y2!.push(i * 2 + offset)
    data.z2!.push(i * 3 + offset)
  }
  return makeTable(tableSchema(...COLUMNS.map((name) => column(name, 'f64'))), data)
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** Just enough graph for the type-level questions: the value half is tested through the ops. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('landmark-test')
  g = addNode(g, node('table', 'core.tableFromUrl', { url: 'https://example.org/lm.csv' }))
  g = addNode(g, node('lm', 'core.landmarkTransform', params))
  g = addEdge(g, { source: 'table', sourceHandle: 'out', target: 'lm', targetHandle: 'in' })
  return g
}

describe('core.landmarkTransform — the six pickers', () => {
  it('promises a transform whatever is upstream', () => {
    // A transform carries no schema — its landmarks are data, decided by the run — so there is
    // nothing to infer beyond the kind. Same answer NBLAST gives for its matrix.
    const out = inferGraph(pipeline(PICKED)).nodes['lm']?.outputs['transform']
    expect(out?.kind).toBe('transform')
  })

  it('refuses six pickers that landed on the same column', () => {
    /*
     * Which is what an *unset* set of pickers looks like: six required pickers over one port
     * with one dtype list all fall back to the same first compatible column. That is why they
     * are required rather than optional — an optional picker's choice is dropped whenever the
     * schema is not visible, and an uploaded table's schema is missing on every reload until
     * the browser peek settles. See the node's header.
     */
    const issues = inferGraph(pipeline()).nodes['lm']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toMatch(/must be different|Pick all six/)
  })

  it('keeps an explicit choice even where the schema cannot be seen', () => {
    // The property that made `optional: false` the right call: `core.tableFromUrl` publishes no
    // schema until it has fetched, and these six names have to survive that.
    const issues = inferGraph(pipeline(PICKED)).nodes['lm']?.issues ?? []
    expect(issues).toEqual([])
  })
})

describe('reading landmarks off a table', () => {
  it('interleaves three columns into one xyz buffer', () => {
    const table = landmarks(3)
    const out = landmarkTriple(table, ['x', 'y', 'z'], 1)
    expect(out.length).toBe(9)
    // Row 1 is (1, 2, 3) by construction, interleaved rather than column-major.
    expect([...out.slice(3, 6)]).toEqual([1, 2, 3])
  })

  it('converts micrometres to nanometres, per side', () => {
    /*
     * Per side rather than one setting for both, because the two halves of a real registration
     * routinely differ — Coda's own hub landmarks are nanometres against micrometres. One
     * control would silently scale one of them.
     */
    expect(scaleFor('um')).toBe(1000)
    expect(scaleFor('nm')).toBe(1)
    // The node narrows its param to this union before calling, so an unrecognised value cannot
    // reach here — `unitsOf` reads anything else as the declared default.

    const table = landmarks(4)
    const nm = landmarkTriple(table, ['x2', 'y2', 'z2'], scaleFor('nm'))
    const um = landmarkTriple(table, ['x2', 'y2', 'z2'], scaleFor('um'))
    expect(um[0]).toBe(nm[0]! * 1000)
  })

  it('is float64, unlike the geometry it will be applied to', () => {
    // Landmarks are what a spline is *fitted from*, and the fit is a cubic solve whose
    // conditioning is worse than anything the transform itself does.
    expect(landmarkTriple(landmarks(4), ['x', 'y', 'z'], 1)).toBeInstanceOf(Float64Array)
  })

  it('refuses a missing coordinate by row, rather than substituting zero', () => {
    /*
     * A spline interpolates its landmarks *exactly*, so a bad pair is not averaged away — it is
     * honoured. Zero would pin a control point at the origin and drag every neuron near it,
     * which draws perfectly well.
     */
    const table = landmarks(4)
    const holed = makeTable(table.schema, { ...table.data, y: [0, null, 2, 3] })
    expect(() => landmarkTriple(holed, ['x', 'y', 'z'], 1)).toThrow(/Row 2 of "y"/)
    expect(() => landmarkTriple(holed, ['x', 'y', 'z'], 1)).toThrow(/interpolates its landmarks/)
  })

  it('names a column that is not there', () => {
    expect(() => landmarkTriple(landmarks(4), ['x', 'nope', 'z'], 1)).toThrow(/no column called/)
  })

  it('refuses fewer landmarks than a 3-D spline can be fitted from', () => {
    // Three points define a plane; the affine part alone needs four. fastcore refuses below it
    // too, and refusing here names the table rather than surfacing as a Python error.
    expect(MIN_LANDMARKS).toBe(4)
    expect(() => checkLandmarkCount(3)).toThrow(/at least 4 landmarks/)
    expect(() => checkLandmarkCount(4)).not.toThrow()
  })
})
