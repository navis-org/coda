/**
 * "Reading a card" — the three ways it can go wrong without anything failing.
 *
 * The figure is hand-authored markup with hand-placed labels, which is two of them: a callout can
 * point at an element that is not there any more, and two labels can be placed on top of each
 * other. The third is the one that matters most and is the least visible — the card it draws is a
 * *copy* of the editor's chrome, so a button renamed in `CodaNodeView` leaves a guide confidently
 * describing a control that no longer says that. Nothing on the page breaks; it just becomes
 * untrue.
 *
 * What is deliberately not asserted here is the arrangement. jsdom performs no layout, so whether
 * a leader crosses a card or a hover panel falls off the stage is `pnpm probe:node-anatomy`'s
 * question, taken in a browser.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { STATE_GLYPH, STATE_TEXT } from '../ui/nodes/runState'
import { ANATOMY_PARTS, STAGE_H, STAGE_W, anatomyHTML } from './anatomy'

const html = anatomyHTML()

/** Every `data-anat="…"` in the figure, in document order. */
const targets = [...html.matchAll(/data-anat="([^"]+)"/g)].map((m) => m[1] as string)

/** Every callout's `data-for`, which is the other half of the same pair. */
const pointers = [...html.matchAll(/data-for="([^"]+)"/g)].map((m) => m[1] as string)

