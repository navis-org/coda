/**
 * Merge Suggestions, against **real parquet bytes** — a trimmed copy of SEAM's rv2 set, written
 * by pyarrow the way SEAM writes the full one (`__fixtures__/make.py`).
 *
 * Reading the file is the point. Every failure this path has had anywhere in Coda has been in the
 * reading rather than the folding: an id through a float, a nested column dropped in silence, a
 * dtype that decoded but meant something else. A test that handed `readSuggestions` a hand-built
 * table would check the half that has never broken.
 *
 * What is pinned here, in order of how badly it would hurt:
 *
 *  - **root ids come back as text, exactly.** An 18-digit id through a float is a different
 *    neuron and nothing downstream could tell (invariant 8).
 *  - the schema the card promises before a fetch is the schema the rows arrive in (invariant 3);
 *  - `shown` is read, never recomputed — it is SEAM's absolute cutoff (invariant 14);
 *  - a tip nobody judged is **null**, not `""`, which is "judged, nothing belongs".
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ID_COLUMN_NAME, isNeuronId } from '../../core/ids'
import { defaultParams, findParam, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { ParamValues } from '../../core/node'
import type { CodaType, TableSchema } from '../../core/types'
import { columnNames } from '../../core/types'
import type { LayersValue, PointsValue, TableValue } from '../../core/values'
import { blobBytes } from '../../data/files/bytes'
import { openTableFile } from '../../data/files/read'
import '../../nodes'
import { peekSuggestions, resetSuggestionPeeks } from './suggestionIndex'
import { parseSuggestionSet } from './suggestionSet'
import type { OpenFile } from './suggestionRead'
import { readSuggestions } from './suggestions'
import {
  CANDIDATE_FIELDS,
  TIP_FIELDS,
  neuronsSchema,
  published,
  schemaOf,
} from './suggestionTables'

const DIR = 'src/packs/seam/__fixtures__'

const SET = parseSuggestionSet(
  JSON.parse(readFileSync(`${DIR}/fixture.json`, 'utf8')),
  'https://example.invalid/coda_rv2/fixture.json',
)

/** The node's own opener, pointed at the committed files instead of at a URL. */
const openLocal: OpenFile = (file) =>
  openTableFile(blobBytes(new Blob([readFileSync(`${DIR}/${file}`)])))

const built = await readSuggestions(SET, openLocal)

/** A declared output's schema. `CodaType` is a union and only some arms carry one. */
function schemaOfType(type: CodaType | undefined): TableSchema {
  const schema = type && 'schema' in type ? type.schema : undefined
  if (!schema) throw new Error('the output declares no schema')
  return schema
}

const def = requireNodeDef('seam:suggestions')
const infer = (params: ParamValues = {}) =>
  def.inferOutputs!(makeInferContext(def, { ...defaultParams(def), ...params }, {}))

/*
 * The peek memo is module-level, so without this a `validate` assertion inherits whatever an
 * earlier test left under the same address — and the states it distinguishes ("still looking",
 * "failed", "an index") are exactly what it would inherit.
 */
beforeEach(resetSuggestionPeeks)

describe('the card', () => {
  /** Invariant 6: it fetches, so a `cheap` node would refetch on every keystroke anywhere. */
  it('is expensive', () => {
    expect(def.cost).toBe('expensive')
  })

  /** Invariant 2: `inferOutputs` may not fetch, so the columns are a contract, not a discovery. */
  it('promises every output’s columns before anything is read', () => {
    const out = infer()
    expect(columnNames(schemaOfType(out.tips))).toEqual(
      published(TIP_FIELDS).map((f) => f.name),
    )
    expect(columnNames(schemaOfType(out.candidates))).toEqual(
      published(CANDIDATE_FIELDS).map((f) => f.name),
    )
    expect(columnNames(schemaOfType(out.neurons))).toEqual(columnNames(neuronsSchema()))
  })

  it('asks for an address before it will run, and refuses one that is not a URL', () => {
    const validate = (params: ParamValues) =>
      def.validate!(makeInferContext(def, { ...defaultParams(def), ...params }, {})).join(' ')
    expect(validate({})).toContain('directory of suggestion sets')
    expect(validate({ url: 'coda_rv2/fixture.json' })).toContain('http')
    /*
     * A card whose peek has not landed says nothing. "Still looking" and "wrong" are different
     * states and only one of them is the reader's problem — the same reason a column picker
     * keeps a column whose schema has not arrived.
     */
    expect(validate({ url: 'https://example.invalid/x/index.json' })).toBe('')
  })
})

