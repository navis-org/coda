/**
 * Where the Screen Map's labels land, asked of the arithmetic.
 *
 * The properties here are the ones a browser would show and a jsdom render never could — jsdom
 * performs no layout, so a component test can only ever say a label exists. Fed rects, this can
 * say the labels do not sit on top of each other, do not cover the controls they are pointing
 * at, and do not hang off the window. `pnpm probe:screen-map` asks the same three questions of
 * the real screen; this one is what runs on every commit.
 *
 * The fixture is a shell: a toolbar row of small buttons, a canvas, an inspector column, a
 * status bar. Sizes are plausible rather than measured, which is fine — nothing here is a claim
 * about the real geometry, only about what the placer does with a geometry.
 */

import { describe, expect, it } from 'vitest'

import type { LabelBox, Placement, Rect } from './mapLayout'
import { GAP, PAD, placeLabels } from './mapLayout'

const VIEW = { width: 1440, height: 900 }

const box = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
})

/** Eleven toolbar buttons, a canvas, an inspector and a status bar. */
function shell(): LabelBox[] {
  const items: LabelBox[] = [
    {
      id: 'canvas',
      side: 'inside',
      box: box(0, 42, 1120, 800),
      width: 176,
      height: 52,
      region: true,
      at: [0.5, 0.34],
    },
    {
      id: 'inspector',
      side: 'left',
      box: box(1120, 42, 320, 800),
      width: 176,
      height: 52,
      region: true,
    },
    { id: 'statusbar', side: 'above', box: box(0, 866, 1440, 26), width: 176, height: 40 },
    { id: 'add', side: 'left', box: box(1050, 770, 44, 44), width: 176, height: 52 },
    { id: 'rail', side: 'right', box: box(12, 700, 34, 140), width: 176, height: 52 },
    /*
     * A control sitting in the first row of toolbar labels — a floating button over the canvas,
     * which the real shell has two of. It is what makes "never covers a control" a property with
     * teeth: without it, every label's first candidate is already clear of every box and the
     * assertion passes with the collision test taken out. Checked by doing exactly that.
     *
     * It is also the spot that showed `bandFor`'s rule — see that function, which carries it.
     */
    { id: 'nudge', side: 'left', box: box(300, 60, 40, 40), width: 176, height: 52 },
  ]
  // The toolbar: buttons 30px wide from x = 8, then a cluster on the right.
  for (let i = 0; i < 6; i += 1) {
    items.push({
      id: `left${i}`,
      side: 'below',
      box: box(8 + i * 62, 8, 56, 26),
      width: 176,
      height: 52,
    })
  }
  for (let i = 0; i < 5; i += 1) {
    items.push({
      id: `right${i}`,
      side: 'below',
      box: box(940 + i * 40, 8, 34, 26),
      width: 176,
      height: 52,
    })
  }
  return items
}

const rectOf = (place: Placement, item: LabelBox): Rect => ({
  x: place.x,
  y: place.y,
  width: item.width,
  height: item.height,
})

function hits(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

describe('placeLabels', () => {
  const items = shell()
  const places = placeLabels(items, VIEW)
  const byId = new Map(items.map((item) => [item.id, item]))

  it('places every label, including the ones with a crowded band', () => {
    expect(places.map((place) => place.id).sort()).toEqual(items.map((item) => item.id).sort())
  })

  it('never lets two labels overlap', () => {
    for (let i = 0; i < places.length; i += 1) {
      for (let j = i + 1; j < places.length; j += 1) {
        const a = rectOf(places[i]!, byId.get(places[i]!.id)!)
        const b = rectOf(places[j]!, byId.get(places[j]!.id)!)
        expect(hits(a, b), `${places[i]!.id} overlaps ${places[j]!.id}`).toBe(false)
      }
    }
  })

  /*
   * The failure this is for is the quiet one: a label two pixels over the button it names is a
   * label that renders perfectly and hides the answer. Regions are exempt by construction — the
   * canvas is most of the window and every label is over it.
   */
  it('never covers a control', () => {
    for (const place of places) {
      const label = rectOf(place, byId.get(place.id)!)
      for (const item of items) {
        if (item.region) continue
        expect(hits(label, item.box), `${place.id} covers ${item.id}`).toBe(false)
      }
    }
  })

  it('keeps every label inside the window', () => {
    for (const place of places) {
      const label = rectOf(place, byId.get(place.id)!)
      expect(label.x).toBeGreaterThanOrEqual(PAD)
      expect(label.y).toBeGreaterThanOrEqual(PAD)
      expect(label.x + label.width).toBeLessThanOrEqual(VIEW.width - PAD)
      expect(label.y + label.height).toBeLessThanOrEqual(VIEW.height - PAD)
    }
  })

  /*
   * A leader has to start on the box and finish on the label, or it is a line between two things
   * neither of which is what it connects. Both ends are checked because the elbow makes it easy
   * to get one right and the other wrong — the first version turned the wrong way for `above`
   * and looked plausible for every `below` label on screen.
   */
  it('draws a leader from the box to the label, for everything but a region label', () => {
    for (const place of places) {
      const item = byId.get(place.id)!
      if (item.side === 'inside') {
        expect(place.leader).toEqual([])
        continue
      }
      const first = place.leader[0]!
      const last = place.leader[place.leader.length - 1]!
      const grown = {
        x: item.box.x - 1,
        y: item.box.y - 1,
        width: item.box.width + 2,
        height: item.box.height + 2,
      }
      expect(hits({ x: first[0], y: first[1], width: 0.5, height: 0.5 }, grown)).toBe(true)
      const label = rectOf(place, item)
      expect(last[0]).toBeGreaterThanOrEqual(label.x - 1)
      expect(last[0]).toBeLessThanOrEqual(label.x + label.width + 1)
      expect(last[1]).toBeGreaterThanOrEqual(label.y - 1)
      expect(last[1]).toBeLessThanOrEqual(label.y + label.height + 1)
    }
  })

  it('keeps an obstacle clear — the map draws its own panel there', () => {
    const panel = box(600, 780, 400, 60)
    const withPanel = placeLabels(items, VIEW, [panel])
    for (const place of withPanel) {
      const label = rectOf(place, byId.get(place.id)!)
      expect(hits(label, panel), `${place.id} covers the panel`).toBe(false)
    }
  })

  /*
   * The band is the row, not the side. Eleven toolbar buttons are not all the same height in the
   * real shell, so labels each hugging their own button come out ragged under a row that is
   * visibly straight — but reading that as "one band for everything on this side" is worse, and
   * this is the case that says so: a second `below` spot at the foot of the window (a floating
   * button over the canvas is exactly that) must not drag the toolbar's labels 700px down onto
   * the status bar. Asserted as "the toolbar's labels do not move", which is the property; the
   * number they do not move to is nobody's business.
   */
  it('gives a lone control its own band rather than the side’s', () => {
    const lone: LabelBox = {
      id: 'lone',
      side: 'below',
      box: box(600, 700, 40, 40),
      width: 176,
      height: 52,
    }
    const after = placeLabels([...items, lone], VIEW)
    for (const place of places) {
      const moved = after.find((other) => other.id === place.id)!
      expect([moved.x, moved.y], `${place.id} moved`).toEqual([place.x, place.y])
    }
    // And it is under its own box rather than under the toolbar.
    expect(after.find((place) => place.id === 'lone')!.y).toBeGreaterThanOrEqual(740 + GAP - 10)
  })
})
