/**
 * Connectome: the nodes about synaptic connectivity — who connects to whom, how strongly, by what
 * path, and how two connectomes compare.
 *
 * On by default, being most of what Coda is used for, and the pack other packs build on (Cortex
 * will require its CAVE part, which brings it). The first pack moved rather than written, and the first to keep its nodes'
 * **built-in ids** (`keepsBuiltInIds`): twelve nodes named some four hundred times across source,
 * tests and help, where a rename would have changed nothing a reader sees. So their glyphs, help
 * documents, emitters and See also groups stay where they were — each is keyed by the id, which did
 * not move — and only the node modules live here. See `docs/packs.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { adjacencyNode } from './adjacency'
import { compareConnectivityNode } from './compareConnectivity'
import { connectivityNode } from './connectivity'
import { influenceNode } from './influence'
import { matchTypesNode } from './matchTypes'
import { partnerVectorsNode } from './partnerVectors'
import { pathsNode } from './paths'
import { roiConnectivityNode } from './roiConnectivity'
import { synapseEdgesNode } from './synapseEdges'
import { synapsesBetweenNode, synapsesNode } from './synapses'
import { synblastNode } from './synblast'

export const connectome: PackDefinition = {
  id: 'connectome',
  label: 'Connectome',
  description:
    'Synaptic connectivity: partners, paths, influence, synapses, and comparing connectomes.',
  keepsBuiltInIds: true,
  glyph: 'neuron.connectivity',
  // The order these twelve registered in before they moved, so they keep it among themselves.
  nodes: [
    connectivityNode,
    pathsNode,
    influenceNode,
    adjacencyNode,
    roiConnectivityNode,
    synapsesNode,
    synapsesBetweenNode,
    synapseEdgesNode,
    synblastNode,
    partnerVectorsNode,
    matchTypesNode,
    compareConnectivityNode,
  ],
}
