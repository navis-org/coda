import { describe, expect, it } from 'vitest'

import { routeToTargets, servedDatasets } from './routing'

const routeSelection = (
  ids: readonly (string | null)[],
  datasets: readonly (string | null)[] | undefined,
  serves: readonly string[],
) => routeToTargets(ids, datasets, [serves]).routes[0]

describe('routing a selection to a target', () => {
  it('takes every neuron, once each, when the target serves everything', () => {
    expect(routeSelection(['1', '2', '1', null], undefined, [])).toEqual(['1', '2'])
  })

  it('reads a qualified id’s dataset, and asks the target about the id alone', () => {
    const routed = routeSelection(
      ['flywire:720575940621522189', 'hemibrain:10035'],
      undefined,
      ['flywire'],
    )
    expect(routed).toEqual(['720575940621522189'])
  })

  it('reads a dataset column beside plain ids, as a BigClust project has', () => {
    const routed = routeSelection(['1', '2', '3'], ['FlyWire', 'hemibrain', null], ['flywire'])
    // Case ignored; a neuron with no dataset at all is not this target's either.
    expect(routed).toEqual(['1'])
  })

  it('takes the typed list of datasets comma-separated, case and spaces ignored', () => {
    expect(servedDatasets(' FlyWire, hemibrain ,, ')).toEqual(['flywire', 'hemibrain'])
  })

  it('counts the neurons no target serves, across every target', () => {
    const ids = ['flywire:1', 'hemibrain:2', 'mcns:3', 'flywire:1']
    expect(routeToTargets(ids, undefined, [['flywire'], ['hemibrain']])).toEqual({
      routes: [['1'], ['2']],
      unserved: 1,
    })
    expect(routeToTargets(ids, undefined, [['flywire'], []]).unserved).toBe(0)
  })
})
