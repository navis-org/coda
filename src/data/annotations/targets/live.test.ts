/**
 * The SeaTable target against FlyTable — **writing**, so gated twice and pinned to one table.
 *
 * Runs only with `SEATABLE_TOKEN` *and* `SEATABLE_WRITE_TEST=main_test.info_test`: the read-only
 * live suite (`../live.test.ts`) runs whenever the token is set, and this one must not ride along
 * with it. The base and table are constants, not configuration — `main_test.info_test` is a scratch
 * copy of FlyWire's `main.info` made for this, and nothing here may write anywhere else. Every cell
 * it changes is restored in a `finally`.
 *
 *   SEATABLE_WRITE_TEST=main_test.info_test pnpm vitest run src/data/annotations/targets/live.test.ts
 *
 * What it proves that the stubbed suite cannot: that the SQL is accepted as written, that
 * `batch-update-rows` takes the body as built, that a write is visible to the next read, and that
 * the stale-value check holds against the real server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SEATABLE_HOSTS, resetSeaTableCredentials, setToken } from '../credentials'
import { SeaTableTarget } from './seaTable'

const BASE = 'main_test'
const TABLE = 'info_test'
const TOKEN = process.env.SEATABLE_TOKEN
const GATE = process.env.SEATABLE_WRITE_TEST === `${BASE}.${TABLE}`

/** A root id with two rows in `main.info`, measured 2026-10-02 — so the copy has two as well. */
const REPEATED = '720575940621522189'

const live = TOKEN && GATE ? describe : describe.skip

beforeAll(() => setToken(SEATABLE_HOSTS.flytable, TOKEN))
afterAll(() => resetSeaTableCredentials())

live('FlyTable scratch table, writing', () => {
  const target = new SeaTableTarget({
    host: SEATABLE_HOSTS.flytable,
    workspace: '',
    base: BASE,
    table: TABLE,
    idColumn: 'root_783',
  })

  it('reads every row of a repeated id', async () => {
    const read = await target.read([REPEATED], ['cell_type', 'notes'])
    expect(read.records.length).toBeGreaterThan(1)
    expect(new Set(read.records.map((r) => r.key)).size).toBe(read.records.length)
  }, 60_000)

  it('writes a cell, reads it back, holds a stale write, and restores it', async () => {
    const [record] = (await target.read([REPEATED], ['notes'])).records
    const original = record!.values.notes ?? null
    const marker = `coda live test ${Date.now()}`
    try {
      const wrote = await target.write([
        { key: record!.key, field: 'notes', value: marker, before: original },
      ])
      expect(wrote.failed).toEqual([])
      expect(wrote.written).toHaveLength(1)
      const after = await target.read([REPEATED], ['notes'])
      expect(after.records.find((r) => r.key === record!.key)!.values.notes).toBe(marker)

      // The card still thinks the cell holds the original: held, not written.
      const stale = await target.write([
        { key: record!.key, field: 'notes', value: 'should not land', before: original },
      ])
      expect(stale.conflicts).toEqual([{ change: expect.anything(), now: marker }])
    } finally {
      const restored = await target.write([
        { key: record!.key, field: 'notes', value: original, before: marker },
      ])
      expect(restored.failed).toEqual([])
    }
    const last = await target.read([REPEATED], ['notes'])
    expect(last.records.find((r) => r.key === record!.key)!.values.notes ?? null).toBe(original)
  }, 120_000)

  it('writes a date and restores it exactly, time of day included', async () => {
    // SQL answers a date as ISO with the server's offset, and ISO written back loses its time.
    // Read as wall-clock text, the original goes back unchanged.
    const field = 'root_last_modified'
    const [record] = (await target.read([REPEATED], [field])).records
    const original = record!.values[field] ?? null
    const probe = '2024-02-03 14:30'
    try {
      const wrote = await target.write([
        { key: record!.key, field, value: probe, before: original },
      ])
      expect(wrote.failed).toEqual([])
      const after = await target.read([REPEATED], [field])
      expect(after.records.find((r) => r.key === record!.key)!.values[field]).toBe(probe)
    } finally {
      await target.write([{ key: record!.key, field, value: original, before: probe }])
    }
    const last = await target.read([REPEATED], [field])
    expect(last.records.find((r) => r.key === record!.key)!.values[field] ?? null).toBe(
      original,
    )
  }, 120_000)
})
