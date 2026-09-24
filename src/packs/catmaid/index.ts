/**
 * CATMAID: the manually traced datasets on CATMAID servers, and a custom CATMAID project.
 *
 * Part of Connectome (`parent`); see `packs/neuprint/index.ts` for where the dataset nodes are built.
 */

import type { PackDefinition } from '../../core/registry'
import { datasetNodesFor } from '../../nodes/dataset'

export const catmaid: PackDefinition = {
  id: 'catmaid',
  label: 'CATMAID',
  description: 'Manually traced datasets on CATMAID servers, such as FAFB and the L1 larva.',
  parent: 'connectome',
  keepsBuiltInIds: true,
  glyph: 'dataset.catmaid.fafb',
  nodes: datasetNodesFor('catmaid'),
}
