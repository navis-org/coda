/**
 * Every peek whose fetch needs a credential, swept: without one it asks nothing and reports
 * nothing, and signing in is what starts it.
 *
 * A peek runs from inference or a render, on every graph mutation, so a tokenless request there
 * put the Connections dialog in front of somebody who had only dragged a card onto the canvas —
 * and a one-shot "asked" flag spent on that refusal left the answer unknown after signing in, until
 * something awaited it. Found one peek at a time (the neuPrint listing, neuPrint's discovery and
 * geometry peeks, CAVE's discovery), then by this sweep for five more. `PeekGate` is the rule; a
 * new peek belongs in `PEEKS`, and the last test fails until it is there or in `NO_CREDENTIAL`.
 *
 * Both halves are watched, because each hides the other: the clients refuse a tokenless request
 * *before* `fetch`, so a URL count stays green while the report goes out; and a peek that asks
 * nothing at all passes the report check.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import '../nodes'
import { registerBuiltinSources } from './builtins'
import * as annotationCredentials from './annotations/credentials'
import { annotationProvider } from './annotations/registry'
import { resetCaveTableState } from './annotations/caveTable'
import { resetSeaTableState } from './annotations/seaTable'
import { CaveSource } from './cave/CaveSource'
import * as caveCredentials from './cave/credentials'
import {
  peekDatastacks,
  peekL2Cache,
  peekMaterialization,
  peekMaterializations,
} from './cave/datastack'
import { DEFAULT_CAVE_SERVER } from './cave/deployments'
import { peekSkeletonService } from './cave/skeletonService'
import {
  peekReferenceTable,
  peekTableColumns,
  peekTableFacts,
  peekTableList,
  resetCaveState,
} from './cave/tables'
import { NeuPrintSource } from './neuprint/NeuPrintSource'
import * as neuprintCredentials from './neuprint/credentials'

const CAVE = DEFAULT_CAVE_SERVER
const DATASTACK = 'flywire_fafb_public'
const VERSION = 783
const SEATABLE = 'https://cloud.seatable.io'

/** Each peek, made fresh per case so no memo carries over. */
const PEEKS: Array<[string, () => () => unknown]> = [
  [
    'neuPrint listing',
    () => {
      const s = new NeuPrintSource()
      return () => s.peekDatasets()
    },
  ],
  [
    'neuPrint discovery',
    () => {
      const s = new NeuPrintSource()
      return () => s.schemasFor('male-cns:v1.0')
    },
  ],
  [
    'neuPrint skeleton routes',
    () => {
      const s = new NeuPrintSource()
      return () => s.skeletonSourcesFor!('male-cns:v1.0')
    },
  ],
  [
    'neuPrint mesh levels',
    () => {
      const s = new NeuPrintSource()
      return () => s.meshLevelsFor!('male-cns:v1.0')
    },
  ],
  [
    'CAVE listing',
    () => {
      const s = new CaveSource()
      return () => s.peekDatasets()
    },
  ],
  [
    'CAVE discovery',
    () => {
      const s = new CaveSource()
      return () => s.schemasFor(`${DATASTACK}:${VERSION}`)
    },
  ],
  ['CAVE datastacks', () => () => peekDatastacks(CAVE)],
  ['CAVE materializations', () => () => peekMaterializations(CAVE, DATASTACK)],
  ['CAVE materialization', () => () => peekMaterialization(CAVE, DATASTACK, VERSION)],
  ['CAVE level-2 cache', () => () => peekL2Cache(CAVE, DATASTACK)],
  ['CAVE skeleton service', () => () => peekSkeletonService(CAVE, DATASTACK)],
  ['CAVE table list', () => () => peekTableList(CAVE, DATASTACK, VERSION)],
  [
    'CAVE table facts',
    () => () => peekTableFacts(CAVE, DATASTACK, VERSION, 'proofread_neurons'),
  ],
  [
    'CAVE table columns',
    () => () => peekTableColumns(CAVE, DATASTACK, VERSION, 'proofread_neurons'),
  ],
  [
    'CAVE reference table',
    () => () => peekReferenceTable(CAVE, DATASTACK, VERSION, 'proofread_neurons'),
  ],
  [
    'CAVE-table annotations',
    () => () =>
      annotationProvider('caveTable')!.peekColumns({
        provider: 'caveTable',
        config: {
          dataset: `${DATASTACK}:${VERSION}`,
          table: 'hierarchical_neuron_annotations',
          idColumn: 'pt_root_id',
          columns: '',
          pivotOn: 'classification_system',
        },
      }),
  ],
  [
    'SeaTable annotations',
    () => () =>
      annotationProvider('seaTable')!.peekColumns({
        provider: 'seaTable',
        config: {
          host: SEATABLE,
          workspace: '1',
          base: 'b',
          table: 't',
          idColumn: 'id',
          columns: '',
        },
      }),
  ],
]

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function signOut(): void {
  caveCredentials.resetCredentials()
  neuprintCredentials.resetCredentials()
  annotationCredentials.resetSeaTableCredentials()
}

