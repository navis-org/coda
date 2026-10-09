import { beforeEach, describe, expect, it } from 'vitest'

import type { LogEntry } from './annotateSession'
import { editedCells, recordWrite, resetAnnotateSessions, takeUndo } from './annotateSession'

const change = { key: 'row0', field: 'cell_type', value: 'LC4a', before: 'LC4' }

beforeEach(resetAnnotateSessions)

describe('an Annotate card’s undo stack', () => {
  it('hands a batch back only to the target it was written to, and keeps it otherwise', () => {
    // A row key means nothing in another table, so the store itself refuses — not only the button.
    recordWrite('card', [], { target: 'table-a', changes: [change] })
    expect(takeUndo('card', 'table-b')).toBeUndefined()
    expect(takeUndo('card', 'table-a')).toEqual({ target: 'table-a', changes: [change] })
    expect(takeUndo('card', 'table-a')).toBeUndefined()
  })

  it('undoes each target’s own newest batch, whatever was written elsewhere since', () => {
    // A card's tabs share one history; each tab's Undo takes back its own table's last change.
    const other = { ...change, key: 'row9' }
    recordWrite('card', [], { target: 'table-a', changes: [change] })
    recordWrite('card', [], { target: 'table-b', changes: [other] })
    expect(takeUndo('card', 'table-a')).toEqual({ target: 'table-a', changes: [change] })
    expect(takeUndo('card', 'table-b')).toEqual({ target: 'table-b', changes: [other] })
  })

  it('keeps nothing to undo for a write that changed nothing', () => {
    recordWrite('card', [], { target: 'table-a', changes: [] })
    expect(takeUndo('card', 'table-a')).toBeUndefined()
  })
})

describe('which cells a session has edited', () => {
  const entry = (field: string, outcome: LogEntry['outcome'], target = 'a'): LogEntry => ({
    at: new Date(0),
    target,
    label: 'Table',
    id: '1',
    key: 'row0',
    field,
    before: null,
    after: 'x',
    outcome,
  })

  it('counts an edit until it is undone, per target, and ignores what never landed', () => {
    const log = [
      entry('type', 'written'),
      entry('type', 'written'),
      entry('type', 'undone'),
      entry('notes', 'written'),
      entry('notes', 'undone'),
      entry('side', 'held'),
      entry('size', 'failed'),
      entry('class', 'written', 'b'),
    ]
    // Edited twice and undone once is still edited; the other table's edit is not this one's.
    expect(editedCells(log, 'a')).toEqual(new Map([['row0', 'type']]))
    expect(editedCells(log, 'b')).toEqual(new Map([['row0', 'class']]))
  })
})
