// @vitest-environment jsdom

/**
 * The lease, park and release rules a persistent renderer runs on.
 *
 * jsdom has no WebGL and loads no documents, so the roots here are counters. What is checkable is
 * whether a switch keeps a root or builds a new one — and every way that can be wrong is silent: a
 * root destroyed under a surface that just adopted it draws a blank canvas, and one never destroyed is
 * a graphics context held for a scene nobody can see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installMoveBeforeStub } from '../../test/jsdomStubs'
import { RootRegistry } from './persistentRoots'

interface Counted {
  destroys: number
  /** Whether the host was still in the document when the root was destroyed. */
  destroyedConnected: boolean | undefined
}

function registry(options: { keepOnlyIfMovable?: boolean; pinWhenParked?: boolean } = {}) {
  const created: Counted[] = []
  const hosts = new Map<Counted, HTMLElement>()
  const roots = new RootRegistry<Counted>({
    create: () => {
      const root: Counted = { destroys: 0, destroyedConnected: undefined }
      created.push(root)
      const host = document.createElement('div')
      hosts.set(root, host)
      return { host, root }
    },
    destroy: (root) => {
      root.destroys++
      root.destroyedConnected = hosts.get(root)?.isConnected
    },
    graceMs: 5000,
    ...options,
  })
  return { roots, created }
}

/** A surface to lease into. */
function surface(): HTMLElement {
  return document.body.appendChild(document.createElement('div'))
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
    const card = roots.lease('w:n', surface())
    card.release()
    vi.advanceTimersByTime(4999)

    const into = surface()
    const overlay = roots.lease('w:n', into)
    expect(overlay.root).toBe(card.root)
    expect(overlay.host).toBe(card.host)
    expect(overlay.host.parentElement).toBe(into)
    expect(created).toHaveLength(1)

    // The lease cancelled the release: waiting past the original deadline destroys nothing.
    vi.advanceTimersByTime(10_000)
    expect(card.root.destroys).toBe(0)
  })

  it('is parked in the document, not detached', () => {
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    card.release()
    expect(card.host.isConnected).toBe(true)
    expect(card.host.parentElement?.dataset.persistentRoots).toBe('')
  })

  it('is destroyed while its host is still in the document, then removed', () => {
    // A frame's state is read as it is destroyed, and a detached iframe has none to read.
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    card.release()
    vi.advanceTimersByTime(5000)

    expect(card.root.destroys).toBe(1)
    expect(card.root.destroyedConnected).toBe(true)
    expect(card.host.isConnected).toBe(false)
  })

  it('starts again from nothing once the grace period has passed', () => {
    const { roots, created } = registry()
    const card = roots.lease('w:n', surface())
    card.release()
    vi.advanceTimersByTime(5000)
    expect(roots.lease('w:n', surface()).root).not.toBe(card.root)
    expect(created).toHaveLength(2)
  })
})

describe('parked at the size it had', () => {
  it('pins only when asked, so a root sized by its surface pays for no layout', () => {
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    Object.defineProperty(card.host, 'offsetWidth', { get: () => 640 })
    card.release()
    expect(card.host.style.width).toBe('')
  })

  it('pins a host that watches its own size, and unpins it when adopted', () => {
    const { roots } = registry({ pinWhenParked: true })
    const card = roots.lease('w:n', surface())
    Object.defineProperty(card.host, 'offsetWidth', { configurable: true, value: 640 })
    Object.defineProperty(card.host, 'offsetHeight', { configurable: true, value: 360 })
    card.release()
    expect(card.host.style.width).toBe('640px')
    expect(card.host.style.height).toBe('360px')

    roots.lease('w:n', surface())
    expect(card.host.style.width).toBe('')
    expect(card.host.style.height).toBe('')
  })
})

describe('moving without tearing down', () => {
  let stub: ReturnType<typeof installMoveBeforeStub>
  beforeEach(() => {
    stub = installMoveBeforeStub()
  })
  afterEach(() => stub.restore())

  it('parks and adopts with moveBefore, and places a new root the ordinary way', () => {
    // An iframe reloads through an ordinary `appendChild`; only `moveBefore` keeps its document.
    const { roots } = registry()
    const first = roots.lease('w:n', surface())
    expect(stub.moves).toHaveLength(0)

    first.release()
    expect(stub.moves).toHaveLength(1)

    const overlay = surface()
    roots.lease('w:n', overlay)
    expect(stub.moves).toHaveLength(2)
    expect(first.host.parentElement).toBe(overlay)
  })

  it('keeps a root that needs moveBefore when the browser has it', () => {
    const { roots } = registry({ keepOnlyIfMovable: true })
    const card = roots.lease('w:n', surface())
    card.release()
    expect(roots.lease('w:n', surface()).root).toBe(card.root)
  })
})

describe('a root that only a state-preserving move could keep', () => {
  it('is private where the browser has no moveBefore, and destroyed on release', () => {
    const { roots } = registry({ keepOnlyIfMovable: true })
    const card = roots.lease('w:n', surface())
    card.release()
    expect(card.root.destroys).toBe(1)
    expect(roots.lease('w:n', surface()).root).not.toBe(card.root)
  })
})

describe('two surfaces on one key', () => {
  it('gives the second a private root while the first is drawing, destroyed on its release', () => {
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    const inspector = roots.lease('w:n', surface())
    expect(inspector.root).not.toBe(card.root)

    inspector.release()
    expect(inspector.root.destroys).toBe(1)
    expect(card.root.destroys).toBe(0)
  })

  it('ignores a release from a surface that no longer holds it', () => {
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    card.release()
    const overlay = roots.lease('w:n', surface())
    // The card unmounting late must not park what the overlay is drawing.
    card.release()
    vi.advanceTimersByTime(10_000)
    expect(overlay.root.destroys).toBe(0)
    expect(roots.lease('w:n', surface()).root).not.toBe(overlay.root)
  })
})

describe('a root that failed', () => {
  it('is destroyed at once, and once, even when its surface then unmounts', () => {
    const { roots } = registry()
    const card = roots.lease('w:n', surface())
    card.discard()
    card.release()
    vi.advanceTimersByTime(10_000)
    expect(card.root.destroys).toBe(1)
    // And the next surface is not handed it.
    expect(roots.lease('w:n', surface()).root).not.toBe(card.root)
  })
})
