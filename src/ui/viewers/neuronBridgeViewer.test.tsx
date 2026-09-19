// @vitest-environment jsdom

/**
 * The NeuronBridge card against recorded bucket responses (`data/neuronbridge/__fixtures__`).
 *
 * What this can see is the wiring: which requests a page makes, what a tile writes when pinned,
 * what a chip writes, what an expanded line adds. What it cannot see is pixels — jsdom loads no
 * image — so whether the thumbnails *draw* is `data/neuronbridge/live.test.ts`' HEAD requests and a
 * browser, not this.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { NB_BUCKET, resetNeuronBridgeClient } from '../../data/neuronbridge/client'
import { decodePin, encodePin, pinnedTable, readPins } from '../../nodes/lib/neuronbridgePins'
import { tableToCsvParts } from '../export'
import { installDownloadCapture, installJsdomStubs } from '../../test/jsdomStubs'
import { NeuronBridgeViewer } from './NeuronBridgeViewer'
import type { NbView } from './NeuronBridgeCompare'
import type { NeuronBridgeViewerProps } from './NeuronBridgeViewer'
import { clearNeuronBridgeCache } from './useNeuronBridge'

const FIXTURES = join(__dirname, '../../data/neuronbridge/__fixtures__')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const FILES: Record<string, string> = {
  '/current.txt': 'current.txt',
  '/v3_10_0/config.json': 'config.json',
  '/v3_10_0/metadata/by_body/1734350788.json': 'by_body-1734350788.json',
  '/v3_10_0/metadata/by_body/11442.json': 'by_body-11442.json',
  '/v3_10_0/metadata/cdsresults/2945073143147307019.json':
    'cdsresults-2945073143147307019.sample.json',
  '/v3_10_0/metadata/pppmresults/2941778995433177634.json':
    'pppmresults-2941778995433177634.sample.json',
}

let requested: string[] = []

function stubBucket() {
  requested = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      const name = url.startsWith(NB_BUCKET) ? FILES[url.slice(NB_BUCKET.length)] : undefined
      return name
        ? new Response(fixture(name), { status: 200 })
        : new Response('NoSuchKey', { status: 404, statusText: 'Not Found' })
    }),
  )
}

const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

function table(ids: string[]) {
  return tableFromRows(
    NEURONS,
    ids.map((neuronId) => ({ neuronId, type: 'DA1_lPN' })),
    'neurons',
  )
}

const VIEW: NbView = {
  compare: 'side',
  lmView: 'hit',
  emOpacity: 0.7,
  emTint: 'white',
  freeze: true,
}

/**
 * The card, with a spy per setting. `view`'s fields may be given flat — `card({ compare:
 * 'overlay' })` — and the one `onView` setter is routed to a spy per key, so a test reads as the
 * setting it is about.
 */
function card(props: Partial<NeuronBridgeViewerProps> & Partial<NbView> = {}) {
  const handlers = {
    onPage: vi.fn(),
    onMethod: vi.fn(),
    onCollections: vi.fn(),
    onPins: vi.fn(),
    onCompare: vi.fn(),
    onLmView: vi.fn(),
    onEmOpacity: vi.fn(),
    onEmTint: vi.fn(),
    onFreeze: vi.fn(),
  }
  const setters: Record<keyof NbView, (value: never) => void> = {
    compare: handlers.onCompare,
    lmView: handlers.onLmView,
    emOpacity: handlers.onEmOpacity,
    emTint: handlers.onEmTint,
    freeze: handlers.onFreeze,
  }
  const { compare, lmView, emOpacity, emTint, freeze, ...rest } = props
  const flat = { compare, lmView, emOpacity, emTint, freeze }
  const all: NeuronBridgeViewerProps = {
    neurons: table(['1734350788', '99']),
    sourceId: 'neuprint',
    datasetId: 'hemibrain:v1.2.1',
    page: 0,
    method: 'cds',
    collections: ['split', 'omnibus', 'mcfo', 'annotator'],
    tiles: 6,
    version: '',
    pins: [],
    onPage: handlers.onPage,
    onMethod: handlers.onMethod,
    onCollections: handlers.onCollections,
    onPins: handlers.onPins,
    view: {
      ...VIEW,
      ...Object.fromEntries(Object.entries(flat).filter(([, v]) => v !== undefined)),
    },
    onView: (key, value) => setters[key](value as never),
    ...rest,
  }
  const view = render(<NeuronBridgeViewer {...all} />)
  return { ...handlers, view, props: all }
}

