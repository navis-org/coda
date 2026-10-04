import { describe, expect, it } from 'vitest'

import { MemoryTarget } from './fake'
import { withSideEffects } from './sideEffects'
import type { TargetField } from './types'

const FIELDS: TargetField[] = [
  { name: 'cell_type', kind: 'text' },
  { name: 'type', kind: 'text' },
  { name: 'instance', kind: 'text' },
  { name: 'soma_side', kind: 'text' },
  { name: 'root_side', kind: 'text' },
]

function target() {
  return new MemoryTarget(FIELDS, [
    {
      key: '1',
      id: '1',
      values: { type: 'LC4', instance: 'LC4_R', soma_side: 'R' },
    },
    { key: '2', id: '2', values: { type: null, root_side: 'L' } },
    { key: '3', id: '3', values: { type: null } },
  ])
}

describe('what a write writes besides the edited cell', () => {
  it('writes nothing more with every side effect off', async () => {
    const changes = [{ key: '1', field: 'type', value: 'X', before: null }]
    expect(await withSideEffects(target(), changes, {})).toEqual(changes)
  })

  it('keeps instance in step with type: soma side, else root side, else the type alone; cleared with it', async () => {
    const out = await withSideEffects(
      target(),
      [
        { key: '1', field: 'type', value: 'LC4a', before: 'LC4' },
        { key: '2', field: 'type', value: 'LC6', before: null },
        { key: '3', field: 'type', value: 'T4', before: null },
      ],
      { instanceFromType: true },
    )
    expect(out.filter((c) => c.field === 'instance').map((c) => [c.key, c.value])).toEqual([
      ['1', 'LC4a_R'],
      ['2', 'LC6_L'],
      ['3', 'T4'],
    ])
    const cleared = await withSideEffects(
      target(),
      [{ key: '1', field: 'type', value: null, before: 'LC4' }],
      { instanceFromType: true },
    )
    expect(cleared.at(-1)).toMatchObject({ field: 'instance', value: null })
  })

  it('lets a hand edit of the derived field in the same batch win', async () => {
    const out = await withSideEffects(
      target(),
      [
        { key: '1', field: 'type', value: 'LC4a', before: 'LC4' },
        { key: '1', field: 'instance', value: 'mine', before: 'LC4_R' },
      ],
      { instanceFromType: true },
    )
    expect(out.filter((c) => c.field === 'instance')).toHaveLength(1)
  })

  it('records what an unchecked change replaced, so an undo puts it back', async () => {
    const t = target()
    const changes = await withSideEffects(
      t,
      [{ key: '1', field: 'type', value: 'LC4a', before: 'LC4' }],
      { instanceFromType: true },
    )
    const result = await t.write(changes)
    expect(result.written.find((c) => c.field === 'instance')).toMatchObject({
      value: 'LC4a_R',
      before: 'LC4_R',
    })
    expect(t.value('1', 'instance')).toBe('LC4a_R')
  })
})
