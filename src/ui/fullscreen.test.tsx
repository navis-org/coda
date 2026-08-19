// @vitest-environment jsdom

/**
 * Fullscreen, both halves of it.
 *
 * The session half is a toggle in the toolbar, an `F` shortcut and a palette command, all
 * three going through `toggleFullscreen`. What is worth pinning is not that they call it — it
 * is that the button's state is read back off `document.fullscreenElement` rather than written
 * where it was clicked. A browser can refuse, and Escape and F11 both leave fullscreen without
 * passing through anything here; a ⛶ latched on by its own click is wrong in all three cases,
 * and it fails no type check.
 *
 * The persistent half is a web manifest, and it has exactly one way to go wrong that nothing
 * else would catch: an absolute `start_url` works perfectly on a dev server at the domain root
 * and scopes the installed app to `/` on GitHub Pages, where the app lives under `/coda/`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../App'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { useGraphStore } from '../store/graphStore'
import { clearStorage, installFullscreenStub, installJsdomStubs } from '../test/jsdomStubs'

let fullscreen: ReturnType<typeof installFullscreenStub>

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
  fullscreen = installFullscreenStub()
})

beforeEach(() => {
  clearStorage()
  fullscreen.requests.length = 0
  fullscreen.exits.length = 0
  act(() => {
    fullscreen.setElement(null)
    // The start page renders over everything, which is its job — and would sit in front of
    // the toolbar this file is about.
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

const button = () => screen.getByRole('button', { name: /fullscreen/i })

describe('the toolbar toggle', () => {
  it('hands the document element to the Fullscreen API', () => {
    render(<App />)
    fireEvent.click(button())
    // The root, not a wrapper: `:fullscreen`'s `position: fixed` rule exempts `:root`, so this
    // is the one target whose layout is unchanged by the transition.
    expect(fullscreen.requests).toEqual([document.documentElement])
  })

  it('stays unpressed until the browser actually grants it', () => {
    render(<App />)
    fireEvent.click(button())
    // Asked, not granted — which is what a refusal looks like from here, and what the button
    // would get wrong if it latched on its own click.
    expect(button().getAttribute('aria-pressed')).toBe('false')

    act(() => fullscreen.setElement(document.documentElement))
    expect(button().getAttribute('aria-pressed')).toBe('true')
  })

  it('follows fullscreen being left from outside the app', () => {
    render(<App />)
    act(() => fullscreen.setElement(document.documentElement))
    expect(button().getAttribute('aria-pressed')).toBe('true')

    // Escape, or F11: the browser leaves and only says so afterwards.
    act(() => fullscreen.setElement(null))
    expect(button().getAttribute('aria-pressed')).toBe('false')
    expect(fullscreen.requests.length).toBe(0)
  })

  it('exits rather than re-requesting once it is the fullscreen element', () => {
    render(<App />)
    act(() => fullscreen.setElement(document.documentElement))
    fireEvent.click(button())
    expect(fullscreen.exits).toEqual([document.documentElement])
    expect(fullscreen.requests.length).toBe(0)
  })

  it('names the direction it is about to go, in both states', () => {
    render(<App />)
    expect(button().getAttribute('aria-label')).toBe('Enter fullscreen')
    act(() => fullscreen.setElement(document.documentElement))
    expect(button().getAttribute('aria-label')).toBe('Leave fullscreen')
  })
})

describe('the F shortcut', () => {
  it('toggles fullscreen from the canvas', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'f' })
    expect(fullscreen.requests).toEqual([document.documentElement])
  })

  it('is not stolen from a field somebody is typing in', () => {
    render(<App />)
    // The graph-name box is in the toolbar, an inch from the button — typing "Fly" into it
    // must not put the window fullscreen twice.
    fireEvent.keyDown(screen.getByTitle(/Graph name/), { key: 'f' })
    expect(fullscreen.requests.length).toBe(0)
  })
})

describe('the web manifest', () => {
  // `process.cwd()` rather than `import.meta.url`, which the rest of the suite uses: under the
  // jsdom environment vite rewrites that to an http URL and `fileURLToPath` refuses it. Vitest
  // runs from the project root.
  const publicFile = (name: string) => resolve(process.cwd(), 'public', name)

  const manifest = JSON.parse(readFileSync(publicFile('manifest.webmanifest'), 'utf8')) as {
    start_url: string
    scope: string
    display: string
    icons: { src: string; sizes: string }[]
  }

  it('asks for a window with no browser chrome in it', () => {
    expect(manifest.display).toBe('standalone')
  })

  it('keeps start_url and scope relative, so a subpath deploy still works', () => {
    // Resolved against the manifest's own URL. Absolute would point at the domain root, which
    // on GitHub Pages is somebody else's site.
    for (const url of [manifest.start_url, manifest.scope]) {
      expect(url.startsWith('/')).toBe(false)
      expect(/^[a-z]+:/i.test(url)).toBe(false)
    }
  })

  it('ships every icon it declares', () => {
    // A manifest naming a file that is not in `public/` installs an app with a blank icon.
    for (const icon of manifest.icons) {
      expect(() => readFileSync(publicFile(icon.src))).not.toThrow()
    }
    expect(manifest.icons.map((i) => i.sizes)).toContain('192x192')
    expect(manifest.icons.map((i) => i.sizes)).toContain('512x512')
  })
})
