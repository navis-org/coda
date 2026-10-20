/**
 * The per-node values the Biophysics pack's nodes write, merged into the 3D View's "by node value"
 * list by `nodes/lib/nodeValues.ts`. Data only, found by glob: types are the only imports.
 */

import type { NodeValueDef } from '../../nodes/lib/nodeValues'

/** The node value Simulate's Arbour output carries. `simulateOps.ts` writes it under this name. */
export const PEAK_VOLTAGE = 'peakVoltage'

const nodeValues: readonly NodeValueDef[] = [
  {
    value: PEAK_VOLTAGE,
    label: 'peak voltage (mV)',
    source: 'Simulate Model’s Arbour output, the highest membrane voltage each node reached',
  },
]

export default nodeValues
