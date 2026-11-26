/** Roots an edit replaced, said to whoever follows them (`rootEdits.ts`). */

import { describe, expect, it, vi } from 'vitest'

import { announceEdit, onEdit } from './rootEdits'

const EDIT = { deployment: 'd', datastack: 's', roots: ['7'], certain: true }

describe('announced edits', () => {
  it('reach every listener until it stops listening, and say nothing for no roots', () => {
    const heard = vi.fn()
    const stop = onEdit(heard)
    announceEdit({ ...EDIT, roots: [] })
    announceEdit(EDIT)
    stop()
    announceEdit(EDIT)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith(EDIT)
  })
})
