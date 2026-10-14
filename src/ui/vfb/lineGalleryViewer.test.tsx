// @vitest-environment jsdom

/**
 * The VFB Line Gallery card, in jsdom.
 *
 * jsdom loads no images, so what is checked is the wiring: one lead tile per line, a line's other
 * images behind `+N`, the ☆ writing the pins param, and which image the large view shows and when
 * it asks for the stack.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { tableFromRows } from '../../core/values'
import { IMAGES_SCHEMA } from '../../packs/vfb/ops'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { LineGalleryViewer } from './LineGalleryViewer'
import type { GalleryView } from '../../packs/vfb/ops'

/** The card as the node draws it: the view params held the way `onParamChange` would hold them. */
function Gallery(props: Partial<ComponentProps<typeof LineGalleryViewer>>) {
  const [mode, setMode] = useState<GalleryView>('projection')
  const [withTemplate, setWithTemplate] = useState(true)
  return (
    <LineGalleryViewer
      images={undefined}
      tiles={24}
      pins={[]}
      onPins={() => {}}
      mode={mode}
      onMode={setMode}
      withTemplate={withTemplate}
      onWithTemplate={setWithTemplate}
      {...props}
    />
  )
}

beforeAll(() => installJsdomStubs({ width: 1000, height: 700 }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const thumb = (id: string) => `https://www.virtualflybrain.org/data/VFB/i/${id}/thumbnail.png`

function images() {
  const row = (lineId: string, line: string, imageId: string, part = 'line') => ({
    line,
    imageId,
    specimen: `${line} ${imageId}`,
    part,
    template: 'VFB_00101567',
    license: 'CC-BY_4.0',
    thumbnail: thumb(imageId),
    lineId,
  })
  return tableFromRows(IMAGES_SCHEMA, [
    row('exp_a', 'MB074C', 'VFB_a1'),
    row('exp_a', 'MB074C', 'VFB_a2'),
    row('exp_a', 'MB074C', 'VFB_a3', 'fragment'),
    row('exp_b', 'R15B01', 'VFB_b1'),
  ])
}

describe('VFB Line Gallery', () => {
  const lead = () => document.querySelectorAll('.image-tile:not([data-secondary])')

  it('draws one tile per line at its first image, the others behind +N, opened as one band', () => {
    render(<Gallery images={images()} />)
    expect([...lead()].map((t) => t.getAttribute('data-line'))).toEqual(['exp_a', 'exp_b'])
    expect(lead()[0]!.querySelector('img')!.getAttribute('src')).toBe(thumb('VFB_a1'))
    const more = document.querySelector<HTMLButtonElement>('.image-tile__others')!
    expect(more.textContent).toBe('+2')
    expect(document.querySelector('.image-tiles__group[data-open]')).toBeNull()
    fireEvent.click(more)
    const band = document.querySelector('.image-tiles__group[data-open]')!
    expect(band.getAttribute('aria-label')).toBe('MB074C')
    expect(band.querySelectorAll('.image-tile')).toHaveLength(3)
  })

  it('pins and unpins an image through the pins param', () => {
    const onPins = vi.fn()
    const { rerender } = render(
      <Gallery images={images()} tiles={24} pins={[]} onPins={onPins} />,
    )
    fireEvent.click(lead()[1]!.querySelector('.image-tile__star')!)
    expect(onPins).toHaveBeenLastCalledWith(['VFB_b1'])
    rerender(<Gallery images={images()} tiles={24} pins={['VFB_b1']} onPins={onPins} />)
    const star = lead()[1]!.querySelector('.image-tile__star')!
    expect(star.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(star)
    expect(onPins).toHaveBeenLastCalledWith([])
    expect(screen.getByText('1 image pinned')).toBeTruthy()
  })

  it('counts the pins the Pinned port emits, and says when stored pins are gone from the table', () => {
    render(<Gallery images={images()} pins={['VFB_b1', 'VFB_gone']} />)
    expect(screen.getByText('1 image pinned; 1 pin no longer in the table')).toBeTruthy()
  })

  it('shows the first line in the large view, and an opened tile in its place', () => {
    render(<Gallery images={images()} />)
    const view = () => document.querySelector<HTMLImageElement>('.vfb-stage img')!
    expect(view().getAttribute('src')).toBe(thumb('VFB_a1'))
    expect(screen.getByText('Licence: CC-BY_4.0')).toBeTruthy()
    fireEvent.click(lead()[1]!.querySelector('.image-tile__thumb')!)
    expect(view().getAttribute('src')).toBe(thumb('VFB_b1'))
    const link = document.querySelector<HTMLAnchorElement>('.vfb-gallery__links a')!
    expect(link.href).toBe('https://virtualflybrain.org/reports/VFB_b1')
  })

  it('loads the stack only when Slices is chosen, and steps through it', async () => {
    const fetch = stubStack()
    render(<Gallery images={withStack()} />)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Slices'))
    const slider = await screen.findByRole('slider')
    expect(slider.getAttribute('max')).toBe('4')
    // It opens at the middle slice.
    expect(screen.getByText('z 3 / 5')).toBeTruthy()
    expect(String(fetch.mock.calls[0]![0])).toBe(NRRD_URL)
  })

  it('projects the stack for the view without the template, and keeps only the projection', async () => {
    const fetch = stubStack()
    render(<Gallery images={withStack()} />)
    const template = () => screen.getByLabelText('template')
    const drawn = () => document.querySelector('.vfb-stage__slice')
    expect(document.querySelector('.vfb-stage img')).toBeTruthy()
    // VFB publishes no template-free image, so unticking asks for the stack and projects it.
    fireEvent.click(template())
    await vi.waitFor(() => expect(drawn()).toBeTruthy())
    expect(screen.queryByRole('slider')).toBeNull()
    // Back and forth redraws from the kept projection, with no second fetch.
    fireEvent.click(template())
    expect(drawn()).toBeNull()
    fireEvent.click(template())
    expect(drawn()).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    // The stack itself was let go, so Slices asks for it again (from the browser's cache, live).
    fireEvent.click(screen.getByText('Slices'))
    expect(await screen.findByRole('slider')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('downloads the stack once when Slices is chosen while the projection is still loading', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const fetch = vi.fn(async () => {
      await held
      return new Response(nrrdBytes(4, 3, 5))
    })
    vi.stubGlobal('fetch', fetch)
    render(<Gallery images={withStack()} />)
    fireEvent.click(screen.getByLabelText('template'))
    fireEvent.click(screen.getByText('Slices'))
    release()
    expect(await screen.findByRole('slider')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('turns a VNC stack to lie as VFB draws the nerve cord', async () => {
    stubStack()
    render(<Gallery images={withStack({ template: 'VFB_00200000' })} />)
    fireEvent.click(screen.getByText('Slices'))
    await screen.findByRole('slider')
    // The 4×3 stack, drawn 3 wide and 4 tall.
    const canvas = document.querySelector<HTMLCanvasElement>('.vfb-stage__slice')!
    expect([canvas.width, canvas.height]).toEqual([3, 4])
  })

  it('shows lines in steps', () => {
    render(<Gallery images={images()} tiles={1} />)
    expect(lead()).toHaveLength(1)
    fireEvent.click(screen.getByText('Show more'))
    expect(lead()).toHaveLength(2)
  })
})

const NRRD_URL = 'https://www.virtualflybrain.org/data/VFB/i/a1/volume.nrrd'

/** One image with a projection and a stack. */
const withStack = (row: Record<string, string> = {}) =>
  tableFromRows(IMAGES_SCHEMA, [
    {
      lineId: 'exp_a',
      line: 'MB074C',
      imageId: 'VFB_a1',
      thumbnail: thumb('VFB_a1'),
      nrrd: NRRD_URL,
      ...row,
    },
  ])

/** `fetch` answering every request with a 4×3×5 stack. */
function stubStack() {
  const fetch = vi.fn(async (_url: string) => new Response(nrrdBytes(4, 3, 5)))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** A raw 8-bit NRRD of the given shape, as VFB writes them but unencoded. */
function nrrdBytes(width: number, height: number, depth: number): Uint8Array {
  const header =
    `NRRD0004\ntype: uint8\nencoding: raw\ndimension: 3\nsizes: ${width} ${height} ${depth}\n` +
    `space directions: (0.5,0,0) (0,0.5,0) (0,0,1)\n\n`
  const head = new TextEncoder().encode(header)
  const out = new Uint8Array(head.length + width * height * depth)
  out.set(head)
  for (let i = head.length; i < out.length; i++) out[i] = i % 256
  return out
}
