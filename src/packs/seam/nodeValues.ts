/**
 * The per-node value Affinity Clusters writes, offered in the 3D View's "by node value" picker.
 *
 * Data only, found by glob: types are the only imports. **The key is declared here and imported
 * outward** — `affinityClusters.ts` takes it from this file, the way `biophys/simulateOps.ts` takes
 * `PEAK_VOLTAGE` from its pack's. The lint rule restricts what this file imports, not who imports
 * it, so nothing is dragged into `nodes.html`'s bundle by the arrow pointing this way; and the
 * alternative — a literal here and a constant there, held together by a test — answers with a
 * test what this answers structurally.
 */

import type { NodeValueDef } from '../../nodes/lib/nodeValues'

/** The key a cluster number is written under in `SkeletonGeometry.nodeValues`. */
export const CLUSTER_NODE_VALUE = 'cluster'

const values: readonly NodeValueDef[] = [
  {
    value: CLUSTER_NODE_VALUE,
    label: 'predicted cluster (0 is background)',
    source: 'Affinity Clusters, the cluster each skeleton node was folded into',
  },
]

export default values
