/**
 * 3D morphology viewer node.
 *
 * Three typed inputs — skeletons, meshes, synapse points — each with its own colour
 * encoding, so you can colour neurons by cell type while colouring their synapses by
 * polarity in the same scene.
 *
 * Only `skeletons` is required; a scene of meshes alone is legitimate, so the requirement
 * sits on validation rather than on the ports (see `validate`).
 */

import type { InferContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, attributeSchema, column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isMeshesValue, isPointsValue, isSkeletonsValue, makeTable } from '../../core/values'
import { colorParams } from '../lib/encodingParams'
import { rowsWithIds } from '../lib/tableOps'

const FALLBACK_SCHEMA: TableSchema = tableSchema(column('bodyId', 'i64'))

/** The attribute table the selection is drawn from — skeletons first, then meshes. */
function selectionSourceSchema(ctx: InferContext): TableSchema {
  return (
    attributeSchema(ctx.inputs.skeletons) ??
    attributeSchema(ctx.inputs.meshes) ??
    FALLBACK_SCHEMA
  )
}

export const viewer3dNode = registerNode({
  type: 'out.viewer3d',
  label: '3D View',
  category: 'visualisation',
  description: 'Render skeletons, meshes and synapses in 3D, with data-driven colour.',
  guide:
    'Skeletons, meshes and synapse points in one 3D scene, each with its own colour encoding — so neurons can be coloured by cell type while their synapses are coloured by polarity, in the same space. Only one of the three sockets needs filling; a scene of meshes alone is a perfectly good thing to look at. Everything arrives in nanometres, so geometry from different queries lines up.',
  cost: 'cheap',
  inputs: [
    { id: 'skeletons', label: 'Skeletons', type: T.skeletons(), required: false },
    { id: 'meshes', label: 'Meshes', type: T.meshes(), required: false },
    { id: 'points', label: 'Points', type: T.points(), required: false },
  ],
  outputs: [{ id: 'selected', label: 'Selected', type: T.neurons() }],
  params: [
    ...colorParams({
      prefix: 'skeleton',
      from: 'skeletons',
      label: 'Skeleton colour',
      defaultMode: 'categorical',
    }),
    {
      id: 'skeletonWidth',
      kind: 'number',
      label: 'Line width',
      default: 1,
      min: 0.5,
      max: 6,
      step: 0.5,
      presentational: true,
      advanced: true,
    },
    ...colorParams({
      prefix: 'mesh',
      from: 'meshes',
      label: 'Mesh colour',
      defaultMode: 'constant',
      defaultColor: 'muted',
      advanced: true,
    }),
    {
      id: 'meshOpacity',
      kind: 'number',
      label: 'Mesh opacity',
      default: 0.25,
      min: 0.02,
      max: 1,
      step: 0.05,
      presentational: true,
      advanced: true,
    },
    ...colorParams({
      prefix: 'point',
      from: 'points',
      label: 'Point colour',
      defaultMode: 'categorical',
      defaultColor: '1',
    }),
    {
      id: 'pointSize',
      kind: 'number',
      label: 'Point size',
      default: 60,
      min: 5,
      max: 500,
      step: 5,
      presentational: true,
      advanced: true,
    },
    {
      id: 'background',
      kind: 'enum',
      label: 'Background',
      default: 'theme',
      presentational: true,
      advanced: true,
      options: [
        { value: 'theme', label: 'follow theme' },
        { value: 'dark', label: 'dark' },
        { value: 'light', label: 'light' },
      ],
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'neurons',
      default: [],
      help: 'Set by clicking neurons in the viewer. Feeds the Selected output.',
    },
  ],

  inferOutputs: (ctx) => ({ selected: T.neurons(selectionSourceSchema(ctx)) }),

  validate: (ctx) => {
    const hasAny = ctx.inputs.skeletons ?? ctx.inputs.meshes ?? ctx.inputs.points
    if (!hasAny) return ['Connect skeletons, meshes or points to see anything']
    return []
  },

  evaluate: (ctx) => {
    const skeletons = ctx.input('skeletons')
    const meshes = ctx.input('meshes')
    const points = ctx.input('points')

    if (!isSkeletonsValue(skeletons) && !isMeshesValue(meshes) && !isPointsValue(points)) {
      throw new Error('Nothing connected to render')
    }

    // Selection resolves against whichever attribute table has one row per neuron. Points
    // are excluded on purpose: their rows are synapses, not neurons.
    const attributes: TableValue | undefined = isSkeletonsValue(skeletons)
      ? skeletons.attributes
      : isMeshesValue(meshes)
        ? meshes.attributes
        : undefined

    if (!attributes) {
      return { selected: makeTable(FALLBACK_SCHEMA, { bodyId: [] }, 'neurons') }
    }
    return { selected: rowsWithIds(attributes, ctx.params.selection) }
  },
})
