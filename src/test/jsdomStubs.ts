/**
 * jsdom stubs for component tests.
 *
 * jsdom has no layout engine, so anything that measures the DOM sees zeros. React Flow
 * refuses to show nodes it hasn't measured, and the chart viewers refuse to draw without
 * a size — so both need a plausible box before they render anything at all.
 */

export interface JsdomStubOptions {
  /** Size reported to ResizeObserver observers and getBoundingClientRect. */
  width?: number
  height?: number
}

export function installJsdomStubs(options: JsdomStubOptions = {}): void {
  const width = options.width ?? 800
  const height = options.height ?? 480

  /**
   * Reports a size immediately on observe. A no-op ResizeObserver leaves every chart at
   * 0×0 and they all early-return, so the tests would pass while rendering nothing.
   */
  class ResizeObserverStub implements ResizeObserver {
    private callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element): void {
      const contentRect = {
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
      } as DOMRectReadOnly
      const entry = {
        target,
        contentRect,
        borderBoxSize: [{ inlineSize: width, blockSize: height }],
        contentBoxSize: [{ inlineSize: width, blockSize: height }],
        devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
      } as unknown as ResizeObserverEntry
      this.callback([entry], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1
  } as unknown as typeof DOMMatrixReadOnly

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  }

  // jsdom implements no scrolling, so this is missing entirely rather than a no-op.
  // Stubbed here rather than guarded in components — every real browser has it.
  if (!Element.prototype.scrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    })
  }

  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const isCanvas = this.classList.contains('canvas-area')
      const w = isCanvas ? 1200 : width
      const h = isCanvas ? 800 : height
      return {
        x: 0,
        y: 0,
        width: w,
        height: h,
        top: 0,
        left: 0,
        right: w,
        bottom: h,
        toJSON: () => ({}),
      } as DOMRect
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 1200,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 800,
  })

  installCanvas2d()
}

/**
 * A 2D context that accepts every call and remembers nothing.
 *
 * jsdom does not implement `getContext` at all — it reports to the virtual console and hands
 * back null — so without this the scatter viewer's paint pass is skipped entirely and every
 * render of one prints a stack trace. Two things follow from stubbing it, and the second is
 * the reason to bother: the noise goes, and `drawScatter` genuinely *runs*, so a crash in the
 * draw path fails a test instead of being invisible until someone opens a browser.
 *
 * Deliberately not a recording spy. What is drawn is asserted on the SVG the same spec
 * produces (`scatterDraw.test.ts`), which is real output rather than a transcript of calls
 * into a fake; a canvas mock detailed enough to assert against would be a second renderer to
 * keep in step with the first.
 */
function installCanvas2d(): void {
  if (typeof HTMLCanvasElement === 'undefined') return
  // jsdom only defines `ImageData` when the optional `canvas` package is present, and
  // `NeuronThumbnail` builds one the moment it has a context to draw into — so stubbing
  // `getContext` without this turns its previously-skipped effect into a ReferenceError.
  globalThis.ImageData ??= class {
    data: Uint8ClampedArray
    width: number
    height: number
    colorSpace: PredefinedColorSpace = 'srgb'
    constructor(data: Uint8ClampedArray, width: number, height?: number) {
      this.data = data
      this.width = width
      this.height = height ?? data.length / 4 / width
    }
  } as unknown as typeof ImageData

  const noop = () => {}
  const context = {
    canvas: null,
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setTransform: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    putImageData: noop,
    drawImage: noop,
    createImageData: (w: number, h: number) =>
      new ImageData(new Uint8ClampedArray(w * h * 4), w, h),
    measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
    createLinearGradient: () => ({ addColorStop: noop }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  }
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, kind: string) {
      // WebGL stays unavailable on purpose: sigma and three both check for it and degrade,
      // and a fake context that answered would send them down a render path with no GPU
      // behind it. Only 2D is honest to fake.
      if (kind !== '2d') return null
      return { ...context, canvas: this } as unknown as CanvasRenderingContext2D
    },
  })
}

export interface CapturedDownload {
  filename: string
  blob: Blob
  text(): Promise<string>
}