const tiles = () => document.querySelectorAll('.nbridge__tile')
const firstTiles = () => document.querySelectorAll('.nbridge__tile:not([data-secondary])')

beforeAll(() => installJsdomStubs())
beforeEach(() => {
  resetNeuronBridgeClient()
  clearNeuronBridgeCache()
  stubBucket()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NeuronBridgeViewer', () => {
  it('pages the table and shows the neuron’s lines, one tile each, a step at a time', async () => {
    card()
    expect(screen.getByText('1 / 2')).toBeTruthy()
    await waitFor(() => expect(firstTiles()).toHaveLength(6))
    // 40 matches in the sample are 25 lines; the header says both.
    expect(screen.getByText(/25 lines from 40 images/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(firstTiles()).toHaveLength(12)
  })

  it('fetches the match file only for the neuron on screen, and never the PPPM one unasked', async () => {
    card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    expect(requested.filter((u) => u.includes('/cdsresults/'))).toHaveLength(1)
    expect(requested.some((u) => u.includes('/pppmresults/'))).toBe(false)
  })

  it('pins a tile’s match whole, and unpins it', async () => {
    const { onPins, view, props } = card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    const star = firstTiles()[0]!.querySelector<HTMLButtonElement>('.nbridge__star')!
    fireEvent.click(star)
    expect(onPins).toHaveBeenCalledTimes(1)
    const written = onPins.mock.calls[0]![0] as string[]
    expect(written).toHaveLength(1)
    const pin = decodePin(written[0]!)!
    expect(pin).toMatchObject({
      neuronId: '1734350788',
      method: 'cds',
      emLibrary: 'FlyEM_Hemibrain_v1.2.1',
      nbVersion: 'v3_10_0',
      area: 'Brain',
    })
    expect(firstTiles()[0]!.querySelector('.nbridge__line')!.textContent).toBe(pin.line)

    view.rerender(<NeuronBridgeViewer {...props} pins={written} />)
    const pressed = firstTiles()[0]!.querySelector<HTMLButtonElement>('.nbridge__star')!
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pressed)
    expect(onPins).toHaveBeenLastCalledWith([])
  })

  it('writes a chip back in the chips’ own order', async () => {
    const { onCollections } = card({ collections: ['annotator', 'split'] })
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /^MCFO/ }))
    expect(onCollections).toHaveBeenLastCalledWith(['split', 'mcfo', 'annotator'])
  })

  it('shows a line’s other images only when asked, and hides them again', async () => {
    card({ tiles: 60 })
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    const before = tiles().length
    const more = document.querySelector<HTMLButtonElement>('.nbridge__others')!
    const extra = Number(more.textContent!.replace(/\D/g, ''))
    fireEvent.click(more)
    expect(tiles().length).toBe(before + extra)
    fireEvent.click(more)
    expect(tiles().length).toBe(before)
  })

  it('opens a match as the two images it compared, with a link to the line', async () => {
    card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    const line = firstTiles()[0]!.querySelector('.nbridge__line')!.textContent!
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    const detail = screen.getByRole('region', { name: `Match ${line}` })
    const images = detail.querySelectorAll('img')
    expect(images).toHaveLength(2)
    expect(images[0]!.getAttribute('src')).toMatch(
      /^https:\/\/s3\.amazonaws\.com\/janelia-flylight-color-depth\//,
    )
    expect(detail.querySelector('a')!.getAttribute('href')).toBe(
      `https://neuronbridge.janelia.org/search?q=${encodeURIComponent(line)}`,
    )
  })

  it('says a neuron NeuronBridge never indexed has no record, rather than erroring', async () => {
    card({ page: 1 })
    await waitFor(() => expect(screen.getByText(/has no record of this neuron/)).toBeTruthy())
    expect(document.querySelector('.profile__error')).toBeNull()
  })

  it('says a dataset NeuronBridge does not cover, and asks the bucket nothing', async () => {
    card({ sourceId: 'mock', datasetId: 'optic-lobe-mini' })
    expect(screen.getByText(/no matches for this dataset/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requested).toEqual([])
  })

  it('says so when the dataset’s version is not the one NeuronBridge matched', async () => {
    card({ neurons: table(['11442']), datasetId: 'male-cns:v1.0' })
    await waitFor(() => expect(screen.getByRole('note').textContent).toMatch(/v0\.9.*v1\.0/))
    // The ambiguous id resolved to male CNS's record — not MANC's, not the VNC pilot's.
    expect(screen.getByText(/FlyEM Male CNS Brain v0\.9/)).toBeTruthy()
  })

  it('offers PPPM only where the neuron has it', async () => {
    const { onMethod } = card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'PPPM' }))
    expect(onMethod).toHaveBeenCalledWith('pppm')
  })

  it('keeps a pin written against another neuron when pinning this one', async () => {
    const elsewhere = encodePin({
      neuronId: '5813022341',
      line: 'SS00001',
      collection: 'FlyLight Split-GAL4 Drivers',
      method: 'cds',
      score: 1,
      pppmRank: null,
      matchingPixels: 1,
      mirrored: false,
      area: 'Brain',
      slideCode: '',
      objective: '',
      lmImageId: '1',
      emLibrary: 'FlyEM_Hemibrain_v1.2.1',
      nbVersion: 'v3_10_0',
    })
    const { onPins } = card({ pins: [elsewhere] })
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__star')!)
    expect((onPins.mock.calls[0]![0] as string[])[0]).toBe(elsewhere)
  })
})

