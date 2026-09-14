/**
 * Renderers that outlive the surface drawing them: the lease, park and release rules behind
 * `PersistentCanvas`, generic over the root and free of three.js so they are testable without
 * WebGL. Why the renderer core is kept rather than the viewer, and what that measured, is in
 * `docs/viewers.md` — "A 3D renderer is handed between surfaces, not rebuilt".
 */

/** A renderer root, the element it lives in, and how to give it back. */
export interface CanvasLease<Root> {
  /** What a surface adopts: the element pointer events are bound to, with the canvas inside it. */
  readonly host: HTMLDivElement
  readonly root: Root
  /** Parked for the grace period if the root is held under a key; destroyed at once if private. */
  release(): void
  /** Destroyed at once — a root that failed is not handed to the next surface. */
  discard(): void
}

interface RootRegistryOptions<Root> {
  create: (canvas: HTMLCanvasElement) => Root
  destroy: (root: Root) => void
  /** How long a parked root waits for a surface to lease it before it is destroyed. */
  graceMs: number
}

interface Entry<Root> {
  readonly host: HTMLDivElement
  readonly root: Root
  /** The lease drawing it, or undefined while parked. */
  holder: CanvasLease<Root> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

export class RootRegistry<Root> {
  private readonly entries = new Map<string, Entry<Root>>()
  private readonly options: RootRegistryOptions<Root>
  private parking: HTMLDivElement | undefined

  constructor(options: RootRegistryOptions<Root>) {
    this.options = options
  }

  /**
   * The root held under `key`, created on first use — or a private one, with no key or while
   * another surface is drawing the held one. Two live surfaces on one key is not an error: the
   * inspector draws a Topology card beside the canvas one. A private root is one that is never
   * entered in the registry, which is what every surface built before this existed.
   */
  lease(key: string | undefined): CanvasLease<Root> {
    const found = key === undefined ? undefined : this.entries.get(key)
    const slot = found?.holder ? undefined : key
    const held = slot !== undefined && found ? found : this.make()
    clearTimeout(held.timer)
    if (slot !== undefined) this.entries.set(slot, held)

    const lease: CanvasLease<Root> = {
      host: held.host,
      root: held.root,
      release: () => {
        if (held.holder !== lease) return
        if (slot === undefined) {
          this.destroy(slot, held)
          return
        }
        held.holder = undefined
        /*
         * Parked in a hidden lot in the document rather than detached. Nothing re-measures a
         * parked root — its surface is gone and a demand frameloop draws nothing — so it keeps the
         * size it had and the next surface resizes it once, rather than a round trip through 0 × 0
         * rebuilding the drawing buffer and every full-size target.
         */
        this.parkingLot().appendChild(held.host)
        held.timer = setTimeout(() => this.destroy(slot, held), this.options.graceMs)
      },
      discard: () => {
        if (held.holder === lease) this.destroy(slot, held)
      },
    }
    held.holder = lease
    return lease
  }

  private make(): Entry<Root> {
    const host = document.createElement('div')
    host.style.width = '100%'
    host.style.height = '100%'
    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    host.appendChild(canvas)
    return { host, root: this.options.create(canvas), holder: undefined, timer: undefined }
  }

  private destroy(key: string | undefined, held: Entry<Root>): void {
    clearTimeout(held.timer)
    held.holder = undefined
    if (key !== undefined && this.entries.get(key) === held) this.entries.delete(key)
    held.host.remove()
    this.options.destroy(held.root)
  }

  private parkingLot(): HTMLDivElement {
    if (this.parking?.isConnected) return this.parking
    const lot = document.createElement('div')
    lot.setAttribute('aria-hidden', 'true')
    lot.dataset.persistentRoots = ''
    Object.assign(lot.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      pointerEvents: 'none',
      visibility: 'hidden',
    })
    document.body.appendChild(lot)
    this.parking = lot
    return lot
  }
}