function signIn(): void {
  caveCredentials.setToken(CAVE, 'test-token')
  neuprintCredentials.setToken('test-token')
  annotationCredentials.setToken(SEATABLE, 'test-token')
}

/** Every auth channel that opens the Connections dialog. */
function watchReports(): { raised: string[]; stop: () => void } {
  const raised: string[] = []
  const stops = [
    caveCredentials.subscribeAuthFailure,
    neuprintCredentials.subscribeAuthFailure,
    annotationCredentials.subscribeAuthFailure,
  ].map((subscribe) => subscribe((message: string) => raised.push(message)))
  return { raised, stop: () => stops.forEach((stop) => stop()) }
}

beforeEach(() => {
  registerBuiltinSources()
  resetCaveState()
  resetCaveTableState()
  resetSeaTableState()
  signOut()
})

afterEach(() => {
  vi.unstubAllGlobals()
  signOut()
})

it.each(PEEKS)('%s asks nothing and reports nothing without a token', async (_, make) => {
  const urls: string[] = []
  // Pending forever: this is about what gets asked for, and an answer would start a cascade.
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url))
    return new Promise(() => {})
  })
  const peek = make()
  const { raised, stop } = watchReports()
  peek()
  await tick()
  peek()
  await tick()
  stop()
  expect(urls).toEqual([])
  expect(raised).toEqual([])

  // And signing in is what starts it, rather than the tokenless look having used it up.
  signIn()
  peek()
  await tick()
  expect(urls.length).toBeGreaterThan(0)
})

/**
 * The exported `peek*` functions this sweep does not call, and why none of them can reach a
 * credentialed server. `DataSource` methods are covered by name in `PEEKS`; this guards the free
 * functions, which is where the five this sweep found lived.
 */
const NO_CREDENTIAL: Record<string, string> = {
  peekUploadSchema: 'reads the browser shelf (IndexedDB)',
  peekUploadMeta: 'reads the browser shelf (IndexedDB)',
  peekMeshUpload: 'reads the browser shelf (IndexedDB)',
  peekEdgeSets: 'reads the browser shelf (IndexedDB)',
  peekEdgeSet: 'reads the browser shelf (IndexedDB)',
  peekCurrentVersion: "NeuronBridge's public bucket",
  peekFlat: 'a public GCS bucket',
  peekPrecomputed: 'starts nothing — reads settled probes',
  peekRootCheck: 'starts nothing — reads a map',
  peekBases: 'starts nothing — reads a map',
  peekDatastackRecord: '`peekMaterializations`, which is swept',
  peekRefColumns: "each provider's `peekColumns`, which are swept",
  peekTableFile: "reads a URL's footer by Range request, which carries no credential",
}

it('sweeps every exported peek, or says why it need not', () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const exported = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) =>
      [...readFileSync(join(root, file), 'utf8').matchAll(/^export function (peek\w+)/gm)].map(
        (match) => match[1]!,
      ),
    )
  // Only the `PEEKS` table counts: a name mentioned in a comment is not a peek that is swept.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const swept = self.slice(
    self.indexOf('const PEEKS'),
    self.indexOf('\n]\n', self.indexOf('const PEEKS')),
  )
  const missing = exported.filter(
    (name) => !(name in NO_CREDENTIAL) && !swept.includes(`${name}(`),
  )
  expect(missing, 'add each to PEEKS, or to NO_CREDENTIAL with the reason').toEqual([])
})
