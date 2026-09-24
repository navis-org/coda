/**
 * CAVE: the datasets served by CAVE, a custom CAVE datastack, and the tools for its tables and
 * root ids.
 *
 * Part of Connectome (`parent`); see `packs/neuprint/index.ts` for where the dataset nodes are built.
 */

import type { PackDefinition } from '../../core/registry'
import { caveAnnotationNode } from '../../nodes/annotation'
import { datasetNodesFor } from '../../nodes/dataset'
import { caveTableInfoNode, caveTablesNode } from '../../nodes/dataset/caveTables'
import { updateRootIdsNode } from '../../nodes/transform/updateRootIds'

export const cave: PackDefinition = {
  id: 'cave',
  label: 'CAVE',
  description: 'Datasets served by CAVE, such as FlyWire, BANC and MICrONS, with their tables.',
  parent: 'connectome',
  keepsBuiltInIds: true,
  glyph: 'dataset.flywire',
  nodes: [
    ...datasetNodesFor('cave'),
    caveAnnotationNode,
    caveTablesNode,
    caveTableInfoNode,
    updateRootIdsNode,
  ],
}
