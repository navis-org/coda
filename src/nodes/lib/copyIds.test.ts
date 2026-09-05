/**
 * What the Copy IDs button would put on the clipboard.
 *
 * Everything here fails *quietly*: a copy that dropped a repeat, joined with the wrong
 * character or rounded an 18-digit root id still produces a plausible-looking list, and the
 * place it is noticed is a query somewhere else that comes back short. So the assertions are
 * about the text, character for character, rather than about a count.
 *
 * `copyIdsSettings` gets its own block because it is the seam the two exporters read through:
 * their goldens compare emitted text, so a wrong answer there is a notebook that disagrees with
 * the card and a suite that keeps passing.
 *
 * The card's own behaviour — the count, the disabled button, the write itself — is
 * `ui/nodes/copyIdsBody.test.tsx`.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { SEPARATORS, copyIds, copyIdsSettings, joinIds } from './copyIds'

const SCHEMA = tableSchema(column('neuronId', 'i64'), column('type', 'str'))

function table(ids: Array<number | string | null>): TableValue {
  return tableFromRows(
    SCHEMA,
    ids.map((neuronId) => ({ neuronId, type: 'LC4' })),
  )
}

/** The ids of a table, joined the way the given params say. What every reader ends up doing. */
function copied(
  ids: Array<number | string | null>,
  params: Record<string, unknown> = {},
): string {
  const settings = copyIdsSettings(params)
  return joinIds(copyIds(table(ids), settings.dedupe), settings)
}

describe('the ids', () => {
  it('keeps first-seen order when deduplicating, rather than sorting', () => {
    // A Sort upstream is a decision. `[...new Set()]` keeps insertion order and a sort would
    // discard it silently — the list still looks right, in the wrong order.
    expect(copyIds(table([30, 10, 30, 20, 10]), true)).toEqual(['30', '10', '20'])
  })

  it('keeps the repeats when Deduplicate is off', () => {
    expect(copyIds(table([30, 10, 30]), false)).toEqual(['30', '10', '30'])
  })

  it('drops a null rather than copying a blank line', () => {
    // What a left-joined Neuron Set row is: a body the backend published nothing about. An
    // empty line in the middle of a pasted list is a query for nothing.
    expect(copyIds(table([10, null, 20]), true)).toEqual(['10', '20'])
  })

  it('carries an 18-digit root id exactly', () => {
    // Invariant 8. `idColumn` reads through `idText`, so the id that comes out is the id that
    // went in — a float64 round trip gives `648518347529750700`, a different neuron.
    expect(copyIds(table(['648518347529750614']), true)).toEqual(['648518347529750614'])
  })
})

describe('the settings', () => {
  it('answers the card and both exporters with a character, not a name', () => {
    expect(copyIdsSettings({ separator: 'commaSpace' }).separator).toBe(', ')
    expect(copyIdsSettings({ separator: 'tab' }).separator).toBe('\t')
  })

  it('falls back to one id per line for a separator nobody has any more', () => {
    // A stored graph naming a separator that has since gone would otherwise join with
    // `undefined` — `'1undefined2'`, which reads as data corruption rather than a lost setting.
    expect(copyIdsSettings({ separator: 'semicolon' }).separator).toBe('\n')
    expect(copyIdsSettings({}).separator).toBe('\n')
  })

  it('reads an absent Deduplicate as on and an absent Quote as off, matching the defaults', () => {
    // A graph saved before either control existed, and `EmitContext.params` for a node whose
    // key is simply not set. Absence and the declared default agree here, deliberately.
    expect(copyIdsSettings({})).toEqual({ separator: '\n', dedupe: true, quoted: false })
    expect(copyIdsSettings({ dedupe: false, quoted: true }).dedupe).toBe(false)
    expect(copyIdsSettings({ dedupe: false, quoted: true }).quoted).toBe(true)
  })

  it('resolves every separator the node offers', () => {
    // The node's options and this resolver read one table, which is the point of it being one.
    for (const [id, { text }] of Object.entries(SEPARATORS)) {
      expect(copied([1, 2], { separator: id }), id).toBe(`1${text}2`)
    }
  })
})

describe('the text', () => {
  it('joins one id per line with nothing passed, which is what the Network viewer wants', () => {
    // `joinIds(ids)` is the Network card's **Copy ids**: a list in hand, no table anywhere.
    expect(joinIds(['1', '2'])).toBe('1\n2')
  })

  it('quotes each id, not the joined line', () => {
    // The two are the same thing for a one-element list, which is exactly how this ships
    // broken: `"1, 2"` pastes as one string and fails in the tool it was pasted into.
    expect(copied([1, 2], { separator: 'commaSpace', quoted: true })).toBe('"1", "2"')
  })

  it('has no separator to add for a single id, and none for an empty table', () => {
    expect(copied([1])).toBe('1')
    expect(copied([])).toBe('')
  })
})
