/**
 * ZapBench: whole-brain calcium activity from the larval zebrafish, read from the public release.
 *
 * The first pack, and the one that proved the seams: the three nodes are registered here, and
 * the rest of what the pack brings is found by file — `glyphs.ts`, `seeAlso.ts` and the documents
 * in `help/`. The data layer it reads through stays in `src/data/zapbench`, a transport being a
 * fact about the backend rather than about which pack draws on it.
 */

import type { PackDefinition } from '../../core/registry'
import { neuronTracesNode } from './neuronTraces'
import { neuronsNode } from './neurons'
import { tracesNode } from './traces'

export const zapbench: PackDefinition = {
  id: 'zapbench',
  label: 'ZapBench',
  description:
    'Whole-brain calcium activity from the larval zebrafish, with its cells matched to neurons.',
  glyph: 'zapbench:traces',
  nodes: [neuronTracesNode, tracesNode, neuronsNode],
}
