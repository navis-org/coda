# The Coda mark

![The Coda mark](../public/logo.svg)

The name is the mark. In music a **coda** is the concluding passage, and its sign is a ring
crossed by two lines — which is also, near enough, a graph node with four ports. Nothing else
in the identity has to explain what Coda is; the mark already does.

## The geometry is measured, not drawn by eye

The first cut of this mark used a compass circle with one uniform stroke. That is wrong. The
numbers below come from the outline of **Bravura**, the SMuFL reference music font (glyph
`U+E048`), read off the curves with `fontTools`:

| | |
|---|---|
| Ring outer | 670 × 750 units — **W/H 0.89**, ~12% taller than wide |
| Ring inner | 337 × 648 units |
| Stroke at 3 and 9 o'clock | 165 units |
| Stroke at 12 and 6 o'clock | 56 units |
| **Contrast** | **2.9 : 1**, heavy at the sides |
| Cross bar | 48 units — thinner than either |

Two things follow, and the second is the one that matters. The ring is an oval. But it is also
a *calligraphic* stroke, and that contrast — not the ovalness — is what stops the sign reading
as a crosshair.

Our cut keeps the 0.89 oval (rounded to 0.90) and pulls the contrast back from 2.9:1 to
**1.6:1**. Bravura's own proportions rebuilt at icon scale put the thin axis at 0.7px in a
browser tab, where it greys out; 1.6:1 keeps every axis above a pixel and still reads as the
coda sign rather than a target.

## Two cuts, because they fail differently

| Cut | Where | Why |
|---|---|---|
| **outline** | favicon, toolbar, anything small | Keeps its *identity* down to 16px — you can still see a ring crossed by two lines |
| **solid** | start page, app icon, avatar | Ring as a filled mass with the cross cut out, which is how the real glyph is built. More presence, no identity below ~24px |

The solid cut's failure is specific and worth knowing: at 16px the knockout eats the disc and
the mark reads as a **four-pointed star**. Bravura's cross bars are 7% of the ring width; the
first version of ours were 14%, which made it worse. They are 3.8 units now. Even so, the rule
stands — solid only above roughly 24px.

This was found by screenshotting at 1 device pixel per CSS pixel and magnifying, not by scaling
an SVG down and squinting at it. A scaled SVG will always look fine; the rasteriser is what
decides.

## Files

| File | Contents |
|---|---|
| [`src/ui/CodaMark.tsx`](../src/ui/CodaMark.tsx) | Both cuts, in `currentColor`, for in-app use |
| [`public/logo.svg`](../public/logo.svg) | Outline cut, blue baked in. Favicon, README, docs |
| [`public/icon.svg`](../public/icon.svg) | Solid cut on a rounded plate. Avatar, source for the touch icon |
| `public/apple-touch-icon.png` | 180px raster of `icon.svg`, because Safari will not take an SVG here |

## Colour

`CodaMark` paints in `currentColor` and takes the ink of whatever contains it. That is not
laziness — it is the fix for a specific collision. The brand blue and `--socket-table` are the
same value (`#3987e5`), so an accent-blue mark in the toolbar sits inches from Table sockets in
exactly that blue and reads as a typed port rather than as chrome. The toolbar mark is therefore
`--text-primary`; the start page mark, in a modal with no sockets in view, is `--accent`.

The standalone files flip between `#2a78d6` and `#3987e5` on `prefers-color-scheme` so the mark
stays comfortable against both a light and a dark browser chrome. If the media query is not
supported the light value applies, which is the safer of the two.

## If you change it

Re-check at 16px on a 1× display before anything else, on both a light and a dark ground. The
mark has no second colour and no wordmark to lean on at that size, so legibility there is the
whole constraint.