describe('reading a set', () => {
  it('reads every tip and every candidate the manifest says it holds', () => {
    expect(built.tips.length).toBe(SET.counts.tips)
    expect(built.candidates.length).toBe(SET.counts.candidates)
    expect(built.shown).toBe(SET.counts.shown)
  })

  /** The whole of invariant 8, in the one place this node could lose it. */
  it('reads root ids as text, exactly', () => {
    for (const name of [ID_COLUMN_NAME, 'candidateId']) {
      const cells = built.tips.data[name]!
      expect(cells.length).toBe(built.tips.length)
      for (const cell of cells) {
        expect(typeof cell).toBe('string')
        expect(isNeuronId(cell as string)).toBe(true)
      }
    }
    // The one that would actually bite: an 18-digit id survives the read unchanged, where the
    // same id through a float would name a neighbouring neuron.
    const id = SET.neurons[0]!
    expect(built.tips.data[ID_COLUMN_NAME]).toContain(id)
    expect(String(Number(id))).not.toBe(id)
  })

  /** Invariant 3, reached through a file rather than a mismatched pair. */
  it('publishes rows under exactly the schema it promised', () => {
    for (const [table, fields] of [
      [built.tips, TIP_FIELDS],
      [built.candidates, CANDIDATE_FIELDS],
    ] as const) {
      expect(table.schema).toEqual(schemaOf(fields))
      expect(Object.keys(table.data).sort()).toEqual(
        published(fields)
          .map((f) => f.name)
          .sort(),
      )
      for (const field of published(fields)) {
        expect(table.data[field.name]!.length).toBe(table.length)
      }
    }
  })

  it('reads `shown` as a boolean rather than the text parquet could hand back', () => {
    const shown = built.tips.data['shown']!
    for (const cell of shown) expect(typeof cell).toBe('boolean')
    expect(shown.filter(Boolean).length).toBe(SET.counts.shown)
  })

  /**
   * SEAM's verdicts arrive `;`-joined, and the two empty cases are different answers: `""` is
   * "judged, and nothing in the list belongs", `null` is "nobody looked at this tip". The
   * fixture holds both on purpose, because a reader folding one into the other would report
   * 2,331 unlooked-at tips as judgements of "none".
   */
  it('keeps a judged-but-empty verdict apart from an unjudged one', () => {
    const belongs = built.tips.data['seam_belongs']!
    expect(belongs.filter((cell) => cell === '').length).toBeGreaterThan(0)
    expect(belongs.filter((cell) => cell === null).length).toBeGreaterThan(0)
    for (const [i, cell] of belongs.entries()) {
      // A tip with no verdict has no list, and a tip with a verdict has one — possibly empty.
      expect(cell === null).toBe(built.tips.data['seam_verdict']![i] === null)
    }
  })

  /**
   * The set as published checks out, which is the state to notice a change from.
   *
   * SEAM's exporter now runs both of these before writing (their `bccb484`); the loader runs
   * them again because this is the only place a *reader* can see the failure, and the next set
   * will come from a pipeline nobody here runs.
   */
  it('finds nothing wrong with the ids of a sound set', () => {
    expect(built.damaged).toBe(0)
    expect(built.stray).toBe(0)
  })

  /** The joined id is the rank-1 row's, for the tip it belongs to — not merely some candidate. */
  it('joins the rank-1 candidate of that tip, by end_uid', () => {
    const byEnd = new Map<number, string>()
    const ends = built.candidates.data['end_uid']!
    const ranks = built.candidates.data['rank']!
    const roots = built.candidates.data['candidateId']!
    for (const [i, end] of ends.entries()) {
      if (ranks[i] === 1) byEnd.set(end as number, roots[i] as string)
    }
    const tipEnds = built.tips.data['end_uid']!
    const joined = built.tips.data['candidateId']!
    for (const [i, end] of tipEnds.entries()) {
      expect(joined[i]).toBe(byEnd.get(end as number) ?? null)
    }
  })

  it('draws one point per tip, at the tip rather than at the contact', () => {
    expect(built.points.positions.length).toBe(built.tips.length * 3)
    expect(built.points.units).toBe('nm')
    expect(built.points.attributes).toBe(built.tips)
    expect(built.points.positions[0]).toBeCloseTo(built.tips.data['x']![0] as number)
  })

  /**
   * The neuron rows come from the manifest's list, so a set naming a neuron its tips file has
   * nothing for still gets a row. Zero tips is an answer; an absent row is not.
   */
  it('folds one row per neuron the manifest names, in its order', () => {
    expect(built.neurons.kind).toBe('neurons')
    expect(built.neurons.data[ID_COLUMN_NAME]).toEqual([...SET.neurons])
    let tips = 0
    let shown = 0
    for (let i = 0; i < built.neurons.length; i++) {
      tips += built.neurons.data['tips']![i] as number
      shown += built.neurons.data['shown']![i] as number
    }
    expect(tips).toBe(SET.counts.tips)
    expect(shown).toBe(SET.counts.shown)
  })

  /**
   * The exact per-neuron numbers, because there are now **three** implementations of this fold —
   * the node, the pandas emitter and the R one — and two of them have already disagreed.
   *
   * The R chunk returned 0.5275 where pandas returned 1.8689: `dplyr::summarise()` binds its
   * arguments in order, so `shown = sum(shown)` shadowed the logical column before
   * `expectedRight` read it, `ifelse()` took a length-one condition, and the total became the
   * first row's `r`. A plausible number, and wrong. These values are what all three produce
   * against `__fixtures__`, so a change to any one of them is checked by running its cell
   * against the same files and comparing this list.
   */
  it('sums r over the shown rows, to the number both exporters produce', () => {
    expect(
      (built.neurons.data['expectedRight'] as number[]).map((v) => Number(v.toFixed(4))),
    ).toEqual([1.8689, 1.8467, 1.7657, 1.8467, 1.6524])
  })

  /** `r` is the chance a *shown* first is right, so the expectation sums over the shown rows. */
  it('expects no more right firsts than it shows', () => {
    for (let i = 0; i < built.neurons.length; i++) {
      const expected = built.neurons.data['expectedRight']![i] as number
      expect(expected).toBeGreaterThanOrEqual(0)
      expect(expected).toBeLessThanOrEqual(built.neurons.data['shown']![i] as number)
    }
  })

  /** The layer is the shown suggestions, two points each: where to look and where to merge. */
  it('carries a tip and a contact for every shown suggestion, and nothing else', () => {
    expect(built.suggestions.length).toBe(SET.counts.shown)
    for (const item of built.suggestions) {
      expect(isNeuronId(item.neuronId)).toBe(true)
      expect(isNeuronId(item.candidateId)).toBe(true)
      expect(item.tipNm).not.toEqual(item.contactNm)
      expect(item.r).toBeGreaterThanOrEqual(0)
    }
  })
})

