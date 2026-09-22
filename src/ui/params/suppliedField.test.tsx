// @vitest-environment jsdom

/**
 * A string field a wire answers for (`StringParam.supplied`).
 *
 * Reported on `CAVE table`: its `Datastack` stayed editable beside a wired Dataset and showed its
 * own text while the node read the wire, so the field was a control that did nothing and said
 * nothing about it. Written against the shared `caveDatastackParam`, which is what all three CAVE
 * nodes declare, rather than a fixture param of its own.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { NodeDefinition } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import type { CodaType } from '../../core/types'
import { T } from '../../core/types'
import { CAVE_DATASET_INPUT, caveDatastackParam } from '../../nodes/lib/caveParams'
import { ParamField } from './ParamField'

afterEach(cleanup)

const PARAM = caveDatastackParam('fixture')

const DEF: NodeDefinition = {
  type: 'test.caveDatastack',
  label: 'Test',
  category: 'dataset',
  description: 'fixture',
  cost: 'cheap',
  inputs: [CAVE_DATASET_INPUT],
  outputs: [],
  params: [PARAM],
  evaluate: () => ({}),
}

function draw(input: CodaType | undefined, datastack: string) {
  const values = { ...defaultParams(DEF), datastack }
  const ctx = makeInferContext(DEF, values, { dataset: input })
  render(<ParamField param={PARAM} value={datastack} ctx={ctx} onChange={() => undefined} />)
  return screen.getByLabelText<HTMLInputElement>('Datastack')
}

describe('the Datastack field beside a Dataset wire', () => {
  it('shows the wired datastack, not editable, and says why', () => {
    const field = draw(
      T.dataset('cave', 'brain_and_nerve_cord:1015'),
      'flywire_fafb_public:783',
    )
    expect(field.value).toBe('brain_and_nerve_cord:1015')
    expect(field.disabled).toBe(true)
    expect(field.title).toMatch(/wired Dataset/)
  })

  it('is the typed field when nothing is wired', () => {
    const field = draw(undefined, 'flywire_fafb_public:783')
    expect(field.value).toBe('flywire_fafb_public:783')
    expect(field.disabled).toBe(false)
  })

  /*
   * `caveTarget` falls back to the typed name while the wire has not said which datastack it is,
   * so the field is still the one being read and has to stay editable.
   */
  it('stays the typed field while the wire has not resolved', () => {
    const field = draw(T.dataset(), 'flywire_fafb_public:783')
    expect(field.value).toBe('flywire_fafb_public:783')
    expect(field.disabled).toBe(false)
  })
})
