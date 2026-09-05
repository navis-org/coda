/**
 * What each run state looks like and is called, for the surfaces that draw one.
 *
 * Two tables, lifted out of `CodaNodeView` at the second consumer: the box a folded group draws
 * has to say "something in here failed", and typing the `×` out again is how a canvas comes to
 * have cards saying one thing and boxes another. `nodeIssues.ts` is the precedent — the ranking
 * lives in one place because two surfaces read it.
 *
 * A glyph **and** a colour, never colour alone: `.state-badge` tints by `data-state`, and a
 * reader who cannot tell the hues apart still has a mark to read.
 */

import type { NodeRunState } from '../../core/scheduler'

export const STATE_GLYPH: Record<NodeRunState, string> = {
  ok: '✓',
  stale: '!',
  running: '·',
  error: '×',
  blocked: '–',
  disabled: 'M',
  idle: '',
}

export const STATE_TEXT: Record<NodeRunState, string> = {
  ok: 'up to date',
  stale: 'needs run',
  running: 'running',
  error: 'error',
  blocked: 'waiting upstream',
  disabled: 'muted',
  idle: 'not evaluated',
}
