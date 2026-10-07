import { describe, expect, it } from 'vitest'

import { daylightLayout } from './arborDaylight'
import { equalAngleLayout } from './arborLayout'
import { buildArbor, keyTree, landmarkDistances } from './arborOps'
import { arbour } from './__fixtures__/arbour'

describe('daylightLayout', () => {
  it('answers what equalAngleLayout answers, where there is no Worker to send it to', async () => {
    // Node has no `Worker`, so this is the on-thread fallback — the one path jsdom and the tests
    // take, and the one the card's first frame relies on when a worker cannot be spawned.
    const arbor = buildArbor(arbour(600, 5, { jump: 0.08, step: 800 }), 0)
    const tree = keyTree(arbor)
    const d = landmarkDistances(tree, arbor.geodesic)
    const off = await daylightLayout(tree, d, 2)
    const on = equalAngleLayout(tree, d, 2)
    expect(Array.from(off.x1)).toEqual(Array.from(on.x1))
    expect(Array.from(off.y1)).toEqual(Array.from(on.y1))
  })
})