describe('NeuronBridgeViewer — the comparison', () => {
  async function opened(props: Partial<NeuronBridgeViewerProps> & Partial<NbView> = {}) {
    const handles = card(props)
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    // The first line in the sample is SS02800, a mirrored match.
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    return handles
  }
  const detail = () => document.querySelector<HTMLElement>('.nbridge__detail')!
  const figures = () => [...detail().querySelectorAll('.nbridge__figure')]
  const layersOf = (figure: Element) => [...figure.querySelectorAll('img')]

  it('holds the comparison above the tiles when frozen, and scrolls it with them when not', async () => {
    const { view, props } = await opened()
    expect(document.querySelector('.nbridge__top .nbridge__detail')).not.toBeNull()
    expect(document.querySelector('.nbridge__scroll .nbridge__grid')).not.toBeNull()
    view.rerender(<NeuronBridgeViewer {...props} view={{ ...props.view, freeze: false }} />)
    expect(document.querySelector('.nbridge__top .nbridge__detail')).toBeNull()
    expect(document.querySelector('.nbridge__scroll .nbridge__detail')).not.toBeNull()
  })

  it('writes the freeze checkbox back', async () => {
    const { onFreeze } = await opened()
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep in view/ }))
    expect(onFreeze).toHaveBeenCalledWith(false)
  })

  it('flips the EM of a mirrored match, and keeps it hidden until its corner can be clipped', async () => {
    await opened()
    const [em, lm] = figures()
    const emImage = layersOf(em!)[0]!
    expect(emImage.dataset.flip).toBe('true')
    // jsdom loads nothing, so the size the clip needs never arrives: hidden is the right state.
    expect(emImage.style.visibility).toBe('hidden')
    expect(layersOf(lm!)[0]!.dataset.flip).toBeUndefined()
  })

  it('switches compare mode and LM image through its params', async () => {
    const { onCompare, onLmView } = await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Overlay' }))
    expect(onCompare).toHaveBeenCalledWith('overlay')
    fireEvent.click(screen.getByRole('button', { name: 'Whole line' }))
    expect(onLmView).toHaveBeenCalledWith('line')
  })

  it('draws the LM alone, the hit over the grey line, and the EM over the LM', async () => {
    const lmOnly = await opened({ compare: 'lm', lmView: 'both' })
    expect(figures()).toHaveLength(1)
    const [grey, hit] = layersOf(figures()[0]!)
    expect(grey!.dataset.grey).toBe('true')
    expect(hit!.dataset.lighten).toBe('true')
    lmOnly.view.unmount()

    await opened({ compare: 'overlay', lmView: 'hit', emOpacity: 0.4 })
    const layers = layersOf(figures()[0]!)
    expect(layers).toHaveLength(2)
    expect(layers[1]!.dataset.lighten).toBe('true')
    expect(layers[1]!.style.opacity).toBe('0.4')
    // White by default, so it stands apart from a hit it matches colour for colour.
    expect(layers[1]!.dataset.tint).toBe('white')
    expect(layers[0]!.dataset.tint).toBeUndefined()
  })

  it('switches the overlay’s EM between white and its depth colours', async () => {
    const { onEmTint } = await opened({ compare: 'overlay' })
    fireEvent.click(screen.getByRole('button', { name: 'EM in colour' }))
    expect(onEmTint).toHaveBeenCalledWith('colour')
  })

  it('fades the overlay live while dragging, and writes the opacity once, on release', async () => {
    const { onEmOpacity } = await opened({ compare: 'overlay', emOpacity: 0.7 })
    const slider = screen.getByRole('slider', { name: 'EM opacity' })
    fireEvent.change(slider, { target: { value: '0.3' } })
    fireEvent.change(slider, { target: { value: '0.2' } })
    expect(onEmOpacity).not.toHaveBeenCalled()
    expect(layersOf(figures()[0]!).at(-1)!.style.opacity).toBe('0.2')
    fireEvent.pointerUp(slider)
    expect(onEmOpacity).toHaveBeenCalledTimes(1)
    expect(onEmOpacity).toHaveBeenCalledWith(0.2)
  })

  it('opens a figure full screen, switches it with the EM/LM buttons, and closes on Escape', async () => {
    await opened()
    fireEvent.click(detail().querySelectorAll('.nbridge__open')[1]!)
    const dialog = screen.getByRole('dialog')
    // Portalled out of the card, as `Modal` does for a card's dialog.
    expect(dialog.closest('.nbridge-full')!.parentElement).toBe(document.body)
    expect(dialog.getAttribute('aria-label')).toMatch(/^LM /)
    // The footer carries the details and the same controls as the card.
    expect(within(dialog).getByText('Collection')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Overlay' })).toBeTruthy()
    // The EM/LM switch is a pair of buttons; the arrows are the lines'.
    fireEvent.click(within(dialog).getByRole('button', { name: 'EM' }))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toMatch(/^EM /)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Escape closed the full-screen view only; the comparison under it is still open.
    expect(detail()).not.toBeNull()
  })

  it('keeps the full-screen view’s clicks from reaching the card behind it', async () => {
    const onCardClick = vi.fn()
    const onCardDoubleClick = vi.fn()
    const all = card()
    all.view.rerender(
      <div onClick={onCardClick} onDoubleClick={onCardDoubleClick}>
        <NeuronBridgeViewer {...all.props} />
      </div>,
    )
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    fireEvent.click(detail().querySelector('.nbridge__open')!)
    onCardClick.mockClear()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'LM' }))
    fireEvent.doubleClick(dialog.querySelector('.nbridge__stack')!)
    expect(onCardClick).not.toHaveBeenCalled()
    expect(onCardDoubleClick).not.toHaveBeenCalled()
  })
})