/**
 * Intercept the anchor-click download dance so tests can assert what would have been
 * saved. jsdom has neither `URL.createObjectURL` nor real navigation, so both are stubbed;
 * anchor clicks are swallowed to avoid "Not implemented: navigation" noise.
 *
 * Returns the list downloads accumulate into, plus a restore function.
 */
export function installDownloadCapture(): {
  downloads: CapturedDownload[]
  restore: () => void
} {
  const downloads: CapturedDownload[] = []
  const blobs = new Map<string, Blob>()
  let counter = 0

  const originalCreate = URL.createObjectURL as unknown
  const originalRevoke = URL.revokeObjectURL as unknown
  const originalClick = HTMLAnchorElement.prototype.click

  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:mock/${++counter}`
    blobs.set(url, blob)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL

  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    const blob = blobs.get(this.href)
    if (this.download && blob) {
      downloads.push({
        filename: this.download,
        blob,
        text: () => blobToText(blob),
      })
    }
  }

  return {
    downloads,
    restore: () => {
      URL.createObjectURL = originalCreate as typeof URL.createObjectURL
      // `triggerDownload` revokes on the next tick, which lands *after* a test has torn
      // its stubs down. jsdom ships no `revokeObjectURL`, so putting the original back
      // would restore `undefined` and throw an unhandled TypeError out of a timer.
      URL.revokeObjectURL = (originalRevoke ?? (() => {})) as typeof URL.revokeObjectURL
      HTMLAnchorElement.prototype.click = originalClick
    },
  }
}

/** `Blob.text()` exists in jsdom, but fall back to FileReader if it doesn't. */
async function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(new Error('could not read blob')))
    reader.readAsText(blob)
  })
}

/**
 * Give this environment a working `localStorage`.
 *
 * Node 26 shadows jsdom's, so `window.localStorage` throws on access and every persistence path
 * silently degrades — which is correct behaviour for the app and means the persistence layer has
 * no coverage at all by default. Opt in per suite rather than globally: with storage present,
 * autosaves and preferences start leaking between test files.
 */
export function installStorageStub(): void {
  let held: Storage | undefined
  try {
    held = window.localStorage
  } catch {
    held = undefined
  }
  if (held) return

  const entries = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
    setItem: (key, value) => {
      entries.set(key, String(value))
    },
  }
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}

/**
 * A Fullscreen API, which jsdom implements no part of.
 *
 * Records what was asked of it, and — the half that cannot be driven any other way — lets a
 * test *grant* fullscreen. Whether something is fullscreen is read off
 * `document.fullscreenElement`, which a real browser writes and a request does not: it decides,
 * announces the outcome with `fullscreenchange`, and may refuse. That ordering is the whole
 * thing `ui/fullscreen.ts` is built around, so a stub that flipped the flag inside
 * `requestFullscreen` would be testing a browser that does not exist.
 *
 * Opt in per suite, like `installStorageStub`: a global Fullscreen API would have every other
 * component test running paths no browser grants them.
 */
export function installFullscreenStub(): {
  /** Elements `requestFullscreen` was called on, in order. */
  requests: Element[]
  /** What was fullscreen at each `exitFullscreen` call — so a test can say *what* was exited. */
  exits: (Element | null)[]
  /** Put an element in (or `null` out of) fullscreen and announce it, as a browser would. */
  setElement: (element: Element | null) => void
} {
  const requests: Element[] = []
  const exits: (Element | null)[] = []

  const setElement = (element: Element | null) => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: element,
    })
    document.dispatchEvent(new Event('fullscreenchange'))
  }

  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    value: function (this: Element) {
      requests.push(this)
      return Promise.resolve()
    },
  })
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: () => {
      exits.push(document.fullscreenElement)
      return Promise.resolve()
    },
  })
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })

  return { requests, exits, setElement }
}

/** Clear localStorage where the environment provides it; tolerate where it doesn't. */
export function clearStorage(): void {
  try {
    window.localStorage?.clear()
  } catch {
    /* Node 26 shadows jsdom's localStorage unless --localstorage-file is passed. */
  }
}
