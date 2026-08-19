/**
 * The Coda mark, as an inline SVG.
 *
 * The name is the mark: in music a *coda* is the concluding passage, and its sign is a ring
 * crossed by two lines — which is also, near enough, a graph node with four ports.
 *
 * Geometry is not invented. It is measured off the Bravura outline (the SMuFL reference music
 * font, U+E048): there the ring is 670 × 750 units — **0.89 wide-to-tall, not a circle** — drawn
 * with a 2.9:1 calligraphic stroke, heavy at 3 and 9 o'clock and thin at 12 and 6, with cross
 * bars thinner than either. Two cuts of that live here:
 *
 *  - `outline` — the ring at the true 0.90 oval, but with the stroke contrast pulled back to
 *    1.6:1 so the thin axis never falls under a pixel. This is the primary mark.
 *  - `solid` — the ring as a filled mass with the cross knocked out of it, which is how the
 *    real glyph is actually constructed. More presence, but see the size note below.
 *
 * **Size matters more than usual here.** At 16px the solid cut's knockout eats the disc and the
 * mark reads as a four-pointed star rather than a coda; the outline cut keeps its identity all
 * the way down. So: `outline` for anything small or incidental, `solid` only above ~24px.
 *
 * **Colour is the caller's.** Both cuts paint in `currentColor`, so the mark takes the ink of
 * whatever it sits in. That is deliberate in the toolbar, where painting it `--accent` would
 * make it the same blue as a Table socket and read as a typed port rather than as chrome.
 * `public/logo.svg` and `public/icon.svg` carry the same geometry with colours baked in, for
 * the favicon, touch icon and README where no CSS reaches.
 */

import { useId } from 'react'

export type CodaMarkVariant = 'outline' | 'solid'

export interface CodaMarkProps {
  /** Rendered edge length in px. The mark is square and centred in its box. */
  size?: number
  /** `solid` is only legible above roughly 24px — see the note above. */
  variant?: CodaMarkVariant
  className?: string
}

export function CodaMark({ size = 20, variant = 'outline', className }: CodaMarkProps) {
  // Two marks on one page must not share a mask id. `useId` produces colons, which are legal in
  // a fragment reference but awkward everywhere else, so they come out.
  const maskId = `coda-mark-${useId().replace(/:/g, '')}`

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {variant === 'outline' ? (
        <>
          {/* Ring: outer ellipse 18 × 20, inner 12.24 × 16.4 — 5.76 of stroke at the sides
              against 3.6 at top and bottom. */}
          <path
            fillRule="evenodd"
            d="M32 12a18 20 0 1 0 0 40 18 20 0 1 0 0-40Zm0 3.6a12.24 16.4 0 1 1 0 32.8 12.24 16.4 0 1 1 0-32.8Z"
          />
          <rect x="30" y="5" width="4" height="54" rx="2" />
          <rect x="7" y="30" width="50" height="4" rx="2" />
        </>
      ) : (
        <>
          {/* The cross is a real hole rather than a stroke in the background colour, so the
              solid cut can sit on any surface — including the start page's image. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
            <ellipse cx="32" cy="32" rx="16.8" ry="18.7" fill="#fff" />
            <path d="M32 10V54M10 32H54" stroke="#000" strokeWidth="3.8" />
          </mask>
          <ellipse cx="32" cy="32" rx="16.8" ry="18.7" mask={`url(#${maskId})`} />
          <g fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
            <path d="M32 8.2V10.7" />
            <path d="M32 53.3V55.8" />
            <path d="M10.6 32H12.6" />
            <path d="M51.4 32H53.4" />
          </g>
        </>
      )}
    </svg>
  )
}
