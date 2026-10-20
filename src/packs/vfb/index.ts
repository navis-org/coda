/**
 * Virtual Fly Brain: what VFB knows about the neurons of a connectome.
 *
 * Off by default, reached by `/vfb`. The direction it exists for is connectome → VFB: start from
 * neurons already on the canvas and bring in their VFB types and the papers that describe them,
 * then the driver lines and images that label them. `docs/vfb-plan.md` is the design
 * record. The data layer it reads through stays in `src/data/vfb`, a transport being a fact about
 * the backend rather than about which pack draws on it.
 *
 * Requires nothing: the bridge to a connectome is a neuron-id column and a Dataset wire, both
 * built in.
 */

import type { PackDefinition } from '../../core/registry'
import { expressionNode } from './expression'
import { galleryNode } from './gallery'
import { imagesNode } from './images'
import { infoNode } from './info'
import { linesNode } from './lines'
import { neuronsNode } from './neurons'
import { publicationsNode } from './publications'

export const vfb: PackDefinition = {
  id: 'vfb',
  label: 'Virtual Fly Brain',
  description:
    'Look connectome neurons up in Virtual Fly Brain: their FBbt cell types, the papers that describe them, and the driver lines that label them, drawn beside the EM.',
  defaultOn: false,
  glyph: 'vfb:neurons',
  nodes: [
    neuronsNode,
    infoNode,
    publicationsNode,
    linesNode,
    imagesNode,
    galleryNode,
    expressionNode,
  ],
}
