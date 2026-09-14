// @vitest-environment jsdom

/**
 * The lease, park and release rules a persistent renderer runs on.
 *
 * jsdom has no WebGL, so the roots here are counters. What is checkable is whether a switch keeps a
 * renderer or builds a new one — and every way that can be wrong is silent: a root destroyed under
 * a surface that just adopted it draws a blank canvas, and one never destroyed is a graphics context
 * held for a scene nobody can see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RootRegistry } from './persistentRoots'

function registry() {
  const created: { destroys: number }[] = []
  const roots = new RootRegistry({
    create: () => {
      const root = { destroys: 0 }
      created.push(root)
      return root
    },
    destroy: (root) => {
      root.destroys++
    },
    graceMs: 5000,
  })
  return { roots, created }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('a renderer handed between surfaces', () => {
  it('is the same root and host when the next surface leases it within the grace period', () => {
    const { roots, created } = registry()
    const card = roots.lease('w:n')
    card.release()
    vi.advanceTimersByTime(4999)

    const overlay = roots.lease('w:n')
    expect(overlay.root).toBe(card.root)
    expect(overlay.host).toBe(card.host)
    expect(created).toHaveLength(1)

    // The lease cancelled the release: waiting past the original deadline destroys nothing.
    vi.advanceTimersByTime(10_000)
    expect(card.root.destroys).toBe(0)
  })

  it('is parked in the document, not detached, so it keeps a size to come back to', () => {
    const { roots } = registry()
    const card = roots.lease('w:n')
    card.release()
    expect(card.host.isConnected).toBe(true)
    expect(card.host.parentElement?.dataset.persistentRoots).toBe('')
  })

  it('is destroyed, and its host removed, once nothing leases it for the grace period', () => {
    const { roots, created } = registry()
    const card = roots.lease('w:n')
    card.release()
    vi.advanceTimersByTime(5000)

    expect(card.root.destroys).toBe(1)
    expect(card.host.isConnected).toBe(false)

    // The next surface starts again from nothing.
    expect(roots.lease('w:n').root).not.toBe(card.root)
    expect(created).toHaveLength(2)
  })
})

describe('two surfaces on one key', () => {
  it('gives the second a private root while the first is drawing, destroyed on its release', () => {
    const { roots } = registry()
    const card = roots.lease('w:n')
    const inspector = roots.lease('w:n')
    expect(inspector.root).not.toBe(card.root)

    inspector.release()
    expect(inspector.root.destroys).toBe(1)
    expect(card.root.destroys).toBe(0)
  })

  it('ignores a release from a surface that no longer holds it', () => {
    const { roots } = registry()
    const card = roots.lease('w:n')
    card.release()
    const overlay = roots.lease('w:n')
    // The card unmounting late must not park what the overlay is drawing.
    card.release()
    vi.advanceTimersByTime(10_000)
    expect(overlay.root.destroys).toBe(0)
    expect(roots.lease('w:n').root).not.toBe(overlay.root)
  })
})

describe('a root that failed', () => {
  it('is destroyed at once, and once, even when its surface then unmounts', () => {
    const { roots } = registry()
    const card = roots.lease('w:n')
    card.discard()
    card.release()
    vi.advanceTimersByTime(10_000)
    expect(card.root.destroys).toBe(1)
    // And the next surface is not handed it.
    expect(roots.lease('w:n').root).not.toBe(card.root)
  })
})