describe('NeuronBridgeViewer — stepping through lines', () => {
  /** The line names on the tiles, in order: what ← and → step through. */
  const tileLines = () =>
    [...document.querySelectorAll<HTMLElement>('.nbridge__tile[data-line]')].map(
      (tile) => tile.dataset.line!,
    )
  const openLine = () =>
    document.querySelector('.nbridge__detail .nbridge__detail-line')?.textContent ?? null
  const selectedTile = () =>
    document.querySelector<HTMLElement>('.nbridge__tile[data-selected]')?.dataset.line
  const press = (key: string, target: Element = document.activeElement ?? document.body) =>
    fireEvent.keyDown(target, { key })

  async function openFirst(props: Partial<NeuronBridgeViewerProps> & Partial<NbView> = {}) {
    const handles = card(props)
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    const thumb = firstTiles()[0]!.querySelector<HTMLButtonElement>('.nbridge__thumb')!
    fireEvent.click(thumb)
    thumb.focus()
    return handles
  }

  it('steps to the next and previous line with the arrow keys, and stops at the ends', async () => {
    await openFirst()
    const order = tileLines()
    expect(openLine()).toBe(order[0])
    press('ArrowRight')
    expect(openLine()).toBe(order[1])
    expect(selectedTile()).toBe(order[1])
    press('ArrowRight')
    press('ArrowLeft')
    expect(openLine()).toBe(order[1])
    press('ArrowLeft')
    press('ArrowLeft')
    expect(openLine()).toBe(order[0])
    expect(screen.getByText('1 / 25')).toBeTruthy()
  })

  it('shows the next batch of lines when stepping past the last one on screen', async () => {
    await openFirst({ tiles: 6 })
    expect(firstTiles()).toHaveLength(6)
    for (let i = 0; i < 6; i++) press('ArrowRight')
    expect(firstTiles()).toHaveLength(12)
    expect(openLine()).toBe(tileLines()[6])
  })

  it('steps from a line’s second image to the next line, not the same one again', async () => {
    await openFirst({ tiles: 60 })
    fireEvent.click(document.querySelector('.nbridge__others')!)
    const order = tileLines()
    fireEvent.click(document.querySelector('.nbridge__tile[data-secondary] .nbridge__thumb')!)
    expect(openLine()).toBe(order[0])
    press('ArrowRight', detailRegion())
    expect(openLine()).toBe(order[1])
  })

  it('leaves the arrows to a slider and to anything without a match open', async () => {
    card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    press('ArrowRight', firstTiles()[0]!)
    expect(openLine()).toBeNull()
    cleanup()
    await openFirst({ compare: 'overlay' })
    const before = openLine()
    press('ArrowRight', screen.getByRole('slider', { name: 'EM opacity' }))
    expect(openLine()).toBe(before)
  })

  it('keeps the arrows from React Flow, which moves a selected node with them', async () => {
    const onNodeKeyDown = vi.fn()
    const all = card()
    all.view.rerender(
      <div onKeyDown={onNodeKeyDown}>
        <NeuronBridgeViewer {...all.props} />
      </div>,
    )
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    press('ArrowRight', detailRegion())
    expect(onNodeKeyDown).not.toHaveBeenCalled()
  })

  it('takes the focus when opened, so the keys work where a click focuses nothing', async () => {
    card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    // Safari's behaviour: the click leaves focus on the body.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    expect(document.activeElement).toBe(detailRegion())
  })

  it('steps through lines in full screen, keeping the LM image full screen', async () => {
    await openFirst()
    const order = tileLines()
    fireEvent.click(detailRegion().querySelectorAll('.nbridge__open')[1]!)
    const dialog = () => screen.getByRole('dialog')
    // Where a key pressed in full screen lands: the view takes the focus as it opens.
    const fullKeys = () => document.activeElement!
    expect(fullKeys().closest('.nbridge-full')).not.toBeNull()
    expect(dialog().getAttribute('aria-label')).toContain(`LM ${order[0]}`)
    press('ArrowRight', fullKeys())
    press('ArrowRight', fullKeys())
    expect(dialog().getAttribute('aria-label')).toContain(`LM ${order[2]}`)
    expect(within(dialog()).getByText('3 / 25')).toBeTruthy()
    // The card behind followed along.
    expect(selectedTile()).toBe(order[2])
    press('ArrowLeft', fullKeys())
    expect(dialog().getAttribute('aria-label')).toContain(`LM ${order[1]}`)
  })

  it('offers the same steps as buttons', async () => {
    await openFirst()
    const order = tileLines()
    fireEvent.click(screen.getByRole('button', { name: 'Next line' }))
    expect(openLine()).toBe(order[1])
    fireEvent.click(screen.getByRole('button', { name: 'Previous line' }))
    expect(openLine()).toBe(order[0])
    expect(screen.getByRole('button', { name: 'Previous line' })).toHaveProperty(
      'disabled',
      true,
    )
  })
})