/**
 * The node's own `evaluate`, over HTTP.
 *
 * Written because the last node in this pack shipped with an `evaluate` that had never once run:
 * every part was tested, nothing had run them together, and the first real run found two design
 * errors in an afternoon. Everything above this point reads a `Blob` and calls `readSuggestions`
 * directly, which skips `openOverHttp`, `urlHead`, the layer, the manifest check and the warning
 * — in other words most of what `evaluate` is.
 *
 * The server below honours `Range` and answers `HEAD`, because those are the two things the
 * reader needs of a host and the two a host most often does not do. It is deliberately **not**
 * shared with `probe-seam-suggestions.mjs`: that one also has to serve cross-origin, and a shared
 * version would be a helper tuned to neither.
 */
describe('the node, end to end over HTTP', () => {
  let origin = ''
  let server: Server

  beforeAll(async () => {
    server = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\/+/, '')
      let bytes: Buffer
      try {
        bytes = readFileSync(`${DIR}/${name}`)
      } catch {
        res.writeHead(404).end()
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(bytes.length) }).end()
        return
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (!range) {
        res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes)
        return
      }
      const from = Number(range[1])
      const to = Math.min(Number(range[2]), bytes.length - 1)
      res
        .writeHead(206, {
          'content-length': String(to - from + 1),
          'content-range': `bytes ${from}-${to}/${bytes.length}`,
        })
        .end(bytes.subarray(from, to + 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => server.close())

  const run = async (params: ParamValues = {}) => {
    const said: string[] = []
    const out = await def.evaluate({
      params: { ...defaultParams(def), url: `${origin}/fixture.json`, ...params },
      refresh: false,
      reportFetched: () => undefined,
      warn: (message: string) => said.push(message),
      publish: () => undefined,
      input: () => undefined,
      inputKey: () => undefined,
      column: () => undefined,
      columns: () => [],
      inputPorts: () => [],
      outputPorts: () => [],
      resolveSource: () => undefined as never,
      signal: new AbortController().signal,
      progress: () => {},
    } as never)
    return { out, said }
  }

  /**
   * The production shape: a pipeline deposits sets into a directory and keeps an index, and a
   * card pins one by name. The card reads the *same* files either way, so this is about the
   * addressing — which is the half a fixture URL never exercises.
   */
  /**
   * The picker is filled by a peek, which is the only shape invariant 2 allows: options are read
   * synchronously on every inference pass, so the read starts the fetch it cannot answer and
   * fires `reportSourceLearned` when it lands. The first look is therefore always empty, and the
   * test is that the second one is not.
   */
  it('fills the Set dropdown from the directory, one fetch later', async () => {
    const address = `${origin}/index.json`
    const options = () => {
      const param = findParam(def, 'set')!
      const list = (param as { options: unknown }).options as (ctx: {
        params: ParamValues
      }) => { value: string }[]
      return list({ params: { url: address } }).map((option) => option.value)
    }
    expect(peekSuggestions(address).state).toBe('pending')
    expect(options()).toEqual([])
    // One turn of the event loop is all the fetch needs against a server in this process.
    await vi.waitFor(() => expect(peekSuggestions(address).state).toBe('index'))
    expect(options()).toEqual(['rv2', 'rv2-mismatched'])
  })

  /** One field, two kinds of document, told apart by what the document is rather than its name. */
  it('recognises a single set’s manifest as one, not as a directory', async () => {
    const address = `${origin}/fixture.json`
    peekSuggestions(address)
    await vi.waitFor(() => expect(peekSuggestions(address).state).toBe('single'))
  })

  /**
   * The address a reader actually has is the directory's — it is what their browser's address
   * bar holds. Both the picker and the run must reach the same file from it, or the dropdown
   * fills and the run then refuses.
   */
  it('reads the directory when given only its address, slash or no slash', async () => {
    for (const address of [`${origin}/`, origin]) {
      resetSuggestionPeeks()
      const { out } = await run({ url: address, set: 'rv2' })
      expect((out['tips'] as TableValue).length).toBe(SET.counts.tips)
      await vi.waitFor(() => expect(peekSuggestions(address).state).toBe('index'))
    }
  })

  it('reads a set chosen by name out of a directory’s index', async () => {
    const { out } = await run({ url: `${origin}/index.json`, set: 'rv2' })
    expect((out['tips'] as TableValue).length).toBe(SET.counts.tips)
  })

  /**
   * Pinned, not latest: a directory that gains a set changes nothing about a card already
   * pointed at one, and a card naming a set that is gone says so rather than reading its
   * neighbour.
   */
  it('refuses a set the directory does not hold, listing the ones it does', async () => {
    await expect(run({ url: `${origin}/index.json`, set: 'rv9' })).rejects.toThrow(
      /no set called “rv9”.*rv2, rv2-mismatched/s,
    )
  })

  it('refuses a directory with no set chosen, rather than guessing one', async () => {
    await expect(run({ url: `${origin}/index.json` })).rejects.toThrow(/Choose one of its sets/)
  })

  /**
   * One field takes either kind of address, decided by what the document *is*. A card that
   * ignored a control it had no use for would be worse than one that says so.
   */
  it('refuses a set named against a single manifest, rather than ignoring it', async () => {
    await expect(run({ url: `${origin}/fixture.json`, set: 'rv2' })).rejects.toThrow(
      /nothing for `Set` to choose/,
    )
  })

  it('fetches a set and publishes all five outputs', async () => {
    const { out, said } = await run()
    expect((out['tips'] as TableValue).length).toBe(SET.counts.tips)
    expect((out['candidates'] as TableValue).length).toBe(SET.counts.candidates)
    expect((out['neurons'] as TableValue).length).toBe(SET.neurons.length)
    expect((out['points'] as PointsValue).positions.length).toBe(SET.counts.tips * 3)
    // Two annotations per shown suggestion: the tip and the contact.
    const layers = out['layers'] as LayersValue
    const annotations = (layers.items[0] as { annotations: unknown[] }).annotations
    expect(annotations.length).toBe(SET.counts.shown * 2)
    // A sound set that matches its own manifest says nothing at all.
    expect(said).toEqual([])
  })

  /**
   * The failure a reader could not otherwise see: a directory holding one run's manifest beside
   * another run's files. Warned rather than refused — the tables are still readable, and naming
   * the mismatch is more use than showing nothing.
   */
  it('says so when the files do not match the manifest', async () => {
    const { said } = await run({ url: `${origin}/mismatched.json` })
    expect(said.join(' ')).toMatch(/does not match its own manifest/)
    expect(said.join(' ')).toMatch(/tips says 9999/)
  })

  /**
   * **The 2026-11-09 incident, as a regression fixture.**
   *
   * `__fixtures__/damaged/` is the trimmed set with its ids put back through a float64, the way
   * a `Series.map` over a nullable `Int64` column produced them — a *string* column of *rounded*
   * ids, which is why "every id is a string column" did not catch it and why nothing downstream
   * could have. SEAM fixed the exporter; this is what makes sure a future set that regresses is
   * caught on read, by us, rather than by whoever eventually clicks a merge.
   */
  it('catches ids that have been through a float, and still publishes the sound one', async () => {
    const { out, said } = await run({ url: `${origin}/damaged/fixture.json` })
    const tips = out['tips'] as TableValue
    expect(said.join(' ')).toMatch(/through a 64-bit float/)
    expect(said.join(' ')).toMatch(/25 tips disagree/)
    expect(said.join(' ')).toMatch(/judged ids name nothing/)
    // The rows are still published, and `candidateId` is the joined one rather than the file's.
    expect(tips.length).toBe(SET.counts.tips)
    const joined = tips.data['candidateId']!
    for (const id of joined) {
      if (typeof id !== 'string') continue
      // A sound id is not what a float would have left behind.
      expect(String(BigInt(Number(id)))).not.toBe(id)
    }
  })

  it('names the address when the set is not there', async () => {
    await expect(run({ url: `${origin}/nothing.json` })).rejects.toThrow()
  })
})
