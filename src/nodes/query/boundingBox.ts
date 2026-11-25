/**
 * Bounding Box: a box somebody types, as Volumes and as a neuroglancer layer.
 *
 * Two outputs because the box goes two places. `Volumes` is a one-item mesh set, so `Points in
 * Volumes` asks "which synapses are in this box" with no change to that node, and the 3D View
 * draws it beside the neurons. `Layers` is the same box as a neuroglancer annotation, chained the
 * way every layer node chains (a `Layers` input passed on with this one added), for the
 * Neuroglancer card's `Extra layers`.
 *
 * `cheap`: no fetch, and the work is eight corners. The parse, the units and the mesh are
 * `nodes/lib/boundingBox.ts`', shared with both exporters.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { LayersValue, MeshesValue } from '../../core/values'
import { layersFrom, makeTable } from '../../core/values'
import { ROI_MESH_SCHEMA } from '../../data/source'
import { boxLayer, boxMesh, readBox } from '../lib/boundingBox'

registerNode({
  type: 'core.boundingBox',
  label: 'Bounding Box',
  category: 'utility',
  description:
    'A box you define by two corners, as Volumes for Points in Volumes and as a layer for Neuroglancer.',
  guide:
    'Defines an axis-aligned box from two opposite corners, typed or pasted from neuroglancer. ' +
    'Wire Volumes into Points in Volumes to find the synapses inside it, or into the 3D View to ' +
    'draw it, and Layers into the Neuroglancer card’s Extra layers. Neuroglancer usually shows ' +
    'positions in voxels, not nanometres: set Units to voxels and give the voxel size, or the box ' +
    'lands in the wrong place.',
  cost: 'cheap',
  inputs: [{ id: 'layers', label: 'Layers', type: T.layers(), required: false }],
  outputs: [
    { id: 'meshes', label: 'Volumes', type: T.meshes(ROI_MESH_SCHEMA) },
    { id: 'layers', label: 'Layers', type: T.layers() },
  ],
  params: [
    {
      id: 'cornerA',
      kind: 'string',
      label: 'Corner 1',
      placeholder: 'x, y, z',
      default: '',
      help: 'One corner of the box, as x, y, z. Paste it from neuroglancer’s position readout.',
    },
    {
      id: 'cornerB',
      kind: 'string',
      label: 'Corner 2',
      placeholder: 'x, y, z',
      default: '',
      help: 'The opposite corner. Which corner is which does not matter.',
    },
    {
      id: 'units',
      kind: 'enum',
      label: 'Units',
      default: 'nm',
      options: [
        { value: 'nm', label: 'nm' },
        { value: 'voxels', label: 'voxels' },
      ],
      help: 'What the corners are in. Neuroglancer usually shows voxels; Coda works in nanometres.',
    },
    {
      id: 'voxelSize',
      kind: 'string',
      label: 'Voxel size',
      placeholder: '4, 4, 40',
      default: '',
      visibleIf: (params) => params.units === 'voxels',
      help: 'Size of one voxel in nanometres, as x, y, z: 4, 4, 40 on FlyWire, 8, 8, 8 on MANC and the hemibrain.',
    },
    {
      id: 'name',
      kind: 'string',
      label: 'Name',
      placeholder: 'box',
      default: 'box',
      help: 'What Points in Volumes writes in its column for points inside, and the layer’s name in neuroglancer.',
    },
  ],

  // Constant, like `ROI Meshes`' and `Upload Mesh`'s: the box's columns are the region schema's.
  inferOutputs: () => ({ meshes: T.meshes(ROI_MESH_SCHEMA), layers: T.layers() }),

  // `evaluate` throws the same sentence, so a run changes nothing about what the card says.
  validate: (ctx) => {
    const read = readBox(ctx.params)
    if ('error' in read) return [read.error]
    return read.warning ? [read.warning] : []
  },

  evaluate: (ctx) => {
    const read = readBox(ctx.params)
    if ('error' in read) throw new Error(read.error)
    const { box, name } = read

    const meshes: MeshesValue = {
      kind: 'meshes',
      items: [boxMesh(box, name)],
      attributes: makeTable(ROI_MESH_SCHEMA, { roi: [name], primary: [true] }),
      bounds: box,
      // Nanometres by construction: `readBox` has already multiplied voxels out. No `space`, as
      // `Upload Mesh` has none — a typed box says nothing about which template it was read in.
      units: 'nm',
    }
    const layers: LayersValue = {
      kind: 'layers',
      items: [...layersFrom(ctx.input('layers')), boxLayer(box, name)],
    }
    return { meshes, layers }
  },
})
