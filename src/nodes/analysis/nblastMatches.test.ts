/**
 * The NBLAST Matches node's contract, and the seam under it.
 *
 * The Python is not testable here — vitest has no Pyodide — so what is checked is everything on
 * this side: the schema/value agreement (invariant 3), the direction rule, the clamping, and
 * that padding never reaches the table. `scripts/probe-matches.mjs` covers the other side, and
 * it is the one probe in the family that checks *numbers*, because parity with fastcore's
 * definitions of `percentage` and `skip_self` is the whole reason this node crosses the bridge.
 *
 * The division of labour is worth stating: everything below builds a `MatchesResult` by hand
 * and asserts what Coda does with it. Whether fastcore produces that result correctly is the
 * probe's question, not this file's.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { MatrixValue } from '../../core/values'
import { getColumn, makeMatrix } from '../../core/values'
import type { MatchesResult } from '../../pyodide/matches'
import type { MatchParams } from '../lib/matchOps'
import {
  checkMatchSize,
  checkSkipSelf,
  clampN,
  groupsAndCandidates,
  lowerIsBetter,
  matchIssues,
  matchRequestFrom,
  matchSchema,
  matchTable,
} from '../lib/matchOps'
import '../index'

function matrix(rows: number, cols: number, measure?: 'similarity' | 'distance'): MatrixValue {
  const values = new Float64Array(rows * cols)
  for (let i = 0; i < values.length; i++) values[i] = i / values.length
  return makeMatrix(
    Array.from({ length: rows }, (_, i) => `q${i}`),
    Array.from({ length: cols }, (_, i) => `t${i}`),
    values,
    'NBLAST score',
    measure,
  )
}

const PARAMS: MatchParams = {
  mode: 'top',
  axis: 0,
  direction: 'auto',
  skipSelf: true,
  n: 3,
  cutoff: 'threshold',
  threshold: 0.5,
  percentage: 0.05,
}

describe('matchOps — which way round the scores run', () => {
  it('reads the matrix when nobody overrode it', () => {
    expect(lowerIsBetter(matrix(4, 4, 'distance'), 'auto')).toBe(true)
    expect(lowerIsBetter(matrix(4, 4, 'similarity'), 'auto')).toBe(false)
  })

  it('treats an unstated measure as higher-is-better rather than as a refusal', () => {
    // A Pivot genuinely cannot say what its cells are, and refusing on a fact nobody stated
    // would break every graph that pivots a connectivity table and looks for the top partners.
    expect(lowerIsBetter(matrix(4, 4), 'auto')).toBe(false)
  })

  it('lets the override win in both directions', () => {
    expect(lowerIsBetter(matrix(4, 4, 'distance'), 'higher')).toBe(false)
    expect(lowerIsBetter(matrix(4, 4, 'similarity'), 'lower')).toBe(true)
  })
})

describe('matchOps — the axis, and what it means', () => {
  it('groups by row on axis 0 and by column on axis 1', () => {
    expect(groupsAndCandidates(matrix(5, 9), 0)).toEqual([5, 9])
    expect(groupsAndCandidates(matrix(5, 9), 1)).toEqual([9, 5])
  })
})

describe('matchOps — clamping, which is the alternative to a stack trace', () => {
  it('cuts n down to what the matrix can offer', () => {
    // fastcore raises when n exceeds the scanned axis, and the user set "top 20" on a card
    // that has no idea how wide the matrix is until it runs.
    expect(clampN(20, 9, false)).toBe(9)
    expect(clampN(20, 9, true)).toBe(8)
    expect(clampN(3, 9, true)).toBe(3)
  })

  it('never returns zero, however narrow the matrix', () => {
    expect(clampN(5, 1, true)).toBe(1)
    expect(clampN(5, 0, false)).toBe(1)
  })

  it('says so when it clamped, with both numbers', () => {
    const said: string[] = []
    checkMatchSize({ warn: (m) => said.push(m) }, matrix(5, 4), { ...PARAMS, n: 20 })
    expect(said.join(' ')).toMatch(/top 20/)
    expect(said.join(' ')).toMatch(/returned 3/)
  })

  it('says nothing when it did not clamp', () => {
    const said: string[] = []
    checkMatchSize({ warn: (m) => said.push(m) }, matrix(5, 9), { ...PARAMS, n: 3 })
    expect(said).toEqual([])
  })
})

describe('matchOps — the self-skip', () => {
  it('refuses a rectangular matrix, which has no diagonal to skip', () => {
    expect(() => checkSkipSelf(matrix(5, 9), true)).toThrow(/no diagonal/)
  })

  it('allows it on a square one, and allows it off on any', () => {
    expect(() => checkSkipSelf(matrix(9, 9), true)).not.toThrow()
    expect(() => checkSkipSelf(matrix(5, 9), false)).not.toThrow()
  })
})

describe('matchOps — the request', () => {
  it('copies the scores rather than handing over the upstream buffer', () => {
    // `callPython` transfers, so passing the matrix's own buffer would detach the scheduler's
    // cached result for the node above and leave it empty on the next render.
    const m = matrix(4, 4)
    const request = matchRequestFrom(m, PARAMS)
    expect(request.scores).not.toBe(m.values)
    expect(Array.from(request.scores)).toEqual(Array.from(m.values))
  })

  it('carries the clamped n, not the one on the card', () => {
    expect(matchRequestFrom(matrix(5, 4), { ...PARAMS, n: 20 }).n).toBe(3)
  })

  it('resolves the direction before it crosses', () => {
    expect(matchRequestFrom(matrix(4, 4, 'distance'), PARAMS).distances).toBe(true)
    expect(matchRequestFrom(matrix(4, 4, 'similarity'), PARAMS).distances).toBe(false)
  })
})

describe('matchOps — the schema half and the value half', () => {
  const labelled = makeMatrix(
    ['a', 'b'],
    ['x', 'y', 'z'],
    Float64Array.from([0.9, 0.5, 0.1, 0.2, 0.8, 0.4]),
    'NBLAST score',
    'similarity',
  )

  const agrees = (table: ReturnType<typeof matchTable>, mode: 'top' | 'above' | 'count') => {
    expect(table.schema.columns.map((c) => c.name)).toEqual(
      matchSchema(mode).columns.map((c) => c.name),
    )
    // The half that breaks only after a run: every promised column has to actually be there.
    for (const c of matchSchema(mode).columns) expect(table.data[c.name]).toBeDefined()
  }

  it('produces the columns it promised, for every mode', () => {
    const top: MatchesResult = {
      mode: 'top',
      idx: Int32Array.from([0, 1, 1, 2]),
      values: Float64Array.from([0.9, 0.5, 0.8, 0.4]),
      groups: 2,
      n: 2,
    }
    agrees(matchTable(labelled, top, 0), 'top')

    const above: MatchesResult = {
      mode: 'above',
      offsets: Int32Array.from([0, 2, 3]),
      idx: Int32Array.from([0, 1, 1]),
      values: Float64Array.from([0.9, 0.5, 0.8]),
      groups: 2,
    }
    agrees(matchTable(labelled, above, 0), 'above')

    const counts: MatchesResult = { mode: 'count', counts: Int32Array.from([2, 1]), groups: 2 }
    agrees(matchTable(labelled, counts, 0), 'count')
  })

  it('calls the value column `score` whatever the matrix called its cells', () => {
    // Invariant 3: `valueLabel` is data, so a schema named from it could not be inferred and
    // would break every downstream picker the moment somebody pressed Run.
    const odd = makeMatrix(['a'], ['x'], Float64Array.from([1]), 'connections', 'count')
    const table = matchTable(
      odd,
      {
        mode: 'top',
        idx: Int32Array.from([0]),
        values: Float64Array.from([1]),
        groups: 1,
        n: 1,
      },
      0,
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'query',
      'target',
      'rank',
      'score',
    ])
  })

  it('names the group and the match from the right axes', () => {
    const table = matchTable(
      labelled,
      {
        mode: 'top',
        idx: Int32Array.from([0, 1, 1, 2]),
        values: Float64Array.from([0.9, 0.5, 0.8, 0.4]),
        groups: 2,
        n: 2,
      },
      0,
    )
    expect(getColumn(table, 'query')).toEqual(['a', 'a', 'b', 'b'])
    expect(getColumn(table, 'target')).toEqual(['x', 'y', 'y', 'z'])
    expect(getColumn(table, 'rank')).toEqual([1, 2, 1, 2])
  })

  it('swaps them on axis 1, where the group is a column', () => {
    // The one thing `axis` controls, and the one that is invisible on a square matrix.
    const table = matchTable(
      labelled,
      {
        mode: 'top',
        idx: Int32Array.from([0, 1, 0]),
        values: Float64Array.from([0.9, 0.8, 0.1]),
        groups: 3,
        n: 1,
      },
      1,
    )
    expect(getColumn(table, 'query')).toEqual(['x', 'y', 'z'])
    expect(getColumn(table, 'target')).toEqual(['a', 'b', 'a'])
  })

  it('drops fastcore’s padding rather than putting a match called -1 in front of somebody', () => {
    const padded: MatchesResult = {
      mode: 'top',
      idx: Int32Array.from([0, -1, 1, 2]),
      values: Float64Array.from([0.9, NaN, 0.8, 0.4]),
      groups: 2,
      n: 2,
    }
    const table = matchTable(labelled, padded, 0)
    expect(table.length).toBe(3)
    expect(getColumn(table, 'target')).toEqual(['x', 'y', 'z'])
  })

  it('drops a non-finite score even where the index survived', () => {
    const table = matchTable(
      labelled,
      {
        mode: 'top',
        idx: Int32Array.from([0, 1]),
        values: Float64Array.from([0.9, -Infinity]),
        groups: 1,
        n: 2,
      },
      0,
    )
    expect(table.length).toBe(1)
  })

  it('ranks each group from 1, restarting per group', () => {
    const table = matchTable(
      labelled,
      {
        mode: 'above',
        offsets: Int32Array.from([0, 2, 3]),
        idx: Int32Array.from([0, 1, 1]),
        values: Float64Array.from([0.9, 0.5, 0.8]),
        groups: 2,
      },
      0,
    )
    expect(getColumn(table, 'rank')).toEqual([1, 2, 1])
  })

  it('gives a count table one row per group, cutoff or no cutoff', () => {
    const table = matchTable(
      labelled,
      { mode: 'count', counts: Int32Array.from([2, 0]), groups: 2 },
      0,
    )
    expect(getColumn(table, 'query')).toEqual(['a', 'b'])
    expect(getColumn(table, 'matches')).toEqual([2, 0])
  })
})

describe('matchOps — edit-time issues', () => {
  it('catches a percentage typed as a percent', () => {
    expect(
      matchIssues({ ...PARAMS, mode: 'above', cutoff: 'percentage', percentage: 5 }).join(' '),
    ).toMatch(/fraction/)
  })

  it('says nothing about a percentage that is one', () => {
    expect(
      matchIssues({ ...PARAMS, mode: 'above', cutoff: 'percentage', percentage: 0.05 }),
    ).toEqual([])
    expect(matchIssues(PARAMS)).toEqual([])
  })
})

describe('neuron.nblastMatches — the definition', () => {
  it('publishes a table whose columns follow the mode, with no observed fallback', () => {
    const def = requireNodeDef('neuron.nblastMatches')
    // `makeInferContext` rather than a hand-rolled literal, so a new member on `InferContext`
    // is one edit rather than ten, and so the columns resolve the way the editor resolves them.
    const infer = (mode: string) =>
      def.inferOutputs?.(makeInferContext(def, { ...defaultParams(def), mode }, {}))
    const top = infer('top')?.matches
    const count = infer('count')?.matches
    expect(
      top && 'schema' in top && top.schema ? top.schema.columns.map((c) => c.name) : [],
    ).toEqual(['query', 'target', 'rank', 'score'])
    expect(
      count && 'schema' in count && count.schema ? count.schema.columns.map((c) => c.name) : [],
    ).toEqual(['query', 'matches'])
    // Derivable, so it must be derived rather than read back off the last run.
    expect(def.observesOutputSchema).toBeFalsy()
  })

  it('is expensive, so a threshold field does not fire a run per keystroke', () => {
    expect(requireNodeDef('neuron.nblastMatches').cost).toBe('expensive')
  })
})
