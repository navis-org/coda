// @vitest-environment jsdom

/**
 * The Upload Table card.
 *
 * What is worth driving here is the *state machine*, because three of its four states look
 * alike from the code and mean completely different things to somebody looking at a canvas:
 * nothing picked, looking for stored rows, and rows that are not in this browser. Collapsing
 * the middle one into the last would print "not stored in this browser" on every card for the
 * first frames of every load, which is exactly how a message that matters stops being read.
 *
 * The other half is the size ceiling, which has to refuse *before* reading — a check made
 * after `file.text()` has resolved is a check made after the tab has already stalled.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphNode } from '../../core/graph'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { MAX_UPLOAD_BYTES, putUpload, resetUploads } from '../../data/uploads'
import '../../nodes'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { UploadBody } from './UploadBody'

installJsdomStubs()

const CSV = 'root_id,cellType\n101,LC4\n102,LC6\n'

function node(params: Record<string, unknown> = {}): GraphNode {
  const def = requireNodeDef('core.uploadTable')
  return {
    id: 'up',
    type: 'core.uploadTable',
    position: { x: 0, y: 0 },
    params: { ...defaultParams(def), ...params } as GraphNode['params'],
  }
}

function drawIn(params: Record<string, unknown> = {}, compact = true) {
  const setParam = vi.fn()
  const onError = vi.fn()
  const graphNode = node(params)
  const ctx = makeInferContext(requireNodeDef('core.uploadTable'), graphNode.params, {})
  const utils = render(
    <UploadBody
      node={graphNode}
      ctx={ctx}
      compact={compact}
      setParam={setParam}
      onError={onError}
    />,
  )
  return { setParam, onError, ...utils }
}

const draw = drawIn

/** A File whose `size` can be lied about, which is the only way to reach the ceiling. */
function fakeFile(name: string, text: string, size = text.length): File {
  const file = new File([text], name, { type: 'text/csv' })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  // jsdom's File has no `text()` in every version; the body only ever calls that one.
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(text),
    configurable: true,
  })
  return file
}

function pick(file: File) {
  const input = screen.getByLabelText('Choose a CSV file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetUploads()
})
afterEach(cleanup)

