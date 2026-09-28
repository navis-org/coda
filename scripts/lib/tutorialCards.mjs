/**
 * The title card and the end card, drawn in headless Chrome as transparent PNGs at the video's
 * own size.
 *
 * Chrome rather than ffmpeg's `drawtext` because the cards should be the product's typography:
 * the mark is `public/logo.svg` itself and the name is set in `--font-ui` (`system-ui`), which is
 * what the toolbar draws. A font file handed to ffmpeg would be a second spelling of both.
 *
 * - `intro.png`: the mark and "Coda", centred, straight over the canvas. There was a radial scrim
 *   behind them; it banded into visible rings after the encode, and the opening canvas is empty
 *   and dark anyway, so there was nothing for it to hold back.
 * - `outro.png`: the mark alone with the site's address under it, on nothing. The render fades
 *   the last frame to the canvas colour (`CANVAS`) first, so it reads as the app emptying out.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { launchChrome } from './browserProbe.mjs'

/** `--canvas` in the dark theme: the colour the end card sits on. */
export const CANVAS = '#121211'
/** Where the end card sends people. */
export const SITE = 'coda.science'

/** The mark, recoloured: the file's own `<style>` picks the blue per colour scheme. */
function mark() {
  const svg = readFileSync(fileURLToPath(new URL('../../public/logo.svg', import.meta.url)), 'utf8')
  const paths = svg.slice(svg.indexOf('<g '), svg.indexOf('</g>') + 4)
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${paths.replace('currentColor', '#3987e5')}</svg>`
}

const PAGE = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
  body { display: grid; place-items: center; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .lockup { position: relative; display: flex; align-items: center; gap: 30px; }
  .lockup svg { width: 132px; height: 132px; }
  .lockup span { font-size: 124px; font-weight: 700; letter-spacing: -0.02em; color: #f3f2ef; line-height: 1; }
  .end { display: flex; flex-direction: column; align-items: center; gap: 34px; }
  .end svg { width: 150px; height: 150px; }
  .end span { font-size: 34px; font-weight: 500; letter-spacing: 0.04em; color: #a3a19b; }
</style></head><body>${body}</body></html>`

/**
 * Write `intro.png` and `outro.png` into `out` and return their paths.
 *
 * @param {string} out  a directory, with a trailing slash
 * @param {{ width: number, height: number, dpr: number }} view
 */
export async function renderCards(out, view) {
  const pages = {
    intro: PAGE(`<div class="lockup">${mark()}<span>Coda</span></div>`),
    outro: PAGE(`<div class="end">${mark()}<span>${SITE}</span></div>`),
  }
  const profile = '/tmp/coda-tutorial-cards'
  const browser = await launchChrome({
    port: 9485,
    profile,
    ...view,
    args: [`--force-device-scale-factor=${view.dpr}`],
  })
  // Transparent, so the cards composite over the video rather than replacing it.
  await browser.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  const files = {}
  try {
    for (const [name, html] of Object.entries(pages)) {
      await browser.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') })
      await browser.waitFor('document.readyState === "complete" && document.fonts.status === "loaded"', `the ${name} card`)
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' })
      files[name] = `${out}${name}.png`
      writeFileSync(files[name], Buffer.from(shot.result.data, 'base64'))
    }
  } finally {
    browser.close()
  }
  return files
}
