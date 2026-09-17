// @vitest-environment jsdom

/**
 * The Upload Mesh card.
 *
 * `uploadBody.test.tsx`'s counterpart, and the four states are shared code now
 * (`useUploadState`), so what is driven here is what this card does differently:
 *
 *  - **Several files at once, each one mesh.** A region set is a directory, so the picker is
 *    `multiple` and a file becomes an item named after its own stem.
 *  - **A file that is not a mesh is skipped, not fatal.** A directory of shells with a
 *    `README.txt` in it should import the shells and say what it left — `fetchRoiMeshSet`'s rule
 *    for a region the server has no shape for, which is the same situation.
 *  - **The bytes are read here.** `File` is DOM and `src/nodes` is headless, so the parse and
 *    the size ceiling both live on this side; the node only ever loads what is already stored.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphNode } from '../../core/graph'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MAX_UPLOAD_BYTES, putMeshUpload, resetUploads } from '../../data/uploads'
import '../../nodes'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { tetra } from '../../test/meshes'
import { UploadMeshBody } from './UploadMeshBody'

installJsdomStubs()

/** A tetrahedron as OBJ — four vertices, four faces, and small enough to read. */
const OBJ = [
  'v 0 0 0',
  'v 1 0 0',
  'v 0 1 0',
  'v 0 0 1',
  'f 1 2 3',
  'f 1 2 4',
  'f 1 3 4',
  'f 2 3 4',
]
  .join('\n')
  .concat('\n')

function node(params: Record<string, unknown> = {}): GraphNode {
  const def = requireNodeDef('core.uploadMesh')
  return {
    id: 'up',
    type: 'core.uploadMesh',
    position: { x: 0, y: 0 },
    params: { ...defaultParams(def), ...params } as GraphNode['params'],
  }
}

function draw(params: Record<string, unknown> = {}, compact = true) {
  const setParam = vi.fn()
  const onError = vi.fn()
  const graphNode = node(params)
  const ctx = makeInferContext(requireNodeDef('core.uploadMesh'), graphNode.params, {})
  const utils = render(
    <UploadMeshBody
      node={graphNode}
      ctx={ctx}
      compact={compact}
      setParam={setParam}
      onError={onError}
    />,
  )
  return { setParam, onError, ...utils }
}

/**
 * A File whose `size` can be lied about, which is the only way to reach the ceiling.
 *
 * No `arrayBuffer` stub: `installJsdomStubs` polyfills `Blob.prototype.arrayBuffer` and `File`
 * extends `Blob`, so the card's real path to bytes is exercised rather than replaced.
 */
function fakeFile(name: string, text: string, size = text.length): File {
  const file = new File([text], name)
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function pick(...files: File[]) {
  const input = screen.getByLabelText('Choose mesh files') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetUploads()
})
afterEach(cleanup)

describe('picking meshes', () => {
  it('asks for files when there are none, and offers no controls yet', () => {
    draw()
    expect(screen.getByText(/No mesh yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose meshes…' })).toBeTruthy()
    // The Units picker over files that do not exist would be a control about nothing.
    expect(screen.queryByText('Units')).toBeNull()
  })

  it('takes several files at once, one mesh each, named after the file', async () => {
    const { setParam } = draw()
    pick(fakeFile('LO_R.obj', OBJ), fakeFile('ME_R.obj', OBJ))

    await waitFor(() => expect(setParam).toHaveBeenCalledWith('fileName', '2 files'))
    const id = setParam.mock.calls.find((call) => call[0] === 'dataId')?.[1]
    expect(typeof id).toBe('string')

    // Re-drawn against the stored upload, which is what the card would show after the write.
    cleanup()
    draw({ dataId: id, fileName: '2 files' }, false)
    await waitFor(() => expect(screen.getByText(/2 meshes/)).toBeTruthy())
    expect(screen.getByText('LO_R')).toBeTruthy()
    expect(screen.getByText('ME_R')).toBeTruthy()
  })

  it('names a single file by itself rather than as "1 files"', async () => {
    // The label is what the card shows and what the exporters quote, so one file keeps its own
    // name; only a pick of several gets counted.
    const { setParam } = draw()
    pick(fakeFile('LO_R.obj', OBJ))
    await waitFor(() => expect(setParam).toHaveBeenCalledWith('fileName', 'LO_R.obj'))
  })

  it('skips a file that is not a mesh and imports the rest, saying which', async () => {
    const { setParam, onError } = draw()
    pick(fakeFile('README.txt', 'these are my regions\n'), fakeFile('LO_R.obj', OBJ))

    await waitFor(() => expect(setParam).toHaveBeenCalledWith('dataId', expect.any(String)))
    expect(String(onError.mock.calls[0]?.[0])).toContain('README.txt')
    // One mesh, not two — and the surviving one is the real one.
    const id = setParam.mock.calls.find((call) => call[0] === 'dataId')?.[1]
    cleanup()
    draw({ dataId: id, fileName: '2 files' })
    await waitFor(() => expect(screen.getByText(/1 mesh/)).toBeTruthy())
  })

  it('refuses when nothing picked was a mesh, naming the first reason', async () => {
    const { setParam, onError } = draw()
    pick(fakeFile('notes.txt', 'nothing here\n'))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/no vertices/)
    // Nothing is stored and the node is left pointing where it was.
    expect(setParam).not.toHaveBeenCalledWith('dataId', expect.any(String))
  })

  it('refuses a pick too large to parse, before a byte is read', async () => {
    /*
     * The check is against the files' own sizes — after `arrayBuffer()` resolves is after the tab
     * has already stalled. Summed over the selection, because what the parse holds at once is
     * the whole of what was picked.
     */
    const { setParam, onError } = draw()
    const half = MAX_UPLOAD_BYTES * 0.6
    pick(fakeFile('a.obj', OBJ, half), fakeFile('b.obj', OBJ, half))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/2 files come to/)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/Decimate the mesh/)
    expect(setParam).not.toHaveBeenCalled()
  })

  it('tells somebody whose geometry is elsewhere what to do about it', async () => {
    // What a colleague opening a shared link sees. It has to read as an instruction, not a
    // fault: the files are on the sender's machine and the fix is to pick them here.
    draw({ dataId: 'm_nothing', fileName: 'glomeruli.obj' })
    await waitFor(() => expect(screen.getByText(/is not stored in this browser/)).toBeTruthy())
    expect(screen.getByText(/glomeruli\.obj/)).toBeTruthy()
    expect(screen.getByText(/choose the files again/)).toBeTruthy()
  })

  it('keeps the per-region listing off the card and in the overlay', async () => {
    const id = await putMeshUpload('2 files', [tetra('LO_R'), tetra('ME_R')], 512)
    draw({ dataId: id, fileName: '2 files' }, true)
    await waitFor(() => expect(screen.getByText(/2 meshes/)).toBeTruthy())
    // Sixty region names do not belong on a 300px card; the expand button is what they are for.
    expect(screen.queryByText('Region')).toBeNull()

    cleanup()
    draw({ dataId: id, fileName: '2 files' }, false)
    await waitFor(() => expect(screen.getByText('Region')).toBeTruthy())
    expect(screen.getByText('LO_R')).toBeTruthy()
  })

  it('draws the Units control once there is something for it to be about', async () => {
    const id = await putMeshUpload('one', [tetra('LO_R')], 64)
    draw({ dataId: id, fileName: 'LO_R.obj' })
    await waitFor(() => expect(screen.getByText('Units')).toBeTruthy())
  })
})
