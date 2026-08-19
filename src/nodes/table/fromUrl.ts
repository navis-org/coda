/**
 * The same CSV as `core.uploadTable`, fetched rather than picked.
 *
 * The pair is deliberate and the difference between them is one property: **a URL is
 * reproducible and an upload is not**. So this node needs no storage at all — the graph carries
 * the address, and a colleague opening the file re-fetches it and gets the same table, which is
 * exactly the thing Upload Table cannot do. What it gives up is working at all on a file that
 * only exists on somebody's disk, or behind a login, or on a host that sends no CORS headers.
 * Neither node supersedes the other.
 *
 * ## Everything else follows from being a fetch
 *
 * **`expensive`, and this is invariant 6 in its plainest form.** The URL is a text field. Marked
 * `cheap` it would fire a request per keystroke, at whatever host was half-typed.
 *
 * **The schema is remembered per URL, not observed.** The shape is decided by a remote server
 * that inference may not call (invariant 2), which is the situation `observesOutputSchema`
 * exists for — and it is *almost* right here. What rules it out is `Text columns`: a `columns`
 * param finds its options through `schemaFrom`, which is handed the node's inputs and params
 * and deliberately not `ctx.observed`. Widening it to see the observed schema would make
 * inference resolve that param against a schema the **scheduler** cannot see when it computes
 * the provenance key and resolves `ctx.columns` — the exact desynchronisation invariant 5 is
 * about.
 *
 * So the schema goes somewhere every one of those callers can read: a module-level map keyed by
 * URL, filled by `evaluate`. Same lifetime as an observed schema — empty before the first run
 * and empty again after a reload — and the same idiom as `peekUploadSchema` one layer over,
 * including the announcement that tells the store to infer again now that it can do better.
 *
 * **`refresh` is not decoration.** Cache keys are provenance, so `evaluate` must be
 * deterministic for fixed params — and a file at a URL can change underneath one. That is the
 * hidden mutable state invariant 4 requires an explicit nonce for, exactly as the Dataset node's
 * own `refresh` does. Without it, re-running a workflow against an updated file returns the old
 * table from cache with nothing to say so.
 */

import { registerNode } from '../../core/registry'
import type { ColumnSchemaSource } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { T, columnNames, findColumn } from '../../core/types'
import { parseDelimited } from '../../data/csv'
import { MAX_UPLOAD_BYTES, reportUploadLearned } from '../../data/uploads'
import { uploadIsNeurons, uploadShapeSchema, uploadShapeTable } from '../lib/tableOps'

/**
 * Schemas seen at each URL this session.
 *
 * Session-scoped on purpose: it is a fact about what a server returned, not about the document,
 * so persisting it would let a saved graph claim columns nobody has fetched. Keyed by URL rather
 * than by node id — two nodes pointed at one file describe the same table, and a node deleted
 * and re-added has not learned anything new.
 */
const schemaByUrl = new Map<string, TableSchema>()

const fetchedSchema: ColumnSchemaSource = (_inputs, params) =>
  schemaByUrl.get(String(params.url ?? '').trim())

/** Test seam, and the reason the map is not exported directly. */
export function resetFetchedSchemas(): void {
  schemaByUrl.clear()
}

