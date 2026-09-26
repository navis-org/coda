/**
 * Cortex: tools for cortical neurons — the Cortex Gallery first, drawing a volume's cells side by
 * side against depth with the layers behind them.
 *
 * Off by default, being a tool for one kind of data; `/cortex` switches it on. It requires CAVE's
 * part, MICrONS being a CAVE datastack — which brings Connectome with it as CAVE's parent. The
 * frames it draws with are `frames.ts`, data per dataset. See `docs/cortex.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { depthNode } from './depth'
import { galleryNode } from './gallery'
import { laminarProfileNode } from './laminarProfile'

export const cortex: PackDefinition = {
  id: 'cortex',
  label: 'Cortex',
  description: 'Cortical neurons against depth and layer, starting with MICrONS.',
  defaultOn: false,
  requires: ['cave'],
  glyph: 'cortex:gallery',
  nodes: [galleryNode, depthNode, laminarProfileNode],
}
