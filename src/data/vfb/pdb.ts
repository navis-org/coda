/**
 * Read-only Cypher against Virtual Fly Brain's production database (the PDB).
 *
 * The PDB is Neo4j 4.4 behind `https://pdb.virtualflybrain.org`. On 2026-10-14 it answered an
 * anonymous `POST /db/neo4j/tx/commit` with `access-control-allow-origin: *`, so a browser can ask it
 * directly. It is reached for what VFBquery has no batch form for — `bridge.ts` lists each
 * statement. Whether a browser *should* ask it is the first
 * question put to VFB (`docs/vfb-plan.md`, A1), and everything that does goes through this file so
 * the answer changes one place.
 *
 * Two rules:
 *
 * - **Values go in `parameters`, never into the statement text.** An id or a name typed by
 *   somebody is data. Spliced into the query it is a Cypher injection against a server we do not
 *   own, and it defeats the server's plan cache too.
 * - **The statements are reads.** Nothing here sends a write clause, and `assertReadOnly` refuses
 *   one, `CALL` included (a procedure can write), so a later edit cannot quietly start writing to
 *   a production database. It is a guard against our own code drifting, matched on whole words;
 *   the server's own access rules are VFB's.
 *
 * The request goes through `common.ts`' `vfbJson`, which is `fetchText` as a POST, so the
 * unreachable, cancelled and slow cases are told apart the way every other cross-origin read here
 * tells them apart.
 */

import { vfbJson } from './common'

const PDB_URL = 'https://pdb.virtualflybrain.org/db/neo4j/tx/commit'

const HINT = 'Virtual Fly Brain’s database answers cross-origin reads; check that it is up.'

/** One row, keyed by the statement's `RETURN` column names. */
type PdbRow = Readonly<Record<string, unknown>>

/** Anything that could change the database. Matched on words, case-insensitively. */
const WRITE_CLAUSE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH|CALL)\b/i

interface TxResponse {
  results?: { columns: string[]; data: { row: unknown[] }[] }[]
  errors?: { code?: string; message?: string }[]
}

/** Run one read-only statement and return its rows. */
export async function cypher(
  statement: string,
  parameters: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Promise<PdbRow[]> {
  if (WRITE_CLAUSE.test(statement)) {
    throw new Error('Refused to send a statement that could write to Virtual Fly Brain.')
  }
  const body = (await vfbJson(PDB_URL, HINT, signal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ statements: [{ statement, parameters }] }),
  })) as TxResponse
  const failure = body.errors?.[0]
  if (failure) {
    throw new Error(`Virtual Fly Brain refused the query: ${failure.message ?? failure.code}`)
  }
  const result = body.results?.[0]
  if (!result) return []
  return result.data.map(({ row }) =>
    Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
  )
}
