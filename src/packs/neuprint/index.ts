/**
 * neuPrint: the datasets Janelia publishes on neuPrint, a custom neuPrint server, and Raw Cypher.
 *
 * Part of Connectome (`parent`): off with it, and switchable on its own beneath it. The nodes are
 * built where every dataset node is built — `nodes/dataset`, from the family table, the synthetic
 * Demo Data staying built in — and this lists the ones that are neuPrint's. Their ids are the
 * built-in ones they always had (`keepsBuiltInIds`). See `docs/packs.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { datasetNodesFor } from '../../nodes/dataset'
import { rawCypherNode } from '../../nodes/query/rawCypher'

export const neuprint: PackDefinition = {
  id: 'neuprint',
  label: 'neuPrint',
  description: 'Datasets published on neuPrint, such as the hemibrain, MaleCNS and MANC.',
  parent: 'connectome',
  keepsBuiltInIds: true,
  glyph: 'dataset.hemibrain',
  nodes: [...datasetNodesFor('neuprint'), rawCypherNode],
}