export const tableFromUrlNode = registerNode({
  type: 'core.tableFromUrl',
  label: 'Table from URL',
  category: 'utility',
  description: 'Fetch a CSV from a URL and read it as a table.',
  cost: 'expensive',
  inputs: [],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'url',
      kind: 'string',
      label: 'URL',
      placeholder: 'https://example.org/annotations.csv',
      help: 'A CSV, TSV or semicolon-separated file. The host must allow cross-origin reads.',
      default: '',
    },
    {
      id: 'idColumn',
      kind: 'enum',
      label: 'ID column',
      help: 'Renamed to bodyId, which is the name every neuron node looks for.',
      default: '',
      /*
       * An enum rather than a `column` param, for the reason spelled out on the upload node: an
       * enum's stored value reaches the provenance key verbatim, where a column param's is
       * resolved against the available schema first — and a schema that is empty before the
       * first fetch and full after it would key the node two different ways either side of a
       * run it had just finished.
       */
      options: (ctx) => [
        { value: '', label: 'none (plain table)' },
        // Identifiers only: a float is a measurement and a boolean is a flag.
        ...(schemaByUrl.get(String(ctx.params.url ?? '').trim())?.columns ?? [])
          .filter((c) => c.dtype === 'i64' || c.dtype === 'str')
          .map((c) => ({ value: c.name, label: c.name })),
      ],
    },
    {
      id: 'textColumns',
      kind: 'columns',
      label: 'Text columns',
      help: 'Read these as text rather than numbers — a cluster id is a label, not a quantity.',
      /*
       * No port to read: the schema comes from what this URL last returned. Safe against the
       * key only because `resolveColumns` now keeps a chosen list while the schema is unknown —
       * before that it collapsed to empty before the first fetch and to the real list after,
       * changing the key of a node that had just finished fetching and sending it back to the
       * host to do it again.
       */
      from: '',
      schemaFrom: fetchedSchema,
      default: [],
      optional: true,
      advanced: true,
    },
    {
      id: 'refresh',
      kind: 'int',
      label: 'Refresh',
      help: 'Bump to fetch again. The file at a URL can change; the cache key cannot see that.',
      default: 0,
      min: 0,
      advanced: true,
      internal: true,
    },
  ],

  inferOutputs: (ctx) => {
    const known = schemaByUrl.get(String(ctx.params.url ?? '').trim())
    const idColumn = String(ctx.params.idColumn ?? '')
    const shaped = uploadShapeSchema(known, idColumn, ctx.columns('textColumns'))
    return {
      out: uploadIsNeurons(known, idColumn) ? T.neurons(shaped) : T.table(shaped),
    }
  },

  /**
   * Checked at edit time, where there is no data — so this is about the *address* only.
   *
   * A bad ID column cannot be reported here: nothing has been fetched until the first run and
   * nothing again after a reload, so a check against the remembered schema would fire on every
   * load of every graph that uses this node. `evaluate` says it instead, table in hand.
   */
  validate: (ctx) => {
    const url = String(ctx.params.url ?? '').trim()
    if (!url) return ['No URL yet — paste one in']
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return [`"${url}" is not a URL`]
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return [`Only http and https can be fetched, not "${parsed.protocol.replace(':', '')}"`]
    }
    // A warning, never a refusal — the same call `Find Neurons` makes about `limit: 0`. A page
    // served over http into an https app is blocked by the browser, but saying so is the
    // browser's job at the moment it happens, not a reason to refuse the address now.
    if (parsed.protocol === 'http:') {
      return ['An http URL will be blocked by the browser when this app is served over https']
    }
    return []
  },

  evaluate: async (ctx) => {
    const url = String(ctx.params.url ?? '').trim()
    if (!url) throw new Error('No URL. Paste the address of a CSV file into the URL field.')

    ctx.progress(0, 'fetching')
    let response: Response
    try {
      response = await fetch(url, { signal: ctx.signal, redirect: 'follow' })
    } catch (err) {
      /*
       * A browser reports a cross-origin refusal as an opaque `TypeError` with no detail — the
       * same thing `data/precomputed/transport.ts` has to work around — so a network failure
       * and a CORS failure are indistinguishable from here. Naming both beats picking one: the
       * fix for the second is completely different from the fix for the first, and a message
       * that only said "network error" would send somebody to check their wifi.
       */
      if (ctx.signal.aborted) throw err
      throw new Error(
        `Could not fetch ${url}. The host may be unreachable, or it may not allow ` +
          `cross-origin reads — a browser refuses those without saying so. A file served ` +
          `from the same origin as this app, or from a host sending ` +
          `Access-Control-Allow-Origin, will work.`,
      )
    }

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status} ${response.statusText}`.trim())
    }

    // Before the body is read, when it is still free — the same call `pivotTable` makes on
    // shape rather than on the array it is about to allocate. Absent on a chunked response,
    // which is why the parsed size is checked again below.
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${url} is ${Math.round(declared / (1024 * 1024))} MB, over the ` +
          `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
      )
    }

    ctx.progress(0.5, 'reading')
    const text = await response.text()
    if (text.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${url} is ${Math.round(text.length / (1024 * 1024))} MB, over the ` +
          `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
      )
    }

    ctx.progress(0.8, 'parsing')
    const parsed = parseDelimited(text)
    if (parsed.table.schema.columns.length === 0 || parsed.table.length === 0) {
      /*
       * Very often an HTML error page served with a 200, which parses into one useless column.
       * Saying what arrived is what turns "no rows" into something actionable.
       */
      const head = text.trim().slice(0, 60)
      throw new Error(
        `${url} had no rows to read.${head ? ` It starts: ${JSON.stringify(head)}` : ''}`,
      )
    }

    const idColumn = String(ctx.params.idColumn ?? '')
    if (idColumn && !findColumn(parsed.table.schema, idColumn)) {
      throw new Error(
        `ID column "${idColumn}" is not in ${url}. Available: ${columnNames(parsed.table.schema).join(', ')}`,
      )
    }

    /*
     * Remember the shape, then say so. Without the announcement the map fills but nothing
     * re-infers, so every column picker downstream stays empty until the next unrelated graph
     * edit — the "any edit at all fixes it" signature invariant 2 describes.
     */
    if (schemaByUrl.get(url) !== parsed.table.schema) {
      schemaByUrl.set(url, parsed.table.schema)
      reportUploadLearned()
    }

    ctx.progress(1)
    return { out: uploadShapeTable(parsed.table, idColumn, ctx.columns('textColumns')) }
  },
})
