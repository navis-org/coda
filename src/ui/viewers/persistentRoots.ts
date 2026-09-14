/**
 * Roots kept between the surfaces that draw them — a React Three Fiber root, a Neuroglancer frame —
 * and the lease, park and release rules they share. Generic over the root, so the rules are testable
 * without WebGL or a loaded document. Why, and what it measured: `docs/viewers.md`.
 */

/**
 * How long a root nobody is looking at is kept: long enough for a switch, a dashboard round trip or a
 * glance at another workflow, short enough that a hidden scene does not hold its GPU memory.
 */
export const RELEASE_AFTER_MS = 5000

/** A root, the element it lives in, and how to give it back. */
export interface RootLease<Root> {
  /** The element the root lives in, already placed in the surface that leased it. */
  readonly host: HTMLElement
  readonly root: Root
  /** Parked for the grace period if the root is held under a key; destroyed at once if private. */
  release(): void
  /** Destroyed at once — a root that failed is not handed to the next surface. */
  discard(): void
}

interface RootRegistryOptions<Root> {
  /** A new root and the element it lives in, not yet attached anywhere. */
  create: () => { host: HTMLElement; root: Root }
  /** Called while the host is still in the document, so a root inside it can still be read. */
  destroy: (root: Root) => void
  /** How long a parked root waits for a surface to lease it. `RELEASE_AFTER_MS` if unset. */
  graceMs?: number
  /**
   * Keep a root only where moving its host keeps it alive — an iframe, which any move but
   * `moveBefore` reloads. Where it cannot, every lease is private.
   */
  keepOnlyIfMovable?: boolean
  /**
   * Pin a parked host at the size it had, for a root that watches its own size and would follow the
   * one-pixel lot down and back. Opt-in, because reading the size forces a layout.
   */
  pinWhenParked?: boolean
}

interface Entry<Root> {
  readonly host: HTMLElement
  readonly root: Root
  /** The lease drawing it, or undefined while parked. */
  holder: RootLease<Root> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether parking pinned the host's size, to be unpinned when it is adopted. */
  pinned: boolean
}

/**
 * Whether this browser can move an element without tearing it down: `Element.moveBefore`, in Chrome
 * and Edge 133+ and Firefox 144+, and not in Safari. A function rather than a constant, since a test
 * installs it at runtime.
 */
function canMoveKeepingState(): boolean {
  return typeof Element !== 'undefined' && 'moveBefore' in Element.prototype
}

type MovableParent = Element & { moveBefore(node: Node, child: Node | null): void }

/**
 * Put `node` last in `parent`, keeping its state where the browser can. `moveBefore` only moves
 * between two connected parents, so a node never attached anywhere goes in the ordinary way.
 */
function moveInto(parent: Element, node: Element): void {
  if (canMoveKeepingState() && parent.isConnected && node.isConnected) {
    ;(parent as MovableParent).moveBefore(node, null)
  } else {
    parent.appendChild(node)
  }
}

let lot: HTMLDivElement | undefined

/** The one hidden place every registry parks in. */
function parkingLot(): HTMLDivElement {
  if (lot?.isConnected) return lot
  const made = document.createElement('div')
  made.setAttribute('aria-hidden', 'true')
  made.dataset.persistentRoots = ''
  Object.assign(made.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    pointerEvents: 'none',
    visibility: 'hidden',
  })
  document.body.appendChild(made)
  lot = made
  return made
}

export class RootRegistry<Root> {
  private readonly entries = new Map<string, Entry<Root>>()
  private readonly options: RootRegistryOptions<Root>

  constructor(options: RootRegistryOptions<Root>) {
    this.options = options
  }

  /**
   * The root held under `key`, placed in `parent` — created on first use, or private: with no key,
   * where `keepOnlyIfMovable` finds no `moveBefore`, or while another surface is drawing the held one.
   * Two live surfaces on one key is not an error: the inspector draws a Topology card beside the
   * canvas one. A private root is never entered in the registry, which is what every surface built
   * before this existed.
   *
   * The registry places the host itself, and every later move too, so no caller holds the element to
   * move it with an `appendChild` — which, for a frame, is a reload.
   */
  lease(key: string | undefined, parent: Element): RootLease<Root> {
    const keepable = !this.options.keepOnlyIfMovable || canMoveKeepingState()
    const found = key === undefined || !keepable ? undefined : this.entries.get(key)
    const slot = !keepable || found?.holder ? undefined : key
    const held: Entry<Root> =
      slot !== undefined && found
        ? found
        : { ...this.options.create(), holder: undefined, timer: undefined, pinned: false }
    clearTimeout(held.timer)
    if (held.pinned) {
      held.host.style.width = ''
      held.host.style.height = ''
      held.pinned = false
    }
    if (slot !== undefined) this.entries.set(slot, held)
    moveInto(parent, held.host)

    const lease: RootLease<Root> = {
      host: held.host,
      root: held.root,
      release: () => {
        if (held.holder !== lease) return
        if (slot === undefined) {
          this.destroy(slot, held)
          return
        }
        held.holder = undefined
        if (this.options.pinWhenParked) {
          const { offsetWidth: width, offsetHeight: height } = held.host
          if (width > 0 && height > 0) {
            held.host.style.width = `${width}px`
            held.host.style.height = `${height}px`
            held.pinned = true
          }
        }
        // Parked in the document, never detached: a detached iframe has no document.
        moveInto(parkingLot(), held.host)
        held.timer = setTimeout(
          () => this.destroy(slot, held),
          this.options.graceMs ?? RELEASE_AFTER_MS,
        )
      },
      discard: () => {
        if (held.holder === lease) this.destroy(slot, held)
      },
    }
    held.holder = lease
    return lease
  }

  private destroy(key: string | undefined, held: Entry<Root>): void {
    clearTimeout(held.timer)
    held.holder = undefined
    if (key !== undefined && this.entries.get(key) === held) this.entries.delete(key)
    this.options.destroy(held.root)
    held.host.remove()
  }
}
