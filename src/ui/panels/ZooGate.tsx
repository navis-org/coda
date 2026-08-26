/**
 * Mounts the Zoo browser when the store says it is open, and not before.
 *
 * Two deferrals, and they are not the same one. The **fetch** is deferred because `ZooBrowser`
 * downloads an index the moment it mounts, and rendering it always with a `null` inside would
 * put a network request on every page load for a feature most sessions never open. The **code**
 * is deferred because a static import would ship the browser, its minimap and `data/zoo` — a
 * little over a thousand lines — inside the main chunk for that same never-opened feature. The
 * first needs the conditional; the second needs `lazy`, which is why this is its own module
 * rather than four lines at the top of `ZooBrowser.tsx`: a file that statically imports the
 * component cannot also be what defers loading it.
 *
 * `Suspense` with a `null` fallback rather than a spinner: the chunk is small and local, and the
 * browser opens onto its own "Loading the Zoo…" state a moment later anyway. Two loading
 * indicators in sequence for one gesture reads as a stutter. Same shape as `LazyViewers`.
 */

import { Suspense, lazy } from 'react'

import { useGraphStore } from '../../store/graphStore'

const ZooBrowser = lazy(async () => ({ default: (await import('./ZooBrowser')).ZooBrowser }))

export function ZooGate() {
  const open = useGraphStore((s) => s.zooOpen)
  const closeZoo = useGraphStore((s) => s.closeZoo)
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <ZooBrowser onClose={closeZoo} />
    </Suspense>
  )
}
