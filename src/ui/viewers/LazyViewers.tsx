/**
 * Lazy wrappers for the WebGL viewers.
 *
 * three.js and sigma together are the majority of the bundle, and most graphs use neither.
 * `React.lazy` puts each behind its own chunk that is fetched the first time a scene is
 * actually rendered, so opening the editor stays fast.
 */

import { Suspense, lazy } from 'react'

import type { NetworkViewerProps } from './NetworkViewer'
import type { Viewer3DProps } from './Viewer3D'

const NetworkViewerImpl = lazy(async () => ({
  default: (await import('./NetworkViewer')).NetworkViewer,
}))

const Viewer3DImpl = lazy(async () => ({
  default: (await import('./Viewer3D')).Viewer3D,
}))

function Loading({ what }: { what: string }) {
  return (
    <div className="viewer">
      <div className="viewer__empty">loading {what}…</div>
    </div>
  )
}

export function LazyNetworkViewer(props: NetworkViewerProps) {
  return (
    <Suspense fallback={<Loading what="network renderer" />}>
      <NetworkViewerImpl {...props} />
    </Suspense>
  )
}

export function LazyViewer3D(props: Viewer3DProps) {
  return (
    <Suspense fallback={<Loading what="3D renderer" />}>
      <Viewer3DImpl {...props} />
    </Suspense>
  )
}
