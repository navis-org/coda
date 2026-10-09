// @vitest-environment jsdom

/**
 * The Annotate card, in the real editor, against an in-memory target — nothing here reaches a
 * backend. The target's own rules (the stale-value check, refusals, batching) are
 * `data/annotations/targets/*.test.ts`; what is pinned here is that the card reads what the
 * selection names, writes what was typed, says what happened, and refuses while locked.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { idText } from '../../core/ids'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import type { TargetSpec } from '../../packs/annotation/targets'
import { newSpec, writeSpecs } from '../../packs/annotation/targets'
import { resetClioCredentials, setClioToken } from '../../data/annotations/clioCredentials'
import { SEATABLE_HOSTS } from '../../data/annotations/credentials'
import {
  registerAnnotationTarget,
  resetAnnotationTargets,
} from '../../data/annotations/targets'
import { MemoryTarget } from '../../data/annotations/targets/fake'
import { holdEditableFile } from '../../data/files/editable'
import type { TargetField } from '../../data/annotations/targets/types'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource } from '../../data/source'
import '../../nodes'
import '../../packs'
import { useGraphStore } from '../../store/graphStore'
import { everyNeuron } from '../../test/findNeurons'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { resetAnnotateSessions } from './annotateSession'

const DATASET = mockDatasetIds()[0]!

const FIELDS: TargetField[] = [
  { name: 'root_id', kind: 'text', readOnly: 'the id column' },
  { name: 'cell_type', kind: 'text' },
  { name: 'side', kind: 'choice', options: ['left', 'right'] },
  { name: 'size', kind: 'number', integer: true },
  { name: 'cell_type_source', kind: 'text' },
  { name: 'Brain_region', kind: 'text' },
]

/** The tab every test starts from, pointed at the table the fake is registered under. */
const SPEC: TargetSpec = {
  ...newSpec(),
  base: 'main_test',
  table: 'info_test',
  keyColumn: 'root_id',
  fields: ['cell_type', 'side'],
}

let target: MemoryTarget

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetAnnotateSessions()
  target = new MemoryTarget(FIELDS, [], { label: 'Test table' })
  // Under the key the card's settings name, so a card pointed anywhere else would not find it.
  registerAnnotationTarget(
    {
      backend: 'seaTable',
      host: SEATABLE_HOSTS.flytable,
      workspace: '',
      base: 'main_test',
      table: 'info_test',
      idColumn: 'root_id',
    },
    target,
  )
})

afterEach(() => {
  cleanup()
  resetAnnotationTargets()
  act(() => useGraphStore.setState({ locked: false }))
})

/** The first element matching `selector`, once it is there. */
const found = (selector: string, root: ParentNode = document) =>
  waitFor(() => {
    const element = root.querySelector(selector)
    if (!element) throw new Error(`no ${selector}`)
    return element as HTMLElement
  })

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  const col = { ds: 0, find: 1, an: 2 }[id] ?? 3
  return {
    id,
    type,
    position: { x: col * 320, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

function graph(specs: readonly TargetSpec[]): CodaGraph {
  let g = emptyGraph('annotate')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', { ...everyNeuron(), limit: 3 }))
  g = addNode(g, node('an', 'annotation:editor', { targets: writeSpecs(specs) }))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  return addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'an',
    targetHandle: 'neurons',
  })
}

/** Open the graph, run it, and give the target a record for each neuron the search found. */
async function open(
  specs: readonly TargetSpec[] = [SPEC],
  into: MemoryTarget = target,
): Promise<{ body: HTMLElement; ids: string[] }> {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graph(specs))
  })
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
  const out = useGraphStore.getState().nodeOutput('find', 'neurons')
  if (!isTableValue(out)) throw new Error('the search found nothing')
  const ids = out.data.neuronId!.map((cell) => idText(cell)!)
  into.add(
    ids.map((id, i) => ({
      key: `row${i}`,
      id,
      values: { cell_type: `T${i}`, side: 'left', size: i, cell_type_source: 'XY' },
    })),
  )
  const body = await found('.annotate')
  return { body, ids }
}

const inputs = (body: HTMLElement) => [
  ...body.querySelectorAll<HTMLInputElement>('input.annotate__input'),
]

