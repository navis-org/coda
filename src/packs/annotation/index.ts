/**
 * Cell typing/annotation tools: the nodes for typing and annotating cells, of which a BigClust2
 * project — the desktop explorer for embeddings of whole connectomes — is one piece.
 *
 * `annotation:editor` (Annotate) edits a selection's annotations in FlyTable, SeaTable or Clio.
 * `annotation:bigclust` reads a project folder — its neurons with every embedding's coordinates, the
 * k-NN graph and the feature vectors — so Scatter Plot, Embedding and the rest of Coda can work on
 * what BigClust shows. The reading is `src/data/bigclust`: the format and the transport are facts
 * about the project, not about which pack draws on them.
 */

import type { PackDefinition } from '../../core/registry'
import { projectNode } from './bigclust'
import { editorNode } from './editor'

export const annotation: PackDefinition = {
  id: 'annotation',
  label: 'Cell typing/annotation tools',
  description:
    'Tools for typing and annotating cells: BigClust projects (embeddings of whole connectomes with their k-NN graphs and feature vectors) and an editor for annotations in FlyTable, SeaTable or Clio.',
  glyph: 'annotation:bigclust',
  // Off for somebody who has never touched its switch: these are a specialist's tools.
  defaultOn: false,
  nodes: [projectNode, editorNode],
}
