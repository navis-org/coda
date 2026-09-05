// @vitest-environment jsdom
/**
 * What a finished run is allowed to interrupt somebody for, and the one piece of state the
 * title flash keeps.
 *
 * Two halves under test, and both are here because they fail *quietly*. `runAnnouncement` is
 * where every "is this worth saying" rule lives, and each of them wrong means a notification
 * nobody wanted rather than an error anybody sees. The flash keeps a single module variable —
 * the title it replaced — and the way to get that wrong is to re-read `document.title` on a
 * second flash, which latches our own text in as the base and leaves the tab saying "Run
 * finished" for the rest of the session with nothing left to restore.
 *
 * Under jsdom for the title, which is a real `document`. The notification half is deliberately
 * *not* faked: jsdom has no `Notification` at all, which is exactly the `unsupported` branch —
 * so the suite runs on an engine that cannot show one, and what is asserted is the contract that
 * matters there, that it answers `false` rather than throwing. Driving a real permission prompt
 * is a browser job and stays one.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import type { RunSummary } from '../core/scheduler'
import {
  NOTIFY_AFTER_MS,
  bellState,
  clearTitleFlash,
  flashTitle,
  notifyState,
  runAnnouncement,
  showRunNotification,
} from './notify'

function summary(patch: Partial<RunSummary> = {}): RunSummary {
  return {
    executed: ['a', 'b', 'c'],
    failed: [],
    deferred: [],
    loopNodes: [],
    iterations: 0,
    cancelled: false,
    durationMs: NOTIFY_AFTER_MS + 1000,
    ...patch,
  }
}

describe('runAnnouncement', () => {
  it('says nothing about a run that finished quickly', () => {
    // The floor is the whole reason auto-run does not have to be excluded: what decides whether
    // somebody switched away is the duration, not which button started the run.
    expect(
      runAnnouncement(summary({ durationMs: NOTIFY_AFTER_MS - 1 }), 'Graph'),
    ).toBeUndefined()
    expect(runAnnouncement(summary({ durationMs: NOTIFY_AFTER_MS }), 'Graph')).toBeDefined()
  })

  it('says nothing about a cancelled run', () => {
    // The user pressed Cancel. Telling them it stopped is telling them what they just did.
    expect(runAnnouncement(summary({ cancelled: true }), 'Graph')).toBeUndefined()
  })

  it('says nothing about a run that touched no node', () => {
    // An auto pass over a graph of expensive nodes defers all of them and still reports a
    // duration. Announcing that would be announcing that nothing happened.
    const deferredOnly = summary({ executed: [], failed: [], deferred: ['a', 'b'] })
    expect(runAnnouncement(deferredOnly, 'Graph')).toBeUndefined()
  })

  it('names the graph, the nodes and the duration', () => {
    const announcement = runAnnouncement(summary({ durationMs: 95_400 }), 'Central complex')
    expect(announcement?.title).toBe('Coda — run finished')
    expect(announcement?.body).toContain('Central complex')
    expect(announcement?.body).toContain('3 nodes')
    // The same spelling the status bar uses, so the notification and the line you read when you
    // come back to the tab agree about one number.
    expect(announcement?.body).toContain('95.4s')
  })

  it('leaves an unnamed graph unnamed rather than saying Untitled', () => {
    const bare = runAnnouncement(summary(), undefined)?.body
    expect(bare).toBe(runAnnouncement(summary(), '   ')?.body)
    expect(bare?.startsWith('3 nodes')).toBe(true)
  })

  it('counts loop passes, which the node set cannot', () => {
    // `executed` is a set of node ids and so reads "3 nodes" for a loop that made four hundred
    // passes — see `RunSummary.loopNodes`. A loop is also what a run long enough to reach the
    // floor usually is.
    const looped = runAnnouncement(summary({ iterations: 400, loopNodes: ['a', 'b'] }), 'G')
    expect(looped?.body).toContain('400 passes')
  })

  it('tells a failure apart from a success in every field', () => {
    const failed = runAnnouncement(summary({ executed: ['a'], failed: ['b', 'c'] }), 'G')
    expect(failed?.title).toBe('Coda — run failed')
    expect(failed?.body).toContain('2 nodes of 3 failed')
    // The tab strip truncates from the right, so the glyph carries the outcome on its own.
    expect(failed?.flash.startsWith('⚠')).toBe(true)
    expect(runAnnouncement(summary(), 'G')?.flash.startsWith('✓')).toBe(true)
  })

  it('keeps the graph name out of the tab title', () => {
    // It is the first thing a narrow tab would cut, and the notification already carries it.
    const announcement = runAnnouncement(summary(), 'Central complex')
    expect(announcement?.flash).not.toContain('Central complex')
  })
})

describe('the title flash', () => {
  beforeEach(() => {
    clearTitleFlash()
    document.title = 'Coda — Connectome Data Analysis'
  })

  it('restores the title it replaced', () => {
    flashTitle('✓ Run finished')
    expect(document.title).toBe('✓ Run finished')
    clearTitleFlash()
    expect(document.title).toBe('Coda — Connectome Data Analysis')
  })

  it('keeps the original across a second flash', () => {
    // The regression this file exists for: re-reading `document.title` here would latch
    // "✓ Run finished" in as the base, and the tab would never say anything else again.
    flashTitle('✓ Run finished')
    flashTitle('⚠ Run failed')
    clearTitleFlash()
    expect(document.title).toBe('Coda — Connectome Data Analysis')
  })

  it('is safe to clear when nothing is flashing', () => {
    clearTitleFlash()
    clearTitleFlash()
    expect(document.title).toBe('Coda — Connectome Data Analysis')
  })
})

describe('bellState', () => {
  it('needs the preference and the permission together', () => {
    // The rule the whole feature turns on: a stored `true` is not an answer, because the
    // permission behind it can be revoked from browser settings with nothing raised here. This
    // is the only place the pair is combined, and it is asserted rather than left to a render
    // because the interesting row — granted, preference off — is unreachable under jsdom.
    expect(bellState(true, 'granted').on).toBe(true)
    expect(bellState(false, 'granted').on).toBe(false)
    expect(bellState(true, 'denied').on).toBe(false)
    expect(bellState(true, 'default').on).toBe(false)
    expect(bellState(true, 'unsupported').on).toBe(false)
  })

  it('blocks on the two states the user cannot leave from here', () => {
    // `default` is not blocked — it is the one state a click can still move. Getting this wrong
    // disables the control before it has ever been offered.
    expect(bellState(false, 'denied').blocked).toBe(true)
    expect(bellState(false, 'unsupported').blocked).toBe(true)
    expect(bellState(false, 'default').blocked).toBe(false)
    expect(bellState(true, 'granted').blocked).toBe(false)
  })
})

describe('the permission seam', () => {
  it('reports an engine with no Notification as unsupported rather than throwing', () => {
    // jsdom is that engine, and so is an iOS Safari tab that has not been installed to the home
    // screen. All three of the ways this can be absent mean the same thing: do not offer it.
    expect(notifyState()).toBe('unsupported')
  })

  it('answers false rather than throwing when it cannot show one', () => {
    // Android Chrome throws `Illegal constructor` here for a real reason — it serves
    // notifications only through a service worker — and the title flash has already happened by
    // the time this runs, so the failure has to degrade rather than propagate.
    const announcement = runAnnouncement(summary(), 'G')
    expect(announcement).toBeDefined()
    expect(showRunNotification(announcement!)).toBe(false)
  })
})