describe('Annotate card', () => {
  it('folds a configured target’s settings behind its name, and unfolds them on a click', async () => {
    const { body } = await open()
    const labels = () => [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels()).toEqual([])
    const toggle = body.querySelector<HTMLButtonElement>('.annotate__target')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    // Every setting the card draws, and not the field list the chooser manages.
    expect(labels()).toEqual([
      'ID column',
      'Backend',
      'Base',
      'Table',
      'Key column',
      'Server',
      'Workspace',
      'Serves',
    ])
    fireEvent.click(toggle)
    expect(labels()).toEqual([])
  })

  it('shows the settings while they do not yet name a target', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().closeStartPage()
      let g = emptyGraph('annotate')
      g = addNode(g, node('an', 'annotation:editor'))
      useGraphStore.getState().loadGraph(g)
    })
    const body = await found('.annotate')
    expect(body.querySelectorAll('.param__label').length).toBeGreaterThan(0)
    // `validate`'s own sentence, so the card and its badge cannot disagree on what is missing.
    expect(body.textContent).toContain('Set Base, Table, Key column.')
  })

  it('reads the selection’s records with the chosen fields', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body).map((i) => i.value)).toEqual(['T0', 'T1', 'T2']))
    expect(body.querySelectorAll('.annotate__table select')).toHaveLength(3)
    expect(body.textContent).toContain('3 neurons')
  })

  it('writes a committed edit, logs it, and undoes it', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const cell = inputs(body)[0]!
    fireEvent.change(cell, { target: { value: 'LC4a' } })
    fireEvent.blur(cell)
    await waitFor(() => expect(target.value('row0', 'cell_type')).toBe('LC4a'))
    await waitFor(() => expect(body.textContent).toContain('Log (1)'))

    const undo = [...body.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
    expect(undo.disabled).toBe(false)
    fireEvent.click(undo)
    await waitFor(() => expect(target.value('row0', 'cell_type')).toBe('T0'))
    await waitFor(() => expect(inputs(body)[0]!.value).toBe('T0'))
  })

  it('offers Undo only while the card points at the table the change was made to', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const cell = inputs(body)[0]!
    fireEvent.change(cell, { target: { value: 'LC4a' } })
    fireEvent.blur(cell)
    await waitFor(() => expect(target.value('row0', 'cell_type')).toBe('LC4a'))
    const undo = () =>
      [...body.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
    await waitFor(() => expect(undo().disabled).toBe(false))
    // Pointed elsewhere, the row key means nothing: Undo stands down and says why.
    act(() =>
      useGraphStore
        .getState()
        .setParam('an', 'targets', writeSpecs([{ ...SPEC, table: 'another_table' }])),
    )
    await waitFor(() => expect(undo().disabled).toBe(true))
    expect(undo().title).toMatch(/Nothing written to this table/)
    act(() => useGraphStore.getState().setParam('an', 'targets', writeSpecs([SPEC])))
    await waitFor(() => expect(undo().disabled).toBe(false))
  })

  it('holds an edit to a cell somebody changed since it was read, and shows what is there', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    target.edit('row1', 'cell_type', 'changed elsewhere')
    const cell = inputs(body)[1]!
    fireEvent.change(cell, { target: { value: 'mine' } })
    fireEvent.blur(cell)
    await waitFor(() => expect(body.querySelector('.annotate__cell--held')).not.toBeNull())
    expect(target.value('row1', 'cell_type')).toBe('changed elsewhere')
    expect(inputs(body)[1]!.value).toBe('changed elsewhere')
  })

  it('says on the cell why typed text cannot go in, and writes nothing until it can', async () => {
    const { body } = await open([{ ...SPEC, fields: ['size'] }])
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const cell = inputs(body)[0]!
    fireEvent.change(cell, { target: { value: 'abc' } })
    fireEvent.blur(cell)
    // Kept on screen and marked, rather than snapping back as though the edit had been taken.
    const marked = await found('.annotate__cell--failed', body)
    expect(marked.getAttribute('title')).toMatch(/not a number/)
    expect(cell.value).toBe('abc')
    fireEvent.change(cell, { target: { value: '2.5' } })
    fireEvent.blur(cell)
    await waitFor(() =>
      expect(body.querySelector('.annotate__cell--failed')!.getAttribute('title')).toMatch(
        /not a whole number/,
      ),
    )
    expect(target.sent).toHaveLength(0)
    fireEvent.change(cell, { target: { value: '7' } })
    fireEvent.blur(cell)
    await waitFor(() => expect(target.value('row0', 'size')).toBe(7))
    expect(body.querySelector('.annotate__cell--failed')).toBeNull()
  })

  it('says how many neurons no tab serves', async () => {
    // Plain ids carry no dataset, so a tab serving only FlyWire serves none of them.
    const { body } = await open([{ ...SPEC, serves: 'flywire' }])
    await waitFor(() => expect(body.textContent).toContain('3 neurons no tab serves'))
    // Drawn as a loss, not as an ordinary part of the sentence.
    expect(body.querySelector('.annotate__loss')!.textContent).toBe('3 neurons no tab serves')
  })

  it('adds a tab, and keeps each tab’s settings its own', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    fireEvent.click(body.querySelector('[aria-label="Add a table or dataset"]')!)
    const tabs = () => [...body.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
    await waitFor(() => expect(tabs()).toEqual(['main_test / info_test', 'New table']))
    // The new tab is not set up, and says so; the first is untouched.
    expect(body.textContent).toContain('Set Base, Table, Key column.')
    fireEvent.click(body.querySelectorAll('[role="tab"]')[0]!)
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
  })

  it('sets one field on the rows ticked, and undoes them together', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const ticks = [...body.querySelectorAll<HTMLInputElement>('tbody .annotate__pick input')]
    fireEvent.click(ticks[0]!)
    fireEvent.click(ticks[2]!)
    const fill = await found('.annotate__fill', body)
    fireEvent.change(fill.querySelector('input')!, { target: { value: 'LC4a' } })
    fireEvent.click(fill.querySelector('button')!)
    await waitFor(() => expect(target.value('row0', 'cell_type')).toBe('LC4a'))
    expect([target.value('row1', 'cell_type'), target.value('row2', 'cell_type')]).toEqual([
      'T1',
      'LC4a',
    ])
    const undo = [...body.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
    await waitFor(() => expect(undo.disabled).toBe(false))
    fireEvent.click(undo)
    await waitFor(() => expect(target.value('row2', 'cell_type')).toBe('T2'))
    expect(target.value('row0', 'cell_type')).toBe('T0')
  })

  it('lists the fields alphabetically, case ignored', async () => {
    const names = (body: HTMLElement) =>
      [...body.querySelectorAll('.annotate__chooser label span')].map((e) => e.textContent)
    const { body } = await open()
    fireEvent.click(await found('.annotate__choose:not([disabled])', body))
    expect(names(body)).toEqual([
      'Brain_region',
      'cell_type',
      'cell_type_source',
      'root_id',
      'side',
      'size',
    ])
  })

  it('offers Clio’s datasets as a list once there is a token, and keeps one it does not list', async () => {
    setClioToken('abc')
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return new Response(url.endsWith('/v2/datasets') ? '{"CNS":{},"MANC":{}}' : '[]')
    })
    try {
      const clio = { ...newSpec(), backend: 'clio' as const, dataset: 'old-name' }
      registerAnnotationTarget({ backend: 'clio', dataset: 'old-name' }, target)
      const { body } = await open([clio])
      fireEvent.click(await found('.annotate__target', body))
      const select = (await found('select[aria-label="Dataset"]', body)) as HTMLSelectElement
      expect([...select.options].map((o) => o.textContent)).toEqual([
        'Choose a dataset…',
        'CNS',
        'MANC',
        'old-name (not listed by Clio)',
      ])
      expect(select.value).toBe('old-name')
    } finally {
      vi.unstubAllGlobals()
      resetClioCredentials()
    }
  })

  it('shows a Clio body nobody has annotated only once asked to, as an empty row it can write to', async () => {
    const clio = new MemoryTarget(FIELDS, [], { label: 'Clio · CNS', blanks: true })
    registerAnnotationTarget({ backend: 'clio', dataset: 'CNS' }, clio)
    const tab = {
      ...newSpec(),
      backend: 'clio' as const,
      dataset: 'CNS',
      fields: ['cell_type'],
    }
    // The records `open` makes go to the table, not to Clio: Clio holds nothing for these bodies.
    const { body, ids } = await open([tab])
    await waitFor(() => expect(body.textContent).toContain('3 not in this table'))
    // Marked as a loss, and the ids it means named on hover.
    const loss = body.querySelector<HTMLElement>('.annotate__loss')!
    expect(loss.textContent).toBe('3 not in this table')
    expect(loss.title).toBe(`No row for: ${ids.join(', ')}`)
    expect(inputs(body)).toHaveLength(0)
    act(() =>
      useGraphStore
        .getState()
        .setParam('an', 'targets', writeSpecs([{ ...tab, unannotated: true }])),
    )
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    expect(body.textContent).toContain('3 not annotated yet')
    expect(body.textContent).not.toContain('not in this table')
    fireEvent.change(inputs(body)[1]!, { target: { value: 'LC4a' } })
    fireEvent.blur(inputs(body)[1]!)
    await waitFor(() => expect(clio.value(ids[1]!, 'cell_type')).toBe('LC4a'))
  })

  it('refuses a CSV tab outright in a browser that cannot write to a file, settings and all', async () => {
    // jsdom has no File System Access picker, as Firefox and Safari have none.
    const { body } = await open([{ ...newSpec(), backend: 'csv' }])
    await waitFor(() => expect(body.textContent).toContain('needs a Chromium browser'))
    // The backend to switch away from, and nothing to fill in: no settings, no note asking for them.
    const labels = [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels).toEqual(['Backend'])
    expect(body.textContent).not.toContain('Set File')
  })

  it('edits a CSV file on disk, appending a row for a neuron it lacks once asked to', async () => {
    // A Chromium browser: one with the File System Access picker, which is what makes a CSV tab.
    vi.stubGlobal('showOpenFilePicker', async () => [])
    onTestFinished(() => void vi.unstubAllGlobals())
    const disk = { text: 'root_id,cell_type\n' }
    const fake = {
      kind: 'file',
      name: 'types.csv',
      // jsdom's File has no text(); the target asks only for that.
      getFile: async () => ({ text: async () => disk.text }),
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async () => {
        let next = ''
        return {
          write: async (chunk: string) => void (next += chunk),
          close: async () => void (disk.text = next),
        }
      },
    } as unknown as FileSystemFileHandle
    const tab = {
      ...newSpec(),
      backend: 'csv' as const,
      file: holdEditableFile(fake),
      fileName: 'types.csv',
      keyColumn: 'root_id',
      fields: ['cell_type'],
    }
    const { body, ids } = await open([tab])
    await waitFor(() => expect(body.textContent).toContain('3 not in this table'))
    act(() =>
      useGraphStore
        .getState()
        .setParam('an', 'targets', writeSpecs([{ ...tab, unannotated: true }])),
    )
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    fireEvent.change(inputs(body)[0]!, { target: { value: 'LC4a' } })
    fireEvent.blur(inputs(body)[0]!)
    await waitFor(() => expect(disk.text).toBe(`root_id,cell_type\n${ids[0]},LC4a\n`))
  })

  it('marks a cell edited once written, and unmarks it once undone', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const edited = () => [...body.querySelectorAll('.annotate__cell--edited')]
    expect(edited()).toHaveLength(0)
    fireEvent.change(inputs(body)[1]!, { target: { value: 'LC4a' } })
    fireEvent.blur(inputs(body)[1]!)
    await waitFor(() => expect(edited()).toHaveLength(1))
    expect(edited()[0]!.querySelector('input')!.value).toBe('LC4a')
    fireEvent.click([...body.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!)
    await waitFor(() => expect(target.value('row1', 'cell_type')).toBe('T1'))
    await waitFor(() => expect(edited()).toHaveLength(0))
  })

  it('keeps the rows ticked across a write, a settings edit and a Refresh, and reads again only for the Refresh', async () => {
    const reads = vi.spyOn(target, 'read')
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    const tick = () => body.querySelector<HTMLInputElement>('tbody .annotate__pick input')!
    fireEvent.click(tick())
    const cell = body.querySelectorAll<HTMLInputElement>('tbody input.annotate__input')[1]!
    fireEvent.change(cell, { target: { value: 'LC4a' } })
    fireEvent.blur(cell)
    await waitFor(() => expect(target.value('row1', 'cell_type')).toBe('LC4a'))
    // A new spec text, the same datasets served: re-parsed and re-routed, the same read.
    fireEvent.click(body.querySelector('.annotate__target')!)
    const serves = body.querySelector<HTMLInputElement>('input[aria-label="Serves"]')!
    fireEvent.change(serves, { target: { value: ' ' } })
    fireEvent.blur(serves)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(tick().checked).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)
    // Refresh reads again and keeps the ticks on the rows it brings back.
    fireEvent.click(body.querySelector('.annotate__refresh')!)
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(tick().checked).toBe(true))
  })

  it('offers nothing to edit while the canvas is locked', async () => {
    const { body } = await open()
    await waitFor(() => expect(inputs(body)).toHaveLength(3))
    act(() => useGraphStore.setState({ locked: true }))
    await waitFor(() => expect(inputs(body)).toHaveLength(0))
    expect(body.textContent).toContain('locked')
  })
})