describe('the four states', () => {
  it('asks for a file when there is none, and offers no controls yet', () => {
    draw()
    expect(screen.getByText(/No file yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose CSV…' })).toBeTruthy()
    // The ID column picker over a file that does not exist would be an empty dropdown.
    expect(screen.queryByText('ID column')).toBeNull()
  })

  it('says it is looking while the peek has not answered', async () => {
    const id = await putUpload('a.csv', tableFromRows(tableSchema(column('a', 'i64')), [{ a: 1 }]), 8)
    resetUploads()
    draw({ dataId: id, fileName: 'a.csv' })
    // The state a reload passes through. Not the same claim as "it is not here".
    expect(screen.getByText(/Looking for the stored rows/)).toBeTruthy()
    expect(screen.queryByText(/not stored in this browser/)).toBeNull()
  })

  it('names the file and its shape once the rows are found', async () => {
    const id = await putUpload(
      'annotations.csv',
      tableFromRows(tableSchema(column('root_id', 'i64'), column('cellType', 'str')), [
        { root_id: 101, cellType: 'LC4' },
      ]),
      2048,
    )
    draw({ dataId: id, fileName: 'annotations.csv' })
    expect(screen.getByText('annotations.csv')).toBeTruthy()
    expect(screen.getByText(/1 × 2 · 2 kB/)).toBeTruthy()
    // The controls appear only now: they are pickers over columns that now exist.
    expect(screen.getByText('ID column')).toBeTruthy()
    expect(screen.getByText('Text columns')).toBeTruthy()
  })

  it('tells a colleague what to do when the rows are on somebody else’s machine', async () => {
    const id = await putUpload('a.csv', tableFromRows(tableSchema(column('a', 'i64')), [{ a: 1 }]), 8)
    // A different browser: the graph still holds the reference, the database does not hold
    // the rows. This is the whole cost of keeping uploads out of the .coda.json.
    globalThis.indexedDB = new IDBFactory()
    resetUploads()
    draw({ dataId: id, fileName: 'annotations.csv' })

    const absent = await screen.findByText(/not stored in this browser/)
    expect(absent.textContent).toContain('annotations.csv')
    // An instruction, not a fault report.
    expect(absent.textContent).toMatch(/choose the file again/i)
  })
})

describe('bringing data in', () => {
  it('parses a picked file and points the node at it', async () => {
    const { setParam, onError } = draw()
    pick(fakeFile('annotations.csv', CSV))

    await waitFor(() => expect(setParam).toHaveBeenCalledWith('fileName', 'annotations.csv'))
    const dataId = setParam.mock.calls.find((c) => c[0] === 'dataId')?.[1]
    expect(String(dataId)).toMatch(/^u_/)
    expect(onError).not.toHaveBeenCalled()
  })

  it('refuses an oversized file before reading a byte of it', async () => {
    const { setParam, onError } = draw()
    const huge = fakeFile('embedding.csv', CSV, MAX_UPLOAD_BYTES + 1)
    // If the ceiling were checked after `text()` resolved, the tab would already have stalled.
    Object.defineProperty(huge, 'text', {
      value: () => Promise.reject(new Error('must not be read')),
    })
    pick(huge)

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0]![0])).toMatch(/over the .* limit/)
    expect(setParam).not.toHaveBeenCalled()
  })

  it('refuses a file with nothing in it rather than storing an empty table', async () => {
    const { setParam, onError } = draw()
    pick(fakeFile('empty.csv', ''))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0]![0])).toContain('no rows')
    expect(setParam).not.toHaveBeenCalled()
  })

  it('reports a ragged import once rather than badging the node forever', async () => {
    // A fact about the import, not about the node's configuration — so it goes through the
    // error channel at the moment it happens and the rows still land.
    const { setParam, onError } = draw()
    pick(fakeFile('ragged.csv', 'a,b,c\n1,2,3\n4,5\n'))
    await waitFor(() => expect(setParam).toHaveBeenCalledWith('fileName', 'ragged.csv'))
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/padded with blanks/)
  })

  it('takes pasted rows through exactly the same path as a file', async () => {
    const { setParam } = draw()
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    fireEvent.change(screen.getByLabelText('Paste delimited rows'), { target: { value: CSV } })
    fireEvent.click(screen.getByRole('button', { name: 'Use these rows' }))

    await waitFor(() => expect(setParam).toHaveBeenCalledWith('fileName', 'Pasted rows'))
    // Same store, so the same content address: pasting a file's contents and picking the file
    // are the same import and must not produce two cache entries.
    const pastedId = setParam.mock.calls.find((c) => c[0] === 'dataId')?.[1]
    const fromFile = await putUpload(
      'annotations.csv',
      tableFromRows(tableSchema(column('root_id', 'i64'), column('cellType', 'str')), [
        { root_id: 101, cellType: 'LC4' },
        { root_id: 102, cellType: 'LC6' },
      ]),
      CSV.length,
    )
    expect(pastedId).toBe(fromFile)
  })
})

describe('the overlay', () => {
  it('lists the columns and their types, which is what the expand button is for', async () => {
    const id = await putUpload(
      'annotations.csv',
      tableFromRows(tableSchema(column('root_id', 'i64'), column('cellType', 'str')), [
        { root_id: 101, cellType: 'LC4' },
      ]),
      64,
    )
    const { container } = drawIn({ dataId: id, fileName: 'annotations.csv' }, false)
    // Scoped to the listing: `root_id` is also an option in the ID column dropdown, and a
    // bare query would pass on that alone without the table ever being rendered.
    const listing = container.querySelector('.upload-body__schema')!
    expect(within(listing as HTMLElement).getByText('root_id')).toBeTruthy()
    expect(within(listing as HTMLElement).getByText('i64')).toBeTruthy()
    expect(within(listing as HTMLElement).getByText('cellType')).toBeTruthy()
  })

  it('keeps that listing off the card, where it would not fit', async () => {
    const id = await putUpload(
      'annotations.csv',
      tableFromRows(tableSchema(column('root_id', 'i64'), column('cellType', 'str')), [
        { root_id: 101, cellType: 'LC4' },
      ]),
      64,
    )
    const { container } = drawIn({ dataId: id, fileName: 'annotations.csv' }, true)
    expect(container.querySelector('.upload-body__schema')).toBeNull()
  })
})
