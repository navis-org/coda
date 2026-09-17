/**
 * The Upload Mesh node.
 *
 * Thin, like its sibling — one IndexedDB read and a scale — so what is worth pinning is
 * everything that follows from the geometry living outside the graph, plus the two things that
 * are this node's own:
 *
 *  - **Units are applied at the node, not at the upload.** The stored geometry is in the file's
 *    own numbers, so getting the control wrong costs a re-run rather than a re-pick — and the
 *    param is in the provenance key, which is what makes that re-run happen at all.
 *  - **The output is interchangeable with `ROI Meshes`'.** Same `roi`/`primary` columns under
 *    the same names, because everything downstream addresses them by name: a `Points in Volumes`
 *    that needed configuring differently depending on where its shells came from would defeat
 *    the point of the node.
 *  - **Missing geometry is an instruction, not a crash.** This is what a graph opened on another
 *    machine does, and the message has to name the files rather than the content hash.
 *  - **The content address is the provenance.** Re-picking the same files must re-run nothing; a
 *    different set must invalidate. There is no `refresh` nonce holding that up.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { attributeSchema, columnNames } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import { isMeshesValue, tableFromRows } from '../../core/values'
import { ROI_MESH_SCHEMA } from '../../data/source'
import { putMeshUpload, putUpload, resetUploads, uploadPeekSettled } from '../../data/uploads'
import '../index'
import { node } from '../../test/graph'
import { sourcelessScheduler } from '../../test/scheduler'
import { tetra } from '../../test/meshes'

function graph(params: Record<string, unknown> = {}): CodaGraph {
  return addNode(emptyGraph('upload-mesh-test'), node('up', 'core.uploadMesh', params))
}

async function stored(label = '2 files'): Promise<string> {
  return putMeshUpload(label, [tetra('LO_R', 'LO_R.obj'), tetra('ME_R', 'ME_R.stl')], 512)
}

function contextFor(g: CodaGraph) {
  const def = requireNodeDef('core.uploadMesh')
  const up = g.nodes.find((n) => n.id === 'up')!
  return makeInferContext(def, up.params, inferGraph(g).nodes['up']!.inputs)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetUploads()
})

describe('core.uploadMesh', () => {
  it('hands back one mesh per file, named after the file', async () => {
    const scheduler = sourcelessScheduler()
    await scheduler.run(graph({ dataId: await stored() }), { mode: 'full' })

    const out = scheduler.output('up', 'meshes')
    if (!isMeshesValue(out)) throw new Error('expected meshes')
    expect(out.items.map((item) => item.id)).toEqual(['LO_R', 'ME_R'])
    expect(out.attributes.data['roi']).toEqual(['LO_R', 'ME_R'])
    expect(out.attributes.data['file']).toEqual(['LO_R.obj', 'ME_R.stl'])
    // True throughout, for the reason the precomputed and CATMAID sources give: nothing in a
    // pile of files says which shells nest, and `primary` is the licence to sum.
    expect(out.attributes.data['primary']).toEqual([true, true])
  })

  it('names its columns what ROI Meshes names its own, which is the whole point', () => {
    /*
     * Everything downstream addresses columns by name, so a custom shell has to be the same kind
     * of thing as a fetched one — `Points in Volumes` reads `roi` with no configuration, and the
     * 3D View's Volumes socket colours by `primary`. `file` is the one this adds.
     */
    const out = inferGraph(graph()).nodes['up']?.outputs['meshes']
    const columns = attributeSchema(out)?.columns ?? []
    /*
     * Whole columns rather than names: a rename is the obvious drift and a **dtype** change is the
     * quiet one. `primary` is `bool`, and `ColorBy`'s `dtypes` filtering is a function of dtype —
     * so `bool → str` on one side would leave the 3D View's Volumes picker offering different
     * options depending on where the shells came from, with every name still matching.
     */
    expect(columns.slice(0, ROI_MESH_SCHEMA.columns.length)).toEqual(ROI_MESH_SCHEMA.columns)
    expect(columnNames({ columns })).toEqual([...columnNames(ROI_MESH_SCHEMA), 'file'])
  })

  it('advertises that schema before anything is picked, let alone run', () => {
    // Constant rather than peeked, like `ROI Meshes`': a colour picker downstream populates the
    // moment the wire is made rather than after a file is chosen.
    const out = inferGraph(graph({ dataId: '' })).nodes['up']?.outputs['meshes']
    expect(columnNames(attributeSchema(out))).toContain('roi')
  })

  it('scales into nanometres, and says so on the value', async () => {
    const id = await stored()
    const scheduler = sourcelessScheduler()
    await scheduler.run(graph({ dataId: id, units: 'um' }), { mode: 'full' })

    const out = scheduler.output('up', 'meshes')
    if (!isMeshesValue(out)) throw new Error('expected meshes')
    // A micron is a thousand nanometres, and the unit tetrahedron's far corner is at 1.
    expect(out.items[0]?.positions[3]).toBeCloseTo(1_000)
    expect(out.bounds.max[0]).toBeCloseTo(1_000)
    expect(out.units).toBe('nm')
  })

  it('leaves a nanometre file exactly as the file wrote it', async () => {
    const scheduler = sourcelessScheduler()
    await scheduler.run(graph({ dataId: await stored() }), { mode: 'full' })
    const out = scheduler.output('up', 'meshes')
    if (!isMeshesValue(out)) throw new Error('expected meshes')
    expect(out.items[0]?.positions[3]).toBe(1)
  })

  it('re-runs when the units change, because the geometry does', async () => {
    /*
     * The half that makes applying units *here* rather than at the upload work: it is an
     * ordinary param in the provenance key, so a corrected control invalidates everything
     * downstream. Baked in at ingest it would need the files picked again.
     */
    const id = await stored()
    const scheduler = sourcelessScheduler()
    const first = graph({ dataId: id, units: 'nm' })
    await scheduler.run(first, { mode: 'full' })
    const before = scheduler.output('up', 'meshes')

    const second = setNodeParam(first, 'up', 'units', 'mm')
    await scheduler.run(second, { mode: 'full' })
    const after = scheduler.output('up', 'meshes')
    if (!isMeshesValue(before) || !isMeshesValue(after)) throw new Error('expected meshes')
    expect(after.items[0]?.positions[3]).toBeCloseTo(1_000_000)
  })

  it('does not re-run when only the label changes', async () => {
    // `fileName` is `presentational`: two people picking one file under two labels hold
    // identical geometry, and in the key a rename would invalidate everything downstream.
    const id = await stored()
    const scheduler = sourcelessScheduler()
    const first = graph({ dataId: id, fileName: '2 files' })
    await scheduler.run(first, { mode: 'full' })
    const before = scheduler.output('up', 'meshes')

    await scheduler.run(setNodeParam(first, 'up', 'fileName', 'my regions'), { mode: 'full' })
    // The same object, not an equal one: a cache hit rather than a re-run.
    expect(scheduler.output('up', 'meshes')).toBe(before)
  })

  it('re-picking the same files re-runs nothing, a different set invalidates', async () => {
    // What the content address buys, and why there is no `refresh` nonce.
    const again = await stored()
    const other = await putMeshUpload('one file', [tetra('AL_R', 'AL_R.ply')], 64)
    expect(await stored()).toBe(again)
    expect(other).not.toBe(again)
  })

  it('tells somebody to pick the files again rather than throwing a hash at them', async () => {
    // What a graph opened on another machine does. The id is a content hash nobody can act on;
    // the filename is the thing to go and find.
    const scheduler = sourcelessScheduler()
    await scheduler.run(graph({ dataId: 'm_nothing', fileName: 'glomeruli.obj' }), {
      mode: 'full',
    })
    const error = scheduler.info('up').error ?? ''
    expect(error).toContain('glomeruli.obj')
    expect(error).toMatch(/pick the files again/)
    expect(error).not.toContain('m_nothing')
  })

  it('says nothing while the peek is still looking, and starts the read that ends it', async () => {
    /*
     * Two halves, and the second is the one that shipped broken. "Not in this browser" over a
     * node that is about to fill itself in is the false alarm that stops a real one being read —
     * *and* `validate` is the only thing here that starts the read, because unlike Upload Table
     * this node's `inferOutputs` is constant and peeks nothing. Asked after `uploadPeekSettled`
     * it left the load unstarted, so a graph whose geometry really was absent said nothing until
     * somebody pressed Run. Only a headless caller can see it: the card peeks too.
     */
    const id = await stored()
    // The cold path a reload takes: a reference in the graph and an empty session mirror.
    resetUploads()
    const def = requireNodeDef('core.uploadMesh')
    const g = graph({ dataId: id, fileName: '2 files' })
    expect(def.validate!(contextFor(g))).toEqual([])

    await vi.waitFor(() => expect(uploadPeekSettled(id)).toBe(true))
    // And once it lands with the meshes there, still nothing: the instruction is for the absent
    // case, which the test above covers.
    expect(def.validate!(contextFor(g))).toEqual([])
  })

  it('refuses an id belonging to an uploaded *table*, rather than waiting forever', async () => {
    /*
     * The two ids are indistinguishable strings, so a node pointed at the wrong one — a
     * hand-edited file, a copied param — has to reach its own "pick the files again" rather than
     * sit on "looking…" for a read that has already landed. `peekMeshUpload` asks the *kind*,
     * which is what makes that fall out.
     */
    const tableId = await putUpload(
      'annotations.csv',
      tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: '1' }]),
      64,
    )
    const def = requireNodeDef('core.uploadMesh')
    const g = graph({ dataId: tableId, fileName: 'annotations.csv' })
    expect(def.validate!(contextFor(g)).join(' ')).toMatch(/not stored in this browser/)
  })

  it('asks for a file before it asks for anything else', () => {
    const def = requireNodeDef('core.uploadMesh')
    expect(def.validate!(contextFor(graph()))).toEqual([
      'No mesh chosen — use the button on the node',
    ])
  })

  it('is cheap, and reaches no data source at all', () => {
    // One IndexedDB read of already-parsed geometry — no network, so nothing here is a request
    // per keystroke at a shared server. `makeScheduler` throws if a source is ever asked for.
    const def = requireNodeDef('core.uploadMesh')
    expect(def.cost).toBe('cheap')
    expect(def.inputs).toEqual([])
  })
})
