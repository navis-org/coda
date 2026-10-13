import { describe, expect, it } from 'vitest'
import reference from './__fixtures__/neuron-reference.json'
import { compartmentAt, discretize } from './discretize'
import {
  REFERENCE_CASES,
  buildCase,
  caseNamed,
  cutMaxLength as cut,
  straightCable,
} from './referenceCases'

const RA = 100
const CM = 1

describe('discretize', () => {
  it('cuts every section into the d_lambda count NEURON computes for it', () => {
    for (const fixture of reference.cases) {
      const { tree } = buildCase(caseNamed(fixture.name))
      // The fixture records our count when it was generated; drift there is a change of rule.
      expect(tree.sections.map((s) => s.nseg)).toEqual(fixture.ourNseg)
      if ('neuronNseg' in fixture) expect(fixture.ourNseg).toEqual(fixture.neuronNseg)
    }
  })

  it('never leaves a compartment longer than the cap, unlike navis’s rounding', () => {
    // navis: 1 + 2·int(19 / 20) = 1, a single 19 µm segment under a 10 µm cap.
    const tree = cut(straightCable([0, 19], [1, 1]), 10)
    expect(tree.sections[0]!.nseg).toBe(3)
    for (const length of [1, 9.99, 10, 10.01, 20, 31, 100]) {
      const { sections } = cut(straightCable([0, length], [1, 1]), 10)
      const { nseg } = sections[0]!
      expect(nseg % 2).toBe(1)
      expect(length / nseg).toBeLessThanOrEqual(10)
    }
  })

  it('numbers every compartment after its parent, with zero-area junctions', () => {
    for (const c of REFERENCE_CASES) {
      const { tree } = buildCase(c)
      expect(tree.parent[0]).toBe(-1)
      for (let i = 1; i < tree.count; i++) expect(tree.parent[i]).toBeLessThan(i)
      // The root and each section's end node carry no membrane.
      expect(tree.area[0]).toBe(0)
      for (const s of tree.sections) expect(tree.area[s.first + s.nseg]).toBe(0)
    }
  })

  it('integrates a cone rather than averaging its radius', () => {
    const r1 = 2
    const r2 = 0.5
    const length = 200
    const tree = cut(straightCable([0, 50, 100, 150, 200], [2, 1.625, 1.25, 0.875, 0.5]), 7)
    // Lateral area of the frustum: π (r1 + r2) · slant.
    const total = tree.area.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(Math.PI * (r1 + r2) * Math.hypot(length, r1 - r2), 6)

    // Root-to-tip axial resistance: Ra·L / (π r1 r2), in MΩ (×1e-2 for Ω·cm·µm/µm²).
    let path = 0
    for (let c = 1; c < tree.count; c++) path += 1 / tree.gAxial[c]!
    const exact = (1e-2 * RA * length) / (Math.PI * r1 * r2)
    expect(path).toBeCloseTo(exact, 6)
    // The mean-radius cylinder this replaces is off by more than a third.
    const meanR = (r1 + r2) / 2
    expect(
      Math.abs((1e-2 * RA * length) / (Math.PI * meanR * meanR) - exact) / exact,
    ).toBeGreaterThan(0.35)
  })

  it('maps nodes to compartments as NEURON’s sec(x) does', () => {
    // One 30 µm section of three segments: nodes at x = 0, 1/3, 0.5, 1.
    const tree = cut(straightCable([0, 10, 15, 30], [1, 1, 1, 1]), 10)
    const { first, nseg } = tree.sections[0]!
    expect(nseg).toBe(3)
    expect(Array.from(tree.nodeCompartment)).toEqual([
      0, // the root: the section's 0 end
      first + 1, // x = 1/3 lies on the boundary and goes up, as NEURON's does
      first + 1,
      first + nseg, // x = 1: the end node
    ])
  })

  it('places a point on an edge by the same rule as a node', () => {
    // 30 µm, three segments of 10: nodes at 0, 10, 15 and 30 µm.
    const tree = cut(straightCable([0, 10, 15, 30], [1, 1, 1, 1]), 10)
    const { first } = tree.sections[0]!
    for (let node = 1; node < 4; node++) {
      expect(compartmentAt(tree, node, 1)).toBe(tree.nodeCompartment[node])
    }
    // Halfway along 0→10 is 5 µm, the first segment; halfway along 15→30 is 22.5 µm, the third.
    expect(compartmentAt(tree, 1, 0.5)).toBe(first)
    expect(compartmentAt(tree, 3, 0.5)).toBe(first + 2)
    // The start of the first edge is the root; the root itself has no edge.
    expect(compartmentAt(tree, 1, 0)).toBe(0)
    expect(compartmentAt(tree, 0, 0.5)).toBe(0)
  })

  it('starts a section at its own radius, with no shoulder at the junction', () => {
    const { tree } = buildCase(caseNamed('soma-step'))
    const total = tree.area.reduce((a, b) => a + b, 0)
    // The soma's lateral area and two straight fibres, nothing else.
    const cylinder = (r: number, length: number) => 2 * Math.PI * r * length
    const exact = cylinder(1.3, 2.6) + cylinder(0.2, 50) + cylinder(0.15, 40)
    expect(total).toBeCloseTo(exact, 6)
    // Without `startRadius` each fibre's first piece is a cone down from the soma's radius.
    const c = caseNamed('soma-step')
    const { startRadius: _, ...coned } = c.tree
    const without = buildCase({ ...c, tree: coned }).tree.area.reduce((a, b) => a + b, 0)
    expect(without).toBeGreaterThan(exact * 1.3)
  })

  it('breaks a section where a single child starts at its own radius', () => {
    // A 10 µm soma-like stretch at r = 2, then one thin process at r = 0.2: no branch point, but
    // the jump is a section boundary, so the process is a cylinder rather than a cone.
    const tree = cut(
      {
        ...straightCable([0, 10, 60], [2, 2, 0.2]),
        startRadius: Float64Array.of(NaN, NaN, 0.2),
      },
      5,
    )
    expect(tree.sections.length).toBe(2)
    const total = tree.area.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(2 * Math.PI * 2 * 10 + 2 * Math.PI * 0.2 * 50, 6)
  })

  it('labels a compartment by the node nearest its centre, whichever way the tree points', () => {
    const labels = [1, 1, 3, 3]
    const forward = cut(straightCable([0, 10, 20, 30], [1, 1, 1, 1], labels), 10)
    // Centres at 5, 15 and 25 µm: 5 is nearer node 0 or 1 (tie → 0), 15 a tie of 1 and 2 → 1.
    expect(Array.from(forward.region)).toEqual([1, 1, 1, 3, 3])

    // The same cable rooted at the other end: same labels on the same stretches of cable.
    const reversed = {
      ...straightCable([0, 10, 20, 30], [1, 1, 1, 1], labels),
      parent: Int32Array.of(1, 2, 3, -1),
    }
    const backward = cut(reversed, 10)
    expect(Array.from(backward.region)).toEqual([3, 3, 1, 1, 1])
  })

  it('refuses a forest, a cycle, a missing radius and mismatched arrays', () => {
    const options = { rule: { kind: 'maxLength', length: 10 } as const, ra: RA, cm: CM }
    expect(() =>
      discretize(
        {
          positions: new Float64Array(6),
          radii: Float64Array.of(1, 1),
          parent: Int32Array.of(-1, -1),
        },
        options,
      ),
    ).toThrow(/exactly one root/)
    expect(() =>
      discretize(
        {
          positions: new Float64Array(9),
          radii: Float64Array.of(1, 1, 1),
          parent: Int32Array.of(-1, 2, 1),
        },
        options,
      ),
    ).toThrow(/connected/)
    expect(() => discretize(straightCable([0, 10], [1, 0]), options)).toThrow(/no radius/)
    // A Uint8Array would wrap these to 255 and 0 without a word.
    expect(() => discretize(straightCable([0, 10], [1, 1], [-1, 3]), options)).toThrow(/0–255/)
    expect(() => discretize(straightCable([0, 10], [1, 1], [256, 3]), options)).toThrow(/0–255/)
    expect(() =>
      discretize(
        {
          positions: new Float64Array(3),
          radii: Float64Array.of(1, 1),
          parent: Int32Array.of(-1, 0),
        },
        options,
      ),
    ).toThrow(/same nodes/)
  })
})
