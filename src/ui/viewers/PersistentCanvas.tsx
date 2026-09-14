/**
 * React Three Fiber's `<Canvas>`, with a root that survives its component.
 *
 * `<Canvas>` measures its container, calls `configure({ size, … })` and `render(children)` on a
 * `createRoot(canvas)`, and unmounts the root with the component. This does the same against a
 * root leased from `persistentRoots.ts` under `persistKey`, so the next surface to draw the node
 * renders the same element tree into the *same* root and everything the scene built survives.
 * Without a key, or while another surface holds it, the root is private — `<Canvas>` exactly.
 *
 * Deliberately **no context bridge** and no suspend-to-parent; why, and the measurements, are in
 * `docs/viewers.md` — "A 3D renderer is handed between surfaces, not rebuilt".
 */

import { Component, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot, extend } from '@react-three/fiber'
import type { ReconcilerRoot, RenderProps, RootState, Size } from '@react-three/fiber'
import * as THREE from 'three'

import { RootRegistry } from './persistentRoots'
import type { CanvasLease } from './persistentRoots'

/*
 * The catalogue of intrinsic three elements, which `<Canvas>` registers on its first render. Its
 * own call is untyped JavaScript; the namespace carries non-constructors (`UniformsUtils`) that the
 * `Catalogue` type refuses, and the reconciler only ever looks up the constructors.
 */
extend(THREE as unknown as Parameters<typeof extend>[0])

type Root = ReconcilerRoot<HTMLCanvasElement>

/** How long a scene nobody is looking at keeps its renderer — see `docs/viewers.md`. */
const RELEASE_AFTER_MS = 5000

const roots = new RootRegistry<Root>({
  create: createRoot,
  destroy: (root) => root.unmount(),
  graceMs: RELEASE_AFTER_MS,
})

/**
 * Binds pointer events to the host the canvas lives in, once per root.
 *
 * Module-level rather than a closure: a root keeps the latest `onCreated` it was configured with,
 * and a closure there would hold the configuring surface's whole render scope for as long as the
 * root is parked. The host moves with the root, so the binding holds in every surface.
 */
function connectHost(state: RootState) {
  const host = state.gl.domElement.parentElement
  if (host) state.events.connect?.(host)
}

type PersistentCanvasProps = Required<
  Pick<RenderProps<HTMLCanvasElement>, 'flat' | 'frameloop' | 'camera' | 'events'>
> & {
  /** Where the renderer is held — see `scopedKey`. Undefined means a private root. */
  persistKey: string | undefined
  children: ReactNode
}

export function PersistentCanvas({
  persistKey,
  children,
  flat,
  frameloop,
  camera,
  events,
}: PersistentCanvasProps) {
  const outer = useRef<HTMLDivElement>(null)
  /** The lease this surface draws into, and whether it still owes an adopted canvas a frame. */
  const held = useRef<{ lease: CanvasLease<Root>; fresh: boolean } | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [error, setError] = useState<unknown>(undefined)

  // `<Canvas>`' rule: a failure inside the scene is thrown from the component that owns it.
  if (error !== undefined) throw error

  // Stable, so the scene's error boundary is not handed a new prop on every commit.
  const fail = useCallback((reason: unknown) => {
    held.current?.lease.discard()
    setError(reason)
  }, [])

  useLayoutEffect(() => {
    const element = outer.current
    if (!element) return
    const lease = roots.lease(persistKey)
    element.appendChild(lease.host)
    held.current = { lease, fresh: true }
    return () => {
      held.current = null
      lease.release()
    }
  }, [persistKey])

  /*
   * Measured the way `<Canvas>` measures, with `getBoundingClientRect`, so a card inside React
   * Flow's transform gets the same size it always did — `.viewer3d-canvas canvas`' `!important`
   * stretch is written against that number.
   */
  useLayoutEffect(() => {
    const element = outer.current
    if (!element) return
    const read = () => {
      const rect = element.getBoundingClientRect()
      // A box with no area is no size at all: a renderer is never configured against one.
      setSize((previous) =>
        rect.width <= 0 || rect.height <= 0
          ? null
          : previous &&
              previous.width === rect.width &&
              previous.height === rect.height &&
              previous.top === rect.top &&
              previous.left === rect.left
            ? previous
            : { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
      )
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /*
   * Only when something configurable changed — a new surface's size above all — where `<Canvas>`
   * configures on every commit. `render` below queues behind a configure still in flight, so the two
   * need no sequencing beyond their order here.
   */
  useLayoutEffect(() => {
    const current = held.current
    if (!current || !size) return
    current.lease.root
      .configure({ flat, frameloop, camera, events, size, onCreated: connectHost })
      .catch(fail)
  }, [persistKey, size, flat, frameloop, camera, events, fail])

  // Every commit, as `<Canvas>` does: `render` is how new props reach the scene.
  useLayoutEffect(() => {
    const current = held.current
    if (!current || !size) return
    const store = current.lease.root.render(
      <RootErrorBoundary onError={fail}>
        <Suspense fallback={null}>{children}</Suspense>
      </RootErrorBoundary>,
    )
    if (!current.fresh) return
    current.fresh = false
    // An adopted canvas shows nothing until drawn. A root still being created has no renderer to
    // ask yet, and draws its first frame when its scene mounts.
    const state = store.getState()
    if (state.gl) state.invalidate()
  })

  return (
    <div
      ref={outer}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    />
  )
}

/** Catches inside the scene's own React root, which a DOM-side boundary cannot see into. */
class RootErrorBoundary extends Component<
  { onError: (reason: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(reason: unknown) {
    this.props.onError(reason)
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}
