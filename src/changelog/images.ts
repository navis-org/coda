/**
 * What the changelog's readers need to know about its images, apart from the entries.
 *
 * Its own module, rather than exports of `entries.ts`, because the editor imports it statically:
 * the What's New card picks thumbnails with it, and importing anything at runtime from
 * `entries.ts` would put the whole changelog's prose into the editor's first chunk. Types only
 * from there, which cost nothing.
 */

import type { Capture } from './entries'

/**
 * The pixel density captures are taken at. Read by `scripts/changelog-shots.mjs` to take them and
 * by `render.ts` to draw them at the size they had on screen; an image with no `capture` is 1x.
 */
export const CAPTURE_DENSITY = 2

/**
 * Whether a capture pictures the What's New card itself. The card draws other entries'
 * thumbnails, so such a capture runs after every other one, and its own image is never used as
 * a thumbnail — the card would contain itself.
 */
export const depictsCard = (capture: Capture | undefined): boolean =>
  capture?.open === 'openWhatsNew'

/** The thumbnail `pnpm changelog:shots` writes beside a captured image. */
export const thumbFile = (file: string): string => file.replace(/\.(\w+)$/, '.thumb.$1')