describe('every callout points at something, and everything pointed at is explained', () => {
  it('pairs each label with a part', () => {
    expect([...pointers].sort()).toEqual([...ANATOMY_PARTS].sort())
    for (const id of ANATOMY_PARTS) expect(targets, `no part for "${id}"`).toContain(id)
  })

  /*
   * The other direction, which is the one that rots quietly: a part can keep its `data-anat` after
   * its callout is edited away, and then the figure carries a rectangle round a button with
   * nothing to say about it.
   *
   * The three chrome controls the *other* card carries are the deliberate exception — the Explore
   * card draws `☰` and `▾` because a real card does, and they are labelled once on the dataset
   * card rather than twice.
   */
  it('leaves nothing marked but unexplained', () => {
    const unlabelled = targets.filter((id) => !pointers.includes(id))
    expect(unlabelled.sort()).toEqual(['ds-run', 'ex-collapse', 'ex-fold'])
  })

  it('marks each part exactly once', () => {
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe('the notes are the content', () => {
  it('gives every part a sentence rather than a caption', () => {
    for (const m of html.matchAll(/<div class="anat__note"[^>]*>\s*<p>([^<]+)<\/p>/g)) {
      const note = (m[1] as string).trim()
      expect(note.length, note).toBeGreaterThan(60)
      expect(note.endsWith('.'), note).toBe(true)
    }
  })

  it('names every run state the scheduler has', () => {
    for (const [state, text] of Object.entries(STATE_TEXT)) {
      expect(html, `no row for "${state}"`).toContain(`data-state="${state}"`)
      expect(html).toContain(`<span>${text}</span>`)
    }
    // The empty glyph is `idle`'s whole point; the rest have to be drawn.
    for (const glyph of Object.values(STATE_GLYPH)) if (glyph) expect(html).toContain(glyph)
  })
})

/**
 * The labels are placed by hand in the stage's px world, and the failure that is invisible from
 * here is two of them landing on the same spot — which happened twice while this was being
 * arranged.
 *
 * The height is estimated from the label's own text against the mono column width, because a
 * label that wraps to two lines is twice as tall as the coordinate table suggests; that is the
 * exact case that collided. Approximate on purpose: the point is to catch an overlap, and a
 * generous box is the safe direction to be wrong in.
 */
describe('the labels are inside the stage and clear of each other', () => {
  const labels = [
    ...html.matchAll(/data-for="([^"]+)"[\s\S]*?--x:(\d+)px; --y:(\d+)px; --w:(\d+)px/g),
  ]
    .map((m) => ({
      id: m[1] as string,
      x: Number(m[2]),
      y: Number(m[3]),
      w: Number(m[4]),
    }))
    .map((l) => {
      const text = new RegExp(`data-for="${l.id}"[\\s\\S]*?</span>([^<]+)</button>`).exec(html)
      const chars = (text?.[1] ?? '').trim().length
      const lines = Math.max(1, Math.ceil((chars * 6.4 + 20) / l.w))
      return { ...l, h: lines * 19 + 6 }
    })

  it('reads every one', () => {
    expect(labels.length).toBe(ANATOMY_PARTS.length)
  })

  it('keeps them in the world the stage declares', () => {
    for (const l of labels) {
      expect(l.x + l.w, l.id).toBeLessThanOrEqual(STAGE_W)
      expect(l.y + l.h, l.id).toBeLessThanOrEqual(STAGE_H)
    }
  })

  it('does not stack two on one spot', () => {
    for (const a of labels) {
      for (const b of labels) {
        if (a.id >= b.id) continue
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart, `"${a.id}" overlaps "${b.id}"`).toBe(true)
      }
    }
  })

  /* A hover panel is `visibility: hidden` rather than absent, so one hanging off the right of the
     stage widens the *document* at every viewport width — see `NOTE_W` in `anatomy.ts`. */
  it('hangs each hover panel from the end that keeps it on the stage', () => {
    const NOTE_W = 252
    for (const l of labels) {
      const side = new RegExp(`data-for="${l.id}"[\\s\\S]*?data-notex="(l|r)"`).exec(html)?.[1]
      const left = side === 'r' ? l.x + l.w - NOTE_W : l.x
      expect(left, `${l.id} panel starts off the stage`).toBeGreaterThanOrEqual(0)
      expect(left + NOTE_W, `${l.id} panel ends off the stage`).toBeLessThanOrEqual(STAGE_W)
    }
  })
})

/**
 * The figure copies the editor's chrome, and a copy is a thing that goes stale.
 *
 * Each row is a control the figure draws and the literal the app writes on it, checked in both
 * directions: the guide has to carry it, and the component has to still say it. A `title` is the
 * right anchor because it is the sentence a reader would otherwise have hovered the real control
 * to read — if it has been reworded, the note beside it here is describing something else.
 *
 * A fragment rather than the whole string where the app builds one (`Data read 3d ago — …`, and
 * the help button's `What ${label} does`), since the variable half is exactly what this figure
 * fills in with its own example.
 */
describe('the chrome it draws is the chrome the editor draws', () => {
  const sources: Record<string, string> = {
    card: readFileSync('src/ui/nodes/CodaNodeView.tsx', 'utf8'),
    dataset: readFileSync('src/ui/nodes/DatasetBody.tsx', 'utf8'),
    cache: readFileSync('src/ui/nodes/CacheAge.tsx', 'utf8'),
    explore: readFileSync('src/ui/explore/ExploreBody.tsx', 'utf8'),
  }

  const CONTROLS: ReadonlyArray<[part: string, source: string, title: string]> = [
    ['run', 'card', 'Run this node and everything it needs'],
    ['ds-run', 'card', 'Already up to date'],
    ['expand', 'card', 'Open this result full size'],
    ['pin', 'card', 'Pin this result to the side of the canvas'],
    ['help', 'card', 'does, and what it assumes'],
    ['fold', 'card', 'Hide the parameters and ports, giving the space to what is below them'],
    ['collapse', 'card', 'Collapse'],
    ['edges', 'dataset', 'Attach a user-supplied edge list'],
    ['cache', 'cache', 'click to fetch it again'],
  ]

  it.each(CONTROLS)('%s says what the card says', (part, source, title) => {
    const control = new RegExp(`data-anat="${part}"[^>]*title="([^"]*)"`).exec(html)?.[1]
    expect(control, `no titled control for "${part}"`).toBeDefined()
    expect(control).toContain(title)
    expect(sources[source], `"${title}" is gone from ${source}`).toContain(title)
  })

  /* The glyphs, which carry as much of the meaning as the words and are as easy to change. */
  it.each([
    ['▶', '&#9654;'],
    ['⤢', '&#10530;'],
    ['⇥', '&#8677;'],
    ['☰', '&#9776;'],
    ['▾', '&#9662;'],
  ])('draws %s where the card does', (glyph, entity) => {
    expect(html).toContain(entity)
    expect(sources.card).toContain(glyph)
  })

  it('spells the selection row the way Explore spells it', () => {
    for (const label of ['+ page', '+ all']) {
      expect(html).toContain(label)
      expect(sources.explore).toContain(label)
    }
  })
})

describe('the page carries the slot this is spliced into', () => {
  it('has a marker for it', () => {
    expect(readFileSync('nodes.html', 'utf8')).toContain('<!--@node-anatomy-->')
  })
})