describe('NeuronBridgeViewer — pinning from the image, and the pinned download', () => {
  async function openFirstLm() {
    const handles = card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    fireEvent.click(detailRegion().querySelectorAll('.nbridge__open')[1]!)
    return handles
  }
  const dialog = () => screen.getByRole('dialog')
  const pinButton = () => within(dialog()).getByRole('button', { name: /Pin/ })

  it('pins the line on screen from full screen, and unpins it', async () => {
    const { onPins, view, props } = await openFirstLm()
    const line = dialog()
      .getAttribute('aria-label')!
      .match(/^LM (\S+)/)![1]
    expect(pinButton().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pinButton())
    const written = onPins.mock.calls.at(-1)![0] as string[]
    expect(written.map((e) => decodePin(e)!.line)).toEqual([line])

    view.rerender(<NeuronBridgeViewer {...props} pins={written} />)
    expect(pinButton().textContent).toBe('★ Pinned')
    // The tile behind agrees: one pin, one state, two places to see it.
    expect(firstTiles()[0]!.querySelector('.nbridge__star')!.getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.click(pinButton())
    expect(onPins).toHaveBeenLastCalledWith([])
  })

  it('pins whichever line it has stepped to, keeping the pins already made', async () => {
    const { onPins, view, props } = await openFirstLm()
    fireEvent.click(pinButton())
    const first = onPins.mock.calls.at(-1)![0] as string[]
    view.rerender(<NeuronBridgeViewer {...props} pins={first} />)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(pinButton().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pinButton())
    const both = (onPins.mock.calls.at(-1)![0] as string[]).map((e) => decodePin(e)!.line)
    expect(both).toHaveLength(2)
    expect(both[0]).toBe(decodePin(first[0]!)!.line)
    expect(both[1]).not.toBe(both[0])
  })

  it('pins from the comparison on the card too', async () => {
    const { onPins } = card()
    await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
    fireEvent.click(firstTiles()[0]!.querySelector('.nbridge__thumb')!)
    fireEvent.click(within(detailRegion()).getByRole('button', { name: /Pin/ }))
    expect(onPins).toHaveBeenCalledTimes(1)
  })

  describe('the pinned download', () => {
    let capture: ReturnType<typeof installDownloadCapture>
    beforeEach(() => {
      capture = installDownloadCapture()
    })
    afterEach(() => capture.restore())

    const pinOf = (neuronId: string, line: string, lmImageId: string) =>
      encodePin({
        neuronId,
        line,
        collection: 'FlyLight Split-GAL4 Drivers',
        method: 'cds',
        score: 1234,
        pppmRank: null,
        matchingPixels: 99,
        mirrored: false,
        area: 'Brain',
        slideCode: 's',
        objective: '63x',
        lmImageId,
        emLibrary: 'FlyEM_Hemibrain_v1.2.1',
        nbVersion: 'v3_10_0',
      })

    it('offers the pinned table beside the lines, and writes exactly what the Pinned port emits', async () => {
      // One pin on a neuron not on screen: the download is every neuron's pins.
      const pins = [pinOf('1734350788', 'SS02800', '1'), pinOf('5813022341', 'SS00001', '2')]
      card({ pins, baseName: 'my-graph_nb' })
      await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
      fireEvent.click(screen.getByLabelText('Download'))
      expect(screen.getByText('CSV data')).toBeTruthy()
      // The row names the extension it writes — not the table's internal id, which it once did.
      expect(screen.getByText('Pinned matches (CSV)').closest('button')!.textContent).toBe(
        'Pinned matches (CSV).csv',
      )
      fireEvent.click(screen.getByText('Pinned matches (CSV)'))
      await waitFor(() => expect(capture.downloads).toHaveLength(1))
      expect(capture.downloads[0]!.filename).toBe('my-graph_nb-pinned.csv')
      expect(await capture.downloads[0]!.text()).toBe(
        tableToCsvParts(pinnedTable(readPins(pins))).join(''),
      )
    })

    it('says there is nothing pinned rather than writing an empty file', async () => {
      const onError = vi.fn()
      card({ onError })
      await waitFor(() => expect(firstTiles().length).toBeGreaterThan(0))
      fireEvent.click(screen.getByLabelText('Download'))
      fireEvent.click(screen.getByText('Pinned matches (CSV)'))
      await waitFor(() => expect(onError).toHaveBeenCalled())
      expect(onError.mock.calls[0]![0]).toMatch(/Nothing is pinned yet/)
      expect(capture.downloads).toHaveLength(0)
    })
  })
})

function detailRegion(): HTMLElement {
  return document.querySelector<HTMLElement>('.nbridge__detail')!
}
